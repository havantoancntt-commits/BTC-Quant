import {
  extractIndicators,
  generateRealisticBTCSeries,
} from './indicators';
import type {
  AgentDebateSummary,
  AgentId,
  AgentSignal,
  BacktestReport,
  Candle,
  ClosedTrade,
  DebateChallenge,
  HtfContext,
  MarketRegime,
  MarketScenario,
  PerformanceStats,
  PipelineCycle,
  Position,
  RiskEvaluation,
  StrategyConfig,
  TechnicalIndicators,
  VoteDirection,
} from './types';

const TAKER_FEE_RATE = 0.0004; // 0.04% institutional VIP taker fee per side

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  initialCapital: 100000,
  riskPerTradePct: 1.25,
  maxLeverage: 3,
  minConsensusScore: 70,
  minRewardRisk: 2.0,
  autoExecute: true,
  useBreakEvenAfterTp1: true,
  vetoChoppyMarket: true,
  agentWeights: {
    macro_scout: 0.25,
    quant_analyst: 0.45,
    orderflow_radar: 0.30,
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
      riskPerTradePct: 0.75,
      maxLeverage: 2,
      minConsensusScore: 78,
      minRewardRisk: 2.4,
      useBreakEvenAfterTp1: true,
      vetoChoppyMarket: true,
    },
  },
  {
    id: 'balanced',
    name: 'Cân bằng Chuẩn Quỹ',
    subtitle: 'Rủi ro 1.25% · Đồng thuận ≥ 70 · R:R 1:2.0',
    config: {
      riskPerTradePct: 1.25,
      maxLeverage: 3,
      minConsensusScore: 70,
      minRewardRisk: 2.0,
      useBreakEvenAfterTp1: true,
      vetoChoppyMarket: true,
    },
  },
  {
    id: 'aggressive',
    name: 'Săn Xu hướng Chủ động',
    subtitle: 'Rủi ro 2.0% · Đồng thuận ≥ 64 · Đòn bẩy 4x',
    config: {
      riskPerTradePct: 2.0,
      maxLeverage: 4,
      minConsensusScore: 64,
      minRewardRisk: 1.8,
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
  if (sum <= 0) {
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
    'PnL_USD',
    'PnL_Pct',
    'RMultiple',
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
      t.pnlUsd.toFixed(2),
      t.pnlPct.toFixed(2),
      t.rMultiple.toFixed(2),
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

export function classifyMarketRegime(
  ind: TechnicalIndicators,
  price: number,
  scenarioHint?: MarketScenario,
): MarketRegime {
  if (scenarioHint === 'choppy_range') return 'Sideway Nhiễu Rủi ro';
  if (scenarioHint === 'liquidity_sweep' || ind.sweepSignal !== 'NONE') {
    return 'Quét Thanh khoản & Hấp thụ';
  }
  if (ind.adxProxy < 15 && ind.bbBandwidth < 0.012 && ind.volumeRatio < 0.85) {
    return 'Sideway Nhiễu Rủi ro';
  }
  if (ind.bbBandwidth < 0.014) {
    return 'Tích lũy Nén Biến động';
  }
  if (price > ind.ema50 && ind.ema21 > ind.ema50) {
    return 'Mở rộng Xu hướng Tăng';
  }
  if (price < ind.ema50 && ind.ema21 < ind.ema50) {
    return 'Mở rộng Xu hướng Giảm';
  }
  return 'Tích lũy Nén Biến động';
}

export function evaluateMacroScout(
  price: number,
  ind: TechnicalIndicators,
  regime: MarketRegime,
  now: number,
): AgentSignal {
  let bullPts = 0;
  let bearPts = 0;

  if (price > ind.ema200) bullPts += 24;
  else bearPts += 24;

  if (ind.ema50 > ind.ema200) bullPts += 20;
  else bearPts += 20;

  // Higher-timeframe (H1 / H4) confluence boost
  if (ind.h4Bias === 'LONG') bullPts += 14;
  else if (ind.h4Bias === 'SHORT') bearPts += 14;

  if (ind.h1Bias === 'LONG') bullPts += 10;
  else if (ind.h1Bias === 'SHORT') bearPts += 10;

  if (ind.spotCvdDelta > 4) bullPts += 22;
  else if (ind.spotCvdDelta < -4) bearPts += 22;

  // Contrarian funding check: extreme positive funding warns against overheated longs
  if (ind.fundingRate > 0.0006) {
    bearPts += 16;
  } else if (ind.fundingRate < -0.0003) {
    bullPts += 16;
  } else if (ind.spotCvdDelta >= 0) {
    bullPts += 10;
  } else {
    bearPts += 10;
  }

  let direction: VoteDirection = 'NEUTRAL';
  let confidence = 52;
  if (regime === 'Sideway Nhiễu Rủi ro') {
    direction = 'NEUTRAL';
    confidence = 44;
  } else if (bullPts - bearPts >= 18) {
    direction = 'LONG';
    confidence = Math.min(96, 52 + (bullPts - bearPts) * 0.58);
  } else if (bearPts - bullPts >= 18) {
    direction = 'SHORT';
    confidence = Math.min(96, 52 + (bearPts - bullPts) * 0.58);
  }

  const summary =
    direction === 'LONG'
      ? `Dòng tiền Spot CVD (+$${ind.spotCvdDelta.toFixed(1)}M), HTF (${ind.h1Bias}/${ind.h4Bias}) & giá trên EMA200 hỗ trợ tăng.`
      : direction === 'SHORT'
        ? `Áp lực bán Spot CVD ($${ind.spotCvdDelta.toFixed(1)}M), HTF (${ind.h1Bias}/${ind.h4Bias}) ưu tiên phòng thủ giảm.`
        : `Thị trường thiếu đồng pha vĩ mô M15–H4 (${regime}), khuyến nghị quan sát.`;

  return {
    agentId: 'macro_scout',
    name: 'Trinh sát Vĩ mô',
    role: 'On-Chain & Đa khung',
    direction,
    confidence: Math.round(confidence),
    scoreContribution: Math.round(confidence),
    summary,
    metrics: [
      { label: 'Spot CVD', value: `${ind.spotCvdDelta >= 0 ? '+' : ''}$${ind.spotCvdDelta.toFixed(1)}M` },
      { label: 'HTF H1/H4', value: `${ind.h1Bias}/${ind.h4Bias}` },
      { label: 'Funding', value: `${(ind.fundingRate * 100).toFixed(3)}%` },
    ],
    timestamp: now,
  };
}

export function evaluateQuantAnalyst(
  price: number,
  ind: TechnicalIndicators,
  now: number,
): AgentSignal {
  let bullFactors = 0;
  let bearFactors = 0;

  // 1. EMA ribbon alignment
  if (ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50) bullFactors += 2;
  else if (ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50) bearFactors += 2;
  else if (price > ind.ema21) bullFactors += 1;
  else bearFactors += 1;

  // 2. RSI healthy momentum zone (avoid buying extreme overbought > 76)
  if (ind.rsi14 >= 46 && ind.rsi14 <= 70) bullFactors += 1.5;
  else if (ind.rsi14 <= 54 && ind.rsi14 >= 30) bearFactors += 1.5;
  else if (ind.rsi14 > 76) bearFactors += 1;
  else if (ind.rsi14 < 24) bullFactors += 1;

  // 3. MACD histogram momentum
  if (ind.macdHistogram > 0 && ind.macdLine > ind.macdSignal) bullFactors += 1.5;
  else if (ind.macdHistogram < 0 && ind.macdLine < ind.macdSignal) bearFactors += 1.5;

  // 4. VWAP position
  if (price > ind.vwap24) bullFactors += 1;
  else bearFactors += 1;

  // 5. Swing structure BoS / HH-HL alignment
  if (ind.structureBias === 'BULLISH') bullFactors += 1.2;
  else if (ind.structureBias === 'BEARISH') bearFactors += 1.2;

  let direction: VoteDirection = 'NEUTRAL';
  let confidence = 50;
  const diff = bullFactors - bearFactors;
  if (diff >= 1.5) {
    direction = 'LONG';
    confidence = Math.min(96, 55 + diff * 7.8);
  } else if (diff <= -1.5) {
    direction = 'SHORT';
    confidence = Math.min(96, 55 + Math.abs(diff) * 7.8);
  }

  const structLabel =
    ind.structureBias === 'BULLISH' ? 'Tăng' : ind.structureBias === 'BEARISH' ? 'Giảm' : 'Ngang';

  const summary =
    direction === 'LONG'
      ? `Hội tụ ${bullFactors.toFixed(1)}/7.2 điểm: EMA9>21>50, RSI(${ind.rsi14.toFixed(1)}), cấu trúc ${structLabel}.`
      : direction === 'SHORT'
        ? `Hội tụ ${bearFactors.toFixed(1)}/7.2 tín hiệu giảm: Dưới VWAP, MACD âm, cấu trúc ${structLabel}.`
        : `Động lượng phân hóa (RSI ${ind.rsi14.toFixed(1)}, cấu trúc ${structLabel}), chưa đạt ngưỡng vào.`;

  return {
    agentId: 'quant_analyst',
    name: 'Chuyên gia Định lượng',
    role: 'Hội tụ Đa Chỉ báo',
    direction,
    confidence: Math.round(confidence),
    scoreContribution: Math.round(confidence),
    summary,
    metrics: [
      { label: 'RSI(14)', value: ind.rsi14.toFixed(1) },
      { label: 'Cấu trúc', value: structLabel },
      { label: 'ATR(14)', value: `$${ind.atr14.toFixed(0)}` },
    ],
    timestamp: now,
  };
}

export function evaluateOrderflowRadar(
  price: number,
  ind: TechnicalIndicators,
  now: number,
): AgentSignal {
  let bullScore = 0;
  let bearScore = 0;

  if (ind.orderbookImbalance > 0.2) bullScore += 36;
  else if (ind.orderbookImbalance < -0.2) bearScore += 36;

  if (ind.sweepSignal === 'BULL_SWEEP') bullScore += 38;
  else if (ind.sweepSignal === 'BEAR_SWEEP') bearScore += 38;

  if (ind.volumeRatio >= 1.15) {
    if (price >= ind.vwap24) bullScore += 22;
    else bearScore += 22;
  }

  let direction: VoteDirection = 'NEUTRAL';
  let confidence = 48;
  if (bullScore - bearScore >= 24) {
    direction = 'LONG';
    confidence = Math.min(97, 54 + (bullScore - bearScore) * 0.55);
  } else if (bearScore - bullScore >= 24) {
    direction = 'SHORT';
    confidence = Math.min(97, 54 + (bearScore - bullScore) * 0.55);
  }

  const imbalancePct = Math.round(ind.orderbookImbalance * 100);
  const summary =
    ind.sweepSignal === 'BULL_SWEEP'
      ? `Phát hiện quét rũ thanh khoản đáy + hấp thụ lệnh mua (${imbalancePct}% Bid), điểm vào sắc nét.`
      : ind.sweepSignal === 'BEAR_SWEEP'
        ? `Từ chối thanh khoản đỉnh kèm tường bán áp đảo (${imbalancePct}% Ask).`
        : direction !== 'NEUTRAL'
          ? `Mất cân bằng sổ lệnh ${imbalancePct >= 0 ? '+' : ''}${imbalancePct}%, khối lượng gấp ${ind.volumeRatio.toFixed(2)}x trung bình.`
          : `Sổ lệnh cân bằng (${imbalancePct}%), chưa thấy dấu chân cá voi rõ rệt.`;

  return {
    agentId: 'orderflow_radar',
    name: 'Radar Sổ lệnh',
    role: 'Thanh khoản & Cá voi',
    direction,
    confidence: Math.round(confidence),
    scoreContribution: Math.round(confidence),
    summary,
    metrics: [
      { label: 'Orderbook', value: `${imbalancePct >= 0 ? '+' : ''}${imbalancePct}%` },
      { label: 'Vol Ratio', value: `${ind.volumeRatio.toFixed(2)}x` },
      { label: 'Sweep', value: ind.sweepSignal === 'NONE' ? 'Không' : ind.sweepSignal === 'BULL_SWEEP' ? 'Rũ đáy' : 'Rũ đỉnh' },
    ],
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
  },
  consensus: { direction: 'LONG' | 'SHORT' | 'NEUTRAL'; score: number },
): AgentDebateSummary {
  const preDebateScore = consensus.score;
  const turns: DebateChallenge[] = [];

  if (consensus.direction === 'NEUTRAL') {
    turns.push({
      id: 'debate-neutral-hold',
      challenger: 'risk_guardian',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 0,
      title: 'Đồng thuận chưa phân hóa hướng đi',
      argument: `Macro (${signals.macro_scout.direction}), Quant (${signals.quant_analyst.direction}) và Orderflow (${signals.orderflow_radar.direction}) đang giữ thế cân bằng trong pha ${regime}. Bảo toàn vốn tiền mặt.`,
    });
    return {
      preDebateScore,
      postDebateScore: preDebateScore,
      scoreDelta: 0,
      challengesCount: 0,
      criticalVetoTriggered: false,
      verdict: 'Hội đồng thống nhất giữ nguyên thanh khoản, chưa kích hoạt phản biện mở lệnh.',
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
        ? `Đề xuất ${side} đi ngược khung H4 (${ind.h4Bias}), tuy nhiên có nến rũ thanh khoản xác nhận đảo chiều nên giảm nhẹ ${Math.abs(penalty)}đ thay vì chặn cứng.`
        : `Quant đề xuất ${side} trên M15 nhưng khung H4 vẫn duy trì xu hướng ${ind.h4Bias}. Giao dịch ngược dòng chính làm giảm xác suất thắng, trừ ${Math.abs(penalty)}đ.`,
    });
  } else if (ind.htfBias === side && ind.h1Bias === ind.h4Bias) {
    turns.push({
      id: 'debate-macro-htf-confirm',
      challenger: 'macro_scout',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 8,
      title: `Xác nhận Đồng pha Đa khung H1/H4 (${side})`,
      argument: `Cả khung H1 và H4 đều đồng thuận ${side}, trùng nhịp dòng tiền Spot CVD (${ind.spotCvdDelta >= 0 ? '+' : ''}$${ind.spotCvdDelta.toFixed(1)}M). Cộng +8đ tin cậy.`,
    });
  }

  // Turn 2: Orderflow Radar cross-examines real-time orderbook wall & liquidity traps
  const oppOrderbook =
    (side === 'LONG' && ind.orderbookImbalance <= -0.22) ||
    (side === 'SHORT' && ind.orderbookImbalance >= 0.22);
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
      title: oppSweep ? 'Cảnh báo Bẫy Thanh khoản Ngược chiều' : 'Phản đối Tường lệnh Sổ cái Áp đảo',
      argument: oppSweep
        ? `Phát hiện nến từ chối râu dài (${ind.sweepSignal}) chống lại lệnh ${side}. Nguy cơ bull/bear trap cao, đề xuất hạ -18đ và kích hoạt cổng VETO.`
        : `Tỷ lệ sổ lệnh đang nghiêng mạnh về phía đối nghịch (${imbPct >= 0 ? '+' : ''}${imbPct}%), tường thanh khoản cản đường giá. Hạ -18đ tin cậy.`,
    });
  } else if (
    hasAlignedSweep ||
    (side === 'LONG' && ind.orderbookImbalance >= 0.24) ||
    (side === 'SHORT' && ind.orderbookImbalance <= -0.24)
  ) {
    const imbPct = Math.round(ind.orderbookImbalance * 100);
    turns.push({
      id: 'debate-orderflow-confirm',
      challenger: 'orderflow_radar',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 8,
      title: hasAlignedSweep ? 'Xác nhận Hấp thụ Liquidity Sweep' : 'Xác nhận Sổ lệnh Đồng thuận',
      argument: hasAlignedSweep
        ? `Dòng tiền thực khớp nến quét thanh khoản (${ind.sweepSignal}) kèm khối lượng ${ind.volumeRatio.toFixed(2)}x, xác nhận tay to gom hàng. Cộng +8đ.`
        : `Lực đỡ sổ lệnh (${imbPct >= 0 ? '+' : ''}${imbPct}%) hỗ trợ trực tiếp hướng ${side}. Cộng +8đ tin cậy.`,
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
      argument: `RSI đạt ${ind.rsi14.toFixed(1)} và giá lệch ${atrStretch.toFixed(1)}x ATR khỏi EMA21. Rủi ro nhịp hồi kỹ thuật quét SL ngay khi vào lệnh, trừ -14đ.`,
    });
  } else if (structConflict) {
    turns.push({
      id: 'debate-quant-structure',
      challenger: 'quant_analyst',
      target: 'orderflow_radar',
      stance: 'CHALLENGE',
      impactScore: -10,
      title: `Cấu trúc Sóng Đỉnh/Đáy chưa xác nhận (${ind.structureBias})`,
      argument: `Cấu trúc 16 nến gần nhất vẫn nghiêng về ${ind.structureBias} trong khi đề xuất là ${side}. Cần thận trọng trừ -10đ.`,
    });
  } else if (structAligned) {
    turns.push({
      id: 'debate-quant-structure-ok',
      challenger: 'quant_analyst',
      target: 'PROPOSED_TRADE',
      stance: 'SUPPORT',
      impactScore: 6,
      title: `Xác nhận Cấu trúc Phá vỡ (BoS ${ind.structureBias})`,
      argument: `Giá xác lập đỉnh/đáy cao-thấp đồng thuận hướng ${side} với độ giãn cách EMA21 hợp lý (${atrStretch.toFixed(1)}x ATR). Cộng +6đ.`,
    });
  }

  // Turn 4: Funding squeeze warning
  if (
    (side === 'LONG' && ind.fundingRate > 0.0006) ||
    (side === 'SHORT' && ind.fundingRate < -0.0003)
  ) {
    turns.push({
      id: 'debate-macro-funding',
      challenger: 'macro_scout',
      target: 'PROPOSED_TRADE',
      stance: 'CHALLENGE',
      impactScore: -10,
      title: 'Cảnh báo Quá nhiệt Funding Rate',
      argument: `Funding ở mức ${(ind.fundingRate * 100).toFixed(3)}%, dễ xuất hiện nhịp quét đòn bẩy ngược chiều ${side}. Trừ -10đ.`,
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
      : `Hội đồng đồng thuận tuyệt đối hướng ${side}: ${postDebateScore}/100 (+${scoreDelta}đ cộng hưởng).`;

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
): { signal: AgentSignal; risk: RiskEvaluation } {
  const atr = Math.max(ind.atr14, price * 0.0025);
  const stopDist = atr * 1.55;
  const tp1Dist = stopDist * 1.45;
  const tp2Dist = stopDist * Math.max(config.minRewardRisk, 2.55);

  const rewardRiskRatio = Number((tp2Dist / stopDist).toFixed(2));

  // Half-Kelly calculation based on debate-calibrated win probability
  const estWinProb = Math.min(0.8, Math.max(0.46, 0.4 + (consensusScore / 100) * 0.4));
  const fullKelly = estWinProb - (1 - estWinProb) / rewardRiskRatio;
  const halfKellyPct = Math.max(0.4, Math.min(config.riskPerTradePct, fullKelly * 0.5 * 100));

  const riskAmountUsd = Number(((equity * halfKellyPct) / 100).toFixed(2));
  const rawBtcSize = riskAmountUsd / stopDist;
  const maxNotional = equity * config.maxLeverage;
  const cappedNotional = Math.min(maxNotional, rawBtcSize * price);
  const positionSizeBtc = Number((cappedNotional / price).toFixed(4));

  // Fee-adjusted Net R:R accounting for round-trip 0.08% institutional taker fee
  const estFeeUsd = Number((cappedNotional * (TAKER_FEE_RATE * 2)).toFixed(2));
  const grossRewardUsd = tp2Dist * positionSizeBtc;
  const grossRiskUsd = Math.max(1, stopDist * positionSizeBtc);
  const netRewardRiskRatio = Number(
    Math.max(0, (grossRewardUsd - estFeeUsd) / (grossRiskUsd + estFeeUsd)).toFixed(2),
  );

  let vetoReason: string | null = null;
  if (hasActivePosition) {
    vetoReason = 'Đang có vị thế mở — ưu tiên quản lý lệnh hiện tại, không chồng lệnh.';
  } else if (dominantDirection === 'NEUTRAL') {
    vetoReason = 'Chưa xác lập hướng đi đồng thuận từ hội đồng phân tích.';
  } else if (config.vetoChoppyMarket && regime === 'Sideway Nhiễu Rủi ro') {
    vetoReason = 'VETO: Phát hiện vùng Sideway nhiễu thanh khoản thấp, tỷ lệ thắng không đạt chuẩn.';
  } else if (debate?.criticalVetoTriggered) {
    vetoReason = `VETO Phản biện: ${debate.verdict}`;
  } else if (consensusScore < config.minConsensusScore) {
    vetoReason = `VETO: Điểm đồng thuận sau phản biện (${consensusScore}/100) thấp hơn ngưỡng (${config.minConsensusScore}).`;
  } else if (netRewardRiskRatio < config.minRewardRisk * 0.9) {
    vetoReason = `VETO: R:R ròng sau phí (${netRewardRiskRatio}) thấp hơn chuẩn tối thiểu.`;
  } else if (ind.atr14 / price > 0.032) {
    vetoReason = 'VETO: Biến động ATR bất thường (>3.2%), kích hoạt khiên bảo vệ vốn.';
  }

  const approved = vetoReason === null;
  const entryPrice = Number(price.toFixed(2));
  const stopLoss =
    dominantDirection === 'LONG'
      ? Number((price - stopDist).toFixed(2))
      : Number((price + stopDist).toFixed(2));
  const takeProfit1 =
    dominantDirection === 'LONG'
      ? Number((price + tp1Dist).toFixed(2))
      : Number((price - tp1Dist).toFixed(2));
  const takeProfit2 =
    dominantDirection === 'LONG'
      ? Number((price + tp2Dist).toFixed(2))
      : Number((price - tp2Dist).toFixed(2));

  const risk: RiskEvaluation = {
    approved,
    vetoReason,
    side: dominantDirection === 'NEUTRAL' ? 'NONE' : dominantDirection,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    rewardRiskRatio,
    netRewardRiskRatio,
    kellyFractionPct: Number(halfKellyPct.toFixed(2)),
    positionSizeBtc,
    positionNotionalUsd: Number(cappedNotional.toFixed(2)),
    riskAmountUsd,
    estFeeUsd,
  };

  const signal: AgentSignal = {
    agentId: 'risk_guardian',
    name: 'Giám đốc Rủi ro',
    role: 'Kelly & Trọng tài VETO',
    direction: approved ? (dominantDirection === 'LONG' ? 'LONG' : 'SHORT') : 'VETO',
    confidence: approved ? Math.min(98, Math.round(70 + netRewardRiskRatio * 7.5)) : 93,
    scoreContribution: approved ? 100 : 0,
    summary: approved
      ? `DUYỆT LỆNH: Half-Kelly ${risk.kellyFractionPct}% (${positionSizeBtc} BTC), R:R ròng 1:${netRewardRiskRatio}, SL $${stopLoss.toLocaleString('en-US')}.`
      : vetoReason ?? 'Từ chối mở lệnh.',
    metrics: [
      { label: 'Half-Kelly', value: `${risk.kellyFractionPct}%` },
      { label: 'Net R:R', value: `1:${netRewardRiskRatio}` },
      { label: 'Phí 2 chiều', value: `$${estFeeUsd.toFixed(0)}` },
    ],
    timestamp: now,
  };

  return { signal, risk };
}

export function runPipelineCycle(params: {
  cycleId: number;
  candles: Candle[];
  fundingRate: number;
  equity: number;
  activePosition: Position | null;
  config: StrategyConfig;
  scenarioHint?: MarketScenario;
  liveOrderbookImbalance?: number;
  htfContext?: HtfContext;
  now?: number;
}): {
  cycle: PipelineCycle;
  indicators: TechnicalIndicators;
  nextPosition: Position | null;
  closedTrade: ClosedTrade | null;
  equityAfter: number;
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
    htfContext,
    now = Date.now(),
  } = params;

  const lastCandle = candles[candles.length - 1];
  const price = lastCandle.close;
  const indicators = extractIndicators(
    candles,
    fundingRate,
    scenarioHint,
    liveOrderbookImbalance,
    htfContext,
    now,
  );
  const regime = classifyMarketRegime(indicators, price, scenarioHint);

  // Step 1: Update or close existing active position against latest candle high/low/close
  let workingPosition = activePosition ? { ...activePosition } : null;
  let closedTrade: ClosedTrade | null = null;
  let updatedEquity = equity;

  if (workingPosition) {
    const pos = workingPosition;
    pos.currentPrice = price;

    if (pos.side === 'LONG') {
      const hitStop = lastCandle.low <= pos.stopLoss;
      const hitTp2 = lastCandle.high >= pos.takeProfit2;
      const hitTp1 = !pos.tp1Hit && lastCandle.high >= pos.takeProfit1;

      if (hitStop && !hitTp2) {
        const exitPrice = pos.stopLoss;
        const exitFee = exitPrice * pos.remainingBtc * TAKER_FEE_RATE;
        const remainPnl = (exitPrice - pos.entryPrice) * pos.remainingBtc - exitFee;
        const totalPnl = pos.realizedPartialPnl + remainPnl;
        const initialRiskUsd = Math.max(1, Math.abs(pos.entryPrice - pos.initialStopLoss) * pos.sizeBtc);
        const rMult = totalPnl / initialRiskUsd;
        const outcome: ClosedTrade['outcome'] =
          totalPnl > 15 ? 'WIN' : totalPnl < -15 ? 'LOSS' : 'BREAKEVEN';

        updatedEquity += remainPnl;
        closedTrade = {
          id: pos.id,
          side: 'LONG',
          entryPrice: pos.entryPrice,
          exitPrice: Number(exitPrice.toFixed(2)),
          sizeBtc: pos.sizeBtc,
          pnlUsd: Number(totalPnl.toFixed(2)),
          pnlPct: Number(((totalPnl / pos.notionalUsd) * 100).toFixed(2)),
          rMultiple: Number(rMult.toFixed(2)),
          outcome,
          exitReason: pos.tp1Hit ? 'BREAKEVEN_STOP' : 'STOP_LOSS',
          openedAt: pos.openedAt,
          closedAt: now,
          consensusScore: pos.consensusScore,
          regime: pos.regime,
        };
        workingPosition = null;
      } else {
        if (hitTp1) {
          const halfSize = Number((pos.remainingBtc * 0.5).toFixed(4));
          const partialExitFee = pos.takeProfit1 * halfSize * TAKER_FEE_RATE;
          const partialPnl = (pos.takeProfit1 - pos.entryPrice) * halfSize - partialExitFee;
          pos.realizedPartialPnl += partialPnl;
          pos.remainingBtc = Number((pos.remainingBtc - halfSize).toFixed(4));
          pos.tp1Hit = true;
          updatedEquity += partialPnl;
          if (config.useBreakEvenAfterTp1) {
            pos.stopLoss = Number((pos.entryPrice * 1.0008).toFixed(2));
          }
        }
        if (hitTp2) {
          const exitPrice = pos.takeProfit2;
          const exitFee = exitPrice * pos.remainingBtc * TAKER_FEE_RATE;
          const remainPnl = (exitPrice - pos.entryPrice) * pos.remainingBtc - exitFee;
          const totalPnl = pos.realizedPartialPnl + remainPnl;
          const initialRiskUsd = Math.max(1, Math.abs(pos.entryPrice - pos.initialStopLoss) * pos.sizeBtc);
          updatedEquity += remainPnl;
          closedTrade = {
            id: pos.id,
            side: 'LONG',
            entryPrice: pos.entryPrice,
            exitPrice: Number(exitPrice.toFixed(2)),
            sizeBtc: pos.sizeBtc,
            pnlUsd: Number(totalPnl.toFixed(2)),
            pnlPct: Number(((totalPnl / pos.notionalUsd) * 100).toFixed(2)),
            rMultiple: Number((totalPnl / initialRiskUsd).toFixed(2)),
            outcome: 'WIN',
            exitReason: 'TP2_TARGET',
            openedAt: pos.openedAt,
            closedAt: now,
            consensusScore: pos.consensusScore,
            regime: pos.regime,
          };
          workingPosition = null;
        } else if (pos.tp1Hit) {
          // Trail SL behind price by 1.35 ATR
          const trailSl = Number((price - indicators.atr14 * 1.35).toFixed(2));
          if (trailSl > pos.stopLoss) pos.stopLoss = trailSl;
        }
      }
    } else {
      // SHORT position
      const hitStop = lastCandle.high >= pos.stopLoss;
      const hitTp2 = lastCandle.low <= pos.takeProfit2;
      const hitTp1 = !pos.tp1Hit && lastCandle.low <= pos.takeProfit1;

      if (hitStop && !hitTp2) {
        const exitPrice = pos.stopLoss;
        const exitFee = exitPrice * pos.remainingBtc * TAKER_FEE_RATE;
        const remainPnl = (pos.entryPrice - exitPrice) * pos.remainingBtc - exitFee;
        const totalPnl = pos.realizedPartialPnl + remainPnl;
        const initialRiskUsd = Math.max(1, Math.abs(pos.initialStopLoss - pos.entryPrice) * pos.sizeBtc);
        const rMult = totalPnl / initialRiskUsd;
        const outcome: ClosedTrade['outcome'] =
          totalPnl > 15 ? 'WIN' : totalPnl < -15 ? 'LOSS' : 'BREAKEVEN';

        updatedEquity += remainPnl;
        closedTrade = {
          id: pos.id,
          side: 'SHORT',
          entryPrice: pos.entryPrice,
          exitPrice: Number(exitPrice.toFixed(2)),
          sizeBtc: pos.sizeBtc,
          pnlUsd: Number(totalPnl.toFixed(2)),
          pnlPct: Number(((totalPnl / pos.notionalUsd) * 100).toFixed(2)),
          rMultiple: Number(rMult.toFixed(2)),
          outcome,
          exitReason: pos.tp1Hit ? 'BREAKEVEN_STOP' : 'STOP_LOSS',
          openedAt: pos.openedAt,
          closedAt: now,
          consensusScore: pos.consensusScore,
          regime: pos.regime,
        };
        workingPosition = null;
      } else {
        if (hitTp1) {
          const halfSize = Number((pos.remainingBtc * 0.5).toFixed(4));
          const partialExitFee = pos.takeProfit1 * halfSize * TAKER_FEE_RATE;
          const partialPnl = (pos.entryPrice - pos.takeProfit1) * halfSize - partialExitFee;
          pos.realizedPartialPnl += partialPnl;
          pos.remainingBtc = Number((pos.remainingBtc - halfSize).toFixed(4));
          pos.tp1Hit = true;
          updatedEquity += partialPnl;
          if (config.useBreakEvenAfterTp1) {
            pos.stopLoss = Number((pos.entryPrice * 0.9992).toFixed(2));
          }
        }
        if (hitTp2) {
          const exitPrice = pos.takeProfit2;
          const exitFee = exitPrice * pos.remainingBtc * TAKER_FEE_RATE;
          const remainPnl = (pos.entryPrice - exitPrice) * pos.remainingBtc - exitFee;
          const totalPnl = pos.realizedPartialPnl + remainPnl;
          const initialRiskUsd = Math.max(1, Math.abs(pos.initialStopLoss - pos.entryPrice) * pos.sizeBtc);
          updatedEquity += remainPnl;
          closedTrade = {
            id: pos.id,
            side: 'SHORT',
            entryPrice: pos.entryPrice,
            exitPrice: Number(exitPrice.toFixed(2)),
            sizeBtc: pos.sizeBtc,
            pnlUsd: Number(totalPnl.toFixed(2)),
            pnlPct: Number(((totalPnl / pos.notionalUsd) * 100).toFixed(2)),
            rMultiple: Number((totalPnl / initialRiskUsd).toFixed(2)),
            outcome: 'WIN',
            exitReason: 'TP2_TARGET',
            openedAt: pos.openedAt,
            closedAt: now,
            consensusScore: pos.consensusScore,
            regime: pos.regime,
          };
          workingPosition = null;
        } else if (pos.tp1Hit) {
          const trailSl = Number((price + indicators.atr14 * 1.35).toFixed(2));
          if (trailSl < pos.stopLoss) pos.stopLoss = trailSl;
        }
      }
    }
  }

  // Step 2: Run 5-Agent Council Evaluation + Adversarial Cross-Examination Debate
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

  const debate = conductAgentDebate(
    price,
    indicators,
    regime,
    {
      macro_scout: macroSignal,
      quant_analyst: quantSignal,
      orderflow_radar: orderflowSignal,
    },
    consensus,
  );
  const calibratedScore = debate.postDebateScore;

  // Dynamic SL tightening if strong opposing council consensus + sweep reversal emerges while holding position
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

  if (workingPosition) {
    const unrealized =
      workingPosition.side === 'LONG'
        ? (price - workingPosition.entryPrice) * workingPosition.remainingBtc
        : (workingPosition.entryPrice - price) * workingPosition.remainingBtc;
    workingPosition.unrealizedPnl = Number(unrealized.toFixed(2));
    workingPosition.unrealizedPnlPct = Number(
      (((unrealized + workingPosition.realizedPartialPnl) / workingPosition.notionalUsd) * 100).toFixed(2),
    );
  }

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
  );

  let actionTaken: PipelineCycle['actionTaken'] = 'NO_SETUP';
  let actionNote = 'Đang theo dõi thanh khoản thị trường, chờ điểm hội tụ tối ưu.';
  let commanderDirection: VoteDirection = 'NEUTRAL';

  if (workingPosition) {
    actionTaken = 'HOLD_POSITION';
    commanderDirection = workingPosition.side;
    actionNote = `Đang quản trị lệnh ${workingPosition.side} @ $${workingPosition.entryPrice.toLocaleString('en-US')} (SL $${workingPosition.stopLoss.toLocaleString('en-US')}).`;
  } else if (closedTrade) {
    actionTaken = 'NO_SETUP';
    commanderDirection = 'NEUTRAL';
    actionNote = `Vừa tất toán lệnh ${closedTrade.id} (${closedTrade.outcome === 'WIN' ? '+' : ''}$${closedTrade.pnlUsd.toFixed(0)}), chờ nến kế tiếp để tái cân bằng.`;
  } else if (risk.approved && config.autoExecute && (risk.side === 'LONG' || risk.side === 'SHORT')) {
    const entryFee = Number((risk.positionNotionalUsd * TAKER_FEE_RATE).toFixed(2));
    updatedEquity -= entryFee;
    commanderDirection = risk.side;
    actionTaken = risk.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT';
    actionNote = `Khớp ${risk.side} ${risk.positionSizeBtc} BTC @ $${risk.entryPrice.toLocaleString('en-US')} (Phản biện ${calibratedScore}/100) · R:R ròng 1:${risk.netRewardRiskRatio}.`;
    workingPosition = {
      id: `TRD-${cycleId.toString().padStart(4, '0')}`,
      side: risk.side,
      entryPrice: risk.entryPrice,
      currentPrice: risk.entryPrice,
      stopLoss: risk.stopLoss,
      initialStopLoss: risk.stopLoss,
      takeProfit1: risk.takeProfit1,
      takeProfit2: risk.takeProfit2,
      sizeBtc: risk.positionSizeBtc,
      remainingBtc: risk.positionSizeBtc,
      notionalUsd: risk.positionNotionalUsd,
      tp1Hit: false,
      realizedPartialPnl: -entryFee,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      openedAt: now,
      consensusScore: calibratedScore,
      regime,
    };
  } else if (!risk.approved && consensus.direction !== 'NEUTRAL') {
    commanderDirection = 'VETO';
    actionTaken = 'VETO_SKIP';
    actionNote = risk.vetoReason ?? 'Risk Guardian từ chối lệnh để bảo vệ tỷ lệ thắng.';
  }

  const commanderSignal: AgentSignal = {
    agentId: 'execution_commander',
    name: 'Chỉ huy Khớp lệnh',
    role: 'Thực thi & Quản lý Lệnh',
    direction: commanderDirection,
    confidence: workingPosition ? calibratedScore : risk.approved ? calibratedScore : 50,
    scoreContribution: calibratedScore,
    summary: actionNote,
    metrics: [
      { label: 'Sau Phản biện', value: `${calibratedScore}/100` },
      { label: 'Trạng thái', value: workingPosition ? `Đang giữ ${workingPosition.side}` : actionTaken === 'VETO_SKIP' ? 'Đã chặn' : 'Chờ lệnh' },
      { label: 'Auto-Bot', value: config.autoExecute ? 'Bật' : 'Thủ công' },
    ],
    timestamp: now,
  };

  const signals: Record<AgentId, AgentSignal> = {
    macro_scout: macroSignal,
    quant_analyst: quantSignal,
    orderflow_radar: orderflowSignal,
    risk_guardian: riskSignal,
    execution_commander: commanderSignal,
  };

  return {
    cycle: {
      cycleId,
      timestamp: now,
      stage: 'EXECUTION_SYNC',
      regime,
      consensusScore: calibratedScore,
      preDebateScore: consensus.score,
      dominantDirection: consensus.direction,
      signals,
      debate,
      risk,
      actionTaken,
      actionNote,
    },
    indicators,
    nextPosition: workingPosition,
    closedTrade,
    equityAfter: Number(updatedEquity.toFixed(2)),
  };
}

export function createManualPosition(params: {
  id: string;
  side: 'LONG' | 'SHORT';
  candles: Candle[];
  fundingRate: number;
  equity: number;
  config: StrategyConfig;
  scenarioHint?: MarketScenario;
  liveOrderbookImbalance?: number;
  htfContext?: HtfContext;
  now?: number;
}): Position {
  const {
    id,
    side,
    candles,
    fundingRate,
    equity,
    config,
    scenarioHint,
    liveOrderbookImbalance,
    htfContext,
    now = Date.now(),
  } = params;

  const lastCandle = candles[candles.length - 1];
  const price = lastCandle.close;
  const ind = extractIndicators(
    candles,
    fundingRate,
    scenarioHint,
    liveOrderbookImbalance,
    htfContext,
    now,
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

  const { risk } = evaluateRiskGuardian(
    price,
    ind,
    regime,
    side,
    Math.max(consensus.score, config.minConsensusScore),
    equity,
    config,
    false,
    now,
  );

  const entryFee = Number((risk.positionNotionalUsd * TAKER_FEE_RATE).toFixed(2));

  return {
    id,
    side,
    entryPrice: risk.entryPrice,
    currentPrice: risk.entryPrice,
    stopLoss: risk.stopLoss,
    initialStopLoss: risk.stopLoss,
    takeProfit1: risk.takeProfit1,
    takeProfit2: risk.takeProfit2,
    sizeBtc: risk.positionSizeBtc,
    remainingBtc: risk.positionSizeBtc,
    notionalUsd: risk.positionNotionalUsd,
    tp1Hit: false,
    realizedPartialPnl: -entryFee,
    unrealizedPnl: 0,
    unrealizedPnlPct: 0,
    openedAt: now,
    consensusScore: consensus.score,
    regime,
  };
}

export function closePositionAtMarket(params: {
  position: Position;
  exitPrice: number;
  equity: number;
  closeRatio?: number;
  useBreakEvenAfterTp1?: boolean;
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
    now = Date.now(),
  } = params;

  const isPartial = closeRatio > 0 && closeRatio < 1 && !position.tp1Hit;
  const priceDiff =
    position.side === 'LONG'
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;

  if (isPartial) {
    const closeBtc = Number((position.remainingBtc * closeRatio).toFixed(4));
    const remainBtc = Number(Math.max(0, position.remainingBtc - closeBtc).toFixed(4));
    const exitFee = exitPrice * closeBtc * TAKER_FEE_RATE;
    const partialPnl = priceDiff * closeBtc - exitFee;
    const updatedEquity = Number((equity + partialPnl).toFixed(2));
    const unrealized = priceDiff * remainBtc;

    let nextSl = position.stopLoss;
    if (useBreakEvenAfterTp1) {
      if (position.side === 'LONG') {
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
      unrealizedPnl: Number(unrealized.toFixed(2)),
      unrealizedPnlPct: Number(
        (((unrealized + position.realizedPartialPnl + partialPnl) / position.notionalUsd) * 100).toFixed(2),
      ),
    };

    return {
      nextPosition,
      closedTrade: null,
      partialPnlUsd: Number(partialPnl.toFixed(2)),
      equityAfter: updatedEquity,
    };
  }

  const exitFee = exitPrice * position.remainingBtc * TAKER_FEE_RATE;
  const remainPnl = priceDiff * position.remainingBtc - exitFee;
  const totalPnl = position.realizedPartialPnl + remainPnl;
  const initialRiskUsd = Math.max(
    1,
    Math.abs(position.entryPrice - position.initialStopLoss) * position.sizeBtc,
  );
  const rMult = totalPnl / initialRiskUsd;
  const outcome: ClosedTrade['outcome'] =
    totalPnl > 15 ? 'WIN' : totalPnl < -15 ? 'LOSS' : 'BREAKEVEN';

  const updatedEquity = Number((equity + remainPnl).toFixed(2));

  const closedTrade: ClosedTrade = {
    id: position.id,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: Number(exitPrice.toFixed(2)),
    sizeBtc: position.sizeBtc,
    pnlUsd: Number(totalPnl.toFixed(2)),
    pnlPct: Number(((totalPnl / position.notionalUsd) * 100).toFixed(2)),
    rMultiple: Number(rMult.toFixed(2)),
    outcome,
    exitReason: 'MANUAL_CLOSE',
    openedAt: position.openedAt,
    closedAt: now,
    consensusScore: position.consensusScore,
    regime: position.regime,
  };

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
): PerformanceStats {
  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const breakevens = trades.filter((t) => t.outcome === 'BREAKEVEN').length;
  const totalTrades = trades.length;

  const grossProfit = trades.filter((t) => t.pnlUsd > 0).reduce((a, b) => a + b.pnlUsd, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnlUsd < 0).reduce((a, b) => a + b.pnlUsd, 0));

  const decided = wins + losses;
  const winRatePct = decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : 0;
  const profitFactor =
    grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 4.5 : 0;
  const expectancyR =
    totalTrades > 0
      ? Number((trades.reduce((a, b) => a + b.rMultiple, 0) / totalTrades).toFixed(2))
      : 0;

  let peak = initialCapital;
  let maxDd = 0;
  for (const eq of equityHistory) {
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const totalPnlUsd = Number((currentEquity - initialCapital).toFixed(2));
  const totalPnlPct = Number(((totalPnlUsd / initialCapital) * 100).toFixed(2));

  // Sharpe proxy from trade R returns
  let sharpeProxy = 0;
  if (trades.length >= 2) {
    const returns = trades.map((t) => t.rMultiple);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance) || 1;
    sharpeProxy = Number(((mean / std) * Math.sqrt(12)).toFixed(2));
  }

  return {
    equity: Number(currentEquity.toFixed(2)),
    totalPnlUsd,
    totalPnlPct,
    totalTrades,
    wins,
    losses,
    breakevens,
    winRatePct,
    profitFactor,
    expectancyR,
    maxDrawdownPct: Number(maxDd.toFixed(2)),
    sharpeProxy,
  };
}

export function runDeterministicBacktest(
  config: StrategyConfig,
  candleCount = 360,
): BacktestReport {
  const series = generateRealisticBTCSeries(candleCount + 60, 88400, 20260915);
  let equity = config.initialCapital;
  let activePosition: Position | null = null;
  const trades: ClosedTrade[] = [];
  const equityHistory: number[] = [equity];
  const equityCurve: Array<{ time: number; equity: number; price: number }> = [];
  let vetoedSetups = 0;

  for (let i = 60; i < series.length; i++) {
    const window = series.slice(0, i + 1);
    const res = runPipelineCycle({
      cycleId: i,
      candles: window,
      fundingRate: 0.00012,
      equity,
      activePosition,
      config: { ...config, autoExecute: true },
      now: series[i].time,
    });

    equity = res.equityAfter;
    activePosition = res.nextPosition;
    if (res.closedTrade) {
      trades.push(res.closedTrade);
      equityHistory.push(equity);
    }
    if (res.cycle.actionTaken === 'VETO_SKIP') {
      vetoedSetups++;
    }

    const markToMarket =
      equity + (activePosition ? activePosition.unrealizedPnl : 0);
    equityCurve.push({
      time: series[i].time,
      equity: Number(markToMarket.toFixed(2)),
      price: series[i].close,
    });
  }

  const stats = computePerformanceStats(
    config.initialCapital,
    equity,
    trades,
    equityHistory,
  );

  return {
    candlesTested: candleCount,
    stats,
    equityCurve,
    trades: trades.slice().reverse(),
    vetoedSetups,
  };
}
