import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeADX,
  computeATR,
  computeEMA,
  computeEMASeries,
  computeMACD,
  computeMarketStructure,
  computeOBV,
  computeRSI,
  computeSMA,
  computeSupportResistance,
  computeVolumeProfile,
  extractIndicators,
  generateRealisticBTCSeries,
  sanitizeCandles,
} from './indicators';
import {
  closePositionAtMarket,
  computePerformanceStats,
  createInitialRiskAccountState,
  createManualPosition,
  DEFAULT_STRATEGY_CONFIG,
  evaluateRiskGuardian,
  formatTradesAsCsv,
  normalizeAgentWeights,
  runPipelineCycle,
} from './multiAgentEngine';
import {
  parseHistoricalCsv,
  runHistoricalBacktest,
  runSimulationBacktest,
} from './backtestEngine';
import type { Candle, Position } from './types';

function makeBullBreakoutSeries(): Candle[] {
  const base = generateRealisticBTCSeries(80, 90000, 999);
  const candles: Candle[] = [...base];
  for (let i = 1; i <= 6; i++) {
    const prev = candles[candles.length - 1];
    const open = prev.close;
    const close = Number((open * 1.0032).toFixed(2));
    candles.push({
      time: prev.time + 15 * 60 * 1000,
      open,
      high: Number((close * 1.0012).toFixed(2)),
      low: Number((open * 0.9992).toFixed(2)),
      close,
      volume: 850,
      isClosed: true,
    });
  }
  return candles;
}

test('Indicators: SMA, EMA, RSI, ATR, OBV, Wilder ADX14, Volume Profile, S/R pivots compute validly', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 90000 + i * 180);
  const sma20 = computeSMA(closes, 20);
  const ema9 = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);
  const rsi = computeRSI(closes, 14);

  assert.ok(ema9 > ema21, 'Fast EMA9 must lead EMA21 in an uptrend');
  assert.ok(sma20 > 90000, 'SMA20 must reflect rising close prices');
  assert.ok(rsi > 70 && rsi <= 100, `RSI on uptrend should be > 70, got ${rsi}`);

  const candles = generateRealisticBTCSeries(90, 92000, 12345);
  const atr = computeATR(candles, 14);
  const adx = computeADX(candles, 14);
  const obv = computeOBV(candles);
  const vp = computeVolumeProfile(candles, 60);
  const sr = computeSupportResistance(candles, 60);

  assert.ok(atr > 50, `ATR should be positive, got ${atr}`);
  assert.ok(adx.adx14 >= 0 && adx.adx14 <= 100, `Wilder ADX must be bounded 0..100, got ${adx.adx14}`);
  assert.ok(Number.isFinite(obv.obv) && Number.isFinite(obv.obvSlope));
  assert.ok(vp.val <= vp.poc && vp.poc <= vp.vah, 'Volume Profile VAL <= POC <= VAH');
  assert.ok(sr.nearestSupport > 0 && sr.nearestResistance > sr.nearestSupport);
});

test('V2 Indicator formulas: SMA-seeded EMA series, flat RSI=50, MACD warmup, BOS/CHoCH structure, and NO fake orderbook proxy', () => {
  // SMA-seeded EMA check
  const vals = [10, 12, 14, 16, 18, 20];
  const ema3 = computeEMASeries(vals, 3);
  assert.equal(ema3[2], 12); // SMA(10,12,14)
  assert.equal(ema3[3], 16 * (2 / 4) + 12 * (1 - 2 / 4)); // 14

  // Flat closes RSI === 50
  assert.equal(computeRSI(Array(25).fill(91000), 14), 50);

  // MACD warmup guard
  assert.equal(computeMACD(Array(20).fill(91000)).warmupValid, false);
  assert.equal(computeMACD(Array.from({ length: 45 }, (_, i) => 90000 + i * 25)).warmupValid, true);

  // Market structure BOS & CHoCH
  const t0 = 1_700_000_000_000;
  const downToBreakUp: Candle[] = Array.from({ length: 24 }, (_, idx) => {
    // Anchor bars 0..11 around 95000..94000, prior bars 12..19 lower at 93000..92000, last bar breaks > 93500
    if (idx < 12) {
      return { time: t0 + idx * 900_000, open: 95000, high: 95200, low: 94600, close: 94800, volume: 100 };
    }
    if (idx < 23) {
      return { time: t0 + idx * 900_000, open: 92500, high: 93000, low: 91800, close: 92200, volume: 100 };
    }
    return { time: t0 + idx * 900_000, open: 92400, high: 93900, low: 92300, close: 93750, volume: 220 };
  });
  const chochRes = computeMarketStructure(downToBreakUp, 92600);
  assert.equal(chochRes.structureBias, 'BULLISH');
  assert.equal(chochRes.structureEvent, 'CHOCH_BULL');

  // Absence of liveOrderbookImbalance MUST mark orderbookSource='UNAVAILABLE' and orderbookImbalance=0
  const candles = makeBullBreakoutSeries();
  const indNoDepth = extractIndicators(candles, null, 'auto_live');
  assert.equal(indNoDepth.orderbookSource, 'UNAVAILABLE');
  assert.equal(indNoDepth.orderbookImbalance, 0);
  assert.equal(indNoDepth.dataStatus, 'ESTIMATED_DATA');
});

test('sanitizeCandles filters NaN, non-positive prices, inverted H/L, duplicates, and flags gaps', () => {
  const baseTime = 1_700_000_000_000;
  const raw: Candle[] = [
    { time: baseTime + 900_000, open: 90100, high: 90200, low: 90000, close: 90150, volume: 10 },
    { time: baseTime, open: 90000, high: 90050, low: 90100, close: 90020, volume: 12 }, // inverted low > high
    { time: baseTime, open: 90000, high: 90120, low: 89950, close: 90080, volume: 14 }, // duplicate ts
    { time: baseTime + 1_800_000, open: NaN, high: 90300, low: 90000, close: 90200, volume: 5 }, // NaN open
    { time: baseTime + 5_400_000, open: 90200, high: 90400, low: 90100, close: 90350, volume: 20 }, // gap after 15m*1
  ];
  const res = sanitizeCandles(raw);
  assert.equal(res.candles.length, 3);
  assert.ok(res.invalidRemoved >= 1);
  assert.ok(res.duplicatesRemoved >= 1);
  assert.ok(res.gapsDetected >= 1);
  assert.ok(res.candles[0].high >= res.candles[0].low);
});

test('Invalid/Empty candles force dataStatus=UNAVAILABLE and ALL 6 Agents return UNAVAILABLE with confidence=0', () => {
  const emptyCycle = runPipelineCycle({
    cycleId: 1,
    candles: [],
    fundingRate: null,
    equity: 100000,
    activePosition: null,
    config: DEFAULT_STRATEGY_CONFIG,
  });

  assert.equal(emptyCycle.indicators.dataValid, false);
  assert.equal(emptyCycle.indicators.dataStatus, 'UNAVAILABLE');
  assert.equal(emptyCycle.cycle.actionTaken, 'VETO_SKIP');
  assert.equal(emptyCycle.nextPosition, null);

  const agentKeys = [
    'macro_scout',
    'quant_analyst',
    'orderflow_radar',
    'strategy_architect',
    'risk_guardian',
    'execution_commander',
  ] as const;

  for (const key of agentKeys) {
    assert.equal(emptyCycle.cycle.signals[key].direction, 'UNAVAILABLE', `${key} must vote UNAVAILABLE`);
    assert.equal(emptyCycle.cycle.signals[key].confidence, 0, `${key} confidence must be 0`);
  }
});

test('Risk Guardian vetoes choppy market and low consensus setups', () => {
  const candles = generateRealisticBTCSeries(90, 93000, 777);
  const ind = extractIndicators(candles, 0.0001, 'choppy_range');

  const choppyRes = evaluateRiskGuardian(
    candles[candles.length - 1].close,
    ind,
    'Sideway Nhiễu Rủi ro',
    'LONG',
    82,
    100000,
    DEFAULT_STRATEGY_CONFIG,
    false,
    Date.now(),
  );

  assert.equal(choppyRes.risk.approved, false);
  assert.equal(choppyRes.signal.direction, 'VETO');
  assert.ok(choppyRes.risk.vetoReason?.includes('Sideway'));

  const lowConsensusRes = evaluateRiskGuardian(
    candles[candles.length - 1].close,
    ind,
    'Mở rộng Xu hướng Tăng',
    'LONG',
    55,
    100000,
    DEFAULT_STRATEGY_CONFIG,
    false,
    Date.now(),
  );
  assert.equal(lowConsensusRes.risk.approved, false);
  assert.equal(lowConsensusRes.signal.direction, 'VETO');
});

test('Risk Guardian computes isolated Futures liquidationPrice vs Spot null and enforces pendingOrdersMarginUsd', () => {
  const candles = makeBullBreakoutSeries();
  const ind = extractIndicators(candles, 0.0001, 'bull_breakout');
  const price = candles[candles.length - 1].close;

  const spotRisk = evaluateRiskGuardian(
    price,
    ind,
    'Mở rộng Xu hướng Tăng',
    'LONG',
    82,
    100000,
    { ...DEFAULT_STRATEGY_CONFIG, marketVenue: 'BINANCE_SPOT', maxLeverage: 4 },
    false,
    Date.now(),
  );
  assert.equal(spotRisk.risk.liquidationPrice, null);
  assert.equal(spotRisk.risk.effectiveLeverage <= 1, true);

  const futRisk = evaluateRiskGuardian(
    price,
    ind,
    'Mở rộng Xu hướng Tăng',
    'LONG',
    82,
    100000,
    { ...DEFAULT_STRATEGY_CONFIG, marketVenue: 'BINANCE_FUTURES', maxLeverage: 5 },
    false,
    Date.now(),
  );
  assert.ok(futRisk.risk.liquidationPrice !== null && futRisk.risk.liquidationPrice < price);
  assert.ok(futRisk.risk.marginRequiredUsd > 0);
  assert.ok(futRisk.risk.confidenceDisclaimer.length > 10);

  // Pending limit margin consuming almost all equity must veto with INSUFFICIENT_MARGIN
  const tightMarginRisk = evaluateRiskGuardian(
    price,
    ind,
    'Mở rộng Xu hướng Tăng',
    'LONG',
    82,
    100000,
    { ...DEFAULT_STRATEGY_CONFIG, marketVenue: 'BINANCE_FUTURES', maxLeverage: 2 },
    false,
    Date.now(),
    undefined,
    undefined,
    'HEALTHY',
    false,
    99500, // pendingOrdersMarginUsd leaves only $500
  );
  assert.equal(tightMarginRisk.risk.approved, false);
  assert.ok(tightMarginRisk.risk.vetoCodes.includes('INSUFFICIENT_MARGIN'));
});

test('Manual trading enforces Risk Guardian: rejects choppy/kill-switch/stale orders WITHOUT deducting fees', () => {
  const choppyCandles = generateRealisticBTCSeries(90, 93000, 777);

  // Choppy range scenario should block manual LONG
  const rejectedChoppy = createManualPosition({
    id: 'TRD-MAN-1',
    side: 'LONG',
    candles: choppyCandles,
    fundingRate: null,
    equity: 100000,
    config: DEFAULT_STRATEGY_CONFIG,
    scenarioHint: 'choppy_range',
  });

  assert.equal(rejectedChoppy.approved, false);
  assert.equal(rejectedChoppy.position, null);
  assert.equal(rejectedChoppy.entryFeeUsd, 0);
  assert.equal(rejectedChoppy.equityAfter, 100000);
  assert.ok(rejectedChoppy.rejectionReason && rejectedChoppy.rejectionReason.length > 5);

  // Even on a strong bull breakout, Kill Switch MUST block manual order without fee loss
  const bullCandles = makeBullBreakoutSeries();
  const killAcc = {
    ...createInitialRiskAccountState(100000),
    emergencyStopActive: true,
  };
  const rejectedKill = createManualPosition({
    id: 'TRD-MAN-2',
    side: 'LONG',
    candles: bullCandles,
    fundingRate: null,
    equity: 100000,
    config: DEFAULT_STRATEGY_CONFIG,
    accountState: killAcc,
  });

  assert.equal(rejectedKill.approved, false);
  assert.equal(rejectedKill.position, null);
  assert.equal(rejectedKill.entryFeeUsd, 0);
  assert.equal(rejectedKill.equityAfter, 100000);
  assert.ok(rejectedKill.vetoCodes.includes('EMERGENCY_STOP'));

  // Stale data must also reject manual order
  const rejectedStale = createManualPosition({
    id: 'TRD-MAN-3',
    side: 'LONG',
    candles: bullCandles,
    fundingRate: null,
    equity: 100000,
    config: DEFAULT_STRATEGY_CONFIG,
    dataQuality: 'STALE',
  });
  assert.equal(rejectedStale.approved, false);
  assert.equal(rejectedStale.entryFeeUsd, 0);
  assert.ok(rejectedStale.vetoCodes.includes('DATA_STALE'));
});

test('Manual trading approves valid bull breakout LONG and enforces BINANCE_SPOT 1x leverage cap', () => {
  const candles = makeBullBreakoutSeries();
  const spotRes = createManualPosition({
    id: 'TRD-MAN-OK',
    side: 'LONG',
    candles,
    fundingRate: null,
    equity: 100000,
    config: { ...DEFAULT_STRATEGY_CONFIG, marketVenue: 'BINANCE_SPOT', maxLeverage: 5, minConsensusScore: 60 },
    scenarioHint: 'bull_breakout',
  });

  assert.equal(spotRes.approved, true);
  assert.ok(spotRes.position !== null);
  assert.ok(spotRes.entryFeeUsd > 0);
  assert.ok(spotRes.equityAfter < 100000);
  assert.ok(spotRes.riskEvaluation.effectiveLeverage <= 1, 'Spot leverage must cap at 1x');
});

test('Conservative OHLC Rule & Gap-Through-SL: same-candle SL + TP1/TP2 triggers STOP_LOSS FIRST, and gap open fills GAP_STOP_LOSS at bar open', () => {
  const baseCandles = makeBullBreakoutSeries();
  const lastTime = baseCandles[baseCandles.length - 1].time;

  // Ambiguous LONG candle touching BOTH Stop Loss (low <= SL) and TP2 (high >= TP2)
  const longPos: Position = {
    id: 'TRD-AMB-L',
    side: 'LONG',
    entryPrice: 92000,
    currentPrice: 92000,
    stopLoss: 91000,
    initialStopLoss: 91000,
    takeProfit1: 93000,
    takeProfit2: 94500,
    liquidationPrice: null,
    marginUsedUsd: 92000,
    sizeBtc: 1.0,
    remainingBtc: 1.0,
    notionalUsd: 92000,
    tp1Hit: false,
    realizedPartialPnl: -36.8,
    feesPaidUsd: 36.8,
    fundingPaidUsd: 0,
    slippagePaidUsd: 0,
    unrealizedPnl: 0,
    unrealizedPnlPct: 0,
    openedAt: lastTime,
    openedCandleTime: lastTime - 900_000,
    consensusScore: 78,
    regime: 'Mở rộng Xu hướng Tăng',
    executionMode: 'SIMULATION',
    venue: 'BINANCE_SPOT',
  };

  const ambiguousCandle: Candle = {
    time: lastTime,
    open: 92000,
    high: 95000, // Touches TP1 and TP2!
    low: 90500,  // Also touches SL!
    close: 93500,
    volume: 1200,
    isClosed: true,
  };

  const longCycle = runPipelineCycle({
    cycleId: 50,
    candles: [...baseCandles.slice(0, -1), ambiguousCandle],
    fundingRate: null,
    equity: 99963.2,
    activePosition: longPos,
    config: DEFAULT_STRATEGY_CONFIG,
  });

  assert.equal(longCycle.nextPosition, null, 'Position must be closed immediately on SL');
  assert.ok(longCycle.closedTrade !== null);
  assert.equal(longCycle.closedTrade.exitReason, 'STOP_LOSS', 'SL MUST beat TP1/TP2 on same candle for LONG');
  assert.equal(longCycle.closedTrade.outcome, 'LOSS');

  // Gap-through-SL candle: opens below LONG SL (89500 < 91000) -> fills at open 89500 with GAP_STOP_LOSS
  const gapCandle: Candle = {
    time: lastTime,
    open: 89500,
    high: 91500,
    low: 89200,
    close: 90000,
    volume: 1600,
    isClosed: true,
  };
  const gapCycle = runPipelineCycle({
    cycleId: 501,
    candles: [...baseCandles.slice(0, -1), gapCandle],
    fundingRate: null,
    equity: 99963.2,
    activePosition: longPos,
    config: DEFAULT_STRATEGY_CONFIG,
    slippageRate: 0.0002,
  });
  assert.equal(gapCycle.nextPosition, null);
  assert.equal(gapCycle.closedTrade?.exitReason, 'GAP_STOP_LOSS');
  assert.ok((gapCycle.closedTrade?.exitPrice ?? 92000) < 89500, 'Gap SL must fill at bar open minus slippage');

  // Ambiguous SHORT candle touching BOTH Stop Loss (high >= SL) and TP2 (low <= TP2)
  const shortPos: Position = {
    ...longPos,
    id: 'TRD-AMB-S',
    side: 'SHORT',
    entryPrice: 92000,
    stopLoss: 93000,
    initialStopLoss: 93000,
    takeProfit1: 91000,
    takeProfit2: 89500,
  };

  const ambiguousShortCandle: Candle = {
    time: lastTime,
    open: 92000,
    high: 93500, // Touches SHORT SL!
    low: 89000,  // Also touches SHORT TP1 & TP2!
    close: 90000,
    volume: 1200,
    isClosed: true,
  };

  const shortCycle = runPipelineCycle({
    cycleId: 51,
    candles: [...baseCandles.slice(0, -1), ambiguousShortCandle],
    fundingRate: null,
    equity: 99963.2,
    activePosition: shortPos,
    config: DEFAULT_STRATEGY_CONFIG,
  });

  assert.equal(shortCycle.nextPosition, null);
  assert.ok(shortCycle.closedTrade !== null);
  assert.equal(shortCycle.closedTrade.exitReason, 'STOP_LOSS', 'SL MUST beat TP1/TP2 on same candle for SHORT');
});

test('Pipeline never self-fills entry candle and never fires TP1 twice or makes remainingBtc negative', () => {
  const candles = makeBullBreakoutSeries();
  const entryCandle = candles[candles.length - 1];

  const openStep = runPipelineCycle({
    cycleId: 1,
    candles,
    fundingRate: 0.0001,
    equity: 100000,
    activePosition: null,
    config: { ...DEFAULT_STRATEGY_CONFIG, minConsensusScore: 62 },
  });

  assert.equal(openStep.cycle.actionTaken, 'OPEN_LONG');
  assert.ok(openStep.nextPosition !== null);
  assert.equal(openStep.nextPosition.openedCandleTime, entryCandle.time);
  assert.ok(openStep.cycle.signals.strategy_architect.direction !== 'UNAVAILABLE');

  // Re-evaluating on the SAME candle time must NOT trigger TP1/SL exit
  const sameBarStep = runPipelineCycle({
    cycleId: 2,
    candles: [
      ...candles.slice(0, -1),
      { ...entryCandle, high: openStep.nextPosition.takeProfit2 + 500, low: openStep.nextPosition.stopLoss - 500 },
    ],
    fundingRate: 0.0001,
    equity: openStep.equityAfter,
    activePosition: openStep.nextPosition,
    config: DEFAULT_STRATEGY_CONFIG,
  });
  assert.ok(sameBarStep.nextPosition !== null, 'Entry candle own wick must not exit newly opened position');
  assert.equal(sameBarStep.nextPosition.tp1Hit, false);

  // Next candle hits TP1 -> partial close 50% + moves SL to breakeven
  const pos = openStep.nextPosition;
  const tp1Candle: Candle = {
    time: entryCandle.time + 900_000,
    open: pos.entryPrice,
    high: pos.takeProfit1 + 40,
    low: pos.entryPrice - 20,
    close: pos.takeProfit1 + 10,
    volume: 640,
    isClosed: true,
  };
  const tp1Step = runPipelineCycle({
    cycleId: 3,
    candles: [...candles, tp1Candle],
    fundingRate: 0.0001,
    equity: openStep.equityAfter,
    activePosition: pos,
    config: DEFAULT_STRATEGY_CONFIG,
  });
  assert.equal(tp1Step.nextPosition?.tp1Hit, true);
  assert.ok((tp1Step.nextPosition?.remainingBtc ?? 0) > 0);
  const remainAfterTp1 = tp1Step.nextPosition!.remainingBtc;

  // Subsequent candle safely above trailed SL and below TP2 must NOT fire TP1 a second time
  const safeMidClose = Number(((pos.takeProfit1 + pos.takeProfit2) / 2).toFixed(2));
  const midCandle: Candle = {
    time: tp1Candle.time + 900_000,
    open: tp1Candle.close,
    high: Math.min(pos.takeProfit2 - 5, safeMidClose + 20),
    low: Math.max(tp1Step.nextPosition!.stopLoss + 10, tp1Candle.close - 20),
    close: safeMidClose,
    volume: 500,
    isClosed: true,
  };
  const midStep = runPipelineCycle({
    cycleId: 4,
    candles: [...candles, tp1Candle, midCandle],
    fundingRate: 0.0001,
    equity: tp1Step.equityAfter,
    activePosition: tp1Step.nextPosition,
    config: DEFAULT_STRATEGY_CONFIG,
  });
  assert.equal(midStep.nextPosition?.remainingBtc, remainAfterTp1, 'TP1 must never fire twice');
});

test('Circuit Breakers: Daily Loss Limit, Max Drawdown, Consecutive Loss Cooldown block entries', () => {
  const candles = makeBullBreakoutSeries();
  const ind = extractIndicators(candles, null, 'bull_breakout');
  const now = Date.now();
  const baseAcc = createInitialRiskAccountState(100000, now);

  const dailyLossAcc = { ...baseAcc, dailyPnlUsd: -3500 }; // -3.5% > 3.0% limit
  const dlRes = evaluateRiskGuardian(
    candles[candles.length - 1].close,
    ind,
    'Mở rộng Xu hướng Tăng',
    'LONG',
    82,
    96500,
    DEFAULT_STRATEGY_CONFIG,
    false,
    now,
    undefined,
    dailyLossAcc,
  );
  assert.equal(dlRes.risk.approved, false);
  assert.ok(dlRes.risk.vetoCodes.includes('DAILY_LOSS_LIMIT'));

  const cooldownAcc = { ...baseAcc, consecutiveLosses: 3, cooldownUntil: now + 600_000 };
  const cdRes = evaluateRiskGuardian(
    candles[candles.length - 1].close,
    ind,
    'Mở rộng Xu hướng Tăng',
    'LONG',
    82,
    98000,
    DEFAULT_STRATEGY_CONFIG,
    false,
    now,
    undefined,
    cooldownAcc,
  );
  assert.equal(cdRes.risk.approved, false);
  assert.ok(cdRes.risk.vetoCodes.includes('CONSECUTIVE_LOSS_COOLDOWN'));

  const ddAcc = { ...baseAcc, peakEquity: 100000, equity: 86000 }; // 14% DD > 12% limit
  const ddRes = evaluateRiskGuardian(
    candles[candles.length - 1].close,
    ind,
    'Mở rộng Xu hướng Tăng',
    'LONG',
    82,
    86000,
    DEFAULT_STRATEGY_CONFIG,
    false,
    now,
    undefined,
    ddAcc,
  );
  assert.equal(ddRes.risk.approved, false);
  assert.ok(ddRes.risk.vetoCodes.includes('MAX_DRAWDOWN_BREAKER'));
});

test('Simulation & Historical Backtest produce 3-way splits, causal EMA21/50 benchmark, V2 equity stats, and zero lookahead', () => {
  const simReport = runSimulationBacktest(DEFAULT_STRATEGY_CONFIG, 300);
  assert.equal(simReport.mode, 'SIMULATED_DATA');
  assert.equal(simReport.isSimulatedData, true);
  assert.ok(simReport.candlesTested >= 300);
  assert.ok(Number.isFinite(simReport.buyAndHoldReturnPct));
  assert.ok(Number.isFinite(simReport.benchmarkEmaReturnPct));
  assert.ok(Number.isFinite(simReport.alphaVsBenchmarkPct));
  assert.ok(Number.isFinite(simReport.stats.sharpeRatio));
  assert.ok(Number.isFinite(simReport.stats.cagrPct));
  assert.ok(Number.isFinite(simReport.stats.calmarRatio));
  assert.ok(Number.isFinite(simReport.stats.recoveryFactor));
  assert.ok(simReport.stats.exposurePct >= 0 && simReport.stats.exposurePct <= 100);
  assert.ok(simReport.stats.maxDrawdownDurationBars >= 0);

  // Build synthetic CSV from deterministic series & test parseHistoricalCsv + 3-way split + Historical Backtest causality
  const series = generateRealisticBTCSeries(320, 82000, 91919);
  const csvHeader = 'timestamp,open,high,low,close,volume\n';
  const csvRows = series
    .map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume}`)
    .join('\n');
  const parsed = parseHistoricalCsv(csvHeader + csvRows);
  assert.equal(parsed.candles.length, 320);

  const histFull = runHistoricalBacktest({
    candles: parsed.candles,
    config: DEFAULT_STRATEGY_CONFIG,
    dataSourceLabel: 'CSV Test',
  });
  assert.equal(histFull.mode, 'HISTORICAL_DATA');
  assert.equal(histFull.isSimulatedData, false);
  assert.ok(
    histFull.inSampleStats !== null &&
      histFull.validationStats !== null &&
      histFull.outOfSampleStats !== null,
    '3-way split (Train/Validation/OOS) must populate on >=180 candles',
  );
  assert.ok(
    histFull.equityCurve.length > 0 && Number.isFinite(histFull.equityCurve[0].benchmarkEquity),
  );

  // Bar equity curve stats consistency
  const directStats = computePerformanceStats(100000, 102000, [], [100000, 102000], {
    barEquitySeries: [100000, 101000, 100200, 99800, 101500, 102000],
    barIntervalMinutes: 15,
    exposureBars: 3,
    totalBars: 5,
  });
  assert.equal(directStats.exposurePct, 60);
  assert.equal(directStats.maxDrawdownDurationBars, 2);
  assert.ok(Number.isFinite(directStats.sharpeRatio));

  // Zero-lookahead causality proof: changing candles AFTER bar 210 must NOT alter equityCurve up to index (210 - warmup)!
  const mutatedTail = parsed.candles.map((c, idx) =>
    idx > 210 ? { ...c, close: c.close * 1.4, high: c.high * 1.4, low: c.low * 1.4 } : c,
  );
  const histMutated = runHistoricalBacktest({
    candles: mutatedTail,
    config: DEFAULT_STRATEGY_CONFIG,
    dataSourceLabel: 'CSV Mutated Tail',
  });

  // Check first 120 bars after warmup match identically despite massive future price change
  for (let i = 0; i < 120; i++) {
    assert.equal(
      histFull.equityCurve[i].equity,
      histMutated.equityCurve[i].equity,
      `Bar ${i} equity must not depend on future candles after bar 210`,
    );
    assert.equal(
      histFull.equityCurve[i].benchmarkEquity,
      histMutated.equityCurve[i].benchmarkEquity,
      `Bar ${i} EMA benchmark must not depend on future candles after bar 210`,
    );
  }
});

test('Manual closePositionAtMarket, normalizeAgentWeights, and formatTradesAsCsv work cleanly', () => {
  const shares = normalizeAgentWeights({
    macro_scout: 0.3,
    quant_analyst: 0.6,
    orderflow_radar: 0.3,
  });
  assert.equal(shares.macro_scout + shares.quant_analyst + shares.orderflow_radar, 100);
  assert.equal(shares.quant_analyst, 50);

  const candles = makeBullBreakoutSeries();
  const manualRes = createManualPosition({
    id: 'TRD-M900',
    side: 'LONG',
    candles,
    fundingRate: null,
    equity: 100000,
    config: { ...DEFAULT_STRATEGY_CONFIG, minConsensusScore: 60 },
    scenarioHint: 'bull_breakout',
  });
  assert.equal(manualRes.approved, true);
  assert.ok(manualRes.position);

  const partialRes = closePositionAtMarket({
    position: manualRes.position,
    exitPrice: manualRes.position.takeProfit1,
    equity: manualRes.equityAfter,
    closeRatio: 0.5,
    useBreakEvenAfterTp1: true,
  });
  assert.ok(partialRes.nextPosition?.tp1Hit);

  const fullRes = closePositionAtMarket({
    position: partialRes.nextPosition!,
    exitPrice: manualRes.position.takeProfit2,
    equity: partialRes.equityAfter,
    closeRatio: 1,
  });
  assert.equal(fullRes.nextPosition, null);
  assert.ok(fullRes.closedTrade);

  const csv = formatTradesAsCsv([fullRes.closedTrade]);
  assert.ok(csv.includes('TRD-M900'));
});
