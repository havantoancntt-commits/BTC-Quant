import type {
  AgentDebateSummary,
  AgentSignal,
  ClosedTrade,
  FeedHealthStatus,
  MarketRegime,
  MarketVenue,
  RiskAccountState,
  RiskEvaluation,
  StrategyConfig,
  TechnicalIndicators,
} from './types';

export const TAKER_FEE_RATE = 0.0004; // 0.04% per side
export const DEFAULT_SLIPPAGE_RATE = 0.0002; // 0.02% conservative market fill slippage

function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function utcWeekKey(ts: number): string {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  return monday.toISOString().slice(0, 10);
}

export function createInitialRiskAccountState(
  initialCapital: number,
  now = Date.now(),
): RiskAccountState {
  const safeEq = Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : 100000;
  return {
    equity: safeEq,
    peakEquity: safeEq,
    dailyStartEquity: safeEq,
    weeklyStartEquity: safeEq,
    dailyPnlUsd: 0,
    weeklyPnlUsd: 0,
    consecutiveLosses: 0,
    cooldownUntil: null,
    emergencyStopActive: false,
    lastOrderAt: null,
    lastDayKey: utcDayKey(now),
    lastWeekKey: utcWeekKey(now),
  };
}

export function rolloverRiskPeriods(
  state: RiskAccountState,
  currentEquity: number,
  now = Date.now(),
): RiskAccountState {
  const dayKey = utcDayKey(now);
  const weekKey = utcWeekKey(now);
  let next = { ...state, equity: currentEquity };

  if (currentEquity > next.peakEquity) {
    next.peakEquity = currentEquity;
  }
  if (dayKey !== next.lastDayKey) {
    next.lastDayKey = dayKey;
    next.dailyStartEquity = currentEquity;
    next.dailyPnlUsd = 0;
  }
  if (weekKey !== next.lastWeekKey) {
    next.lastWeekKey = weekKey;
    next.weeklyStartEquity = currentEquity;
    next.weeklyPnlUsd = 0;
  }
  return next;
}

export function updateRiskAccountOnTradeClose(
  state: RiskAccountState,
  trade: ClosedTrade,
  equityAfter: number,
  config: StrategyConfig,
  now = Date.now(),
): RiskAccountState {
  const rolled = rolloverRiskPeriods(state, equityAfter, now);
  const nextDailyPnl = Number((rolled.dailyPnlUsd + trade.pnlUsd).toFixed(2));
  const nextWeeklyPnl = Number((rolled.weeklyPnlUsd + trade.pnlUsd).toFixed(2));

  let consecutiveLosses = rolled.consecutiveLosses;
  let cooldownUntil = rolled.cooldownUntil;

  if (trade.outcome === 'LOSS') {
    consecutiveLosses += 1;
    if (consecutiveLosses >= config.maxConsecutiveLosses) {
      cooldownUntil = now + Math.max(1, config.cooldownMinutesAfterLoss) * 60 * 1000;
    }
  } else if (trade.outcome === 'WIN') {
    consecutiveLosses = 0;
    cooldownUntil = null;
  }

  return {
    ...rolled,
    equity: equityAfter,
    peakEquity: Math.max(rolled.peakEquity, equityAfter),
    dailyPnlUsd: nextDailyPnl,
    weeklyPnlUsd: nextWeeklyPnl,
    consecutiveLosses,
    cooldownUntil,
  };
}

export function evaluateInstitutionalRisk(params: {
  price: number;
  ind: TechnicalIndicators;
  regime: MarketRegime;
  dominantDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  consensusScore: number;
  equity: number;
  config: StrategyConfig;
  hasActivePosition: boolean;
  now: number;
  debate?: AgentDebateSummary;
  accountState?: RiskAccountState;
  dataQuality?: FeedHealthStatus;
  venue?: MarketVenue;
  isLiveScenario?: boolean;
  orderCooldownMs?: number;
  pendingOrdersMarginUsd?: number;
  activeMarginUsedUsd?: number;
}): { signal: AgentSignal; risk: RiskEvaluation } {
  const startMs = Date.now();
  const {
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
    dataQuality = 'HEALTHY',
    venue = config.marketVenue,
    isLiveScenario = false,
    orderCooldownMs = 4000,
    pendingOrdersMarginUsd = 0,
    activeMarginUsedUsd = 0,
  } = params;

  const vetoCodes: string[] = [];
  const vetoReasons: string[] = [];

  const addVeto = (code: string, reason: string) => {
    if (!vetoCodes.includes(code)) {
      vetoCodes.push(code);
      vetoReasons.push(reason);
    }
  };

  // Guard numeric sanity first
  const validPrice = Number.isFinite(price) && price > 0;
  const validEquity = Number.isFinite(equity) && equity > 0;
  const safePrice = validPrice ? price : 1;
  const safeEquity = validEquity ? equity : 0;

  if (!validPrice) {
    addVeto('INVALID_PRICE', 'VETO: Giá thị trường không hợp lệ (<= 0 hoặc NaN).');
  }
  if (!validEquity) {
    addVeto('INSUFFICIENT_EQUITY', 'VETO: Số dư vốn khả dụng bằng 0 hoặc không hợp lệ.');
  }
  if (!ind.dataValid) {
    addVeto(
      'INVALID_DATA',
      `VETO: Dữ liệu chỉ báo không đầy đủ (${ind.dataIssues.join('; ') || 'thiếu nến'}).`,
    );
  }
  if (isLiveScenario && dataQuality !== 'HEALTHY') {
    addVeto(
      'DATA_STALE',
      `VETO: Nguồn dữ liệu đang ở trạng thái ${dataQuality} — khóa mở vị thế mới để tránh khớp giá sai.`,
    );
  }

  // Account-level circuit breakers & Kill Switch
  if (accountState) {
    if (accountState.emergencyStopActive) {
      addVeto('EMERGENCY_STOP', 'VETO: Công tắc Dừng khẩn cấp (Kill Switch) đang kích hoạt.');
    }
    if (accountState.lastOrderAt !== null && now - accountState.lastOrderAt < orderCooldownMs) {
      addVeto('DUPLICATE_ORDER_GUARD', 'VETO: Bảo vệ chống trùng lặp lệnh (chờ hết thời gian trễ ngắn).');
    }
    if (accountState.cooldownUntil !== null && now < accountState.cooldownUntil) {
      const remainMin = Math.ceil((accountState.cooldownUntil - now) / 60000);
      addVeto(
        'CONSECUTIVE_LOSS_COOLDOWN',
        `VETO: Đang trong thời gian nghỉ ${remainMin} phút sau chuỗi ${accountState.consecutiveLosses} lệnh thua liên tiếp.`,
      );
    }

    const dailyLimitUsd = (accountState.dailyStartEquity * config.maxDailyLossPct) / 100;
    if (dailyLimitUsd > 0 && accountState.dailyPnlUsd <= -dailyLimitUsd) {
      addVeto(
        'DAILY_LOSS_LIMIT',
        `VETO: Chạm ngưỡng lỗ tối đa ngày (-${config.maxDailyLossPct}% / -$${dailyLimitUsd.toFixed(0)}).`,
      );
    }

    const weeklyLimitUsd = (accountState.weeklyStartEquity * config.maxWeeklyLossPct) / 100;
    if (weeklyLimitUsd > 0 && accountState.weeklyPnlUsd <= -weeklyLimitUsd) {
      addVeto(
        'WEEKLY_LOSS_LIMIT',
        `VETO: Chạm ngưỡng lỗ tối đa tuần (-${config.maxWeeklyLossPct}% / -$${weeklyLimitUsd.toFixed(0)}).`,
      );
    }

    const currentDdPct =
      accountState.peakEquity > 0
        ? ((accountState.peakEquity - safeEquity) / accountState.peakEquity) * 100
        : 0;
    if (currentDdPct >= config.maxDrawdownPct) {
      addVeto(
        'MAX_DRAWDOWN_BREAKER',
        `VETO: Drawdown tài khoản (${currentDdPct.toFixed(2)}%) vượt ngưỡng khóa ${config.maxDrawdownPct}%.`,
      );
    }
  }

  const atr = Math.max(Number.isFinite(ind.atr14) ? ind.atr14 : 0, safePrice * 0.0025);
  const stopDist = atr * 1.55;
  const tp1Dist = stopDist * 1.45;
  const tp2Dist = stopDist * Math.max(config.minRewardRisk, 2.55);

  if (stopDist <= 0 || !Number.isFinite(stopDist)) {
    addVeto('INVALID_STOP_LOSS', 'VETO: Khoảng cách Stop Loss không hợp lệ (<= 0).');
  } else if (validPrice && stopDist / safePrice > 0.08) {
    addVeto('STOP_LOSS_TOO_WIDE', 'VETO: Khoảng cách Stop Loss vượt 8% giá thị trường.');
  }

  const rewardRiskRatio = stopDist > 0 ? Number((tp2Dist / stopDist).toFixed(2)) : 0;

  // Position Sizing: explicit choice between Fixed Fractional and Capped Half-Kelly
  const safeConsensus = Number.isFinite(consensusScore) ? consensusScore : 0;
  // NOTE: Calibration proxy used solely under strict riskPerTradePct cap; NOT a forecast of real win probability
  const calibrationProxy = Math.min(0.75, Math.max(0.42, 0.38 + (safeConsensus / 100) * 0.35));
  const fullKelly = rewardRiskRatio > 0 ? calibrationProxy - (1 - calibrationProxy) / rewardRiskRatio : 0;
  const rawHalfKellyPct = Math.max(0.25, Math.min(config.riskPerTradePct, fullKelly * 0.5 * 100));

  const effectiveRiskPct =
    config.sizingMethod === 'FIXED_FRACTIONAL'
      ? Math.max(0.25, Math.min(3.0, config.riskPerTradePct))
      : rawHalfKellyPct;

  const riskAmountUsd = Number(((safeEquity * effectiveRiskPct) / 100).toFixed(2));
  const rawBtcSize = stopDist > 0 ? riskAmountUsd / stopDist : 0;

  // Spot venue enforces 1x leverage cap (Futures supports up to config.maxLeverage)
  const effectiveMaxLev = venue === 'BINANCE_SPOT' ? 1 : Math.max(1, config.maxLeverage);
  const feeReserveFactor = 1 + effectiveMaxLev * TAKER_FEE_RATE * 2;
  const maxNotional = Math.max(0, (safeEquity * effectiveMaxLev) / feeReserveFactor - 1);
  const cappedNotional = Math.max(0, Math.min(maxNotional, rawBtcSize * safePrice));
  const positionSizeBtc = validPrice ? Number((cappedNotional / safePrice).toFixed(4)) : 0;
  const effectiveLeverage = safeEquity > 0 ? Number((cappedNotional / safeEquity).toFixed(2)) : 0;
  const marginRequiredUsd = Number((cappedNotional / effectiveMaxLev).toFixed(2));

  const estFeeUsd = Number((cappedNotional * (TAKER_FEE_RATE * 2)).toFixed(2));
  const fundingEstimateUsd =
    venue === 'BINANCE_FUTURES' && ind.fundingRate !== null
      ? Number((cappedNotional * Math.abs(ind.fundingRate)).toFixed(2))
      : 0;
  const grossRewardUsd = tp2Dist * positionSizeBtc;
  const grossRiskUsd = Math.max(1, stopDist * positionSizeBtc);
  const netRewardRiskRatio =
    grossRiskUsd > 0 && validPrice
      ? Number(Math.max(0, (grossRewardUsd - estFeeUsd) / (grossRiskUsd + estFeeUsd)).toFixed(2))
      : 0;

  const availableMarginUsd = Math.max(0, safeEquity - pendingOrdersMarginUsd - activeMarginUsedUsd);
  if (marginRequiredUsd + estFeeUsd > availableMarginUsd + 0.01) {
    addVeto(
      'INSUFFICIENT_MARGIN',
      `VETO: Ký quỹ khả dụng ($${availableMarginUsd.toFixed(0)}) không đủ cho yêu cầu lệnh ($${(marginRequiredUsd + estFeeUsd).toFixed(0)}).`,
    );
  }
  if (hasActivePosition) {
    addVeto('ACTIVE_POSITION_EXISTS', 'Đang có vị thế mở — ưu tiên quản lý lệnh hiện tại, không chồng lệnh.');
  }
  if (dominantDirection === 'NEUTRAL') {
    addVeto('NEUTRAL_CONSENSUS', 'Chưa xác lập hướng đi đồng thuận từ hội đồng phân tích.');
  }
  if (config.vetoChoppyMarket && regime === 'Sideway Nhiễu Rủi ro') {
    addVeto(
      'CHOPPY_MARKET',
      'VETO: Phát hiện vùng Sideway nhiễu thanh khoản thấp, rủi ro quét SL cao.',
    );
  }
  if (debate?.criticalVetoTriggered) {
    addVeto('DEBATE_VETO', `VETO Phản biện: ${debate.verdict}`);
  }
  if (safeConsensus < config.minConsensusScore) {
    addVeto(
      'LOW_CONSENSUS',
      `VETO: Điểm đồng thuận (${safeConsensus}/100) thấp hơn ngưỡng (${config.minConsensusScore}).`,
    );
  }
  if (netRewardRiskRatio < config.minRewardRisk * 0.9) {
    addVeto(
      'LOW_NET_RR',
      `VETO: R:R ròng sau phí (${netRewardRiskRatio}) thấp hơn chuẩn tối thiểu.`,
    );
  }
  if (validPrice && ind.atr14 / safePrice > 0.032) {
    addVeto(
      'EXTREME_VOLATILITY',
      'VETO: Biến động ATR bất thường (>3.2%), kích hoạt khiên bảo vệ vốn.',
    );
  }
  if (ind.spreadBps > config.maxSpreadBps) {
    addVeto(
      'WIDE_SPREAD',
      `VETO: Spread sổ lệnh quá rộng (${ind.spreadBps.toFixed(1)} bps > ${config.maxSpreadBps} bps).`,
    );
  }
  if (positionSizeBtc <= 0 || cappedNotional < 10) {
    addVeto(
      'SIZE_TOO_SMALL',
      'VETO: Kích thước lệnh tính ra <= 0 hoặc dưới mức tối thiểu sàn ($10).',
    );
  }
  if (effectiveLeverage > effectiveMaxLev + 0.01) {
    addVeto(
      'LEVERAGE_EXCEEDED',
      `VETO: Đòn bẩy thực tế (${effectiveLeverage}x) vượt trần (${effectiveMaxLev}x).`,
    );
  }

  const primaryVetoReason = vetoReasons[0] ?? null;
  const approved = vetoReasons.length === 0;

  const entryPrice = validPrice ? Number(safePrice.toFixed(2)) : 0;
  const stopLoss =
    dominantDirection === 'LONG'
      ? Number(Math.max(0.01, entryPrice - stopDist).toFixed(2))
      : Number((entryPrice + stopDist).toFixed(2));
  const takeProfit1 =
    dominantDirection === 'LONG'
      ? Number((entryPrice + tp1Dist).toFixed(2))
      : Number(Math.max(0.01, entryPrice - tp1Dist).toFixed(2));
  const takeProfit2 =
    dominantDirection === 'LONG'
      ? Number((entryPrice + tp2Dist).toFixed(2))
      : Number(Math.max(0.01, entryPrice - tp2Dist).toFixed(2));

  let liquidationPrice: number | null = null;
  if (venue === 'BINANCE_FUTURES' && effectiveMaxLev > 1 && validPrice && dominantDirection !== 'NEUTRAL') {
    const maintMarginRate = 0.005;
    liquidationPrice =
      dominantDirection === 'LONG'
        ? Number(Math.max(0.01, entryPrice * (1 - 1 / effectiveMaxLev + maintMarginRate)).toFixed(2))
        : Number((entryPrice * (1 + 1 / effectiveMaxLev - maintMarginRate)).toFixed(2));
  }

  const risk: RiskEvaluation = {
    approved,
    vetoReason: primaryVetoReason,
    vetoCodes,
    side: dominantDirection === 'NEUTRAL' ? 'NONE' : dominantDirection,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    liquidationPrice,
    rewardRiskRatio,
    netRewardRiskRatio,
    sizingMethod: config.sizingMethod,
    kellyFractionPct: Number(rawHalfKellyPct.toFixed(2)),
    effectiveRiskPct: Number(effectiveRiskPct.toFixed(2)),
    positionSizeBtc,
    positionNotionalUsd: Number(cappedNotional.toFixed(2)),
    marginRequiredUsd,
    effectiveLeverage,
    riskAmountUsd,
    estFeeUsd,
    fundingEstimateUsd,
    confidenceDisclaimer:
      'Điểm đồng thuận thể hiện mức độ hội tụ kỹ thuật, không phải xác suất thắng thực nghiệm.',
  };

  const invalidDataState = !ind.dataValid || !validPrice;
  const signal: AgentSignal = {
    agentId: 'risk_guardian',
    name: 'Giám đốc Rủi ro',
    role: 'Quản trị Rủi ro & VETO',
    direction: invalidDataState
      ? 'UNAVAILABLE'
      : approved
        ? dominantDirection === 'LONG'
          ? 'LONG'
          : 'SHORT'
        : 'VETO',
    confidence: invalidDataState ? 0 : approved ? Math.min(98, Math.round(70 + netRewardRiskRatio * 7.5)) : 93,
    scoreContribution: approved ? 100 : 0,
    summary: approved
      ? `DUYỆT LỆNH: ${config.sizingMethod === 'FIXED_FRACTIONAL' ? 'Fixed' : 'Half-Kelly'} ${risk.effectiveRiskPct}% (${positionSizeBtc} BTC · ${effectiveLeverage}x), Net R:R 1:${netRewardRiskRatio}, SL $${stopLoss.toLocaleString('en-US')}.`
      : primaryVetoReason ?? 'Từ chối mở lệnh.',
    metrics: [
      { label: 'Cỡ lệnh', value: `${risk.effectiveRiskPct}% (${effectiveLeverage}x)` },
      { label: 'Net R:R', value: `1:${netRewardRiskRatio}` },
      { label: 'Ký quỹ', value: `$${marginRequiredUsd.toFixed(0)}` },
    ],
    evidence: approved
      ? [
          `Cỡ lệnh ${positionSizeBtc} BTC (${risk.effectiveRiskPct}% rủi ro, ${effectiveLeverage}x)`,
          `Net R:R 1:${netRewardRiskRatio} (đã trừ phí 2 chiều $${estFeeUsd.toFixed(2)})`,
          liquidationPrice ? `Thanh lý dự kiến $${liquidationPrice.toLocaleString('en-US')}` : 'Spot 1x — không thanh lý đòn bẩy',
        ]
      : vetoReasons.slice(0, 3),
    riskFlags: vetoCodes,
    dataQuality: invalidDataState ? 'UNAVAILABLE' : ind.dataStatus,
    errorState: invalidDataState ? 'INVALID_RISK_INPUT' : null,
    latencyMs: Math.max(1, Date.now() - startMs),
    timestamp: now,
  };

  return { signal, risk };
}
