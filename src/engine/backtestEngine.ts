import { computeEMASeries, generateRealisticBTCSeries, sanitizeCandles } from './indicators';
import {
  computePerformanceStats,
  createInitialRiskAccountState,
  DEFAULT_SLIPPAGE_RATE,
  runPipelineCycle,
  TAKER_FEE_RATE,
} from './multiAgentEngine';
import type {
  BacktestReport,
  Candle,
  ClosedTrade,
  MarketRegime,
  PerformanceStats,
  Position,
  RegimeBreakdownRow,
  SensitivityPoint,
  SideBreakdownRow,
  StrategyConfig,
  WalkForwardSplit,
} from './types';

export interface CsvParseResult {
  candles: Candle[];
  warnings: string[];
  rowsParsed: number;
  rowsSkipped: number;
}

function parseTimestampMs(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return NaN;
  const num = Number(trimmed);
  if (Number.isFinite(num) && num > 0) {
    // Distinguish seconds (< 1e11) vs milliseconds vs microseconds
    if (num > 1e14) return Math.floor(num / 1000);
    if (num < 1e11) return Math.floor(num * 1000);
    return Math.floor(num);
  }
  const parsedDate = Date.parse(trimmed);
  return Number.isFinite(parsedDate) ? parsedDate : NaN;
}

export function inferBarIntervalMinutes(candles: Candle[]): number {
  if (candles.length < 2) return 15;
  const deltas: number[] = [];
  for (let i = 1; i < Math.min(candles.length, 40); i++) {
    const d = candles[i].time - candles[i - 1].time;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 15;
  deltas.sort((a, b) => a - b);
  const medianMs = deltas[Math.floor(deltas.length / 2)];
  return Math.max(1, Math.round(medianMs / 60000));
}

export function parseHistoricalCsv(csvText: string): CsvParseResult {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { candles: [], warnings: ['Tệp CSV trống.'], rowsParsed: 0, rowsSkipped: 0 };
  }

  const firstCols = lines[0].split(',').map((c) => c.trim().toLowerCase().replace(/^"|"$/g, ''));
  const hasHeader = firstCols.some((c) =>
    ['open', 'high', 'low', 'close', 'time', 'timestamp', 'date', 'open_time'].includes(c),
  );

  let idxTime = 0;
  let idxOpen = 1;
  let idxHigh = 2;
  let idxLow = 3;
  let idxClose = 4;
  let idxVol = 5;

  if (hasHeader) {
    const findCol = (names: string[], fallback: number) => {
      const idx = firstCols.findIndex((c) => names.some((n) => c === n || c.includes(n)));
      return idx >= 0 ? idx : fallback;
    };
    idxTime = findCol(['timestamp', 'open_time', 'time', 'date'], 0);
    idxOpen = findCol(['open'], 1);
    idxHigh = findCol(['high'], 2);
    idxLow = findCol(['low'], 3);
    idxClose = findCol(['close'], 4);
    idxVol = findCol(['volume', 'vol'], 5);
  }

  const startRow = hasHeader ? 1 : 0;
  const rawCandles: Candle[] = [];
  let rowsSkipped = 0;

  for (let i = startRow; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cols.length < 5) {
      rowsSkipped++;
      continue;
    }
    const time = parseTimestampMs(cols[idxTime] ?? '');
    const open = Number(cols[idxOpen]);
    const high = Number(cols[idxHigh]);
    const low = Number(cols[idxLow]);
    const close = Number(cols[idxClose]);
    const volume = cols[idxVol] !== undefined ? Number(cols[idxVol]) : 0;

    if (
      !Number.isFinite(time) ||
      time <= 0 ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      open <= 0 ||
      close <= 0
    ) {
      rowsSkipped++;
      continue;
    }

    rawCandles.push({
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
      isClosed: true,
    });
  }

  const sanitized = sanitizeCandles(rawCandles);
  const warnings: string[] = [];
  if (rowsSkipped > 0) warnings.push(`Bỏ qua ${rowsSkipped} dòng không hợp lệ.`);
  if (sanitized.duplicatesRemoved > 0) {
    warnings.push(`Loại bỏ ${sanitized.duplicatesRemoved} nến trùng timestamp.`);
  }
  if (sanitized.gapsDetected > 0) {
    warnings.push(`Phát hiện ${sanitized.gapsDetected} khoảng trống dữ liệu thời gian.`);
  }

  return {
    candles: sanitized.candles,
    warnings,
    rowsParsed: sanitized.candles.length,
    rowsSkipped: rowsSkipped + sanitized.invalidRemoved,
  };
}

function runCoreSimulationLoop(
  candles: Candle[],
  config: StrategyConfig,
  fundingRate: number,
  slippageRate = DEFAULT_SLIPPAGE_RATE,
  warmupBars = 60,
): {
  stats: PerformanceStats;
  trades: ClosedTrade[];
  equityCurve: Array<{
    time: number;
    equity: number;
    price: number;
    buyHoldEquity: number;
    benchmarkEquity: number;
  }>;
  vetoedSetups: number;
  buyAndHoldReturnPct: number;
  benchmarkEmaReturnPct: number;
  barIntervalMinutes: number;
} {
  const barIntervalMinutes = inferBarIntervalMinutes(candles);
  if (candles.length <= warmupBars + 2) {
    const emptyStats = computePerformanceStats(config.initialCapital, config.initialCapital, [], [
      config.initialCapital,
    ]);
    return {
      stats: emptyStats,
      trades: [],
      equityCurve: [],
      vetoedSetups: 0,
      buyAndHoldReturnPct: 0,
      benchmarkEmaReturnPct: 0,
      barIntervalMinutes,
    };
  }

  let equity = config.initialCapital;
  let activePosition: Position | null = null;
  let accountState = createInitialRiskAccountState(config.initialCapital, candles[warmupBars].time);
  const trades: ClosedTrade[] = [];
  const equityHistory: number[] = [equity];
  const barEquitySeries: number[] = [equity];
  const equityCurve: Array<{
    time: number;
    equity: number;
    price: number;
    buyHoldEquity: number;
    benchmarkEquity: number;
  }> = [];
  let vetoedSetups = 0;
  let exposureBars = 0;

  // Causal Simple Strategy Benchmark: EMA21/EMA50 1x Long/Flat with identical fee + slippage
  const closes = candles.map((c) => c.close);
  const ema21Series = computeEMASeries(closes, 21);
  const ema50Series = computeEMASeries(closes, 50);
  let benchCash = config.initialCapital;
  let benchBtc = 0;
  const benchStartPrice = candles[warmupBars].close;

  for (let i = warmupBars; i < candles.length; i++) {
    // Strictly causal sliding window: only past bars up to closed bar i (never future i+1!)
    const windowStart = Math.max(0, i - 220);
    const causalWindow = candles.slice(windowStart, i + 1);
    const barTime = candles[i].time;
    const barPrice = candles[i].close;

    const res = runPipelineCycle({
      cycleId: i - warmupBars + 1,
      candles: causalWindow,
      fundingRate: config.marketVenue === 'BINANCE_FUTURES' ? fundingRate : null,
      equity,
      activePosition,
      config: { ...config, autoExecute: true },
      scenarioHint: 'auto_live',
      accountState,
      dataQuality: 'HEALTHY',
      slippageRate,
      now: barTime,
    });

    equity = res.equityAfter;
    activePosition = res.nextPosition;
    if (res.nextAccountState) {
      accountState = res.nextAccountState;
    }
    if (res.closedTrade) {
      trades.push(res.closedTrade);
      equityHistory.push(equity);
    }
    if (res.cycle.actionTaken === 'VETO_SKIP') {
      vetoedSetups++;
    }
    if (activePosition) {
      exposureBars++;
    }

    // Update EMA21/EMA50 Crossover Benchmark strictly causally at bar close i
    const bullishCross = ema21Series[i] > ema50Series[i] && barPrice > ema21Series[i];
    if (bullishCross && benchBtc === 0 && benchCash > 10) {
      const execBuy = barPrice * (1 + slippageRate);
      benchBtc = (benchCash * (1 - TAKER_FEE_RATE)) / execBuy;
      benchCash = 0;
    } else if (!bullishCross && benchBtc > 0) {
      const execSell = barPrice * (1 - slippageRate);
      benchCash = benchBtc * execSell * (1 - TAKER_FEE_RATE);
      benchBtc = 0;
    }
    const benchmarkEquity = benchBtc > 0 ? benchBtc * barPrice : benchCash;

    const markToMarket = equity + (activePosition ? activePosition.unrealizedPnl : 0);
    barEquitySeries.push(markToMarket);
    const buyHoldEquity =
      benchStartPrice > 0
        ? config.initialCapital * (barPrice / benchStartPrice)
        : config.initialCapital;

    equityCurve.push({
      time: barTime,
      equity: Number(markToMarket.toFixed(2)),
      price: barPrice,
      buyHoldEquity: Number(buyHoldEquity.toFixed(2)),
      benchmarkEquity: Number(benchmarkEquity.toFixed(2)),
    });
  }

  const endPrice = candles[candles.length - 1].close;
  const buyAndHoldReturnPct =
    benchStartPrice > 0 ? Number((((endPrice - benchStartPrice) / benchStartPrice) * 100).toFixed(2)) : 0;
  const endBenchmarkEquity = benchBtc > 0 ? benchBtc * endPrice : benchCash;
  const benchmarkEmaReturnPct =
    config.initialCapital > 0
      ? Number((((endBenchmarkEquity - config.initialCapital) / config.initialCapital) * 100).toFixed(2))
      : 0;

  const markEnd = equity + (activePosition ? activePosition.unrealizedPnl : 0);
  const totalBars = Math.max(0, candles.length - warmupBars);
  const stats = computePerformanceStats(config.initialCapital, markEnd, trades, equityHistory, {
    barEquitySeries,
    barIntervalMinutes,
    exposureBars,
    totalBars,
  });

  return {
    stats,
    trades,
    equityCurve,
    vetoedSetups,
    buyAndHoldReturnPct,
    benchmarkEmaReturnPct,
    barIntervalMinutes,
  };
}

function buildSideBreakdown(trades: ClosedTrade[], side: 'LONG' | 'SHORT'): SideBreakdownRow {
  const subset = trades.filter((t) => t.side === side);
  const wins = subset.filter((t) => t.outcome === 'WIN').length;
  const losses = subset.filter((t) => t.outcome === 'LOSS').length;
  const decided = wins + losses;
  const netPnlUsd = subset.reduce((acc, t) => acc + t.pnlUsd, 0);
  const avgR = subset.length > 0 ? subset.reduce((acc, t) => acc + t.rMultiple, 0) / subset.length : 0;

  return {
    side,
    trades: subset.length,
    wins,
    winRatePct: decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : 0,
    netPnlUsd: Number(netPnlUsd.toFixed(2)),
    avgR: Number(avgR.toFixed(2)),
  };
}

function buildRegimeBreakdown(trades: ClosedTrade[]): RegimeBreakdownRow[] {
  const byRegime = new Map<MarketRegime, ClosedTrade[]>();
  for (const t of trades) {
    const arr = byRegime.get(t.regime) ?? [];
    arr.push(t);
    byRegime.set(t.regime, arr);
  }
  return Array.from(byRegime.entries()).map(([regime, list]) => {
    const wins = list.filter((t) => t.outcome === 'WIN').length;
    const losses = list.filter((t) => t.outcome === 'LOSS').length;
    const decided = wins + losses;
    const netPnlUsd = list.reduce((a, b) => a + b.pnlUsd, 0);
    const avgR = list.length > 0 ? list.reduce((a, b) => a + b.rMultiple, 0) / list.length : 0;
    return {
      regime,
      trades: list.length,
      wins,
      losses,
      winRatePct: decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : 0,
      netPnlUsd: Number(netPnlUsd.toFixed(2)),
      avgR: Number(avgR.toFixed(2)),
    };
  });
}

function evaluateBacktestFromSeries(params: {
  candles: Candle[];
  config: StrategyConfig;
  mode: 'SIMULATED_DATA' | 'HISTORICAL_DATA';
  dataSourceLabel: string;
  fundingRate: number;
  slippageRate?: number;
  runWalkForward?: boolean;
  runSensitivity?: boolean;
}): BacktestReport {
  const {
    candles,
    config,
    mode,
    dataSourceLabel,
    fundingRate,
    slippageRate = DEFAULT_SLIPPAGE_RATE,
    runWalkForward = true,
    runSensitivity = true,
  } = params;

  const sanitized = sanitizeCandles(candles);
  const clean = sanitized.candles;
  const warnings: string[] = [];

  if (sanitized.invalidRemoved > 0) {
    warnings.push(`Đã lọc bỏ ${sanitized.invalidRemoved} nến lỗi.`);
  }
  if (sanitized.duplicatesRemoved > 0) {
    warnings.push(`Đã loại bỏ ${sanitized.duplicatesRemoved} nến trùng timestamp.`);
  }
  if (sanitized.gapsDetected > 0) {
    warnings.push(`Phát hiện ${sanitized.gapsDetected} khoảng trống dữ liệu trong chuỗi lịch sử.`);
  }
  if (clean.length < 150) {
    warnings.push(`Số lượng nến (${clean.length}) còn ít để đánh giá thống kê sâu (khuyến nghị >= 300 nến).`);
  }

  const warmup = Math.min(60, Math.max(20, Math.floor(clean.length * 0.15)));
  const main = runCoreSimulationLoop(clean, config, fundingRate, slippageRate, warmup);

  // 3-way Split: Train (50%) / Validation (25%) / Out-of-Sample (25%) + Walk-Forward windows
  let inSampleStats: PerformanceStats | null = null;
  let validationStats: PerformanceStats | null = null;
  let outOfSampleStats: PerformanceStats | null = null;
  const walkForwardWindows: WalkForwardSplit[] = [];

  if (runWalkForward && clean.length >= 180) {
    const trainEnd = Math.floor(clean.length * 0.5);
    const valEnd = Math.floor(clean.length * 0.75);
    if (
      trainEnd > warmup + 15 &&
      valEnd - trainEnd >= 25 &&
      clean.length - valEnd >= 25
    ) {
      const trainRun = runCoreSimulationLoop(
        clean.slice(0, trainEnd),
        config,
        fundingRate,
        slippageRate,
        warmup,
      );
      const valRun = runCoreSimulationLoop(
        clean.slice(Math.max(0, trainEnd - warmup), valEnd),
        config,
        fundingRate,
        slippageRate,
        warmup,
      );
      const oosRun = runCoreSimulationLoop(
        clean.slice(Math.max(0, valEnd - warmup)),
        config,
        fundingRate,
        slippageRate,
        warmup,
      );
      inSampleStats = trainRun.stats;
      validationStats = valRun.stats;
      outOfSampleStats = oosRun.stats;

      // 3 Walk-Forward rolling chunks
      const third = Math.floor(clean.length / 3);
      for (let w = 0; w < 3; w++) {
        const wStart = Math.max(0, w * third - (w > 0 ? warmup : 0));
        const wEnd = w === 2 ? clean.length : (w + 1) * third;
        const slice = clean.slice(wStart, wEnd);
        if (slice.length > warmup + 15) {
          const wfRes = runCoreSimulationLoop(slice, config, fundingRate, slippageRate, warmup);
          walkForwardWindows.push({
            label: `Cửa sổ WF #${w + 1}`,
            candlesCount: slice.length - warmup,
            stats: wfRes.stats,
          });
        }
      }
    }
  }

  // Honest Overfitting Diagnostic
  let overfittingRisk: BacktestReport['overfittingRisk'] = 'INSUFFICIENT_SAMPLE';
  let overfittingNotes =
    'Chưa đủ mẫu lệnh (< 6 lệnh hoặc < 180 nến) để đánh giá mức độ overfitting.';

  if (inSampleStats && outOfSampleStats && main.stats.totalTrades >= 6) {
    if (outOfSampleStats.totalTrades < 2) {
      overfittingRisk = 'INSUFFICIENT_SAMPLE';
      overfittingNotes = 'Tập Out-of-Sample phát sinh quá ít lệnh (< 2) để kết luận độ bền.';
    } else if (inSampleStats.netProfitUsd > 0 && outOfSampleStats.netProfitUsd < 0) {
      overfittingRisk = 'HIGH';
      overfittingNotes =
        'Cảnh báo: Chiến lược có lãi trên Train nhưng âm trên Out-of-Sample — dấu hiệu overfitting hoặc nhạy regime.';
    } else if (
      Math.abs(inSampleStats.winRatePct - outOfSampleStats.winRatePct) > 22 ||
      outOfSampleStats.expectancyR < 0
    ) {
      overfittingRisk = 'MODERATE';
      overfittingNotes =
        'Hiệu suất phân kỳ đáng kể giữa Train và Out-of-Sample; cần kiểm tra thêm trên chuỗi dài hơn.';
    } else {
      overfittingRisk = 'LOW';
      overfittingNotes =
        'Kỳ vọng Out-of-Sample giữ được tính nhất quán với Train/Validation; tuy nhiên vẫn cần forward paper trading.';
    }
  }

  // Parameter sensitivity grid (neighboring consensus thresholds)
  const sensitivityGrid: SensitivityPoint[] = [];
  if (runSensitivity && clean.length >= warmup + 30) {
    const offsets = [-6, 0, 6];
    for (const delta of offsets) {
      const testScore = Math.max(54, Math.min(88, config.minConsensusScore + delta));
      const testCfg = { ...config, minConsensusScore: testScore };
      const res = runCoreSimulationLoop(clean, testCfg, fundingRate, slippageRate, warmup);
      sensitivityGrid.push({
        minConsensusScore: testScore,
        riskPerTradePct: testCfg.riskPerTradePct,
        totalTrades: res.stats.totalTrades,
        winRatePct: res.stats.winRatePct,
        netProfitUsd: res.stats.netProfitUsd,
        profitFactor: res.stats.profitFactor,
        maxDrawdownPct: res.stats.maxDrawdownPct,
      });
    }
  }

  const alphaVsBuyAndHoldPct = Number(
    (main.stats.totalPnlPct - main.buyAndHoldReturnPct).toFixed(2),
  );
  const alphaVsBenchmarkPct = Number(
    (main.stats.totalPnlPct - main.benchmarkEmaReturnPct).toFixed(2),
  );

  return {
    mode,
    dataSourceLabel,
    isSimulatedData: mode === 'SIMULATED_DATA',
    candlesTested: Math.max(0, clean.length - warmup),
    barIntervalMinutes: main.barIntervalMinutes,
    dateRange:
      clean.length > warmup
        ? { startTime: clean[warmup].time, endTime: clean[clean.length - 1].time }
        : null,
    validationWarnings: warnings,
    duplicatesRemoved: sanitized.duplicatesRemoved,
    gapsDetected: sanitized.gapsDetected,
    stats: main.stats,
    buyAndHoldReturnPct: main.buyAndHoldReturnPct,
    benchmarkEmaReturnPct: main.benchmarkEmaReturnPct,
    alphaVsBuyAndHoldPct,
    alphaVsBenchmarkPct,
    longBreakdown: buildSideBreakdown(main.trades, 'LONG'),
    shortBreakdown: buildSideBreakdown(main.trades, 'SHORT'),
    regimeBreakdown: buildRegimeBreakdown(main.trades),
    inSampleStats,
    validationStats,
    outOfSampleStats,
    walkForwardWindows,
    overfittingRisk,
    overfittingNotes,
    sensitivityGrid,
    equityCurve: main.equityCurve,
    trades: main.trades.slice().reverse(),
    vetoedSetups: main.vetoedSetups,
  };
}

/**
 * Mode A: Simulated Data Backtest (DEMO / Logic Verification ONLY — clearly flagged SIMULATED_DATA).
 */
export function runSimulationBacktest(
  config: StrategyConfig,
  candleCount = 360,
): BacktestReport {
  const series = generateRealisticBTCSeries(candleCount + 60, 88400, 20260915);
  return evaluateBacktestFromSeries({
    candles: series,
    config,
    mode: 'SIMULATED_DATA',
    dataSourceLabel: 'SIMULATED DATA · Chuỗi tổng hợp kiểm thử logic',
    fundingRate: 0.00012,
    slippageRate: DEFAULT_SLIPPAGE_RATE,
  });
}

// Preserve backwards-compatible export name pointing strictly to Mode A Simulation
export const runDeterministicBacktest = runSimulationBacktest;

/**
 * Mode B: Real Historical Data Backtest (CSV or Exchange API Klines).
 */
export function runHistoricalBacktest(params: {
  candles: Candle[];
  config: StrategyConfig;
  dataSourceLabel: string;
  fundingRate?: number;
  slippageRate?: number;
}): BacktestReport {
  return evaluateBacktestFromSeries({
    candles: params.candles,
    config: params.config,
    mode: 'HISTORICAL_DATA',
    dataSourceLabel: params.dataSourceLabel,
    fundingRate: params.fundingRate ?? 0.0001,
    slippageRate: params.slippageRate ?? DEFAULT_SLIPPAGE_RATE,
  });
}
