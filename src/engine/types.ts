export type MarketScenario = 'auto_live' | 'bull_breakout' | 'liquidity_sweep' | 'bear_flush' | 'choppy_range';

export type AgentId =
  | 'macro_scout'
  | 'quant_analyst'
  | 'orderflow_radar'
  | 'risk_guardian'
  | 'execution_commander';

export type VoteDirection = 'LONG' | 'SHORT' | 'NEUTRAL' | 'VETO';

export type PipelineStage =
  | 'INGEST_MARKET'
  | 'QUANT_CONFLUENCE'
  | 'ORDERFLOW_SCAN'
  | 'RISK_VETO_GATE'
  | 'EXECUTION_SYNC';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HtfContext {
  h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h1Rsi: number;
  h1Ema50: number;
}

export interface TechnicalIndicators {
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  atr14: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbBandwidth: number;
  vwap24: number;
  volumeRatio: number;
  adxProxy: number;
  orderbookImbalance: number; // -1 (ask heavy) to +1 (bid heavy)
  spotCvdDelta: number; // USD millions
  fundingRate: number; // e.g. 0.0001 = 0.01%
  sweepSignal: 'BULL_SWEEP' | 'BEAR_SWEEP' | 'NONE';
  structureBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  htfBias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
}

export type MarketRegime =
  | 'Mở rộng Xu hướng Tăng'
  | 'Mở rộng Xu hướng Giảm'
  | 'Quét Thanh khoản & Hấp thụ'
  | 'Tích lũy Nén Biến động'
  | 'Sideway Nhiễu Rủi ro';

export interface AgentSignal {
  agentId: AgentId;
  name: string;
  role: string;
  direction: VoteDirection;
  confidence: number; // 0-100
  scoreContribution: number; // 0-100
  summary: string;
  metrics: Array<{ label: string; value: string }>;
  timestamp: number;
}

export interface DebateChallenge {
  id: string;
  challenger: AgentId;
  target: AgentId | 'PROPOSED_TRADE';
  stance: 'SUPPORT' | 'CHALLENGE' | 'VETO_TRIGGER';
  impactScore: number; // e.g. +8 or -16
  title: string;
  argument: string;
}

export interface AgentDebateSummary {
  preDebateScore: number;
  postDebateScore: number;
  scoreDelta: number;
  challengesCount: number;
  criticalVetoTriggered: boolean;
  verdict: string;
  turns: DebateChallenge[];
}

export interface RiskEvaluation {
  approved: boolean;
  vetoReason: string | null;
  side: 'LONG' | 'SHORT' | 'NONE';
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  rewardRiskRatio: number;
  netRewardRiskRatio: number;
  kellyFractionPct: number;
  positionSizeBtc: number;
  positionNotionalUsd: number;
  riskAmountUsd: number;
  estFeeUsd: number;
}

export interface PipelineCycle {
  cycleId: number;
  timestamp: number;
  stage: PipelineStage;
  regime: MarketRegime;
  consensusScore: number; // 0-100 (post-debate calibrated score)
  preDebateScore: number;
  dominantDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  signals: Record<AgentId, AgentSignal>;
  debate: AgentDebateSummary;
  risk: RiskEvaluation;
  actionTaken: 'OPEN_LONG' | 'OPEN_SHORT' | 'HOLD_POSITION' | 'VETO_SKIP' | 'NO_SETUP';
  actionNote: string;
}

export interface Position {
  id: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  initialStopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  sizeBtc: number;
  remainingBtc: number;
  notionalUsd: number;
  tp1Hit: boolean;
  realizedPartialPnl: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  openedAt: number;
  consensusScore: number;
  regime: MarketRegime;
}

export type ClosedTradeExitReason =
  | 'TP2_TARGET'
  | 'TP1_TRAILING'
  | 'BREAKEVEN_STOP'
  | 'STOP_LOSS'
  | 'MANUAL_CLOSE';

export interface ClosedTrade {
  id: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  sizeBtc: number;
  pnlUsd: number;
  pnlPct: number;
  rMultiple: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  exitReason: ClosedTradeExitReason;
  openedAt: number;
  closedAt: number;
  consensusScore: number;
  regime: MarketRegime;
}

export interface StrategyConfig {
  initialCapital: number;
  riskPerTradePct: number; // 0.5 - 3.0%
  maxLeverage: number; // 1 - 5x
  minConsensusScore: number; // 60 - 88
  minRewardRisk: number; // 1.6 - 3.5
  autoExecute: boolean;
  useBreakEvenAfterTp1: boolean;
  vetoChoppyMarket: boolean;
  agentWeights: {
    macro_scout: number;
    quant_analyst: number;
    orderflow_radar: number;
  };
}

export interface PerformanceStats {
  equity: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownPct: number;
  sharpeProxy: number;
}

export interface BacktestReport {
  candlesTested: number;
  stats: PerformanceStats;
  equityCurve: Array<{ time: number; equity: number; price: number }>;
  trades: ClosedTrade[];
  vetoedSetups: number;
}

export type MarketFeedSource =
  | 'binance_ws_live'
  | 'binance_rest_live'
  | 'coinbase_live'
  | 'quant_engine_sim';

export interface OrderbookLevel {
  price: number;
  qty: number;
  total: number;
}

export interface MarketSnapshot {
  source: MarketFeedSource;
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24hUsd: number;
  bestBid: number;
  bestAsk: number;
  orderbookImbalance: number;
  orderbookBids?: OrderbookLevel[];
  orderbookAsks?: OrderbookLevel[];
  fundingRate: number;
  htfContext?: HtfContext;
  updatedAt: number;
  candles: Candle[];
  indicators: TechnicalIndicators;
}
