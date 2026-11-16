import type {
  Candle,
  DataClassificationStatus,
  HtfContext,
  MarketScenario,
  StructureEvent,
  SupportResistanceLevels,
  TechnicalIndicators,
  VolumeProfileSummary,
} from './types';

function finiteOr(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export interface SanitizeResult {
  candles: Candle[];
  duplicatesRemoved: number;
  invalidRemoved: number;
  gapsDetected: number;
}

/**
 * Sanitizes OHLCV candles: removes NaN/Infinity/<=0 prices, fixes inverted high/low bounds,
 * sorts ascending by time, deduplicates identical timestamps (keeping latest), and counts gaps.
 */
export function sanitizeCandles(
  rawCandles: Candle[],
  expectedStepMs = 15 * 60 * 1000,
): SanitizeResult {
  if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
    return { candles: [], duplicatesRemoved: 0, invalidRemoved: 0, gapsDetected: 0 };
  }

  let invalidRemoved = 0;
  const byTime = new Map<number, Candle>();
  let duplicatesRemoved = 0;

  for (const c of rawCandles) {
    if (!c || typeof c !== 'object') {
      invalidRemoved++;
      continue;
    }
    const time = Number(c.time);
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const volume = Number(c.volume);

    if (
      !Number.isFinite(time) ||
      time <= 0 ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0
    ) {
      invalidRemoved++;
      continue;
    }

    const normalizedHigh = Math.max(high, open, close, low);
    const normalizedLow = Math.min(low, open, close, high);

    if (byTime.has(time)) {
      duplicatesRemoved++;
    }
    byTime.set(time, {
      time,
      open,
      high: normalizedHigh,
      low: normalizedLow,
      close,
      volume,
      isClosed: c.isClosed ?? true,
    });
  }

  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);

  let gapsDetected = 0;
  if (expectedStepMs > 0) {
    for (let i = 1; i < sorted.length; i++) {
      const delta = sorted[i].time - sorted[i - 1].time;
      if (delta > expectedStepMs * 1.6) {
        gapsDetected++;
      }
    }
  }

  return {
    candles: sorted,
    duplicatesRemoved,
    invalidRemoved,
    gapsDetected,
  };
}

export function computeSMA(values: number[], period: number): number {
  if (!Array.isArray(values) || values.length === 0 || period <= 0) return 0;
  const slice = values.slice(-Math.min(period, values.length));
  if (slice.length === 0) return 0;
  const sum = slice.reduce((acc, v) => acc + finiteOr(v, 0), 0);
  return finiteOr(sum / slice.length, 0);
}

/**
 * Standard SMA-seeded Exponential Moving Average:
 * When values.length >= period, EMA[period - 1] = SMA(values[0..period-1]),
 * then EMA[i] = close[i] * k + EMA[i - 1] * (1 - k) for i >= period.
 */
export function computeEMASeries(values: number[], period: number): number[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const safePeriod = Math.max(1, Math.floor(period));
  const k = 2 / (safePeriod + 1);

  if (values.length < safePeriod) {
    const running: number[] = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += finiteOr(values[i], running[i - 1] ?? 0);
      running.push(sum / (i + 1));
    }
    return running;
  }

  const result = new Array<number>(values.length);
  let seedSum = 0;
  for (let i = 0; i < safePeriod; i++) {
    seedSum += finiteOr(values[i], 0);
    result[i] = seedSum / (i + 1);
  }
  result[safePeriod - 1] = seedSum / safePeriod;

  for (let i = safePeriod; i < values.length; i++) {
    const val = finiteOr(values[i], result[i - 1]);
    result[i] = val * k + result[i - 1] * (1 - k);
  }
  return result;
}

export function computeEMA(values: number[], period: number): number {
  const series = computeEMASeries(values, period);
  return series.length > 0 ? finiteOr(series[series.length - 1], 0) : 0;
}

export function computeRSI(closes: number[], period = 14): number {
  if (!Array.isArray(closes) || closes.length < period + 1) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = finiteOr(closes[i]) - finiteOr(closes[i - 1]);
    if (diff >= 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = finiteOr(closes[i]) - finiteOr(closes[i - 1]);
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return finiteOr(100 - 100 / (1 + rs), 50);
}

export function computeMACD(closes: number[]): {
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  warmupValid: boolean;
} {
  if (!Array.isArray(closes) || closes.length < 35) {
    return { macdLine: 0, macdSignal: 0, macdHistogram: 0, warmupValid: false };
  }
  const ema12 = computeEMASeries(closes, 12);
  const ema26 = computeEMASeries(closes, 26);
  const validMacdTail = closes.slice(25).map((_, idx) => ema12[25 + idx] - ema26[25 + idx]);
  const signalSeries = computeEMASeries(validMacdTail, 9);
  const macdLine = finiteOr(validMacdTail[validMacdTail.length - 1], 0);
  const macdSignal = finiteOr(signalSeries[signalSeries.length - 1], 0);
  return {
    macdLine,
    macdSignal,
    macdHistogram: finiteOr(macdLine - macdSignal, 0),
    warmupValid: true,
  };
}

export function computeATR(candles: Candle[], period = 14): number {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prevClose),
      Math.abs(curr.low - prevClose),
    );
    if (Number.isFinite(tr) && tr >= 0) {
      trueRanges.push(tr);
    }
  }
  if (trueRanges.length === 0) return 0;
  if (trueRanges.length <= period) {
    return finiteOr(trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length, 0);
  }
  // Wilder smoothed ATR
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return finiteOr(atr, 0);
}

export function computeADX(
  candles: Candle[],
  period = 14,
): { adx14: number; plusDi14: number; minusDi14: number } {
  if (!Array.isArray(candles) || candles.length < period * 2) {
    return { adx14: 15, plusDi14: 20, minusDi14: 20 };
  }

  const trList: number[] = [];
  const plusDmList: number[] = [];
  const minusDmList: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    trList.push(tr);
    plusDmList.push(plusDm);
    minusDmList.push(minusDm);
  }

  let smoothTr = trList.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDm = plusDmList.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDm = minusDmList.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues: number[] = [];
  let lastPlusDi = 20;
  let lastMinusDi = 20;

  for (let i = period; i < trList.length; i++) {
    smoothTr = smoothTr - smoothTr / period + trList[i];
    smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDmList[i];
    smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDmList[i];

    const plusDi = smoothTr > 0 ? (smoothPlusDm / smoothTr) * 100 : 0;
    const minusDi = smoothTr > 0 ? (smoothMinusDm / smoothTr) * 100 : 0;
    lastPlusDi = plusDi;
    lastMinusDi = minusDi;
    const diSum = plusDi + minusDi;
    const dx = diSum > 0 ? (Math.abs(plusDi - minusDi) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length === 0) {
    return { adx14: 15, plusDi14: 20, minusDi14: 20 };
  }

  const initLen = Math.min(period, dxValues.length);
  let adx = dxValues.slice(0, initLen).reduce((a, b) => a + b, 0) / initLen;
  for (let i = initLen; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return {
    adx14: Number(finiteOr(adx, 15).toFixed(2)),
    plusDi14: Number(finiteOr(lastPlusDi, 20).toFixed(2)),
    minusDi14: Number(finiteOr(lastMinusDi, 20).toFixed(2)),
  };
}

export function computeBollingerBands(
  closes: number[],
  period = 20,
  mult = 2,
): {
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
  return {
    upper: finiteOr(upper, middle),
    middle: finiteOr(middle, 0),
    lower: finiteOr(lower, middle),
    bandwidth: finiteOr(bandwidth, 0),
  };
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
  return volSum > 0 ? finiteOr(pvSum / volSum) : finiteOr(slice[slice.length - 1]?.close, 0);
}

export function computeOBV(
  candles: Candle[],
  slopeLookback = 10,
): { obv: number; obvSlope: number } {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { obv: 0, obvSlope: 0 };
  }
  const series: number[] = [0];
  let running = 0;
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    if (curr > prev) running += candles[i].volume;
    else if (curr < prev) running -= candles[i].volume;
    series.push(running);
  }
  const lookIdx = Math.max(0, series.length - 1 - slopeLookback);
  const slope = (series[series.length - 1] - series[lookIdx]) / Math.max(1, series.length - 1 - lookIdx);
  return {
    obv: Number(finiteOr(running, 0).toFixed(2)),
    obvSlope: Number(finiteOr(slope, 0).toFixed(2)),
  };
}

export function computeVolumeProfile(
  candles: Candle[],
  lookbackBars = 72,
  binsCount = 24,
): VolumeProfileSummary {
  const slice = candles.slice(-lookbackBars);
  if (slice.length === 0) {
    return { poc: 0, vah: 0, val: 0, lookbackBars: 0 };
  }
  const minLow = Math.min(...slice.map((c) => c.low));
  const maxHigh = Math.max(...slice.map((c) => c.high));
  const range = maxHigh - minLow;
  if (range <= 0) {
    const p = slice[slice.length - 1].close;
    return { poc: p, vah: p, val: p, lookbackBars: slice.length };
  }

  const bins = new Array<number>(binsCount).fill(0);
  const binSize = range / binsCount;

  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    const idx = Math.min(binsCount - 1, Math.max(0, Math.floor((typical - minLow) / binSize)));
    bins[idx] += c.volume;
  }

  let pocIdx = 0;
  for (let i = 1; i < binsCount; i++) {
    if (bins[i] > bins[pocIdx]) pocIdx = i;
  }

  const totalVol = bins.reduce((a, b) => a + b, 0);
  const targetVol = totalVol * 0.7;
  let accumVol = bins[pocIdx];
  let lowIdx = pocIdx;
  let highIdx = pocIdx;

  while (accumVol < targetVol && (lowIdx > 0 || highIdx < binsCount - 1)) {
    const nextLow = lowIdx > 0 ? bins[lowIdx - 1] : -1;
    const nextHigh = highIdx < binsCount - 1 ? bins[highIdx + 1] : -1;
    if (nextHigh >= nextLow && highIdx < binsCount - 1) {
      highIdx++;
      accumVol += Math.max(0, bins[highIdx]);
    } else if (lowIdx > 0) {
      lowIdx--;
      accumVol += Math.max(0, bins[lowIdx]);
    } else {
      break;
    }
  }

  return {
    poc: Number((minLow + (pocIdx + 0.5) * binSize).toFixed(2)),
    val: Number((minLow + lowIdx * binSize).toFixed(2)),
    vah: Number((minLow + (highIdx + 1) * binSize).toFixed(2)),
    lookbackBars: slice.length,
  };
}

export function computeSupportResistance(candles: Candle[], lookback = 60): SupportResistanceLevels {
  const slice = candles.slice(-lookback);
  if (slice.length < 5) {
    const last = candles[candles.length - 1]?.close ?? 0;
    return {
      nearestSupport: last * 0.99,
      nearestResistance: last * 1.01,
      supports: [],
      resistances: [],
    };
  }

  const lastPrice = slice[slice.length - 1].close;
  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];

  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (
      c.high > slice[i - 1].high &&
      c.high > slice[i - 2].high &&
      c.high >= slice[i + 1].high &&
      c.high >= slice[i + 2].high
    ) {
      pivotHighs.push(Number(c.high.toFixed(2)));
    }
    if (
      c.low < slice[i - 1].low &&
      c.low < slice[i - 2].low &&
      c.low <= slice[i + 1].low &&
      c.low <= slice[i + 2].low
    ) {
      pivotLows.push(Number(c.low.toFixed(2)));
    }
  }

  const supports = pivotLows
    .filter((p) => p <= lastPrice)
    .sort((a, b) => b - a)
    .slice(0, 3);
  const resistances = pivotHighs
    .filter((p) => p >= lastPrice)
    .sort((a, b) => a - b)
    .slice(0, 3);

  const fallbackSupport = Number(Math.min(...slice.map((c) => c.low)).toFixed(2));
  const fallbackResistance = Number(Math.max(...slice.map((c) => c.high)).toFixed(2));

  return {
    nearestSupport: supports[0] ?? fallbackSupport,
    nearestResistance: resistances[0] ?? fallbackResistance,
    supports,
    resistances,
  };
}

/**
 * Structural Swing Break of Structure (BOS) & Change of Character (CHoCH).
 */
export function computeMarketStructure(
  candles: Candle[],
  ema21: number,
): { structureBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; structureEvent: StructureEvent } {
  if (candles.length < 24) {
    return { structureBias: 'NEUTRAL', structureEvent: 'NONE' };
  }

  const anchor24 = candles.slice(-24, -12);
  const prior12 = candles.slice(-12, -4);
  const recent4 = candles.slice(-4);
  const last = candles[candles.length - 1];

  const anchorHigh = Math.max(...anchor24.map((c) => c.high));
  const anchorLow = Math.min(...anchor24.map((c) => c.low));
  const priorHigh = Math.max(...prior12.map((c) => c.high));
  const priorLow = Math.min(...prior12.map((c) => c.low));
  const recentHigh = Math.max(...recent4.map((c) => c.high));
  const recentLow = Math.min(...recent4.map((c) => c.low));

  const priorTrendBear = priorHigh < anchorHigh && priorLow < anchorLow;
  const priorTrendBull = priorHigh > anchorHigh && priorLow > anchorLow;

  if (last.close > priorHigh) {
    if (priorTrendBear) {
      return { structureBias: 'BULLISH', structureEvent: 'CHOCH_BULL' };
    }
    return { structureBias: 'BULLISH', structureEvent: 'BOS_BULL' };
  }

  if (last.close < priorLow) {
    if (priorTrendBull) {
      return { structureBias: 'BEARISH', structureEvent: 'CHOCH_BEAR' };
    }
    return { structureBias: 'BEARISH', structureEvent: 'BOS_BEAR' };
  }

  if (recentHigh > priorHigh && recentLow > priorLow && last.close > ema21) {
    return { structureBias: 'BULLISH', structureEvent: 'BOS_BULL' };
  }
  if (recentLow < priorLow && recentHigh < priorHigh && last.close < ema21) {
    return { structureBias: 'BEARISH', structureEvent: 'BOS_BEAR' };
  }

  return { structureBias: 'NEUTRAL', structureEvent: 'NONE' };
}

/**
 * Computes resampled HTF bias strictly from CLOSED 15m bars (never partial remainder candles).
 */
function computeResampledHtfBias(candles: Candle[]): {
  h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  d1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  m5Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  source: 'RESAMPLED_M15' | 'INSUFFICIENT';
} {
  const closed = candles.filter((c) => c.isClosed !== false);
  if (closed.length < 48) {
    return {
      h1Bias: 'NEUTRAL',
      h4Bias: 'NEUTRAL',
      d1Bias: 'NEUTRAL',
      m5Bias: 'NEUTRAL',
      source: 'INSUFFICIENT',
    };
  }

  // Strictly complete 4-bar blocks for H1 (index 3, 7, 11, ...)
  const h1Closes: number[] = [];
  for (let i = 3; i < closed.length; i += 4) {
    h1Closes.push(closed[i].close);
  }
  const lastH1Close = h1Closes[h1Closes.length - 1] ?? 0;

  let h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (h1Closes.length >= 21) {
    const h1Ema9 = computeEMA(h1Closes, 9);
    const h1Ema21 = computeEMA(h1Closes, 21);
    const h1Rsi = computeRSI(h1Closes, 14);
    if (lastH1Close > h1Ema9 && h1Ema9 > h1Ema21 && h1Rsi >= 50) h1Bias = 'LONG';
    else if (lastH1Close < h1Ema9 && h1Ema9 < h1Ema21 && h1Rsi <= 50) h1Bias = 'SHORT';
  }

  // Strictly complete 16-bar blocks for H4 (index 15, 31, 47, ...)
  const h4Closes: number[] = [];
  for (let i = 15; i < closed.length; i += 16) {
    h4Closes.push(closed[i].close);
  }
  const lastH4Close = h4Closes[h4Closes.length - 1] ?? 0;
  let h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (h4Closes.length >= 12) {
    const h4Ema5 = computeEMA(h4Closes, 5);
    const h4Ema12 = computeEMA(h4Closes, 12);
    if (lastH4Close > h4Ema5 && h4Ema5 > h4Ema12) h4Bias = 'LONG';
    else if (lastH4Close < h4Ema5 && h4Ema5 < h4Ema12) h4Bias = 'SHORT';
  }

  return {
    h1Bias,
    h4Bias,
    d1Bias: 'NEUTRAL',
    m5Bias: 'NEUTRAL',
    source: h1Closes.length >= 21 && h4Closes.length >= 12 ? 'RESAMPLED_M15' : 'INSUFFICIENT',
  };
}

export function extractIndicators(
  rawCandles: Candle[],
  fundingRate: number | null = null,
  scenarioHint?: MarketScenario,
  liveOrderbookImbalance?: number,
  htfContext?: HtfContext,
  now?: number,
  spreadBps = 0,
  realAggTradeCvdDelta: number | null = null,
): TechnicalIndicators {
  const { candles, invalidRemoved, gapsDetected } = sanitizeCandles(rawCandles);
  const dataIssues: string[] = [];
  const qualityFlags: string[] = [];

  if (invalidRemoved > 0) {
    dataIssues.push(`Loại bỏ ${invalidRemoved} nến lỗi/NaN`);
    qualityFlags.push(`INVALID_BARS_FILTERED:${invalidRemoved}`);
  }
  if (gapsDetected > 0) {
    dataIssues.push(`Phát hiện ${gapsDetected} khoảng trống dữ liệu nến`);
    qualityFlags.push(`CANDLE_GAPS:${gapsDetected}`);
  }
  if (candles.length < 30) {
    dataIssues.push(`Thiếu dữ liệu tối thiểu (${candles.length}/30 nến)`);
    qualityFlags.push('INSUFFICIENT_CANDLES');
  }

  const hasValidData = candles.length >= 30;
  const safeCandles: Candle[] =
    candles.length > 0
      ? candles
      : [
          {
            time: now ?? Date.now(),
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 0,
          },
        ];

  const closes = safeCandles.map((c) => c.close);
  const last = safeCandles[safeCandles.length - 1];

  const sma20 = computeSMA(closes, 20);
  const sma50 = computeSMA(closes, 50);
  const sma200 = computeSMA(closes, 200);
  const ema9 = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);
  const ema50 = computeEMA(closes, 50);
  const ema200 = computeEMA(closes, Math.min(200, closes.length));
  const emaWarmupValid = closes.length >= 50;
  const rsi14 = computeRSI(closes, 14);
  const macd = computeMACD(closes);
  const atr14 = computeATR(safeCandles, 14);
  const atrWarmupValid = safeCandles.length >= 15;
  const atrPct = last.close > 0 ? Number(((atr14 / last.close) * 100).toFixed(3)) : 0;
  const bb = computeBollingerBands(closes, 20, 2);
  const vwap24 = computeVWAP(safeCandles, 24);
  const { obv, obvSlope } = computeOBV(safeCandles, 10);
  const volumeProfile = computeVolumeProfile(safeCandles, 72, 24);
  const srLevels = computeSupportResistance(safeCandles, 60);
  const { adx14, plusDi14, minusDi14 } = computeADX(safeCandles, 14);

  const volWindow = safeCandles.slice(-21, -1);
  const avgVol =
    volWindow.length > 0
      ? volWindow.reduce((acc, c) => acc + c.volume, 0) / volWindow.length
      : last.volume;
  const volVariance =
    volWindow.length > 1
      ? volWindow.reduce((acc, c) => acc + Math.pow(c.volume - avgVol, 2), 0) / volWindow.length
      : 0;
  const volStd = Math.sqrt(volVariance);

  // Time-normalized volume for live in-progress M15 bar
  const M15_MS = 15 * 60 * 1000;
  let effectiveVol = last.volume;
  if (
    (!scenarioHint || scenarioHint === 'auto_live') &&
    typeof now === 'number' &&
    now >= last.time &&
    now < last.time + M15_MS &&
    avgVol > 0
  ) {
    const elapsedFrac = Math.min(1, Math.max(0.22, (now - last.time) / M15_MS));
    effectiveVol = Math.min(avgVol * 3.5, last.volume / elapsedFrac);
  }
  const volumeRatio = avgVol > 0 ? Number((effectiveVol / avgVol).toFixed(3)) : 1;
  const volumeZScore = volStd > 0 ? Number(((effectiveVol - avgVol) / volStd).toFixed(2)) : 0;

  // Liquidity sweep & wick rejection detection strictly from real OHLC candlestick geometry (no scenario cheat)
  const body = Math.max(Math.abs(last.close - last.open), last.close * 0.0001);
  const lowerWick = Math.max(0, Math.min(last.open, last.close) - last.low);
  const upperWick = Math.max(0, last.high - Math.max(last.open, last.close));

  const recentSlice = safeCandles.slice(-12, -1);
  const recentLow =
    recentSlice.length > 0 ? Math.min(...recentSlice.map((c) => c.low), last.low) : last.low;
  const recentHigh =
    recentSlice.length > 0 ? Math.max(...recentSlice.map((c) => c.high), last.high) : last.high;

  let sweepSignal: TechnicalIndicators['sweepSignal'] = 'NONE';
  if (lowerWick > body * 1.45 && last.low <= recentLow * 1.001 && last.close > last.open) {
    sweepSignal = 'BULL_SWEEP';
  } else if (upperWick > body * 1.45 && last.high >= recentHigh * 0.999 && last.close < last.open) {
    sweepSignal = 'BEAR_SWEEP';
  }

  // Swing market structure bias (BOS & CHoCH)
  const { structureBias, structureEvent } = computeMarketStructure(safeCandles, ema21);

  // Higher-Timeframe context (honestly distinguishing real exchange klines vs closed resampled M15)
  const fallbackHtf = computeResampledHtfBias(safeCandles);
  const h1Bias = htfContext ? htfContext.h1Bias : fallbackHtf.h1Bias;
  const h4Bias = htfContext ? htfContext.h4Bias : fallbackHtf.h4Bias;
  const d1Bias = htfContext?.d1Bias ?? fallbackHtf.d1Bias;
  const m5Bias = htfContext?.m5Bias ?? fallbackHtf.m5Bias;
  const htfSource = htfContext?.source ?? fallbackHtf.source;

  let htfBias: TechnicalIndicators['htfBias'] = 'NEUTRAL';
  if ((h1Bias === 'LONG' && h4Bias !== 'SHORT') || (h4Bias === 'LONG' && h1Bias !== 'SHORT')) {
    htfBias = 'LONG';
  } else if (
    (h1Bias === 'SHORT' && h4Bias !== 'LONG') ||
    (h4Bias === 'SHORT' && h1Bias !== 'LONG')
  ) {
    htfBias = 'SHORT';
  }

  // Orderbook imbalance: ZERO synthetic EMA fallback. Mark UNAVAILABLE when exchange depth is absent.
  const hasRealDepth =
    typeof liveOrderbookImbalance === 'number' &&
    Number.isFinite(liveOrderbookImbalance);
  const orderbookSource: TechnicalIndicators['orderbookSource'] = hasRealDepth
    ? 'EXCHANGE_DEPTH'
    : 'UNAVAILABLE';
  const orderbookImbalance = hasRealDepth
    ? Math.max(-0.98, Math.min(0.98, liveOrderbookImbalance))
    : 0;
  if (!hasRealDepth) {
    qualityFlags.push('ORDERBOOK_UNAVAILABLE');
  }

  // Spot/Futures CVD: prefer real exchange aggressor trade stream delta; else explicit Candle Body Proxy
  let spotCvdDelta = 0;
  let cvdSource: TechnicalIndicators['cvdSource'] = 'UNAVAILABLE';
  if (!hasValidData) {
    cvdSource = 'UNAVAILABLE';
    spotCvdDelta = 0;
  } else if (typeof realAggTradeCvdDelta === 'number' && Number.isFinite(realAggTradeCvdDelta)) {
    cvdSource = 'EXCHANGE_TRADES';
    spotCvdDelta = realAggTradeCvdDelta;
  } else {
    cvdSource = 'CANDLE_BODY_PROXY';
    qualityFlags.push('CVD_ESTIMATED_FROM_OHLCV');
    const cvdLookback = safeCandles.slice(-8);
    spotCvdDelta = cvdLookback.reduce((acc, c) => {
      const dir = c.close >= c.open ? 1 : -1;
      const span = Math.max(c.high - c.low, c.close * 0.0002);
      const strength = Math.abs(c.close - c.open) / span;
      return acc + (dir * strength * c.volume * c.close) / 1_000_000;
    }, 0);
  }

  // Standardized 5-state classification status
  let dataStatus: DataClassificationStatus = 'LIVE_DATA';
  if (!hasValidData || last.close <= 0) {
    dataStatus = 'UNAVAILABLE';
  } else if (scenarioHint && scenarioHint !== 'auto_live') {
    dataStatus = 'SIMULATED_DATA';
  } else if (!hasRealDepth || cvdSource === 'CANDLE_BODY_PROXY' || !emaWarmupValid) {
    dataStatus = hasRealDepth ? 'LIVE_DATA' : 'ESTIMATED_DATA';
  }

  return {
    sma20,
    sma50,
    sma200,
    ema9,
    ema21,
    ema50,
    ema200,
    emaWarmupValid,
    rsi14,
    macdLine: macd.macdLine,
    macdSignal: macd.macdSignal,
    macdHistogram: macd.macdHistogram,
    macdWarmupValid: macd.warmupValid,
    atr14,
    atrPct,
    atrWarmupValid,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    bbBandwidth: bb.bandwidth,
    vwap24,
    obv,
    obvSlope,
    volumeRatio,
    volumeZScore,
    adx14,
    plusDi14,
    minusDi14,
    adxProxy: adx14,
    orderbookImbalance: Number(finiteOr(orderbookImbalance, 0).toFixed(4)),
    orderbookSource,
    spreadBps: Number(finiteOr(spreadBps, 0).toFixed(2)),
    spotCvdDelta: Number(finiteOr(spotCvdDelta, 0).toFixed(2)),
    cvdSource,
    fundingRate: fundingRate !== null && Number.isFinite(fundingRate) ? fundingRate : null,
    sweepSignal,
    structureBias,
    structureEvent,
    htfBias,
    h1Bias,
    h4Bias,
    d1Bias,
    m5Bias,
    htfSource,
    volumeProfile,
    srLevels,
    dataValid: hasValidData && last.close > 0,
    dataStatus,
    dataIssues,
    qualityFlags,
  };
}

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
    const phase = i % 72;
    let drift = 0;
    let volMult = 1;
    if (phase < 24) {
      drift = 0.0014;
      volMult = 1.2;
    } else if (phase < 38) {
      drift = -0.0002;
      volMult = 0.75;
    } else if (phase === 38) {
      drift = 0.0028;
      volMult = 1.85;
    } else if (phase < 56) {
      drift = -0.0012;
      volMult = 1.15;
    } else {
      drift = 0.0005;
      volMult = 0.85;
    }

    const noise = (rng() - 0.48) * 0.0038;
    const open = price;
    const close = Math.max(25000, open * (1 + drift + noise));
    const spread = Math.abs(close - open);
    const wickUp = open * (0.0008 + rng() * 0.0022);
    const wickDown =
      phase === 38
        ? open * 0.0055
        : open * (0.0008 + rng() * 0.0022);

    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;
    const baseVol = 320 + rng() * 280;
    const volume = Number((baseVol * volMult * (1 + (spread / open) * 80)).toFixed(2));

    candles.push({
      time: startTime + i * stepMs,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
      isClosed: true,
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
  const open = last?.close > 0 ? last.close : 92000;
  const rng = createSeededRng(tickStep * 7919 + Math.round(open));
  const recentLow =
    prevCandles.length > 0
      ? Math.min(...prevCandles.slice(-11).map((c) => c.low))
      : open * 0.995;

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
    // Organic candlestick wick geometry below prior swing low, closing green
    drift = 0.0024;
    extraLowerWick = Math.max(open * 0.0058, Math.max(0, open - recentLow) + open * 0.0015);
    volMult = 2.05;
  } else if (scenario === 'choppy_range') {
    drift = (tickStep % 2 === 0 ? 1 : -1) * (0.0004 + rng() * 0.0005);
    volMult = 0.58;
  } else {
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
    time: (last?.time ?? Date.now()) + 15 * 60 * 1000,
    open: Number(open.toFixed(2)),
    high: Number(high.toFixed(2)),
    low: Number(low.toFixed(2)),
    close: Number(close.toFixed(2)),
    volume,
    isClosed: true,
  };
}
