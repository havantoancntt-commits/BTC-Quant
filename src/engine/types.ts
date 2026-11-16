export type MarketScenario =
  | 'auto_live'
  | 'bull_breakout'
  | 'liquidity_sweep'
  | 'bear_flush'
  | 'choppy_range';

export type MarketVenue = 'BINANCE_SPOT' | 'BINANCE_FUTURES';

export type ExecutionMode = 'SIMULATION' | 'PAPER' | 'TESTNET' | 'LIVE';

export type FeedHealthStatus = 'HEALTHY' | 'STALE' | 'INCOMPLETE' | 'DISCONNECTED';

export type DataClassificationStatus =
  | 'LIVE_DATA'
  | 'STALE_DATA'
  | 'ESTIMATED_DATA'
  | 'SIMULATED_DATA'
  | 'UNAVAILABLE';

export type TimeframeKey = '5m' | '15m' | '1h' | '4h' | '1d';

export type AgentId =
  | 'macro_scout'
  | 'quant_analyst'
  | 'orderflow_radar'
  | 'strategy_architect'
  | 'risk_guardian'
  | 'execution_commander';

export type VoteDirection = 'LONG' | 'SHORT' | 'NEUTRAL' | 'VETO' | 'UNAVAILABLE';

export type PipelineStage =
  | 'INGEST_MARKET'
  | 'QUANT_CONFLUENCE'
  | 'ORDERFLOW_SCAN'
  | 'STRATEGY_SYNTHESIS'
  | 'RISK_VETO_GATE'
  | 'EXECUTION_SYNC';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed?: boolean;
}

export interface MarketMetadata {
  symbol: string;
  market_type: 'SPOT' | 'FUTURES';
  timeframe: TimeframeKey;
  exchange_timestamp: number;
  received_timestamp: number;
  sequence_number: number;
  data_status: DataClassificationStatus;
  quality_flags: string[];
}

export interface HtfTimeframeSummary {
  timeframe: TimeframeKey;
  bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  emaFast: number;
  emaSlow: number;
  rsi14: number;
  candleCount: number;
  sufficientData: boolean;
}

export interface HtfContext {
  h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  d1Bias?: 'LONG' | 'SHORT' | 'NEUTRAL';
  m5Bias?: 'LONG' | 'SHORT' | 'NEUTRAL';
  h1Rsi: number;
  h1Ema50: number;
  source?: 'EXCHANGE_KLINES' | 'RESAMPLED_M15' | 'INSUFFICIENT';
  timeframes?: Partial<Record<TimeframeKey, HtfTimeframeSummary>>;
}

export interface VolumeProfileSummary {
  poc: number; // Point of Control (highest volume price level)
  vah: number; // Value Area High (70% volume upper boundary)
  val: number; // Value Area Low (70% volume lower boundary)
  lookbackBars: number;
}

export interface SupportResistanceLevels {
  nearestSupport: number;
  nearestResistance: number;
  supports: number[];
  resistances: number[];
}

export type StructureEvent = 'BOS_BULL' | 'BOS_BEAR' | 'CHOCH_BULL' | 'CHOCH_BEAR' | 'NONE';

export interface TechnicalIndicators {
  sma20: number;
  sma50: number;
  sma200: number;
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  emaWarmupValid: boolean;
  rsi14: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  macdWarmupValid: boolean;
  atr14: number;
  atrPct: number;
  atrWarmupValid: boolean;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbBandwidth: number;
  vwap24: number;
  obv: number;
  obvSlope: number; // positive = accumulation volume slope
  volumeRatio: number;
  volumeZScore: number;
  adx14: number; // True Wilder ADX(14)
  plusDi14: number;
  minusDi14: number;
  adxProxy: number; // Kept as alias to adx14 for compatibility
  orderbookImbalance: number; // -1 (ask heavy) to +1 (bid heavy); 0 when unavailable
  orderbookSource: 'EXCHANGE_DEPTH' | 'UNAVAILABLE';
  spreadBps: number;
  spotCvdDelta: number; // Aggressor CVD delta or candle-body volume proxy (USD millions)
  cvdSource: 'EXCHANGE_TRADES' | 'CANDLE_BODY_PROXY' | 'UNAVAILABLE';
  fundingRate: number | null; // null on pure Spot venue without Futures overlay
  sweepSignal: 'BULL_SWEEP' | 'BEAR_SWEEP' | 'NONE';
  structureBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  structureEvent: StructureEvent;
  htfBias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  d1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  m5Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  htfSource: 'EXCHANGE_KLINES' | 'RESAMPLED_M15' | 'INSUFFICIENT';
  volumeProfile: VolumeProfileSummary;
  srLevels: SupportResistanceLevels;
  dataValid: boolean;
  dataStatus: DataClassificationStatus;
  dataIssues: string[];
  qualityFlags: string[];
}

export type MarketRegime =
  | 'Mở rộng Xu hướng Tăng'
  | 'Mở rộng Xu hướng Giảm'
  | 'Quét Thanh khoản & Hấp thụ'
  | 'Tích lũy Nén Biến động'
  | 'Sideway Nhiễu Rủi ro';

export interface RegimeClassification {
  regime: MarketRegime;
  confidence: number; // 0-100
  evidence: string[];
  classifiedAt: number;
}

export interface AgentSignal {
  agentId: AgentId;
  name: string;
  role: string;
  direction: VoteDirection;
  confidence: number; // Signal alignment strength 0-100 (NOT empirical win probability)
  scoreContribution: number; // 0-100
  summary: string;
  metrics: Array<{ label: string; value: string }>;
  evidence: string[];
  riskFlags: string[];
  dataQuality: DataClassificationStatus;
  errorState: string | null;
  latencyMs: number;
  timestamp: number;
}

export interface DebateChallenge {
  id: string;
  challenger: AgentId;
  target: AgentId | 'PROPOSED_TRADE';
  stance: 'SUPPORT' | 'CHALLENGE' | 'VETO_TRIGGER';
  impactScore: number;
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

export type PositionSizingMethod = 'FIXED_FRACTIONAL' | 'HALF_KELLY';

export interface RiskEvaluation {
  approved: boolean;
  vetoReason: string | null;
  vetoCodes: string[];
  side: 'LONG' | 'SHORT' | 'NONE';
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  liquidationPrice: number | null;
  rewardRiskRatio: number;
  netRewardRiskRatio: number;
  sizingMethod: PositionSizingMethod;
  kellyFractionPct: number;
  effectiveRiskPct: number;
  positionSizeBtc: number;
  positionNotionalUsd: number;
  marginRequiredUsd: number;
  effectiveLeverage: number;
  riskAmountUsd: number;
  estFeeUsd: number;
  fundingEstimateUsd: number;
  confidenceDisclaimer: string;
}

export interface RiskAccountState {
  equity: number;
  peakEquity: number;
  dailyStartEquity: number;
  weeklyStartEquity: number;
  dailyPnlUsd: number;
  weeklyPnlUsd: number;
  consecutiveLosses: number;
  cooldownUntil: number | null;
  emergencyStopActive: boolean;
  lastOrderAt: number | null;
  lastDayKey: string;
  lastWeekKey: string;
}

export interface ManualOrderResult {
  approved: boolean;
  rejectionReason: string | null;
  vetoCodes: string[];
  riskEvaluation: RiskEvaluation;
  position: Position | null;
  entryFeeUsd: number;
  equityAfter: number;
}

export interface PipelineCycle {
  cycleId: number;
  timestamp: number;
  stage: PipelineStage;
  regime: MarketRegime;
  regimeConfidence: number;
  consensusScore: number; // post-debate calibrated score (0-100)
  preDebateScore: number;
  dominantDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  signals: Record<AgentId, AgentSignal>;
  debate: AgentDebateSummary;
  risk: RiskEvaluation;
  actionTaken: 'OPEN_LONG' | 'OPEN_SHORT' | 'HOLD_POSITION' | 'VETO_SKIP' | 'NO_SETUP';
  actionNote: string;
  dataQuality: FeedHealthStatus;
  dataStatus: DataClassificationStatus;
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
  liquidationPrice: number | null;
  marginUsedUsd: number;
  sizeBtc: number;
  remainingBtc: number;
  notionalUsd: number;
  tp1Hit: boolean;
  realizedPartialPnl: number;
  feesPaidUsd: number;
  fundingPaidUsd: number;
  slippagePaidUsd: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  openedAt: number;
  openedCandleTime: number;
  consensusScore: number;
  regime: MarketRegime;
  executionMode: ExecutionMode;
  venue: MarketVenue;
}

export type ClosedTradeExitReason =
  | 'TP2_TARGET'
  | 'TP1_TRAILING'
  | 'BREAKEVEN_STOP'
  | 'STOP_LOSS'
  | 'GAP_STOP_LOSS'
  | 'MANUAL_CLOSE'
  | 'EMERGENCY_FLATTEN';

export interface ClosedTrade {
  id: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  sizeBtc: number;
  grossPnlUsd: number;
  pnlUsd: number; // Net PnL after fees, funding, slippage
  feesPaidUsd: number;
  fundingPaidUsd: number;
  slippagePaidUsd: number;
  pnlPct: number;
  rMultiple: number;
  holdMinutes: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  exitReason: ClosedTradeExitReason;
  openedAt: number;
  closedAt: number;
  consensusScore: number;
  regime: MarketRegime;
}

export interface StrategyConfig {
  initialCapital: number;
  sizingMethod: PositionSizingMethod;
  riskPerTradePct: number; // 0.25 - 3.0%
  maxLeverage: number; // 1 - 5x
  maxDailyLossPct: number; // e.g. 3.0%
  maxWeeklyLossPct: number; // e.g. 6.0%
  maxDrawdownPct: number; // e.g. 12.0%
  maxConsecutiveLosses: number; // e.g. 3
  cooldownMinutesAfterLoss: number; // e.g. 30
  maxSpreadBps: number; // e.g. 15 bps
  minConsensusScore: number; // 58 - 88
  minRewardRisk: number; // 1.6 - 3.5
  autoExecute: boolean;
  useBreakEvenAfterTp1: boolean;
  vetoChoppyMarket: boolean;
  requireClosedCandle: boolean;
  marketVenue: MarketVenue;
  executionMode: ExecutionMode;
  agentWeights: {
    macro_scout: number;
    quant_analyst: number;
    orderflow_radar: number;
  };
}

export interface PerformanceStats {
  equity: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  netProfitUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  cagrPct: number;
  totalFeesUsd: number;
  totalFundingUsd: number;
  totalSlippageUsd: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;
  profitFactor: number;
  expectancyUsd: number;
  expectancyR: number;
  avgWinUsd: number;
  avgLossUsd: number;
  avgHoldMinutes: number;
  maxDrawdownPct: number;
  maxDrawdownDurationBars: number;
  calmarRatio: number;
  recoveryFactor: number;
  exposurePct: number;
  sharpeRatio: number;
  sharpeProxy: number; // Legacy alias synced to time-series annualized sharpeRatio
  sortinoRatio: number;
}

export interface RegimeBreakdownRow {
  regime: MarketRegime;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnlUsd: number;
  avgR: number;
}

export interface SideBreakdownRow {
  side: 'LONG' | 'SHORT';
  trades: number;
  wins: number;
  winRatePct: number;
  netPnlUsd: number;
  avgR: number;
}

export interface WalkForwardSplit {
  label: string;
  candlesCount: number;
  stats: PerformanceStats;
}

export interface SensitivityPoint {
  minConsensusScore: number;
  riskPerTradePct: number;
  totalTrades: number;
  winRatePct: number;
  netProfitUsd: number;
  profitFactor: number;
  maxDrawdownPct: number;
}

export interface BacktestReport {
  mode: 'SIMULATED_DATA' | 'HISTORICAL_DATA';
  dataSourceLabel: string;
  isSimulatedData: boolean;
  candlesTested: number;
  barIntervalMinutes: number;
  dateRange: { startTime: number; endTime: number } | null;
  validationWarnings: string[];
  duplicatesRemoved: number;
  gapsDetected: number;
  stats: PerformanceStats;
  buyAndHoldReturnPct: number;
  benchmarkEmaReturnPct: number;
  alphaVsBuyAndHoldPct: number;
  alphaVsBenchmarkPct: number;
  longBreakdown: SideBreakdownRow;
  shortBreakdown: SideBreakdownRow;
  regimeBreakdown: RegimeBreakdownRow[];
  inSampleStats: PerformanceStats | null;
  validationStats: PerformanceStats | null;
  outOfSampleStats: PerformanceStats | null;
  walkForwardWindows: WalkForwardSplit[];
  overfittingRisk: 'LOW' | 'MODERATE' | 'HIGH' | 'INSUFFICIENT_SAMPLE';
  overfittingNotes: string;
  sensitivityGrid: SensitivityPoint[];
  equityCurve: Array<{
    time: number;
    equity: number;
    price: number;
    buyHoldEquity: number;
    benchmarkEquity: number;
  }>;
  trades: ClosedTrade[];
  vetoedSetups: number;
}

export type MarketFeedSource =
  | 'binance_spot_ws_live'
  | 'binance_spot_rest_live'
  | 'binance_futures_ws_live'
  | 'binance_futures_rest_live'
  | 'binance_ws_live'
  | 'binance_rest_live'
  | 'coinbase_live'
  | 'quant_engine_sim';

export interface OrderbookLevel {
  price: number;
  qty: number;
  total: number;
}

export interface FuturesMarketMetrics {
  markPrice: number | null;
  indexPrice: number | null;
  lastFundingRate: number | null;
  nextFundingTime: number | null;
  openInterestBtc: number | null;
  openInterestUsd: number | null;
}

export interface FeedHealthTelemetry {
  status: FeedHealthStatus;
  dataStatus: DataClassificationStatus;
  venue: MarketVenue;
  source: MarketFeedSource;
  lastMessageAt: number;
  exchangeTimestamp: number;
  serverTimeOffsetMs: number;
  sequenceNumber: number;
  ageMs: number;
  staleAfterMs: number;
  wsConnected: boolean;
  wsHeartbeatOk: boolean;
  reconnectCount: number;
  candleGapsDetected: number;
  duplicatesRemoved: number;
  rateLimit429Count: number;
  qualityFlags: string[];
  lastError: string | null;
}

export interface MarketSnapshot {
  venue: MarketVenue;
  source: MarketFeedSource;
  metadata?: MarketMetadata;
  health: FeedHealthTelemetry;
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24hUsd: number;
  bestBid: number;
  bestAsk: number;
  orderbookImbalance: number;
  orderbookSource?: 'EXCHANGE_DEPTH' | 'UNAVAILABLE';
  orderbookBids?: OrderbookLevel[];
  orderbookAsks?: OrderbookLevel[];
  aggTradeCvdDelta?: number | null;
  fundingRate: number | null;
  futuresMetrics?: FuturesMarketMetrics;
  htfContext?: HtfContext;
  updatedAt: number;
  candles: Candle[];
  indicators?: TechnicalIndicators;
}

export interface ExecutionOrderRecord {
  clientOrderId: string;
  exchangeOrderId: string | null;
  mode: ExecutionMode;
  venue: MarketVenue;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT';
  requestedQtyBtc: number;
  executedQtyBtc: number;
  requestedPrice: number;
  limitPrice?: number | null;
  executedPrice: number | null;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'SIMULATED';
  feeUsd: number;
  reason: string | null;
  expiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PaperReconciliationReport {
  timestamp: number;
  initialCapitalUsd: number;
  equityUsd: number;
  availableBalanceUsd: number;
  usedMarginUsd: number;
  pendingOrdersMarginUsd: number;
  openPositionNotionalUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalFeesUsd: number;
  totalTrades: number;
  openLimitOrdersCount: number;
  discrepancyUsd: number;
  consistent: boolean;
  notes: string[];
}

export interface RiskEventRecord {
  id: string;
  eventType:
    | 'MANUAL_REJECTED'
    | 'AUTO_VETO'
    | 'DAILY_LOSS_BREAKER'
    | 'WEEKLY_LOSS_BREAKER'
    | 'MAX_DD_BREAKER'
    | 'CONSECUTIVE_LOSS_COOLDOWN'
    | 'EMERGENCY_STOP'
    | 'DATA_STALE_BLOCK';
  message: string;
  createdAt: number;
}

export interface HealthDependencyEntry {
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'STANDBY';
  detail: string;
  latencyMs?: number;
}

export interface GeminiAdvisoryResponse {
  configured: boolean;
  model: string | null;
  generatedAt: number;
  verdict: 'LONG' | 'SHORT' | 'WAIT' | 'UNAVAILABLE';
  confidencePct: number;
  rationale: string;
  riskWarnings: string[];
  disclaimer: string;
}
