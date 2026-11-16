import { extractIndicators } from './indicators';
import {
  createInitialRiskAccountState,
  DEFAULT_SLIPPAGE_RATE,
  evaluateInstitutionalRisk,
  rolloverRiskPeriods,
  TAKER_FEE_RATE,
  updateRiskAccountOnTradeClose,
} from './riskManager';
import type {
  AgentDebateSummary,
  AgentId,
  AgentSignal,
  Candle,
  ClosedTrade,
  DebateChallenge,
  FeedHealthStatus,
  HtfContext,
  ManualOrderResult,
  MarketRegime,
  MarketScenario,
  PerformanceStats,
  PipelineCycle,
  Position,
  RegimeClassification,
  RiskAccountState,
  RiskEvaluation,
  StrategyConfig,
  TechnicalIndicators,
  VoteDirection,
} from './types';

export {
  TAKER_FEE_RATE,
  DEFAULT_SLIPPAGE_RATE,
  createInitialRiskAccountState,
  updateRiskAccountOnTradeClose,
};

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  initialCapital: 100000,
  sizingMethod: 'FIXED_FRACTIONAL',
  riskPerTradePct: 1.25,
  maxLeverage: 3,
  maxDailyLossPct: 3.0,
  maxWeeklyLossPct: 6.0,
  maxDrawdownPct: 12.0,
  maxConsecutiveLosses: 3,
  cooldownMinutesAfterLoss: 30,
  maxSpreadBps: 15,
  minConsensusScore: 70,
  minRewardRisk: 2.0,
  autoExecute: true,
  useBreakEvenAfterTp1: true,
  vetoChoppyMarket: true,
  requireClosedCandle: true,
  marketVenue: 'BINANCE_SPOT',
  executionMode: 'SIMULATION',
  agentWeights: {
    macro_scout: 0.25,
    quant_analyst: 0.45,
    orderflow_radar: 0.3,
  },
};

export interface StrategyPreset {
  id: 'conservative' | 'balanced' | 'aggressive';
  name: string;
  subtitle: string;
  config: Partial<StrategyConfig>;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'conservative',
    name: 'Bảo toàn Quỹ',
    subtitle: 'Rủi ro 0.75% · Đồng thuận ≥ 78 · R:R 1:2.4',
    config: {
      sizingMethod: 'FIXED_FRACTIONAL',
      riskPerTradePct: 0.75,
      maxLeverage: 2,
      minConsensusScore: 78,
      minRewardRisk: 2.4,
      maxDailyLossPct: 2.0,
      maxDrawdownPct: 8.0,
      useBreakEvenAfterTp1: true,
      vetoChoppyMarket: true,
    },
  },
  {
    id: 'balanced',
    name: 'Cân bằng Chuẩn Quỹ',
    subtitle: 'Rủi ro 1.25% · Đồng thuận ≥ 70 · R:R 1:2.0',
    config: {
      sizingMethod: 'FIXED_FRACTIONAL',
      riskPerTradePct: 1.25,
      maxLeverage: 3,
      minConsensusScore: 70,
      minRewardRisk: 2.0,
      maxDailyLossPct: 3.0,
      maxDrawdownPct: 12.0,
      useBreakEvenAfterTp1: true,
      vetoChoppyMarket: true,
    },
  },
  {
    id: 'aggressive',
    name: 'Săn Xu hướng Chủ động',
    subtitle: 'Rủi ro 2.0% · Đồng thuận ≥ 64 · Đòn bẩy 4x',
    config: {
      sizingMethod: 'HALF_KELLY',
      riskPerTradePct: 2.0,
      maxLeverage: 4,
      minConsensusScore: 64,
      minRewardRisk: 1.8,
      maxDailyLossPct: 4.5,
      maxDrawdownPct: 15.0,
      useBreakEvenAfterTp1: true,
      vetoChoppyMarket: true,
    },
  },
];

export function normalizeAgentWeights(weights: StrategyConfig['agentWeights']): {
  macro_scout: number;
  quant_analyst: number;
  orderflow_radar: number;
} {
  const sum = weights.macro_scout + weights.quant_analyst + weights.orderflow_radar;
  if (sum <= 0 || !Number.isFinite(sum)) {
    return { macro_scout: 33, quant_analyst: 34, orderflow_radar: 33 };
  }
  const macro = Math.round((weights.macro_scout / sum) * 100);
  const quant = Math.round((weights.quant_analyst / sum) * 100);
  const orderflow = Math.max(0, 100 - macro - quant);
  return {
    macro_scout: macro,
    quant_analyst: quant,
    orderflow_radar: orderflow,
  };
}

export function formatTradesAsCsv(trades: ClosedTrade[]): string {
  const header = [
    'ID',
    'Side',
    'EntryPrice',
    'ExitPrice',
    'SizeBTC',
    'GrossPnL_USD',
    'NetPnL_USD',
    'Fees_USD',
    'Funding_USD',
    'Slippage_USD',
    'PnL_Pct',
    'RMultiple',
    'HoldMinutes',
    'Outcome',
    'ExitReason',
    'Consensus',
    'Regime',
    'OpenedAt',
    'ClosedAt',
  ].join(',');

  const rows = trades.map((t) =>
    [
      t.id,
      t.side,
      t.entryPrice.toFixed(2),
      t.exitPrice.toFixed(2),
      t.sizeBtc.toFixed(4),
      t.grossPnlUsd.toFixed(2),
      t.pnlUsd.toFixed(2),
      t.feesPaidUsd.toFixed(2),
      t.fundingPaidUsd.toFixed(2),
      t.slippagePaidUsd.toFixed(2),
      t.pnlPct.toFixed(2),
      t.rMultiple.toFixed(2),
      t.holdMinutes.toFixed(0),
      t.outcome,
      t.exitReason,
      t.consensusScore,
      `"${t.regime.replace(/"/g, '""')}"`,
      new Date(t.openedAt).toISOString(),
      new Date(t.closedAt).toISOString(),
    ].join(','),
  );

  return [header, ...rows].join('\n');
}

function buildUnavailableAgentSignal(
  agentId: AgentId,
  name: string,
  role: string,
  reason: string,
  now: number,
  startMs: number,
): AgentSignal {
  return {
    agentId,
    name,
    role,
    direction: 'UNAVAILABLE',
    confidence: 0,
    scoreContribution: 0,
    summary: `UNAVAILABLE: ${reason}`,
    metrics: [
      { label: 'Trạng thái', value: 'UNAVAILABLE' },
      { label: 'Độ tin cậy', value: '0/100' },
      { label: 'Cảnh báo', value: 'Thiếu dữ liệu' },
    ],
    evidence: [],
    riskFlags: ['DATA_UNAVAILABLE'],
    dataQuality: 'UNAVAILABLE',
    errorState: reason,
    latencyMs: Math.max(1, Date.now() - startMs),
    timestamp: now,
  };
}

export function classifyMarketRegimeDetailed(
  ind: TechnicalIndicators,
  price: number,
  scenarioHint?: MarketScenario,
  now = Date.now(),
): RegimeClassification {
  if (!ind.dataValid || !Number.isFinite(price) || price <= 0) {
    return {
      regime: 'Sideway Nhiễu Rủi ro',
      confidence: 0,
      evidence: ['Dữ liệu thị trường không hợp lệ hoặc chưa đủ nến khởi động.'],
      classifiedAt: now,
    };
  }

  const evidence: string[] = [];
  if (scenarioHint === 'choppy_range') {
    return {
      regime: 'Sideway Nhiễu Rủi ro',
      confidence: 88,
      evidence: ['Kịch bản Sideway nhiễu thanh khoản được chọn'],
      classifiedAt: now,
    };
  }
  if (ind.sweepSignal !== 'NONE') {
    evidence.push(`Phát hiện nến quét râu dài (${ind.sweepSignal})`);
    evidence.push(`Volume Ratio ${ind.volumeRatio.toFixed(2)}x`);
    return {
      regime: 'Quét Thanh khoản & Hấp thụ',
      confidence: 80,
      evidence,
      classifiedAt: now,
    };
  }
  if (ind.adx14 < 16 && ind.bbBandwidth < 0.012 && ind.volumeRatio < 0.85) {
    evidence.push(`ADX(14)=${ind.adx14.toFixed(1)} < 16`);
    evidence.push(`BB Width ${(ind.bbBandwidth * 100).toFixed(2)}% < 1.2%`);
    evidence.push(`Vol Ratio ${ind.volumeRatio.toFixed(2)}x < 0.85x`);
    return {
      regime: 'Sideway Nhiễu Rủi ro',
      confidence: 82,
      evidence,
      classifiedAt: now,
    };
  }
  if (ind.bbBandwidth < 0.014) {
    return {
      regime: 'Tích lũy Nén Biến động',
      confidence: 74,
      evidence: [
        `BB Bandwidth hẹp ${(ind.bbBandwidth * 100).toFixed(2)}%`,
        `ADX(14)=${ind.adx14.toFixed(1)}`,
      ],
      classifiedAt: now,
    };
  }
  if (price > ind.ema50 && ind.ema21 > ind.ema50) {
    const adxBoost = ind.adx14 >= 22 ? 12 : 0;
    return {
      regime: 'Mở rộng Xu hướng Tăng',
      confidence: Math.min(92, 68 + adxBoost + (ind.plusDi14 > ind.minusDi14 ? 8 : 0)),
      evidence: [
        `Giá > EMA50 & EMA21 > EMA50`,
        `ADX(14)=${ind.adx14.toFixed(1)} (+DI ${ind.plusDi14.toFixed(1)} / -DI ${ind.minusDi14.toFixed(1)})`,
      ],
      classifiedAt: now,
    };
  }
  if (price < ind.ema50 && ind.ema21 < ind.ema50) {
    const adxBoost = ind.adx14 >= 22 ? 12 : 0;
    return {
      regime: 'Mở rộng Xu hướng Giảm',
      confidence: Math.min(92, 68 + adxBoost + (ind.minusDi14 > ind.plusDi14 ? 8 : 0)),
      evidence: [
        `Giá < EMA50 & EMA21 < EMA50`,
        `ADX(14)=${ind.adx14.toFixed(1)} (-DI ${ind.minusDi14.toFixed(1)} / +DI ${ind.plusDi14.toFixed(1)})`,
      ],
      classifiedAt: now,
    };
  }
  return {
    regime: 'Tích lũy Nén Biến động',
    confidence: 62,
    evidence: [`ADX(14)=${ind.adx14.toFixed(1)} chưa phân pha rõ`],
    classifiedAt: now,
  };
}

export function classifyMarketRegime(
  ind: TechnicalIndicators,
  price: number,
  scenarioHint?: MarketScenario,
): MarketRegime {
  return classifyMarketRegimeDetailed(ind, price, scenarioHint).regime;
}

export function evaluateMacroScout(
  price: number,
  ind: TechnicalIndicators,
  regime: MarketRegime,
  now: number,
): AgentSignal {
  const startMs = Date.now();
  if (!ind.dataValid || !Number.isFinite(price) || price <= 0) {
    return buildUnavailableAgentSignal(
      'macro_scout',
      'Trinh sát Vĩ mô',
      'Cấu trúc & Đa khung',
      ind.dataIssues[0] ?? 'Thiếu chuỗi nến hợp lệ',
      now,
      startMs,
    );
  }

  let bullPts = 0;
  let bearPts = 0;
  const evidence: string[] = [];
  const riskFlags: string[] = [];

  if (price > ind.ema200) {
    bullPts += 22;
    evidence.push(`Giá ($${price.toFixed(0)}) > EMA200 ($${ind.ema200.toFixed(0)})`);
  } else {
    bearPts += 22;
    evidence.push(`Giá ($${price.toFixed(0)}) < EMA200 ($${ind.ema200.toFixed(0)})`);
  }

  if (ind.ema50 > ind.ema200) bullPts += 18;
  else bearPts += 18;

  if (ind.h4Bias === 'LONG') bullPts += 14;
  else if (ind.h4Bias === 'SHORT') bearPts += 14;

  if (ind.h1Bias === 'LONG') bullPts += 10;
  else if (ind.h1Bias === 'SHORT') bearPts += 10;

  if (ind.htfSource === 'INSUFFICIENT') {
    riskFlags.push('HTF_INSUFFICIENT');
  } else {
    evidence.push(`Đa khung ${ind.htfSource}: H1=${ind.h1Bias}, H4=${ind.h4Bias}`);
  }

  if (ind.cvdSource === 'UNAVAILABLE') {
    riskFlags.push('CVD_UNAVAILABLE');
  } else {
    if (ind.cvdSource === 'CANDLE_BODY_PROXY') {
      riskFlags.push('CVD_OHLCV_PROXY');
    }
    if (ind.spotCvdDelta > 4) bullPts += 18;
    else if (ind.spotCvdDelta < -4) bearPts += 18;
  }

  if (ind.obvSlope > 0) bullPts += 8;
  else if (ind.obvSlope < 0) bearPts += 8;

  if (ind.fundingRate !== null) {
    if (ind.fundingRate > 0.0006) {
      bearPts += 14;
      riskFlags.push('FUNDING_OVERHEATED_LONG');
    } else if (ind.fundingRate < -0.0003) {
      bullPts += 14;
      riskFlags.push('FUNDING_OVERHEATED_SHORT');
    }
  }

  let direction: VoteDirection = 'NEUTRAL';
  let confidence = 52;
  if (regime === 'Sideway Nhiễu Rủi ro') {
    direction = 'NEUTRAL';
    confidence = 44;
    riskFlags.push('REGIME_CHOPPY');
  } else if (bullPts - bearPts >= 18) {
    direction = 'LONG';
    confidence = Math.min(95, 52 + (bullPts - bearPts) * 0.56);
  } else if (bearPts - bullPts >= 18) {
    direction = 'SHORT';
    confidence = Math.min(95, 52 + (bearPts - bullPts) * 0.56);
  }

  const fundingLabel =
    ind.fundingRate !== null ? `${(ind.fundingRate * 100).toFixed(4)}%` : 'Spot (N/A)';
  const summary =
    direction === 'LONG'
      ? `Delta KL (${ind.spotCvdDelta >= 0 ? '+' : ''}$${ind.spotCvdDelta.toFixed(1)}M · ${ind.cvdSource}), HTF (${ind.h1Bias}/${ind.h4Bias}) & EMA200 hỗ trợ tăng.`
      : direction === 'SHORT'
        ? `Áp lực bán ròng ($${ind.spotCvdDelta.toFixed(1)}M · ${ind.cvdSource}), HTF (${ind.h1Bias}/${ind.h4Bias}) nghiêng giảm.`
        : `Thiếu đồng thuận đa khung H1/H4 (${regime}), ưu tiên quan sát.`;

  return {
    agentId: 'macro_scout',
    name: 'Trinh sát Vĩ mô',
    role: 'Cấu trúc & Đa khung',
    direction,
    confidence: Math.round(confidence),
    scoreContribution: Math.round(confidence),
    summary,
    metrics: [
      { label: 'Vol Delta', value: `${ind.spotCvdDelta >= 0 ? '+' : ''}$${ind.spotCvdDelta.toFixed(1)}M` },
      { label: 'HTF H1/H4', value: `${ind.h1Bias}/${ind.h4Bias}` },
      { label: 'Funding', value: fundingLabel },
    ],
    evidence,
    riskFlags,
    dataQuality: ind.dataStatus,
    errorState: null,
    latencyMs: Math.max(1, Date.now() - startMs),
    timestamp: now,
  };
}

export function evaluateQuantAnalyst(
  price: number,
  ind: TechnicalIndicators,
  now: number,
): AgentSignal {
  const startMs = Date.now();
  if (!ind.dataValid || !Number.isFinite(price) || price <= 0) {
    return buildUnavailableAgentSignal(
      'quant_analyst',
      'Chuyên gia Định lượng',
      'Hội tụ Đa Chỉ báo',
      ind.dataIssues[0] ?? 'Thiếu chuỗi nến hợp lệ',
      now,
      startMs,
    );
  }

  let bullFactors = 0;
  let bearFactors = 0;
  const evidence: string[] = [];
  const riskFlags: string[] = [];

  if (!ind.emaWarmupValid) riskFlags.push('EMA_WARMUP_SHORT');
  if (!ind.macdWarmupValid) riskFlags.push('MACD_WARMUP_SHORT');

  // 1. EMA ribbon + SMA20 confirmation
  if (ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50) {
    bullFactors += 2;
    evidence.push('EMA Ribbon sắp xếp tăng (EMA9 > EMA21 > EMA50)');
  } else if (ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50) {
    bearFactors += 2;
    evidence.push('EMA Ribbon sắp xếp giảm (EMA9 < EMA21 < EMA50)');
  } else if (price > ind.ema21 && price > ind.sma20) {
    bullFactors += 1;
  } else if (price < ind.ema21 && price < ind.sma20) {
    bearFactors += 1;
  }

  // 2. RSI healthy momentum zone
  if (ind.rsi14 >= 46 && ind.rsi14 <= 70) {
    bullFactors += 1.5;
    evidence.push(`RSI(14)=${ind.rsi14.toFixed(1)} vùng động lượng tăng khỏe`);
  } else if (ind.rsi14 <= 54 && ind.rsi14 >= 30) {
    bearFactors += 1.5;
    evidence.push(`RSI(14)=${ind.rsi14.toFixed(1)} vùng động lượng giảm`);
  } else if (ind.rsi14 > 76) {
    bearFactors += 1;
    riskFlags.push('RSI_OVERBOUGHT');
  } else if (ind.rsi14 < 24) {
    bullFactors += 1;
    riskFlags.push('RSI_OVERSOLD');
  }

  // 3. MACD histogram momentum
  if (ind.macdWarmupValid) {
    if (ind.macdHistogram > 0 && ind.macdLine > ind.macdSignal) bullFactors += 1.5;
    else if (ind.macdHistogram < 0 && ind.macdLine < ind.macdSignal) bearFactors += 1.5;
  }

  // 4. VWAP position
  if (price > ind.vwap24) bullFactors += 1;
  else bearFactors += 1;

  // 5. Swing structure BOS/CHoCH + ADX directional DI confirmation
  if (ind.structureBias === 'BULLISH') {
    bullFactors += 1.2;
    evidence.push(`Cấu trúc giá ${ind.structureEvent}`);
  } else if (ind.structureBias === 'BEARISH') {
    bearFactors += 1.2;
    evidence.push(`Cấu trúc giá ${ind.structureEvent}`);
  }

  if (ind.adx14 >= 20) {
    if (ind.plusDi14 > ind.minusDi14) bullFactors += 0.8;
    else if (ind.minusDi14 > ind.plusDi14) bearFactors += 0.8;
  } else {
    riskFlags.push('ADX_WEAK_TREND');
  }

  let direction: VoteDirection = 'NEUTRAL';
  let confidence = 50;
  const diff = bullFactors - bearFactors;
  if (diff >= 1.5) {
    direction = 'LONG';
    confidence = Math.min(96, 55 + diff * 7.2);
  } else if (diff <= -1.5) {
    direction = 'SHORT';
    confidence = Math.min(96, 55 + Math.abs(diff) * 7.2);
  }

  const structLabel =
    ind.structureBias === 'BULLISH' ? 'Tăng' : ind.structureBias === 'BEARISH' ? 'Giảm' : 'Ngang';

  const summary =
    direction === 'LONG'
      ? `Hội tụ ${bullFactors.toFixed(1)}/8.0 điểm: EMA9>21>50, RSI(${ind.rsi14.toFixed(1)}), ADX(${ind.adx14.toFixed(1)}), cấu trúc ${structLabel}.`
      : direction === 'SHORT'
        ? `Hội tụ ${bearFactors.toFixed(1)}/8.0 giảm: Dưới VWAP, MACD âm, ADX(${ind.adx14.toFixed(1)}), cấu trúc ${structLabel}.`
        : `Động lượng phân hóa (RSI ${ind.rsi14.toFixed(1)}, ADX ${ind.adx14.toFixed(1)}), chưa đạt ngưỡng vào.`;

  return {
    agentId: 'quant_analyst',
    name: 'Chuyên gia Định lượng',
    role: 'Hội tụ Đa Chỉ báo',
    direction,
    confidence: Math.round(confidence),
    scoreContribution: Math.round(confidence),
    summary,
    metrics: [
      { label: 'RSI / ADX', value: `${ind.rsi14.toFixed(1)} / ${ind.adx14.toFixed(1)}` },
      {
        label: 'POC VP',
        value: `$${ind.volumeProfile.poc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
      },
      { label: 'ATR(14)', value: `$${ind.atr14.toFixed(0)}` },
    ],
    evidence,
    riskFlags,
    dataQuality: ind.dataStatus,
    errorState: null,
    latencyMs: Math.max(1, Date.now() - startMs),
    timestamp: now,
  };
}

export function evaluateOrderflowRadar(
  price: number,
  ind: TechnicalIndicators,
  now: number,
): AgentSignal {
  const startMs = Date.now();
  if (!ind.dataValid || !Number.isFinite(price) || price <= 0) {
    return buildUnavailableAgentSignal(
      'orderflow_radar',
      'Radar Sổ lệnh',
      'Sổ lệnh & Thanh khoản',
      ind.dataIssues[0] ?? 'Thiếu chuỗi nến hợp lệ',
      now,
      startMs,
    );
  }

  let bullScore = 0;
  let bearScore = 0;
  const evidence: string[] = [];
  const riskFlags: string[] = [];

  // Only score Orderbook depth when genuine exchange depth exists (ZERO fake EMA proxy)
  if (ind.orderbookSource === 'EXCHANGE_DEPTH') {
    if (ind.orderbookImbalance > 0.2) {
      bullScore += 34;
      evidence.push(`Bid/Ask Depth +${Math.round(ind.orderbookImbalance * 100)}% nghiêng mua`);
    } else if (ind.orderbookImbalance < -0.2) {
      bearScore += 34;
      evidence.push(`Bid/Ask Depth ${Math.round(ind.orderbookImbalance * 100)}% nghiêng bán`);
    }
  } else {
    riskFlags.push('ORDERBOOK_UNAVAILABLE');
  }

  if (ind.sweepSignal === 'BULL_SWEEP') {
    bullScore += 36;
    evidence.push('Nến rút chân quét thanh khoản đáy (BULL_SWEEP)');
  } else if (ind.sweepSignal === 'BEAR_SWEEP') {
    bearScore += 36;
    evidence.push('Nến từ chối thanh khoản đỉnh (BEAR_SWEEP)');
  }

  if (ind.volumeRatio >= 1.15) {
    if (price >= ind.vwap24) {
      bullScore += 24;
      evidence.push(`Volume mở rộng ${ind.volumeRatio.toFixed(2)}x trên VWAP`);
    } else {
      bearScore += 24;
      evidence.push(`Volume mở rộng ${ind.volumeRatio.toFixed(2)}x dưới VWAP`);
    }
  }

  if (ind.cvdSource !== 'UNAVAILABLE') {
    if (ind.cvdSource === 'CANDLE_BODY_PROXY') {
      riskFlags.push('CVD_OHLCV_PROXY');
    }
    if (ind.spotCvdDelta > 3) {
      bullScore += 20;
      evidence.push(`CVD dương +$${ind.spotCvdDelta.toFixed(1)}M (${ind.cvdSource})`);
    } else if (ind.spotCvdDelta < -3) {
      bearScore += 20;
      evidence.push(`CVD âm $${ind.spotCvdDelta.toFixed(1)}M (${ind.cvdSource})`);
    }
  }

  let direction: VoteDirection = 'NEUTRAL';
  let confidence = 48;
  if (bullScore - bearScore >= 22) {
    direction = 'LONG';
    confidence = Math.min(97, 54 + (bullScore - bearScore) * 0.55);
  } else if (bearScore - bullScore >= 22) {
    direction = 'SHORT';
    confidence = Math.min(97, 54 + (bearScore - bullScore) * 0.55);
  }

  const imbalanceLabel =
    ind.orderbookSource === 'EXCHANGE_DEPTH'
      ? `${ind.orderbookImbalance >= 0 ? '+' : ''}${Math.round(ind.orderbookImbalance * 100)}%`
      : 'N/A (No Depth)';

  const summary =
    ind.sweepSignal === 'BULL_SWEEP'
      ? `Quét đáy BULL_SWEEP · Vol ${ind.volumeRatio.toFixed(2)}x · Depth ${imbalanceLabel}.`
      : ind.sweepSignal === 'BEAR_SWEEP'
        ? `Từ chối đỉnh BEAR_SWEEP · Vol ${ind.volumeRatio.toFixed(2)}x · Depth ${imbalanceLabel}.`
        : direction !== 'NEUTRAL'
          ? `Dòng tiền ${direction} · Depth ${imbalanceLabel} · Vol ${ind.volumeRatio.toFixed(2)}x (Z=${ind.volumeZScore.toFixed(1)}).`
          : `Thanh khoản cân bằng (Depth ${imbalanceLabel}, Vol ${ind.volumeRatio.toFixed(2)}x), chưa có đột biến.`;

  return {
    agentId: 'orderflow_radar',
    name: 'Radar Sổ lệnh',
    role: 'Sổ lệnh & Thanh khoản',
    direction,
    confidence: Math.round(confidence),
    scoreContribution: Math.round(confidence),
    summary,
    metrics: [
      { label: 'Bid/Ask', value: imbalanceLabel },
      { label: 'Vol / Z', value: `${ind.volumeRatio.toFixed(2)}x (${ind.volumeZScore.toFixed(1)})` },
      {
        label: 'Sweep',
        value:
          ind.sweepSignal === 'NONE'
            ? 'Không'
            : ind.sweepSignal === 'BULL_SWEEP'
              ? 'Rút chân đáy'
              : 'Từ chối đỉnh',
      },
    ],
    evidence,
    riskFlags,
    dataQuality: ind.dataStatus,
    errorState: null,
    latencyMs: Math.max(1, Date.now() - startMs),
    timestamp: now,
  };
}

export function evaluateStrategyArchitect(
  price: number,
  ind: TechnicalIndicators,
  regime: MarketRegime,
  consensus: { direction: 'LONG' | 'SHORT' | 'NEUTRAL'; score: number },
  config: StrategyConfig,
  now: number,
): AgentSignal {
  const startMs = Date.now();
  if (!ind.dataValid || !Number.isFinite(price) || price <= 0) {
    return buildUnavailableAgentSignal(
      'strategy_architect',
      'Kiến trúc Chiến lược',
      'Thiết kế Kèo & R:R',
      ind.dataIssues[0] ?? 'Thiếu chuỗi nến hợp lệ',
      now,
      startMs,
    );
  }

  const evidence: string[] = [];
  const riskFlags: string[] = [];
  const atr = Math.max(ind.atr14, price * 0.0025);
  const stopDist = atr * 1.55;
  const tp2Dist = stopDist * Math.max(config.minRewardRisk, 2.55);

  let playbook = 'Trend Continuation';
  if (ind.sweepSignal !== 'NONE' || ind.structureEvent.startsWith('CHOCH')) {
    playbook = 'Liquidity Sweep / CHoCH Reversal';
  } else if (ind.bbBandwidth < 0.015) {
    playbook = 'Volatility Squeeze Breakout';
  } else if (regime === 'Sideway Nhiễu Rủi ro') {
    playbook = 'Capital Preservation (No-Trade)';
    riskFlags.push('NO_TREND_PLAYBOOK');
  }

  let srRoomRatio = 2.5;
  if (consensus.direction === 'LONG') {
    if (ind.srLevels.resistances.length === 0) {
      srRoomRatio = 3.2;
      evidence.push('Phá đỉnh 60 nến — không có kháng cự Pivot phía trên');
    } else {
      const distToRes = ind.srLevels.nearestResistance - price;
      srRoomRatio = distToRes > 0 ? distToRes / stopDist : 2.5;
      if (distToRes > 0 && distToRes < stopDist * 1.1) {
        riskFlags.push('RESISTANCE_NEARBY');
        evidence.push(`Cận kháng cự Pivot $${ind.srLevels.nearestResistance.toLocaleString('en-US')}`);
      } else {
        evidence.push(`Khoảng thoáng tới TP2 ~${((tp2Dist / price) * 100).toFixed(2)}%`);
      }
    }
  } else if (consensus.direction === 'SHORT') {
    if (ind.srLevels.supports.length === 0) {
      srRoomRatio = 3.2;
      evidence.push('Phá đáy 60 nến — không có hỗ trợ Pivot phía dưới');
    } else {
      const distToSup = price - ind.srLevels.nearestSupport;
      srRoomRatio = distToSup > 0 ? distToSup / stopDist : 2.5;
      if (distToSup > 0 && distToSup < stopDist * 1.1) {
        riskFlags.push('SUPPORT_NEARBY');
        evidence.push(`Cận hỗ trợ Pivot $${ind.srLevels.nearestSupport.toLocaleString('en-US')}`);
      } else {
        evidence.push(`Khoảng thoáng tới TP2 ~${((tp2Dist / price) * 100).toFixed(2)}%`);
      }
    }
  }

  evidence.push(`Playbook: ${playbook}`);
  evidence.push(`Cấu trúc: ${ind.structureEvent} · BB Width ${(ind.bbBandwidth * 100).toFixed(2)}%`);

  const direction: VoteDirection =
    consensus.direction === 'NEUTRAL' || regime === 'Sideway Nhiễu Rủi ro'
      ? 'NEUTRAL'
      : consensus.direction;

  const baseConf = consensus.direction === 'NEUTRAL' ? 46 : consensus.score;
  const srAdj = riskFlags.includes('RESISTANCE_NEARBY') || riskFlags.includes('SUPPORT_NEARBY') ? -10 : 6;
  const confidence = Math.max(0, Math.min(96, Math.round(baseConf + srAdj)));

  const slPreview =
    direction === 'LONG' ? price - stopDist : direction === 'SHORT' ? price + stopDist : price;
  const tpPreview =
    direction === 'LONG' ? price + tp2Dist : direction === 'SHORT' ? price - tp2Dist : price;

  const summary =
    direction === 'NEUTRAL'
      ? `Chưa kích hoạt Playbook (${playbook}) trong pha ${regime}.`
      : `Playbook ${playbook} (${direction}): Entry ~$${price.toLocaleString('en-US')}, SL $${slPreview.toFixed(0)}, TP2 $${tpPreview.toFixed(0)} · SR Room ${srRoomRatio.toFixed(1)}R.`;

  return {
    agentId: 'strategy_architect',
    name: 'Kiến trúc Chiến lược',
    role: 'Thiết kế Kèo & R:R',
    direction,
    confidence,
    scoreContribution: confidence,
    summary,
    metrics: [
      { label: 'Playbook', value: playbook.split(' ')[0] + ' ' + (playbook.split(' ')[1] ?? '') },
      { label: 'Cấu trúc', value: ind.structureEvent },
      { label: 'SR Room', value: `${Math.min(9.9, Math.max(0, srRoomRatio)).toFixed(1)}R` },
    ],
    evidence,
    riskFlags,
    dataQuality: ind.dataStatus,
    errorState: null,
    latencyMs: Math.max(1, Date.now() - startMs),
    timestamp: now,
  };
}

export function computeConsensus(
  signals: {
    macro_scout: AgentSignal;
    quant_analyst: AgentSignal;
    orderflow_radar: AgentSignal;
  },
  config: StrategyConfig,
): { direction: 'LONG' | 'SHORT' | 'NEUTRAL'; score: number } {
  const weights = config.agentWeights;
  const totalW = weights.macro_scout + weights.quant_analyst + weights.orderflow_radar || 1;

  let longScore = 0;
  let shortScore = 0;

  const entries: Array<[AgentSignal, number]> = [
    [signals.macro_scout, weights.macro_scout / totalW],
    [signals.quant_analyst, weights.quant_analyst / totalW],
    [signals.orderflow_radar, weights.orderflow_radar / totalW],
  ];

  for (const [sig, w] of entries) {
    if (sig.direction === 'UNAVAILABLE') continue;
    if (sig.direction === 'LONG') longScore += sig.confidence * w;
    else if (sig.direction === 'SHORT') shortScore += sig.confidence * w;
  }

  if (longScore > shortScore && longScore >= 42) {
    return { direction: 'LONG', score: Math.round(longScore) };
  }
  if (shortScore > longScore && shortScore >= 42) {
    return { direction: 'SHORT', score: Math.round(shortScore) };
  }
  return { direction: 'NEUTRAL', score: Math.round(Math.max(longScore, shortScore)) };
}

export function conductAgentDebate(
  price: number,
  ind: TechnicalIndicators,
  regime: MarketRegime,
  signals: {
    macro_scout: AgentSignal;
    quant_analyst: AgentSignal;
    orderflow_radar: AgentSignal;
    strategy_architect?: AgentSignal;
  },
  consensus: { direction: 'LONG' | 'SHORT' | 'NEUTRAL'; score: number },
): AgentDebateSummary {
  const preDebateScore = consensus.score;
  const turns: DebateChallenge[] = [];

  if (!ind.dataValid || consensus.direction === 'NEUTRAL') {
    turns.push({
      id: 'debate-neutral-hold',
      challenger: 'risk_guardian',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 0,
      title: !ind.dataValid ? 'Thiếu dữ liệu hợp lệ' : 'Đồng thuận chưa phân hóa hướng đi',
      argument: `Macro (${signals.macro_scout.direction}), Quant (${signals.quant_analyst.direction}), Orderflow (${signals.orderflow_radar.direction}) giữ trạng thái quan sát trong pha ${regime}. Bảo toàn vốn tiền mặt.`,
    });
    return {
      preDebateScore,
      postDebateScore: preDebateScore,
      scoreDelta: 0,
      challengesCount: 0,
      criticalVetoTriggered: false,
      verdict: 'Hội đồng thống nhất giữ nguyên thanh khoản, chưa kích hoạt mở lệnh.',
      turns,
    };
  }

  const side = consensus.direction;
  const hasAlignedSweep =
    (side === 'LONG' && ind.sweepSignal === 'BULL_SWEEP') ||
    (side === 'SHORT' && ind.sweepSignal === 'BEAR_SWEEP');

  // Turn 1: Macro Scout cross-examines HTF H1/H4 trend alignment
  if (ind.h4Bias !== 'NEUTRAL' && ind.h4Bias !== side) {
    const penalty = hasAlignedSweep ? -6 : -15;
    turns.push({
      id: 'debate-macro-htf-conflict',
      challenger: 'macro_scout',
      target: 'quant_analyst',
      stance: 'CHALLENGE',
      impactScore: penalty,
      title: `Phản biện Ngược xu hướng H4 (${ind.h4Bias})`,
      argument: hasAlignedSweep
        ? `Đề xuất ${side} đi ngược khung H4 (${ind.h4Bias}), tuy nhiên có nến rũ thanh khoản xác nhận đảo chiều nên giảm nhẹ ${Math.abs(penalty)}đ.`
        : `Đề xuất ${side} trên M15 ngược hướng khung H4 (${ind.h4Bias}). Giao dịch ngược xu hướng lớn làm giảm biên an toàn, trừ ${Math.abs(penalty)}đ.`,
    });
  } else if (ind.htfBias === side && ind.h1Bias === ind.h4Bias) {
    turns.push({
      id: 'debate-macro-htf-confirm',
      challenger: 'macro_scout',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 8,
      title: `Xác nhận Đồng pha Đa khung H1/H4 (${side})`,
      argument: `Cả khung H1 và H4 đều đồng thuận ${side}, trùng nhịp Volume Delta (${ind.spotCvdDelta >= 0 ? '+' : ''}$${ind.spotCvdDelta.toFixed(1)}M). Cộng +8đ hội tụ.`,
    });
  }

  // Turn 2: Orderflow Radar cross-examines orderbook wall & liquidity rejection
  const oppOrderbook =
    ind.orderbookSource === 'EXCHANGE_DEPTH' &&
    ((side === 'LONG' && ind.orderbookImbalance <= -0.22) ||
      (side === 'SHORT' && ind.orderbookImbalance >= 0.22));
  const oppSweep =
    (side === 'LONG' && ind.sweepSignal === 'BEAR_SWEEP') ||
    (side === 'SHORT' && ind.sweepSignal === 'BULL_SWEEP');

  if (oppOrderbook || oppSweep) {
    const imbPct = Math.round(ind.orderbookImbalance * 100);
    turns.push({
      id: 'debate-orderflow-trap',
      challenger: 'orderflow_radar',
      target: 'PROPOSED_TRADE',
      stance: 'VETO_TRIGGER',
      impactScore: -18,
      title: oppSweep ? 'Cảnh báo Râu nến Từ chối Ngược chiều' : 'Phản đối Mất cân bằng Sổ lệnh Ngược chiều',
      argument: oppSweep
        ? `Phát hiện nến từ chối (${ind.sweepSignal}) chống lại lệnh ${side}. Rủi ro quét SL cao, hạ -18đ và cảnh báo VETO.`
        : `Tỷ lệ Bid/Ask đang nghiêng mạnh về phía đối nghịch (${imbPct >= 0 ? '+' : ''}${imbPct}%). Hạ -18đ.`,
    });
  } else if (
    hasAlignedSweep ||
    (ind.orderbookSource === 'EXCHANGE_DEPTH' &&
      ((side === 'LONG' && ind.orderbookImbalance >= 0.24) ||
        (side === 'SHORT' && ind.orderbookImbalance <= -0.24)))
  ) {
    const imbPct = Math.round(ind.orderbookImbalance * 100);
    turns.push({
      id: 'debate-orderflow-confirm',
      challenger: 'orderflow_radar',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 8,
      title: hasAlignedSweep ? 'Xác nhận Nến Quét & Hấp thụ Thanh khoản' : 'Xác nhận Sổ lệnh Đồng thuận',
      argument: hasAlignedSweep
        ? `Dữ liệu nến quét (${ind.sweepSignal}) kèm khối lượng ${ind.volumeRatio.toFixed(2)}x xác nhận lực hấp thụ hướng ${side}. Cộng +8đ.`
        : `Độ sâu Bid/Ask (${imbPct >= 0 ? '+' : ''}${imbPct}%) hỗ trợ trực tiếp hướng ${side}. Cộng +8đ.`,
    });
  }

  // Turn 3: Quant Analyst checks overextension / market structure conflict
  const atrStretch = Math.abs(price - ind.ema21) / Math.max(ind.atr14, price * 0.002);
  const isOverextended =
    (side === 'LONG' && (ind.rsi14 > 73 || atrStretch > 2.25)) ||
    (side === 'SHORT' && (ind.rsi14 < 27 || atrStretch > 2.25));
  const structConflict =
    (side === 'LONG' && ind.structureBias === 'BEARISH') ||
    (side === 'SHORT' && ind.structureBias === 'BULLISH');
  const structAligned =
    (side === 'LONG' && ind.structureBias === 'BULLISH') ||
    (side === 'SHORT' && ind.structureBias === 'BEARISH');

  if (isOverextended) {
    turns.push({
      id: 'debate-quant-overextended',
      challenger: 'quant_analyst',
      target: 'PROPOSED_TRADE',
      stance: 'CHALLENGE',
      impactScore: -14,
      title: 'Cảnh báo Giá Đuổi Xa EMA21 (Quá mua/bán)',
      argument: `RSI đạt ${ind.rsi14.toFixed(1)} và giá lệch ${atrStretch.toFixed(1)}x ATR khỏi EMA21. Rủi ro nhịp hồi kỹ thuật, trừ -14đ.`,
    });
  } else if (structConflict) {
    turns.push({
      id: 'debate-quant-structure',
      challenger: 'quant_analyst',
      target: 'orderflow_radar',
      stance: 'CHALLENGE',
      impactScore: -10,
      title: `Cấu trúc Sóng Đỉnh/Đáy chưa xác nhận (${ind.structureBias})`,
      argument: `Cấu trúc gần nhất nghiêng ${ind.structureBias} trong khi đề xuất là ${side}. Thận trọng trừ -10đ.`,
    });
  } else if (structAligned) {
    turns.push({
      id: 'debate-quant-structure-ok',
      challenger: 'quant_analyst',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 6,
      title: `Xác nhận Cấu trúc ${ind.structureEvent}`,
      argument: `Giá xác lập đỉnh/đáy đồng thuận hướng ${side} với độ giãn EMA21 hợp lý (${atrStretch.toFixed(1)}x ATR). Cộng +6đ.`,
    });
  }

  // Turn 4: Strategy Architect evaluates R:R structural clearance against nearest Pivot S/R
  const archSig = signals.strategy_architect;
  if (archSig && (archSig.riskFlags.includes('RESISTANCE_NEARBY') || archSig.riskFlags.includes('SUPPORT_NEARBY'))) {
    turns.push({
      id: 'debate-architect-sr-wall',
      challenger: 'strategy_architect',
      target: 'PROPOSED_TRADE',
      stance: 'CHALLENGE',
      impactScore: -8,
      title: 'Cảnh báo Cận Vùng Cản S/R Gần TP1',
      argument: `Giá hiện tại nằm sát vùng ${side === 'LONG' ? 'kháng cự' : 'hỗ trợ'} pivot gần nhất, làm hẹp khoảng chạy tới TP1. Trừ -8đ.`,
    });
  } else if (archSig && archSig.direction === side && archSig.confidence >= 70) {
    turns.push({
      id: 'debate-architect-playbook',
      challenger: 'strategy_architect',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 4,
      title: `Playbook R:R Khả thi (${ind.structureEvent})`,
      argument: `Khoảng trống tới vùng Pivot kế tiếp thông thoáng, đáp ứng cấu trúc Entry/SL/TP chuẩn quỹ. Cộng +4đ.`,
    });
  }

  // Turn 5: Funding squeeze warning (only if Futures funding available)
  if (
    ind.fundingRate !== null &&
    ((side === 'LONG' && ind.fundingRate > 0.0006) ||
      (side === 'SHORT' && ind.fundingRate < -0.0003))
  ) {
    turns.push({
      id: 'debate-macro-funding',
      challenger: 'macro_scout',
      target: 'PROPOSED_TRADE',
      stance: 'CHALLENGE',
      impactScore: -10,
      title: 'Cảnh báo Quá nhiệt Funding Rate',
      argument: `Funding Futures ở mức ${(ind.fundingRate * 100).toFixed(4)}%, dễ xuất hiện nhịp quét đòn bẩy ngược chiều ${side}. Trừ -10đ.`,
    });
  }

  const scoreDelta = turns.reduce((acc, t) => acc + t.impactScore, 0);
  const postDebateScore = Math.max(0, Math.min(100, preDebateScore + scoreDelta));
  const challengesCount = turns.filter((t) => t.stance !== 'SUPPORT').length;
  const hasVetoTrigger = turns.some((t) => t.stance === 'VETO_TRIGGER');
  const criticalVetoTriggered =
    (hasVetoTrigger && postDebateScore < 76) ||
    (challengesCount >= 2 && postDebateScore < 74);

  const verdict = criticalVetoTriggered
    ? `Phản biện bác bỏ kèo ${side}: ${challengesCount} rủi ro mâu thuẫn kéo điểm xuống ${postDebateScore}/100.`
    : challengesCount > 0
      ? `Kèo ${side} vượt qua ${challengesCount} phản biện với điểm hiệu chỉnh ${postDebateScore}/100 (${scoreDelta >= 0 ? '+' : ''}${scoreDelta}đ).`
      : `Hội đồng đồng thuận hướng ${side}: ${postDebateScore}/100 (+${scoreDelta}đ cộng hưởng).`;

  return {
    preDebateScore,
    postDebateScore,
    scoreDelta,
    challengesCount,
    criticalVetoTriggered,
    verdict,
    turns,
  };
}

export function evaluateRiskGuardian(
  price: number,
  ind: TechnicalIndicators,
  regime: MarketRegime,
  dominantDirection: 'LONG' | 'SHORT' | 'NEUTRAL',
  consensusScore: number,
  equity: number,
  config: StrategyConfig,
  hasActivePosition: boolean,
  now: number,
  debate?: AgentDebateSummary,
  accountState?: RiskAccountState,
  dataQuality: FeedHealthStatus = 'HEALTHY',
  isLiveScenario = false,
  pendingOrdersMarginUsd = 0,
  activeMarginUsedUsd = 0,
): { signal: AgentSignal; risk: RiskEvaluation } {
  return evaluateInstitutionalRisk({
    price,
    ind,
    regime,
    dominantDirection,
    consensusScore,
    equity,
    config,
    hasActivePosition,
    now,
    debate,
    accountState,
    dataQuality,
    venue: config.marketVenue,
    isLiveScenario,
    pendingOrdersMarginUsd,
    activeMarginUsedUsd,
  });
}

function buildClosedTradeRecord(params: {
  pos: Position;
  exitPrice: number;
  remainPnl: number;
  remainFee: number;
  remainSlippage: number;
  fundingCostUsd: number;
  grossPnlUsd: number;
  exitReason: ClosedTrade['exitReason'];
  closedAt: number;
}): ClosedTrade {
  const {
    pos,
    exitPrice,
    remainPnl,
    remainFee,
    remainSlippage,
    fundingCostUsd,
    grossPnlUsd,
    exitReason,
    closedAt,
  } = params;
  const totalNetPnl = pos.realizedPartialPnl + remainPnl - fundingCostUsd;
  const totalFees = pos.feesPaidUsd + remainFee;
  const totalSlippage = pos.slippagePaidUsd + remainSlippage;
  const totalFunding = pos.fundingPaidUsd + fundingCostUsd;
  const initialRiskUsd = Math.max(
    1,
    Math.abs(pos.entryPrice - pos.initialStopLoss) * pos.sizeBtc,
  );
  const rMult = totalNetPnl / initialRiskUsd;
  const outcome: ClosedTrade['outcome'] =
    totalNetPnl > 15 ? 'WIN' : totalNetPnl < -15 ? 'LOSS' : 'BREAKEVEN';
  const holdMinutes = Math.max(0, Math.round((closedAt - pos.openedAt) / 60000));

  return {
    id: pos.id,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice: Number(exitPrice.toFixed(2)),
    sizeBtc: pos.sizeBtc,
    grossPnlUsd: Number(grossPnlUsd.toFixed(2)),
    pnlUsd: Number(totalNetPnl.toFixed(2)),
    feesPaidUsd: Number(totalFees.toFixed(2)),
    fundingPaidUsd: Number(totalFunding.toFixed(2)),
    slippagePaidUsd: Number(totalSlippage.toFixed(2)),
    pnlPct: pos.notionalUsd > 0 ? Number(((totalNetPnl / pos.notionalUsd) * 100).toFixed(2)) : 0,
    rMultiple: Number(rMult.toFixed(2)),
    holdMinutes,
    outcome,
    exitReason,
    openedAt: pos.openedAt,
    closedAt,
    consensusScore: pos.consensusScore,
    regime: pos.regime,
  };
}

export function runPipelineCycle(params: {
  cycleId: number;
  candles: Candle[];
  fundingRate: number | null;
  equity: number;
  activePosition: Position | null;
  config: StrategyConfig;
  scenarioHint?: MarketScenario;
  liveOrderbookImbalance?: number;
  spreadBps?: number;
  realAggTradeCvdDelta?: number | null;
  htfContext?: HtfContext;
  accountState?: RiskAccountState;
  dataQuality?: FeedHealthStatus;
  slippageRate?: number;
  pendingOrdersMarginUsd?: number;
  now?: number;
}): {
  cycle: PipelineCycle;
  indicators: TechnicalIndicators;
  nextPosition: Position | null;
  closedTrade: ClosedTrade | null;
  equityAfter: number;
  nextAccountState?: RiskAccountState;
} {
  const {
    cycleId,
    candles,
    fundingRate,
    equity,
    activePosition,
    config,
    scenarioHint,
    liveOrderbookImbalance,
    spreadBps = 0,
    realAggTradeCvdDelta = null,
    htfContext,
    accountState,
    dataQuality = 'HEALTHY',
    slippageRate = 0,
    pendingOrdersMarginUsd = 0,
    now = Date.now(),
  } = params;

  const lastCandle = candles[candles.length - 1] ?? {
    time: now,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
  };
  const price = Number.isFinite(lastCandle.close) && lastCandle.close > 0 ? lastCandle.close : 0;
  const indicators = extractIndicators(
    candles,
    fundingRate,
    scenarioHint,
    liveOrderbookImbalance,
    htfContext,
    now,
    spreadBps,
    realAggTradeCvdDelta,
  );
  const regimeInfo = classifyMarketRegimeDetailed(indicators, price, scenarioHint, now);
  const regime = regimeInfo.regime;

  // Step 1: Conservative OHLC Position Management (never evaluate entry bar's own H/L against itself)
  let workingPosition = activePosition ? { ...activePosition } : null;
  let closedTrade: ClosedTrade | null = null;
  let updatedEquity = Number.isFinite(equity) ? equity : config.initialCapital;
  let workingAccount = accountState
    ? rolloverRiskPeriods(accountState, updatedEquity, now)
    : undefined;

  if (workingPosition && price > 0) {
    const pos = workingPosition;
    pos.currentPrice = price;
    const isNewEntrySameBar = pos.openedCandleTime === lastCandle.time;

    if (!isNewEntrySameBar && pos.remainingBtc > 0) {
      const isLong = pos.side === 'LONG';
      const isGapStop =
        Number.isFinite(lastCandle.open) &&
        lastCandle.open > 0 &&
        (isLong ? lastCandle.open < pos.stopLoss : lastCandle.open > pos.stopLoss);

      const hitStop = isLong
        ? lastCandle.low <= pos.stopLoss || isGapStop
        : lastCandle.high >= pos.stopLoss || isGapStop;
      const hitTp1 =
        !pos.tp1Hit &&
        (isLong ? lastCandle.high >= pos.takeProfit1 : lastCandle.low <= pos.takeProfit1);
      const hitTp2 = isLong
        ? lastCandle.high >= pos.takeProfit2
        : lastCandle.low <= pos.takeProfit2;

      // CONSERVATIVE OHLC RULE + GAP-THROUGH-SL FILL:
      // 1) If bar opens past stopLoss, stop triggers immediately at bar OPEN + slippage (GAP_STOP_LOSS).
      // 2) If Stop Loss and TP1/TP2 are BOTH touched within the same bar, SL executes FIRST.
      if (hitStop) {
        const rawExitPrice = isGapStop ? lastCandle.open : pos.stopLoss;
        const slipImpact = rawExitPrice * slippageRate;
        const effectiveExit = isLong ? rawExitPrice - slipImpact : rawExitPrice + slipImpact;
        const exitFee = effectiveExit * pos.remainingBtc * TAKER_FEE_RATE;
        const exitSlippage = slipImpact * pos.remainingBtc;
        const rawPriceDiff = isLong
          ? effectiveExit - pos.entryPrice
          : pos.entryPrice - effectiveExit;
        const remainGrossPnl =
          (isLong ? rawExitPrice - pos.entryPrice : pos.entryPrice - rawExitPrice) *
          pos.remainingBtc;
        const remainNetPnl = rawPriceDiff * pos.remainingBtc - exitFee;

        const holdHours = Math.max(0, (now - pos.openedAt) / 3600000);
        const fundingIntervals = Math.floor(holdHours / 8);
        const effectiveFunding =
          config.marketVenue === 'BINANCE_FUTURES' && fundingRate !== null && fundingIntervals > 0
            ? (isLong ? 1 : -1) * pos.notionalUsd * fundingRate * fundingIntervals
            : 0;

        updatedEquity += remainNetPnl - effectiveFunding;

        let exitReason: ClosedTrade['exitReason'] = isGapStop ? 'GAP_STOP_LOSS' : 'STOP_LOSS';
        if (!isGapStop && pos.tp1Hit) {
          const pastBe = isLong
            ? pos.stopLoss > pos.entryPrice * 1.002
            : pos.stopLoss < pos.entryPrice * 0.998;
          exitReason = pastBe ? 'TP1_TRAILING' : 'BREAKEVEN_STOP';
        }

        const tp1GrossEstimate = pos.tp1Hit
          ? (isLong ? pos.takeProfit1 - pos.entryPrice : pos.entryPrice - pos.takeProfit1) *
            Math.max(0, pos.sizeBtc - pos.remainingBtc)
          : 0;

        closedTrade = buildClosedTradeRecord({
          pos,
          exitPrice: effectiveExit,
          remainPnl: remainNetPnl,
          remainFee: exitFee,
          remainSlippage: exitSlippage,
          fundingCostUsd: effectiveFunding,
          grossPnlUsd: tp1GrossEstimate + remainGrossPnl,
          exitReason,
          closedAt: now,
        });
        workingPosition = null;
      } else {
        if (hitTp1 && pos.remainingBtc > 0) {
          const halfSize = Math.min(
            pos.remainingBtc,
            Number((pos.remainingBtc * 0.5).toFixed(4)),
          );
          if (halfSize > 0) {
            const partialExitFee = pos.takeProfit1 * halfSize * TAKER_FEE_RATE;
            const partialPnl =
              (isLong ? pos.takeProfit1 - pos.entryPrice : pos.entryPrice - pos.takeProfit1) *
                halfSize -
              partialExitFee;
            pos.realizedPartialPnl += partialPnl;
            pos.feesPaidUsd += partialExitFee;
            pos.remainingBtc = Number(Math.max(0, pos.remainingBtc - halfSize).toFixed(4));
            pos.tp1Hit = true;
            updatedEquity += partialPnl;
            if (config.useBreakEvenAfterTp1) {
              pos.stopLoss = isLong
                ? Number((pos.entryPrice * 1.0008).toFixed(2))
                : Number((pos.entryPrice * 0.9992).toFixed(2));
            }
          }
        }

        if (hitTp2 && pos.remainingBtc >= 0) {
          const rawExitPrice = pos.takeProfit2;
          const slipImpact = rawExitPrice * slippageRate;
          const effectiveExit = isLong ? rawExitPrice - slipImpact : rawExitPrice + slipImpact;
          const exitFee = effectiveExit * pos.remainingBtc * TAKER_FEE_RATE;
          const exitSlippage = slipImpact * pos.remainingBtc;
          const remainGrossPnl =
            (isLong ? rawExitPrice - pos.entryPrice : pos.entryPrice - rawExitPrice) *
            pos.remainingBtc;
          const remainNetPnl =
            (isLong ? effectiveExit - pos.entryPrice : pos.entryPrice - effectiveExit) *
              pos.remainingBtc -
            exitFee;

          const holdHours = Math.max(0, (now - pos.openedAt) / 3600000);
          const fundingIntervals = Math.floor(holdHours / 8);
          const effectiveFunding =
            config.marketVenue === 'BINANCE_FUTURES' && fundingRate !== null && fundingIntervals > 0
              ? (isLong ? 1 : -1) * pos.notionalUsd * fundingRate * fundingIntervals
              : 0;

          updatedEquity += remainNetPnl - effectiveFunding;

          const tp1GrossEstimate = pos.tp1Hit
            ? (isLong ? pos.takeProfit1 - pos.entryPrice : pos.entryPrice - pos.takeProfit1) *
              Math.max(0, pos.sizeBtc - pos.remainingBtc)
            : 0;

          closedTrade = buildClosedTradeRecord({
            pos,
            exitPrice: effectiveExit,
            remainPnl: remainNetPnl,
            remainFee: exitFee,
            remainSlippage: exitSlippage,
            fundingCostUsd: effectiveFunding,
            grossPnlUsd: tp1GrossEstimate + remainGrossPnl,
            exitReason: 'TP2_TARGET',
            closedAt: now,
          });
          workingPosition = null;
        } else if (pos.tp1Hit && workingPosition) {
          if (isLong) {
            const trailSl = Number((price - indicators.atr14 * 1.35).toFixed(2));
            if (trailSl > pos.stopLoss && trailSl < price) pos.stopLoss = trailSl;
          } else {
            const trailSl = Number((price + indicators.atr14 * 1.35).toFixed(2));
            if (trailSl < pos.stopLoss && trailSl > price) pos.stopLoss = trailSl;
          }
        }
      }
    }
  }

  if (closedTrade && workingAccount) {
    workingAccount = updateRiskAccountOnTradeClose(
      workingAccount,
      closedTrade,
      updatedEquity,
      config,
      now,
    );
  }

  // Step 2: Run 6-Agent Council Evaluation + Adversarial Cross-Examination Debate
  const macroSignal = evaluateMacroScout(price, indicators, regime, now);
  const quantSignal = evaluateQuantAnalyst(price, indicators, now);
  const orderflowSignal = evaluateOrderflowRadar(price, indicators, now);

  const consensus = computeConsensus(
    {
      macro_scout: macroSignal,
      quant_analyst: quantSignal,
      orderflow_radar: orderflowSignal,
    },
    config,
  );

  const strategySignal = evaluateStrategyArchitect(
    price,
    indicators,
    regime,
    consensus,
    config,
    now,
  );

  const debate = conductAgentDebate(
    price,
    indicators,
    regime,
    {
      macro_scout: macroSignal,
      quant_analyst: quantSignal,
      orderflow_radar: orderflowSignal,
      strategy_architect: strategySignal,
    },
    consensus,
  );
  const calibratedScore = debate.postDebateScore;

  // Dynamic SL tightening if strong opposing council consensus + sweep emerges while holding
  if (workingPosition && calibratedScore >= 80 && consensus.direction !== 'NEUTRAL') {
    const oppSweep =
      (workingPosition.side === 'LONG' &&
        consensus.direction === 'SHORT' &&
        indicators.sweepSignal === 'BEAR_SWEEP') ||
      (workingPosition.side === 'SHORT' &&
        consensus.direction === 'LONG' &&
        indicators.sweepSignal === 'BULL_SWEEP');

    if (oppSweep) {
      const tightDist = Math.max(indicators.atr14 * 0.85, price * 0.0018);
      if (workingPosition.side === 'LONG') {
        const tightenedSl = Number((price - tightDist).toFixed(2));
        if (tightenedSl > workingPosition.stopLoss && tightenedSl < price) {
          workingPosition.stopLoss = tightenedSl;
        }
      } else {
        const tightenedSl = Number((price + tightDist).toFixed(2));
        if (tightenedSl < workingPosition.stopLoss && tightenedSl > price) {
          workingPosition.stopLoss = tightenedSl;
        }
      }
    }
  }

  if (workingPosition && price > 0) {
    const unrealized =
      workingPosition.side === 'LONG'
        ? (price - workingPosition.entryPrice) * workingPosition.remainingBtc
        : (workingPosition.entryPrice - price) * workingPosition.remainingBtc;
    workingPosition.unrealizedPnl = Number(unrealized.toFixed(2));
    workingPosition.unrealizedPnlPct =
      workingPosition.notionalUsd > 0
        ? Number(
            (
              ((unrealized + workingPosition.realizedPartialPnl) /
                workingPosition.notionalUsd) *
              100
            ).toFixed(2),
          )
        : 0;
  }

  const isLiveScenario = !scenarioHint || scenarioHint === 'auto_live';
  const { signal: riskSignal, risk } = evaluateRiskGuardian(
    price,
    indicators,
    regime,
    consensus.direction,
    calibratedScore,
    updatedEquity,
    config,
    workingPosition !== null,
    now,
    debate,
    workingAccount,
    dataQuality,
    isLiveScenario,
    pendingOrdersMarginUsd,
    workingPosition?.marginUsedUsd ?? 0,
  );

  // Respect closed candle requirement for new entries if active (not blocking exit checks above!)
  const candleClosedReady = !config.requireClosedCandle || lastCandle.isClosed !== false;

  let actionTaken: PipelineCycle['actionTaken'] = 'NO_SETUP';
  let actionNote = 'Đang theo dõi thanh khoản thị trường, chờ điểm hội tụ tối ưu.';
  let commanderDirection: VoteDirection = indicators.dataValid ? 'NEUTRAL' : 'UNAVAILABLE';

  if (!indicators.dataValid || price <= 0) {
    actionTaken = 'VETO_SKIP';
    commanderDirection = 'UNAVAILABLE';
    actionNote = risk.vetoReason ?? 'Thiếu dữ liệu thị trường hợp lệ để thực thi lệnh.';
  } else if (workingPosition) {
    actionTaken = 'HOLD_POSITION';
    commanderDirection = workingPosition.side;
    actionNote = `Đang quản trị lệnh ${workingPosition.side} @ $${workingPosition.entryPrice.toLocaleString('en-US')} (SL $${workingPosition.stopLoss.toLocaleString('en-US')}).`;
  } else if (closedTrade) {
    actionTaken = 'NO_SETUP';
    commanderDirection = 'NEUTRAL';
    actionNote = `Vừa tất toán lệnh ${closedTrade.id} (${closedTrade.pnlUsd >= 0 ? '+' : ''}$${closedTrade.pnlUsd.toFixed(0)}), chờ nến kế tiếp để tái cân bằng.`;
  } else if (
    risk.approved &&
    config.autoExecute &&
    candleClosedReady &&
    (risk.side === 'LONG' || risk.side === 'SHORT')
  ) {
    const isLong = risk.side === 'LONG';
    const entrySlip = risk.entryPrice * slippageRate;
    const fillEntryPrice = Number(
      (isLong ? risk.entryPrice + entrySlip : risk.entryPrice - entrySlip).toFixed(2),
    );
    const slippageUsd = Number((entrySlip * risk.positionSizeBtc).toFixed(2));
    const entryFee = Number((fillEntryPrice * risk.positionSizeBtc * TAKER_FEE_RATE).toFixed(2));

    updatedEquity -= entryFee;
    commanderDirection = risk.side;
    actionTaken = isLong ? 'OPEN_LONG' : 'OPEN_SHORT';
    actionNote = `Khớp ${risk.side} ${risk.positionSizeBtc} BTC @ $${fillEntryPrice.toLocaleString('en-US')} (Phản biện ${calibratedScore}/100) · Net R:R 1:${risk.netRewardRiskRatio}.`;

    const notional = Number((fillEntryPrice * risk.positionSizeBtc).toFixed(2));
    const effLev = config.marketVenue === 'BINANCE_SPOT' ? 1 : Math.max(1, config.maxLeverage);

    workingPosition = {
      id: `TRD-${cycleId.toString().padStart(4, '0')}`,
      side: risk.side,
      entryPrice: fillEntryPrice,
      currentPrice: fillEntryPrice,
      stopLoss: risk.stopLoss,
      initialStopLoss: risk.stopLoss,
      takeProfit1: risk.takeProfit1,
      takeProfit2: risk.takeProfit2,
      liquidationPrice: risk.liquidationPrice,
      marginUsedUsd: Number((notional / effLev).toFixed(2)),
      sizeBtc: risk.positionSizeBtc,
      remainingBtc: risk.positionSizeBtc,
      notionalUsd: notional,
      tp1Hit: false,
      realizedPartialPnl: -entryFee,
      feesPaidUsd: entryFee,
      fundingPaidUsd: 0,
      slippagePaidUsd: slippageUsd,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      openedAt: now,
      openedCandleTime: lastCandle.time,
      consensusScore: calibratedScore,
      regime,
      executionMode: config.executionMode,
      venue: config.marketVenue,
    };

    if (workingAccount) {
      workingAccount = { ...workingAccount, lastOrderAt: now };
    }
  } else if (!risk.approved && consensus.direction !== 'NEUTRAL') {
    commanderDirection = 'VETO';
    actionTaken = 'VETO_SKIP';
    actionNote = risk.vetoReason ?? 'Risk Guardian từ chối lệnh để bảo vệ vốn.';
  } else if (risk.approved && config.autoExecute && !candleClosedReady) {
    actionNote = `Tín hiệu ${risk.side} đạt chuẩn nhưng đang chờ nến M15 đóng cửa để tránh nhiễu nến sống.`;
  }

  const commanderSignal: AgentSignal = {
    agentId: 'execution_commander',
    name: 'Chỉ huy Khớp lệnh',
    role: 'Thực thi & Quản lý Lệnh',
    direction: commanderDirection,
    confidence: !indicators.dataValid
      ? 0
      : workingPosition
        ? calibratedScore
        : risk.approved
          ? calibratedScore
          : 50,
    scoreContribution: !indicators.dataValid ? 0 : calibratedScore,
    summary: actionNote,
    metrics: [
      { label: 'Sau Phản biện', value: `${calibratedScore}/100` },
      {
        label: 'Trạng thái',
        value: !indicators.dataValid
          ? 'UNAVAILABLE'
          : workingPosition
            ? `Đang giữ ${workingPosition.side}`
            : actionTaken === 'VETO_SKIP'
              ? 'Đã chặn'
              : 'Chờ lệnh',
      },
      { label: 'Chế độ', value: config.executionMode },
    ],
    evidence: [actionNote],
    riskFlags: !indicators.dataValid ? ['DATA_UNAVAILABLE'] : risk.vetoCodes,
    dataQuality: indicators.dataStatus,
    errorState: !indicators.dataValid ? 'INVALID_MARKET_DATA' : null,
    latencyMs: 1,
    timestamp: now,
  };

  const signals: Record<AgentId, AgentSignal> = {
    macro_scout: macroSignal,
    quant_analyst: quantSignal,
    orderflow_radar: orderflowSignal,
    strategy_architect: strategySignal,
    risk_guardian: riskSignal,
    execution_commander: commanderSignal,
  };

  return {
    cycle: {
      cycleId,
      timestamp: now,
      stage: 'EXECUTION_SYNC',
      regime,
      regimeConfidence: regimeInfo.confidence,
      consensusScore: calibratedScore,
      preDebateScore: consensus.score,
      dominantDirection: consensus.direction,
      signals,
      debate,
      risk,
      actionTaken,
      actionNote,
      dataQuality,
      dataStatus: indicators.dataStatus,
    },
    indicators,
    nextPosition: workingPosition,
    closedTrade,
    equityAfter: Number(updatedEquity.toFixed(2)),
    nextAccountState: workingAccount,
  };
}

/**
 * Manual BUY / SELL execution strictly enforces Risk Guardian approval
 * WITHOUT inflating consensus score. Rejected orders NEVER deduct fees or mutate equity.
 */
export function createManualPosition(params: {
  id: string;
  side: 'LONG' | 'SHORT';
  candles: Candle[];
  fundingRate: number | null;
  equity: number;
  config: StrategyConfig;
  scenarioHint?: MarketScenario;
  liveOrderbookImbalance?: number;
  spreadBps?: number;
  realAggTradeCvdDelta?: number | null;
  htfContext?: HtfContext;
  accountState?: RiskAccountState;
  dataQuality?: FeedHealthStatus;
  hasActivePosition?: boolean;
  slippageRate?: number;
  pendingOrdersMarginUsd?: number;
  now?: number;
}): ManualOrderResult {
  const {
    id,
    side,
    candles,
    fundingRate,
    equity,
    config,
    scenarioHint,
    liveOrderbookImbalance,
    spreadBps = 0,
    realAggTradeCvdDelta = null,
    htfContext,
    accountState,
    dataQuality = 'HEALTHY',
    hasActivePosition = false,
    slippageRate = 0,
    pendingOrdersMarginUsd = 0,
    now = Date.now(),
  } = params;

  const lastCandle = candles[candles.length - 1];
  if (!lastCandle || !Number.isFinite(lastCandle.close) || lastCandle.close <= 0) {
    const emptyInd = extractIndicators(
      [],
      fundingRate,
      scenarioHint,
      liveOrderbookImbalance,
      htfContext,
      now,
      spreadBps,
      realAggTradeCvdDelta,
    );
    const { risk } = evaluateRiskGuardian(
      0,
      emptyInd,
      'Sideway Nhiễu Rủi ro',
      side,
      0,
      equity,
      config,
      hasActivePosition,
      now,
      undefined,
      accountState,
      dataQuality,
      !scenarioHint || scenarioHint === 'auto_live',
      pendingOrdersMarginUsd,
    );
    return {
      approved: false,
      rejectionReason: risk.vetoReason ?? 'Dữ liệu nến không hợp lệ.',
      vetoCodes: risk.vetoCodes,
      riskEvaluation: risk,
      position: null,
      entryFeeUsd: 0,
      equityAfter: equity,
    };
  }

  const price = lastCandle.close;
  const ind = extractIndicators(
    candles,
    fundingRate,
    scenarioHint,
    liveOrderbookImbalance,
    htfContext,
    now,
    spreadBps,
    realAggTradeCvdDelta,
  );
  const regime = classifyMarketRegime(ind, price, scenarioHint);

  const macroSignal = evaluateMacroScout(price, ind, regime, now);
  const quantSignal = evaluateQuantAnalyst(price, ind, now);
  const orderflowSignal = evaluateOrderflowRadar(price, ind, now);
  const consensus = computeConsensus(
    {
      macro_scout: macroSignal,
      quant_analyst: quantSignal,
      orderflow_radar: orderflowSignal,
    },
    config,
  );
  const strategySignal = evaluateStrategyArchitect(
    price,
    ind,
    regime,
    { direction: side, score: consensus.score },
    config,
    now,
  );

  // Run debate anchored to user's requested manual side so Risk Guardian sees genuine directional risk
  const debate = conductAgentDebate(
    price,
    ind,
    regime,
    {
      macro_scout: macroSignal,
      quant_analyst: quantSignal,
      orderflow_radar: orderflowSignal,
      strategy_architect: strategySignal,
    },
    { direction: side, score: consensus.score },
  );

  // NEVER artificially inflate consensus score with Math.max(..., minConsensusScore)!
  const realScore = debate.postDebateScore;
  const isLiveScenario = !scenarioHint || scenarioHint === 'auto_live';

  const { risk } = evaluateRiskGuardian(
    price,
    ind,
    regime,
    side,
    realScore,
    equity,
    config,
    hasActivePosition,
    now,
    debate,
    accountState,
    dataQuality,
    isLiveScenario,
    pendingOrdersMarginUsd,
  );

  if (!risk.approved || risk.positionSizeBtc <= 0) {
    return {
      approved: false,
      rejectionReason: risk.vetoReason ?? 'Risk Guardian từ chối lệnh thủ công.',
      vetoCodes: risk.vetoCodes,
      riskEvaluation: risk,
      position: null,
      entryFeeUsd: 0,
      equityAfter: Number(equity.toFixed(2)),
    };
  }

  const isLong = side === 'LONG';
  const entrySlip = risk.entryPrice * slippageRate;
  const fillEntryPrice = Number(
    (isLong ? risk.entryPrice + entrySlip : risk.entryPrice - entrySlip).toFixed(2),
  );
  const slippageUsd = Number((entrySlip * risk.positionSizeBtc).toFixed(2));
  const entryFee = Number((fillEntryPrice * risk.positionSizeBtc * TAKER_FEE_RATE).toFixed(2));
  const equityAfter = Number((equity - entryFee).toFixed(2));
  const notional = Number((fillEntryPrice * risk.positionSizeBtc).toFixed(2));
  const effLev = config.marketVenue === 'BINANCE_SPOT' ? 1 : Math.max(1, config.maxLeverage);

  const position: Position = {
    id,
    side,
    entryPrice: fillEntryPrice,
    currentPrice: fillEntryPrice,
    stopLoss: risk.stopLoss,
    initialStopLoss: risk.stopLoss,
    takeProfit1: risk.takeProfit1,
    takeProfit2: risk.takeProfit2,
    liquidationPrice: risk.liquidationPrice,
    marginUsedUsd: Number((notional / effLev).toFixed(2)),
    sizeBtc: risk.positionSizeBtc,
    remainingBtc: risk.positionSizeBtc,
    notionalUsd: notional,
    tp1Hit: false,
    realizedPartialPnl: -entryFee,
    feesPaidUsd: entryFee,
    fundingPaidUsd: 0,
    slippagePaidUsd: slippageUsd,
    unrealizedPnl: 0,
    unrealizedPnlPct: 0,
    openedAt: now,
    openedCandleTime: lastCandle.time,
    consensusScore: realScore,
    regime,
    executionMode: config.executionMode,
    venue: config.marketVenue,
  };

  return {
    approved: true,
    rejectionReason: null,
    vetoCodes: [],
    riskEvaluation: risk,
    position,
    entryFeeUsd: entryFee,
    equityAfter,
  };
}

export function closePositionAtMarket(params: {
  position: Position;
  exitPrice: number;
  equity: number;
  closeRatio?: number;
  useBreakEvenAfterTp1?: boolean;
  exitReason?: ClosedTrade['exitReason'];
  slippageRate?: number;
  now?: number;
}): {
  nextPosition: Position | null;
  closedTrade: ClosedTrade | null;
  partialPnlUsd: number;
  equityAfter: number;
} {
  const {
    position,
    exitPrice,
    equity,
    closeRatio = 1,
    useBreakEvenAfterTp1 = true,
    exitReason = 'MANUAL_CLOSE',
    slippageRate = 0,
    now = Date.now(),
  } = params;

  const isLong = position.side === 'LONG';
  const isPartial = closeRatio > 0 && closeRatio < 1 && !position.tp1Hit;
  const slipImpact = exitPrice * slippageRate;
  const effectiveExit = isLong ? exitPrice - slipImpact : exitPrice + slipImpact;
  const priceDiff = isLong
    ? effectiveExit - position.entryPrice
    : position.entryPrice - effectiveExit;

  if (isPartial) {
    const closeBtc = Math.min(
      position.remainingBtc,
      Number((position.remainingBtc * closeRatio).toFixed(4)),
    );
    const remainBtc = Number(Math.max(0, position.remainingBtc - closeBtc).toFixed(4));
    const exitFee = effectiveExit * closeBtc * TAKER_FEE_RATE;
    const exitSlip = slipImpact * closeBtc;
    const partialPnl = priceDiff * closeBtc - exitFee;
    const updatedEquity = Number((equity + partialPnl).toFixed(2));
    const unrealized = priceDiff * remainBtc;

    let nextSl = position.stopLoss;
    if (useBreakEvenAfterTp1) {
      if (isLong) {
        const beSl = Number((position.entryPrice * 1.0008).toFixed(2));
        if (beSl > nextSl) nextSl = beSl;
      } else {
        const beSl = Number((position.entryPrice * 0.9992).toFixed(2));
        if (beSl < nextSl) nextSl = beSl;
      }
    }

    const nextPosition: Position = {
      ...position,
      currentPrice: Number(exitPrice.toFixed(2)),
      remainingBtc: remainBtc,
      stopLoss: nextSl,
      tp1Hit: true,
      realizedPartialPnl: Number((position.realizedPartialPnl + partialPnl).toFixed(2)),
      feesPaidUsd: Number((position.feesPaidUsd + exitFee).toFixed(2)),
      slippagePaidUsd: Number((position.slippagePaidUsd + exitSlip).toFixed(2)),
      unrealizedPnl: Number(unrealized.toFixed(2)),
      unrealizedPnlPct:
        position.notionalUsd > 0
          ? Number(
              (
                ((unrealized + position.realizedPartialPnl + partialPnl) / position.notionalUsd) *
                100
              ).toFixed(2),
            )
          : 0,
    };

    return {
      nextPosition,
      closedTrade: null,
      partialPnlUsd: Number(partialPnl.toFixed(2)),
      equityAfter: updatedEquity,
    };
  }

  const exitFee = effectiveExit * position.remainingBtc * TAKER_FEE_RATE;
  const exitSlip = slipImpact * position.remainingBtc;
  const remainPnl = priceDiff * position.remainingBtc - exitFee;
  const grossDiff = isLong
    ? exitPrice - position.entryPrice
    : position.entryPrice - exitPrice;
  const remainGross = grossDiff * position.remainingBtc;
  const partialGross = position.tp1Hit
    ? (isLong ? position.takeProfit1 - position.entryPrice : position.entryPrice - position.takeProfit1) *
      Math.max(0, position.sizeBtc - position.remainingBtc)
    : 0;

  const updatedEquity = Number((equity + remainPnl).toFixed(2));
  const closedTrade = buildClosedTradeRecord({
    pos: position,
    exitPrice: effectiveExit,
    remainPnl,
    remainFee: exitFee,
    remainSlippage: exitSlip,
    fundingCostUsd: 0,
    grossPnlUsd: partialGross + remainGross,
    exitReason,
    closedAt: now,
  });

  return {
    nextPosition: null,
    closedTrade,
    partialPnlUsd: Number(remainPnl.toFixed(2)),
    equityAfter: updatedEquity,
  };
}

export function computePerformanceStats(
  initialCapital: number,
  currentEquity: number,
  trades: ClosedTrade[],
  equityHistory: number[],
  options?: {
    barEquitySeries?: number[];
    barIntervalMinutes?: number;
    exposureBars?: number;
    totalBars?: number;
  },
): PerformanceStats {
  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const breakevens = trades.filter((t) => t.outcome === 'BREAKEVEN').length;
  const totalTrades = trades.length;

  const winTrades = trades.filter((t) => t.pnlUsd > 0);
  const lossTrades = trades.filter((t) => t.pnlUsd < 0);

  const grossProfitUsd = winTrades.reduce((a, b) => a + b.pnlUsd, 0);
  const grossLossUsd = Math.abs(lossTrades.reduce((a, b) => a + b.pnlUsd, 0));
  const totalFeesUsd = trades.reduce((a, b) => a + (b.feesPaidUsd ?? 0), 0);
  const totalFundingUsd = trades.reduce((a, b) => a + (b.fundingPaidUsd ?? 0), 0);
  const totalSlippageUsd = trades.reduce((a, b) => a + (b.slippagePaidUsd ?? 0), 0);

  const decided = wins + losses;
  const winRatePct = decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : 0;
  const profitFactor =
    grossLossUsd > 0 ? Number((grossProfitUsd / grossLossUsd).toFixed(2)) : grossProfitUsd > 0 ? 4.5 : 0;
  const expectancyR =
    totalTrades > 0
      ? Number((trades.reduce((a, b) => a + b.rMultiple, 0) / totalTrades).toFixed(2))
      : 0;
  const expectancyUsd =
    totalTrades > 0
      ? Number((trades.reduce((a, b) => a + b.pnlUsd, 0) / totalTrades).toFixed(2))
      : 0;
  const avgWinUsd =
    winTrades.length > 0 ? Number((grossProfitUsd / winTrades.length).toFixed(2)) : 0;
  const avgLossUsd =
    lossTrades.length > 0 ? Number((grossLossUsd / lossTrades.length).toFixed(2)) : 0;
  const avgHoldMinutes =
    totalTrades > 0
      ? Number((trades.reduce((a, b) => a + (b.holdMinutes ?? 0), 0) / totalTrades).toFixed(1))
      : 0;

  const ddSeries =
    options?.barEquitySeries && options.barEquitySeries.length >= 2
      ? options.barEquitySeries
      : equityHistory;

  let peak = initialCapital;
  let maxDd = 0;
  let maxDdUsd = 0;
  let currentDdDuration = 0;
  let maxDdDuration = 0;
  for (const eq of ddSeries) {
    if (eq >= peak) {
      peak = eq;
      currentDdDuration = 0;
    } else {
      currentDdDuration += 1;
      if (currentDdDuration > maxDdDuration) maxDdDuration = currentDdDuration;
    }
    const ddUsd = Math.max(0, peak - eq);
    const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
    if (ddPct > maxDd) maxDd = ddPct;
    if (ddUsd > maxDdUsd) maxDdUsd = ddUsd;
  }

  const netProfitUsd = Number((currentEquity - initialCapital).toFixed(2));
  const totalPnlPct =
    initialCapital > 0 ? Number(((netProfitUsd / initialCapital) * 100).toFixed(2)) : 0;

  const barIntervalMinutes = Math.max(1, options?.barIntervalMinutes ?? 15);
  const totalBars = options?.totalBars ?? options?.barEquitySeries?.length ?? 0;
  const exposurePct =
    totalBars > 0 && options?.exposureBars !== undefined
      ? Number(((options.exposureBars / totalBars) * 100).toFixed(1))
      : 0;

  // Honest CAGR only annualized when sample covers >= 14 days to prevent micro-window explosion
  let years = 0;
  if (totalBars > 1) {
    years = (totalBars * barIntervalMinutes) / (365 * 24 * 60);
  } else if (trades.length >= 2) {
    const minOpen = Math.min(...trades.map((t) => t.openedAt));
    const maxClose = Math.max(...trades.map((t) => t.closedAt));
    years = Math.max(0, (maxClose - minOpen) / (365 * 24 * 60 * 60 * 1000));
  }

  let cagrPct = 0;
  if (years >= 14 / 365 && initialCapital > 0 && currentEquity > 0) {
    const rawCagr = (Math.pow(currentEquity / initialCapital, 1 / years) - 1) * 100;
    cagrPct = Number(Math.max(-99.9, Math.min(999.0, rawCagr)).toFixed(2));
  } else {
    cagrPct = totalPnlPct;
  }

  const calmarRatio =
    maxDd > 0 ? Number(((years >= 14 / 365 ? cagrPct : totalPnlPct) / maxDd).toFixed(2)) : 0;
  const recoveryFactor =
    maxDdUsd > 0
      ? Number((netProfitUsd / maxDdUsd).toFixed(2))
      : netProfitUsd > 0
        ? 4.5
        : 0;

  // Time-series annualized Sharpe & Sortino from per-bar mark-to-market equity returns
  let sharpeRatio = 0;
  let sortinoRatio = 0;
  const barSeries = options?.barEquitySeries;
  if (barSeries && barSeries.length >= 3) {
    const barReturns: number[] = [];
    for (let i = 1; i < barSeries.length; i++) {
      const prev = barSeries[i - 1];
      if (prev > 0) {
        barReturns.push((barSeries[i] - prev) / prev);
      }
    }
    if (barReturns.length >= 2) {
      const barsPerYear = (365 * 24 * 60) / barIntervalMinutes;
      const mean = barReturns.reduce((a, b) => a + b, 0) / barReturns.length;
      const variance =
        barReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / barReturns.length;
      const std = Math.sqrt(variance);
      if (std > 1e-12) {
        sharpeRatio = Number(
          Math.max(-25, Math.min(25, (mean / std) * Math.sqrt(barsPerYear))).toFixed(2),
        );
      }
      const downsideSq = barReturns.map((r) => (r < 0 ? r * r : 0));
      const downsideDev = Math.sqrt(downsideSq.reduce((a, b) => a + b, 0) / barReturns.length);
      if (downsideDev > 1e-12) {
        sortinoRatio = Number(
          Math.max(-25, Math.min(25, (mean / downsideDev) * Math.sqrt(barsPerYear))).toFixed(2),
        );
      } else if (mean > 0) {
        sortinoRatio = 4.5;
      }
    }
  } else if (trades.length >= 2) {
    const returns = trades.map((t) => t.rMultiple);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std > 1e-9) {
      sharpeRatio = Number(((mean / std) * Math.sqrt(12)).toFixed(2));
    }
    const downsideSq = returns.filter((r) => r < 0).map((r) => r * r);
    if (downsideSq.length > 0) {
      const downsideDev = Math.sqrt(downsideSq.reduce((a, b) => a + b, 0) / returns.length);
      sortinoRatio = downsideDev > 0 ? Number(((mean / downsideDev) * Math.sqrt(12)).toFixed(2)) : 0;
    } else if (mean > 0) {
      sortinoRatio = 4.5;
    }
  }

  return {
    equity: Number(currentEquity.toFixed(2)),
    grossProfitUsd: Number(grossProfitUsd.toFixed(2)),
    grossLossUsd: Number(grossLossUsd.toFixed(2)),
    netProfitUsd,
    totalPnlUsd: netProfitUsd,
    totalPnlPct,
    cagrPct,
    totalFeesUsd: Number(totalFeesUsd.toFixed(2)),
    totalFundingUsd: Number(totalFundingUsd.toFixed(2)),
    totalSlippageUsd: Number(totalSlippageUsd.toFixed(2)),
    totalTrades,
    wins,
    losses,
    breakevens,
    winRatePct,
    profitFactor,
    expectancyUsd,
    expectancyR,
    avgWinUsd,
    avgLossUsd,
    avgHoldMinutes,
    maxDrawdownPct: Number(maxDd.toFixed(2)),
    maxDrawdownDurationBars: maxDdDuration,
    calmarRatio,
    recoveryFactor,
    exposurePct,
    sharpeRatio,
    sharpeProxy: sharpeRatio,
    sortinoRatio,
  };
}
