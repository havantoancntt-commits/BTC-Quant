import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeATR,
  computeEMA,
  computeRSI,
  extractIndicators,
  generateRealisticBTCSeries,
} from './indicators';
import {
  closePositionAtMarket,
  createManualPosition,
  DEFAULT_STRATEGY_CONFIG,
  evaluateRiskGuardian,
  formatTradesAsCsv,
  normalizeAgentWeights,
  runDeterministicBacktest,
  runPipelineCycle,
} from './multiAgentEngine';
import type { Candle } from './types';

test('EMA and RSI calculate valid bounded indicators on rising series', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 90000 + i * 180);
  const ema9 = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);
  const rsi = computeRSI(closes, 14);

  assert.ok(ema9 > ema21, 'Fast EMA9 must lead EMA21 in an uptrend');
  assert.ok(rsi > 70 && rsi <= 100, `RSI on monotonic uptrend should be > 70, got ${rsi}`);
});

test('ATR computes positive volatility range', () => {
  const candles = generateRealisticBTCSeries(60, 92000, 12345);
  const atr = computeATR(candles, 14);
  assert.ok(atr > 50, `ATR should be positive and realistic for BTC, got ${atr}`);
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

test('Pipeline opens LONG on strong bullish breakout and hits TP1 break-even then TP2', () => {
  const base = generateRealisticBTCSeries(80, 90000, 999);
  // Append 5 strong bullish expansion candles
  const lastClose = base[base.length - 1].close;
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
    });
  }

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
  assert.ok(openStep.nextPosition.entryPrice > lastClose);
  assert.ok(openStep.nextPosition.stopLoss < openStep.nextPosition.entryPrice);
  assert.ok(openStep.nextPosition.takeProfit1 > openStep.nextPosition.entryPrice);
  assert.ok(openStep.nextPosition.takeProfit2 > openStep.nextPosition.takeProfit1);

  // Feed a candle that hits TP1 and pushes SL to break-even
  const pos = openStep.nextPosition;
  const tp1Candle: Candle = {
    time: candles[candles.length - 1].time + 15 * 60 * 1000,
    open: pos.entryPrice,
    high: pos.takeProfit1 + 40,
    low: pos.entryPrice - 20,
    close: pos.takeProfit1 + 10,
    volume: 640,
  };

  const tp1Step = runPipelineCycle({
    cycleId: 2,
    candles: [...candles, tp1Candle],
    fundingRate: 0.0001,
    equity: openStep.equityAfter,
    activePosition: pos,
    config: DEFAULT_STRATEGY_CONFIG,
  });

  assert.ok(tp1Step.nextPosition !== null);
  assert.equal(tp1Step.nextPosition.tp1Hit, true);
  assert.ok(
    tp1Step.nextPosition.stopLoss >= pos.entryPrice,
    'After TP1, SL must move to break-even or better',
  );
  assert.ok(tp1Step.equityAfter > 100000, 'Partial TP1 profit must increase equity');

  // Feed a candle that hits TP2
  const tp2Candle: Candle = {
    time: tp1Candle.time + 15 * 60 * 1000,
    open: tp1Candle.close,
    high: pos.takeProfit2 + 50,
    low: tp1Candle.close - 10,
    close: pos.takeProfit2 + 20,
    volume: 710,
  };

  const tp2Step = runPipelineCycle({
    cycleId: 3,
    candles: [...candles, tp1Candle, tp2Candle],
    fundingRate: 0.0001,
    equity: tp1Step.equityAfter,
    activePosition: tp1Step.nextPosition,
    config: DEFAULT_STRATEGY_CONFIG,
  });

  assert.equal(tp2Step.nextPosition, null);
  assert.ok(tp2Step.closedTrade !== null);
  assert.equal(tp2Step.closedTrade.outcome, 'WIN');
  assert.equal(tp2Step.closedTrade.exitReason, 'TP2_TARGET');
});

test('Deterministic backtest runs cleanly and enforces Risk Guardian veto filtering', () => {
  const report = runDeterministicBacktest(DEFAULT_STRATEGY_CONFIG, 360);
  assert.equal(report.candlesTested, 360);
  assert.ok(report.equityCurve.length === 360);
  assert.ok(report.vetoedSetups > 0, 'Risk Guardian should actively veto low-quality setups');
  assert.ok(report.stats.totalTrades >= 2, 'Backtest should execute trades over 360 candles');
  assert.ok(report.stats.maxDrawdownPct < 20, 'Drawdown must stay controlled');
});

test('extractIndicators honors live depth20 orderbookImbalance in auto_live mode', () => {
  const candles = generateRealisticBTCSeries(60, 65000, 4242);
  const indLiveBid = extractIndicators(candles, 0.0001, 'auto_live', 0.4321);
  assert.equal(indLiveBid.orderbookImbalance, 0.4321);

  const indLiveAsk = extractIndicators(candles, 0.0001, 'auto_live', -0.6543);
  assert.equal(indLiveAsk.orderbookImbalance, -0.6543);
});

test('Manual Buy/Sell creation and partial/full market close update PnL and SL cleanly', () => {
  const candles = generateRealisticBTCSeries(90, 65000, 5151);
  const longPos = createManualPosition({
    id: 'TRD-M001',
    side: 'LONG',
    candles,
    fundingRate: 0.0001,
    equity: 100000,
    config: DEFAULT_STRATEGY_CONFIG,
  });

  assert.equal(longPos.side, 'LONG');
  assert.ok(longPos.stopLoss < longPos.entryPrice);
  assert.ok(longPos.takeProfit1 > longPos.entryPrice);
  assert.ok(longPos.takeProfit2 > longPos.takeProfit1);
  assert.ok(longPos.sizeBtc > 0);

  // Partial 50% close in profit moves SL to break-even
  const partialRes = closePositionAtMarket({
    position: longPos,
    exitPrice: longPos.takeProfit1,
    equity: 100000,
    closeRatio: 0.5,
    useBreakEvenAfterTp1: true,
  });

  assert.ok(partialRes.nextPosition !== null);
  assert.equal(partialRes.closedTrade, null);
  assert.equal(partialRes.nextPosition.tp1Hit, true);
  assert.ok(partialRes.nextPosition.stopLoss >= longPos.entryPrice);
  assert.ok(partialRes.equityAfter > 100000);

  // Full close realizes remaining PnL as MANUAL_CLOSE
  const fullRes = closePositionAtMarket({
    position: partialRes.nextPosition,
    exitPrice: longPos.takeProfit2,
    equity: partialRes.equityAfter,
    closeRatio: 1,
  });

  assert.equal(fullRes.nextPosition, null);
  assert.ok(fullRes.closedTrade !== null);
  assert.equal(fullRes.closedTrade.exitReason, 'MANUAL_CLOSE');
  assert.equal(fullRes.closedTrade.outcome, 'WIN');
  assert.ok(fullRes.equityAfter > partialRes.equityAfter);
});

test('normalizeAgentWeights sums to 100 and formatTradesAsCsv outputs valid CSV rows', () => {
  const shares = normalizeAgentWeights({
    macro_scout: 0.3,
    quant_analyst: 0.6,
    orderflow_radar: 0.3,
  });
  assert.equal(shares.macro_scout + shares.quant_analyst + shares.orderflow_radar, 100);
  assert.equal(shares.quant_analyst, 50);

  const report = runDeterministicBacktest(DEFAULT_STRATEGY_CONFIG, 120);
  const csv = formatTradesAsCsv(report.trades);
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].startsWith('ID,Side,EntryPrice'));
  assert.equal(lines.length, report.trades.length + 1);
});

test('extractIndicators normalizes live in-progress M15 candle volume by elapsed bar time', () => {
  const candles = generateRealisticBTCSeries(60, 80000, 3131);
  const last = candles[candles.length - 1];
  const avgVol =
    candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;

  // Simulate an active live candle only 3.75 minutes into its 15m window (25% elapsed)
  const earlyNow = last.time + 3.75 * 60 * 1000;
  const earlyCandle: Candle = {
    ...last,
    volume: Number((avgVol * 0.45).toFixed(2)),
  };
  const liveSeries = [...candles.slice(0, -1), earlyCandle];
  const ind = extractIndicators(liveSeries, 0.0001, 'auto_live', 0.25, undefined, earlyNow);

  // Normalized volume should scale ~4x (0.45 / 0.25 = 1.8x average) instead of looking muted (0.45x)
  assert.ok(
    ind.volumeRatio >= 1.65 && ind.volumeRatio <= 2.0,
    `Expected time-normalized volumeRatio ~1.8, got ${ind.volumeRatio}`,
  );
});

test('Adversarial Agent Debate challenges and VETOes liquidity trap despite bullish momentum', () => {
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
    });
  }

  // Case A: Opposing H4 downtrend + heavy Ask sell wall (-0.48) => Debate must penalize & VETO
  const trappedStep = runPipelineCycle({
    cycleId: 10,
    candles,
    fundingRate: 0.0001,
    equity: 100000,
    activePosition: null,
    config: DEFAULT_STRATEGY_CONFIG,
    scenarioHint: 'auto_live',
    liveOrderbookImbalance: -0.48,
    htfContext: {
      h1Bias: 'SHORT',
      h4Bias: 'SHORT',
      h1Rsi: 41,
      h1Ema50: candles[candles.length - 1].close + 900,
    },
  });

  assert.ok(trappedStep.cycle.debate.challengesCount >= 2);
  assert.ok(trappedStep.cycle.debate.postDebateScore < trappedStep.cycle.preDebateScore);
  assert.equal(trappedStep.cycle.risk.approved, false);
  assert.equal(trappedStep.cycle.actionTaken, 'VETO_SKIP');

  // Case B: Aligned H1/H4 uptrend + Bid support wall (+0.45) => Debate confirms & executes LONG
  const alignedStep = runPipelineCycle({
    cycleId: 11,
    candles,
    fundingRate: 0.0001,
    equity: 100000,
    activePosition: null,
    config: { ...DEFAULT_STRATEGY_CONFIG, minConsensusScore: 65 },
    scenarioHint: 'auto_live',
    liveOrderbookImbalance: 0.45,
    htfContext: {
      h1Bias: 'LONG',
      h4Bias: 'LONG',
      h1Rsi: 62,
      h1Ema50: candles[candles.length - 1].close - 1200,
    },
  });

  assert.ok(alignedStep.cycle.debate.postDebateScore >= alignedStep.cycle.preDebateScore);
  assert.equal(alignedStep.cycle.risk.approved, true);
  assert.equal(alignedStep.cycle.actionTaken, 'OPEN_LONG');
});


