import type { Candle, HtfContext, MarketScenario, TechnicalIndicators } from './types';

export function computeEMASeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

export function computeEMA(values: number[], period: number): number {
  const series = computeEMASeries(values, period);
  return series.length > 0 ? series[series.length - 1] : 0;
}

export function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeMACD(closes: number[]): {
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
} {
  if (closes.length < 26) {
    return { macdLine: 0, macdSignal: 0, macdHistogram: 0 };
  }
  const ema12 = computeEMASeries(closes, 12);
  const ema26 = computeEMASeries(closes, 26);
  const macdSeries = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalSeries = computeEMASeries(macdSeries, 9);
  const macdLine = macdSeries[macdSeries.length - 1];
  const macdSignal = signalSeries[signalSeries.length - 1];
  return {
    macdLine,
    macdSignal,
    macdHistogram: macdLine - macdSignal,
  };
}

export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prevClose),
      Math.abs(curr.low - prevClose),
    );
    trueRanges.push(tr);
  }
  const slice = trueRanges.slice(-period);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return slice.length > 0 ? sum / slice.length : 0;
}

export function computeBollingerBands(closes: number[], period = 20, mult = 2): {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
} {
  const slice = closes.slice(-period);
  if (slice.length === 0) {
    return { upper: 0, middle: 0, lower: 0, bandwidth: 0 };
  }
  const middle = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - middle, 2), 0) / slice.length;
  const stdDev = Math.sqrt(variance);
  const upper = middle + mult * stdDev;
  const lower = middle - mult * stdDev;
  const bandwidth = middle > 0 ? (upper - lower) / middle : 0;
  return { upper, middle, lower, bandwidth };
}

export function computeVWAP(candles: Candle[], lookback = 24): number {
  const slice = candles.slice(-lookback);
  let pvSum = 0;
  let volSum = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    pvSum += typical * c.volume;
    volSum += c.volume;
  }
  return volSum > 0 ? pvSum / volSum : slice[slice.length - 1]?.close ?? 0;
}

function computeResampledHtfBias(candles: Candle[]): {
  h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
} {
  if (candles.length < 16) {
    return { h1Bias: 'NEUTRAL', h4Bias: 'NEUTRAL' };
  }

  // Resample M15 into synthetic H1 closes (every 4th bar + latest close)
  const h1Closes: number[] = [];
  for (let i = 3; i < candles.length; i += 4) {
    h1Closes.push(candles[i].close);
  }
  const latestClose = candles[candles.length - 1].close;
  if (candles.length % 4 !== 0) {
    h1Closes.push(latestClose);
  }

  const h1Ema9 = computeEMA(h1Closes, Math.min(9, h1Closes.length));
  const h1Ema21 = computeEMA(h1Closes, Math.min(21, h1Closes.length));
  const h1Rsi = computeRSI(h1Closes, Math.min(14, Math.max(4, h1Closes.length - 2)));

  let h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (latestClose > h1Ema9 && h1Ema9 > h1Ema21 && h1Rsi >= 50) h1Bias = 'LONG';
  else if (latestClose < h1Ema9 && h1Ema9 < h1Ema21 && h1Rsi <= 50) h1Bias = 'SHORT';

  // Resample into synthetic H4 closes (every 16th M15 bar + latest close)
  const h4Closes: number[] = [];
  for (let i = 15; i < candles.length; i += 16) {
    h4Closes.push(candles[i].close);
  }
  if (candles.length % 16 !== 0) {
    h4Closes.push(latestClose);
  }
  let h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (h4Closes.length >= 4) {
    const h4Ema5 = computeEMA(h4Closes, Math.min(5, h4Closes.length));
    const h4Ema12 = computeEMA(h4Closes, Math.min(12, h4Closes.length));
    if (latestClose > h4Ema5 && h4Ema5 > h4Ema12) h4Bias = 'LONG';
    else if (latestClose < h4Ema5 && h4Ema5 < h4Ema12) h4Bias = 'SHORT';
  } else {
    h4Bias = h1Bias;
  }

  return { h1Bias, h4Bias };
}

export function extractIndicators(
  candles: Candle[],
  fundingRate = 0.00012,
  scenarioHint?: MarketScenario,
  liveOrderbookImbalance?: number,
  htfContext?: HtfContext,
  now?: number,
): TechnicalIndicators {
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1] ?? {
    time: Date.now(),
    open: 94000,
    high: 94200,
    low: 93800,
    close: 94000,
    volume: 420,
  };

  const ema9 = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);
  const ema50 = computeEMA(closes, 50);
  const ema200 = computeEMA(closes, Math.min(200, closes.length));
  const rsi14 = computeRSI(closes, 14);
  const { macdLine, macdSignal, macdHistogram } = computeMACD(closes);
  const atr14 = computeATR(candles, 14);
  const bb = computeBollingerBands(closes, 20, 2);
  const vwap24 = computeVWAP(candles, 24);

  const volWindow = candles.slice(-21, -1);
  const avgVol =
    volWindow.length > 0
      ? volWindow.reduce((acc, c) => acc + c.volume, 0) / volWindow.length
      : last.volume;

  // Time-normalized volume for live in-progress M15 bar so early bars aren't falsely zeroed out
  const M15_MS = 15 * 60 * 1000;
  let effectiveVol = last.volume;
  if (
    scenarioHint === 'auto_live' &&
    typeof now === 'number' &&
    now >= last.time &&
    now < last.time + M15_MS &&
    avgVol > 0
  ) {
    const elapsedFrac = Math.min(1, Math.max(0.22, (now - last.time) / M15_MS));
    effectiveVol = Math.min(avgVol * 3.5, last.volume / elapsedFrac);
  }
  const volumeRatio = avgVol > 0 ? effectiveVol / avgVol : 1;

  // Directional trend strength proxy (0-60)
  const emaSpreadPct = ema50 > 0 ? Math.abs(ema21 - ema50) / ema50 : 0;
  const adxProxy = Math.min(60, Math.max(8, emaSpreadPct * 2600 + (bb.bandwidth * 380)));

  // Liquidity sweep & wick rejection detection on last 2 bars
  const prev = candles[candles.length - 2] ?? last;
  const body = Math.max(Math.abs(last.close - last.open), 1);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);

  const recentLow = Math.min(...candles.slice(-12, -1).map((c) => c.low), last.low);
  const recentHigh = Math.max(...candles.slice(-12, -1).map((c) => c.high), last.high);

  let sweepSignal: TechnicalIndicators['sweepSignal'] = 'NONE';
  if (
    (lowerWick > body * 1.45 && last.low <= recentLow * 1.001 && last.close > last.open) ||
    scenarioHint === 'liquidity_sweep'
  ) {
    sweepSignal = 'BULL_SWEEP';
  } else if (upperWick > body * 1.45 && last.high >= recentHigh * 0.999 && last.close < last.open) {
    sweepSignal = 'BEAR_SWEEP';
  }

  // Swing market structure bias (BoS / HH-HL vs LH-LL over last 16 candles)
  let structureBias: TechnicalIndicators['structureBias'] = 'NEUTRAL';
  if (candles.length >= 16) {
    const prior12 = candles.slice(-16, -4);
    const recent4 = candles.slice(-4);
    const priorHigh = Math.max(...prior12.map((c) => c.high));
    const priorLow = Math.min(...prior12.map((c) => c.low));
    const recent4High = Math.max(...recent4.map((c) => c.high));
    const recent4Low = Math.min(...recent4.map((c) => c.low));

    if (
      (last.close > priorHigh && recent4Low >= priorLow * 0.999) ||
      (recent4High > priorHigh && recent4Low > priorLow && last.close > ema21)
    ) {
      structureBias = 'BULLISH';
    } else if (
      (last.close < priorLow && recent4High <= priorHigh * 1.001) ||
      (recent4Low < priorLow && recent4High < priorHigh && last.close < ema21)
    ) {
      structureBias = 'BEARISH';
    }
  }

  // Higher-Timeframe context (H1 & H4)
  const fallbackHtf = computeResampledHtfBias(candles);
  const h1Bias = htfContext ? htfContext.h1Bias : fallbackHtf.h1Bias;
  const h4Bias = htfContext ? htfContext.h4Bias : fallbackHtf.h4Bias;
  let htfBias: TechnicalIndicators['htfBias'] = 'NEUTRAL';
  if ((h1Bias === 'LONG' && h4Bias !== 'SHORT') || (h4Bias === 'LONG' && h1Bias !== 'SHORT')) {
    htfBias = 'LONG';
  } else if (
    (h1Bias === 'SHORT' && h4Bias !== 'LONG') ||
    (h4Bias === 'SHORT' && h1Bias !== 'LONG')
  ) {
    htfBias = 'SHORT';
  }

  // Orderbook imbalance & Spot CVD: prefer live exchange depth20 imbalance when available
  const candleBodyRatio = (last.close - last.open) / Math.max(last.high - last.low, 1);
  const prevBodyRatio = (prev.close - prev.open) / Math.max(prev.high - prev.low, 1);
  let orderbookImbalance =
    typeof liveOrderbookImbalance === 'number' && Math.abs(liveOrderbookImbalance) > 0.0001
      ? Math.max(-0.98, Math.min(0.98, liveOrderbookImbalance))
      : Math.max(
          -0.92,
          Math.min(0.92, candleBodyRatio * 0.55 + prevBodyRatio * 0.25 + (ema9 > ema21 ? 0.18 : -0.18)),
        );
  if (scenarioHint && scenarioHint !== 'auto_live') {
    if (sweepSignal === 'BULL_SWEEP') {
      orderbookImbalance = Math.max(orderbookImbalance, 0.58);
    } else if (sweepSignal === 'BEAR_SWEEP') {
      orderbookImbalance = Math.min(orderbookImbalance, -0.58);
    }
  }

  const cvdLookback = candles.slice(-8);
  const spotCvdDelta = cvdLookback.reduce((acc, c) => {
    const dir = c.close >= c.open ? 1 : -1;
    const strength = Math.abs(c.close - c.open) / Math.max(c.high - c.low, 1);
    return acc + (dir * strength * c.volume * c.close) / 1_000_000;
  }, 0);

  return {
    ema9,
    ema21,
    ema50,
    ema200,
    rsi14,
    macdLine,
    macdSignal,
    macdHistogram,
    atr14,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    bbBandwidth: bb.bandwidth,
    vwap24,
    volumeRatio,
    adxProxy,
    orderbookImbalance,
    spotCvdDelta,
    fundingRate,
    sweepSignal,
    structureBias,
    htfBias,
    h1Bias,
    h4Bias,
  };
}

// Deterministic seeded PRNG (Mulberry32) so tests and initial states are reproducible
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateRealisticBTCSeries(
  count = 140,
  startPrice = 91800,
  seed = 20261115,
): Candle[] {
  const rng = createSeededRng(seed);
  const candles: Candle[] = [];
  const stepMs = 15 * 60 * 1000;
  const startTime = Date.now() - count * stepMs;
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    // Alternating macro waves (bull impulse -> consolidation -> sweep -> continuation)
    const phase = i % 72;
    let drift = 0;
    let volMult = 1;
    if (phase < 24) {
      drift = 0.0014; // clean bullish expansion
      volMult = 1.2;
    } else if (phase < 38) {
      drift = -0.0002; // shallow pullback / consolidation
      volMult = 0.75;
    } else if (phase === 38) {
      drift = 0.0028; // liquidity sweep & reclaim candle
      volMult = 1.85;
    } else if (phase < 56) {
      drift = -0.0012; // controlled bearish pullback
      volMult = 1.15;
    } else {
      drift = 0.0005; // accumulation base
      volMult = 0.85;
    }

    const noise = (rng() - 0.48) * 0.0038;
    const open = price;
    const close = Math.max(25000, open * (1 + drift + noise));
    const spread = Math.abs(close - open);
    const wickUp = open * (0.0008 + rng() * 0.0022);
    const wickDown =
      phase === 38
        ? open * 0.0055 // deep sweep wick before reclaim
        : open * (0.0008 + rng() * 0.0022);

    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;
    const baseVol = 320 + rng() * 280;
    const volume = Number((baseVol * volMult * (1 + spread / open * 80)).toFixed(2));

    candles.push({
      time: startTime + i * stepMs,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });
    price = close;
  }

  return candles;
}

export function generateNextSimulatedCandle(
  prevCandles: Candle[],
  scenario: MarketScenario,
  tickStep: number,
): Candle {
  const last = prevCandles[prevCandles.length - 1];
  const open = last.close;
  const rng = createSeededRng(tickStep * 7919 + Math.round(open));

  let drift = 0;
  let volMult = 1;
  let extraLowerWick = 0;
  let extraUpperWick = 0;

  if (scenario === 'bull_breakout') {
    drift = 0.0022 + rng() * 0.0016;
    volMult = 1.65;
  } else if (scenario === 'bear_flush') {
    drift = -0.0024 - rng() * 0.0015;
    volMult = 1.7;
  } else if (scenario === 'liquidity_sweep') {
    drift = 0.0026;
    extraLowerWick = open * 0.0058;
    volMult = 2.05;
  } else if (scenario === 'choppy_range') {
    drift = (tickStep % 2 === 0 ? 1 : -1) * (0.0004 + rng() * 0.0005);
    volMult = 0.58;
  } else {
    // auto_live deterministic market cycle
    const wave = Math.sin(tickStep * 0.28);
    drift = wave * 0.0018 + (rng() - 0.49) * 0.0022;
    volMult = 0.9 + Math.abs(wave) * 0.7;
    if (tickStep % 14 === 0) {
      extraLowerWick = open * 0.0045;
      drift = 0.0021;
      volMult = 1.8;
    } else if (tickStep % 21 === 0) {
      extraUpperWick = open * 0.0045;
      drift = -0.0021;
      volMult = 1.8;
    }
  }

  const close = Math.max(25000, open * (1 + drift));
  const high = Math.max(open, close) + open * (0.0006 + rng() * 0.0014) + extraUpperWick;
  const low = Math.min(open, close) - open * (0.0006 + rng() * 0.0014) - extraLowerWick;
  const volume = Number(((340 + rng() * 240) * volMult).toFixed(2));

  return {
    time: last.time + 15 * 60 * 1000,
    open: Number(open.toFixed(2)),
    high: Number(high.toFixed(2)),
    low: Number(low.toFixed(2)),
    close: Number(close.toFixed(2)),
    volume,
  };
}
