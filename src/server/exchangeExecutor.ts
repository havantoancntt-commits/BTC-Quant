import crypto from 'node:crypto';
import type {
  ClosedTrade,
  ExecutionMode,
  ExecutionOrderRecord,
  MarketVenue,
  PaperReconciliationReport,
  Position,
  RiskAccountState,
  StrategyConfig,
} from '../engine/types';
import { TAKER_FEE_RATE } from '../engine/riskManager';
import type { QuantRepository } from './repository';

export interface ExchangeSymbolFilters {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export const DEFAULT_BTC_FILTERS: ExchangeSymbolFilters = {
  tickSize: 0.01,
  stepSize: 0.00001,
  minQty: 0.00001,
  minNotional: 10,
};

function stepDecimals(step: number): number {
  const str = step.toString();
  if (str.includes('e-')) {
    return Number(str.split('e-')[1] ?? 8);
  }
  const idx = str.indexOf('.');
  return idx >= 0 ? str.length - idx - 1 : 0;
}

export function roundToTickSize(price: number, tickSize: number): number {
  if (!Number.isFinite(price) || price <= 0 || tickSize <= 0) return 0;
  const decimals = stepDecimals(tickSize);
  const rounded = Math.round(price / tickSize) * tickSize;
  return Number(rounded.toFixed(decimals));
}

export function floorToStepSize(qty: number, stepSize: number): number {
  if (!Number.isFinite(qty) || qty <= 0 || stepSize <= 0) return 0;
  const decimals = stepDecimals(stepSize);
  const floored = Math.floor(qty / stepSize + 1e-10) * stepSize;
  return Number(floored.toFixed(decimals));
}

export function quantizeAndValidateOrder(params: {
  price: number;
  qtyBtc: number;
  filters?: ExchangeSymbolFilters;
}): {
  valid: boolean;
  quantizedPrice: number;
  quantizedQtyBtc: number;
  notionalUsd: number;
  error: string | null;
} {
  const filters = params.filters ?? DEFAULT_BTC_FILTERS;
  const quantizedPrice = roundToTickSize(params.price, filters.tickSize);
  const quantizedQtyBtc = floorToStepSize(params.qtyBtc, filters.stepSize);
  const notionalUsd = Number((quantizedPrice * quantizedQtyBtc).toFixed(2));

  if (quantizedPrice <= 0) {
    return { valid: false, quantizedPrice: 0, quantizedQtyBtc: 0, notionalUsd: 0, error: 'Giá không hợp lệ.' };
  }
  if (quantizedQtyBtc < filters.minQty) {
    return {
      valid: false,
      quantizedPrice,
      quantizedQtyBtc,
      notionalUsd,
      error: `Khối lượng ${quantizedQtyBtc} BTC nhỏ hơn minQty (${filters.minQty}).`,
    };
  }
  if (notionalUsd < filters.minNotional) {
    return {
      valid: false,
      quantizedPrice,
      quantizedQtyBtc,
      notionalUsd,
      error: `Giá trị lệnh ($${notionalUsd}) nhỏ hơn minNotional ($${filters.minNotional}).`,
    };
  }

  return {
    valid: true,
    quantizedPrice,
    quantizedQtyBtc,
    notionalUsd,
    error: null,
  };
}

export function signBinanceQuery(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

export function getExchangeCredentialsStatus() {
  return {
    testnetSpotConfigured: Boolean(
      process.env.BINANCE_TESTNET_API_KEY && process.env.BINANCE_TESTNET_API_SECRET,
    ),
    testnetFuturesConfigured: Boolean(
      (process.env.BINANCE_FUTURES_TESTNET_API_KEY || process.env.BINANCE_TESTNET_API_KEY) &&
        (process.env.BINANCE_FUTURES_TESTNET_API_SECRET || process.env.BINANCE_TESTNET_API_SECRET),
    ),
    liveTradingAllowedByEnv: process.env.ALLOW_LIVE_TRADING === 'true',
    liveCredentialsConfigured: Boolean(
      process.env.BINANCE_LIVE_API_KEY && process.env.BINANCE_LIVE_API_SECRET,
    ),
    geminiConfigured: Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY',
    ),
  };
}

export const MAKER_FEE_RATE = 0.0002; // 0.02% maker fee for resting Paper Limit fills

export class ExchangeExecutionService {
  private repo: QuantRepository;

  constructor(repo: QuantRepository) {
    this.repo = repo;
  }

  public async executeOrder(params: {
    clientOrderId: string;
    mode: ExecutionMode;
    venue: MarketVenue;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    orderType?: 'MARKET' | 'LIMIT';
    qtyBtc: number;
    referencePrice: number;
    limitPrice?: number;
    expiresInMs?: number;
    confirmLiveOverride?: boolean;
  }): Promise<ExecutionOrderRecord> {
    const existing = this.repo.getOrderByClientId(params.clientOrderId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const orderType: 'MARKET' | 'LIMIT' = params.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET';
    const targetPrice =
      orderType === 'LIMIT' && typeof params.limitPrice === 'number' && Number.isFinite(params.limitPrice)
        ? params.limitPrice
        : params.referencePrice;

    const q = quantizeAndValidateOrder({
      price: targetPrice,
      qtyBtc: params.qtyBtc,
    });

    if (!q.valid || (orderType === 'LIMIT' && (!params.limitPrice || params.limitPrice <= 0))) {
      const rejected: ExecutionOrderRecord = {
        clientOrderId: params.clientOrderId,
        exchangeOrderId: null,
        mode: params.mode,
        venue: params.venue,
        side: params.side,
        positionSide: params.positionSide,
        orderType,
        requestedQtyBtc: params.qtyBtc,
        executedQtyBtc: 0,
        requestedPrice: params.referencePrice,
        limitPrice: orderType === 'LIMIT' ? (params.limitPrice ?? null) : null,
        executedPrice: null,
        status: 'REJECTED',
        feeUsd: 0,
        reason: orderType === 'LIMIT' && (!params.limitPrice || params.limitPrice <= 0)
          ? 'Giá Limit không hợp lệ.'
          : q.error,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.saveOrder(rejected);
      this.repo.log('WARN', 'EXECUTION', `Order ${params.clientOrderId} rejected: ${rejected.reason}`);
      return rejected;
    }

    if (params.mode === 'SIMULATION' || params.mode === 'PAPER') {
      if (orderType === 'LIMIT') {
        const refRounded = roundToTickSize(params.referencePrice, DEFAULT_BTC_FILTERS.tickSize);
        const isMarketable =
          (params.side === 'BUY' && q.quantizedPrice >= refRounded) ||
          (params.side === 'SELL' && q.quantizedPrice <= refRounded);

        if (isMarketable) {
          const feeUsd = Number((refRounded * q.quantizedQtyBtc * TAKER_FEE_RATE).toFixed(2));
          const filledLimit: ExecutionOrderRecord = {
            clientOrderId: params.clientOrderId,
            exchangeOrderId: `${params.mode === 'PAPER' ? 'PPR-LMT' : 'SIM-LMT'}-${now.toString(36).toUpperCase()}`,
            mode: params.mode,
            venue: params.venue,
            side: params.side,
            positionSide: params.positionSide,
            orderType: 'LIMIT',
            requestedQtyBtc: q.quantizedQtyBtc,
            executedQtyBtc: q.quantizedQtyBtc,
            requestedPrice: refRounded,
            limitPrice: q.quantizedPrice,
            executedPrice: refRounded,
            status: params.mode === 'PAPER' ? 'FILLED' : 'SIMULATED',
            feeUsd,
            reason: 'Lệnh Limit chạm ngay giá thị trường — khớp tức thì (Marketable Limit).',
            expiresAt: null,
            createdAt: now,
            updatedAt: now,
          };
          this.repo.saveOrder(filledLimit);
          this.repo.log('INFO', 'EXECUTION', `${params.mode} LIMIT filled immediately ${params.side} ${q.quantizedQtyBtc} @ $${refRounded}`);
          return filledLimit;
        }

        const expiresAt = now + Math.max(60_000, Math.min(86_400_000, params.expiresInMs ?? 3_600_000));
        const resting: ExecutionOrderRecord = {
          clientOrderId: params.clientOrderId,
          exchangeOrderId: `${params.mode === 'PAPER' ? 'PPR-LMT' : 'SIM-LMT'}-${now.toString(36).toUpperCase()}`,
          mode: params.mode,
          venue: params.venue,
          side: params.side,
          positionSide: params.positionSide,
          orderType: 'LIMIT',
          requestedQtyBtc: q.quantizedQtyBtc,
          executedQtyBtc: 0,
          requestedPrice: refRounded,
          limitPrice: q.quantizedPrice,
          executedPrice: null,
          status: 'NEW',
          feeUsd: 0,
          reason: `Lệnh Limit đang treo chờ khớp tại $${q.quantizedPrice.toLocaleString('en-US')}.`,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        };
        this.repo.saveOrder(resting);
        this.repo.log('INFO', 'EXECUTION', `${params.mode} LIMIT resting NEW ${params.side} ${q.quantizedQtyBtc} BTC @ $${q.quantizedPrice}`);
        return resting;
      }

      const slippage = q.quantizedPrice * 0.0002;
      const fillPrice = Number(
        (params.side === 'BUY' ? q.quantizedPrice + slippage : q.quantizedPrice - slippage).toFixed(2),
      );
      const feeUsd = Number((fillPrice * q.quantizedQtyBtc * TAKER_FEE_RATE).toFixed(2));
      const record: ExecutionOrderRecord = {
        clientOrderId: params.clientOrderId,
        exchangeOrderId: `${params.mode === 'PAPER' ? 'PPR' : 'SIM'}-${now.toString(36).toUpperCase()}`,
        mode: params.mode,
        venue: params.venue,
        side: params.side,
        positionSide: params.positionSide,
        orderType: 'MARKET',
        requestedQtyBtc: q.quantizedQtyBtc,
        executedQtyBtc: q.quantizedQtyBtc,
        requestedPrice: q.quantizedPrice,
        limitPrice: null,
        executedPrice: fillPrice,
        status: params.mode === 'PAPER' ? 'FILLED' : 'SIMULATED',
        feeUsd,
        reason:
          params.mode === 'PAPER'
            ? 'Khớp Paper Trading trên sổ lệnh thời gian thực (tính trượt giá & phí).'
            : 'Khớp mô phỏng cục bộ (SIMULATION).',
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.saveOrder(record);
      this.repo.log(
        'INFO',
        'EXECUTION',
        `${params.mode} ${params.side} ${q.quantizedQtyBtc} BTC @ $${fillPrice} (${params.venue})`,
      );
      return record;
    }

    if (params.mode === 'LIVE') {
      const creds = getExchangeCredentialsStatus();
      if (
        !creds.liveTradingAllowedByEnv ||
        !creds.liveCredentialsConfigured ||
        !params.confirmLiveOverride
      ) {
        const blocked: ExecutionOrderRecord = {
          clientOrderId: params.clientOrderId,
          exchangeOrderId: null,
          mode: 'LIVE',
          venue: params.venue,
          side: params.side,
          positionSide: params.positionSide,
          orderType,
          requestedQtyBtc: q.quantizedQtyBtc,
          executedQtyBtc: 0,
          requestedPrice: q.quantizedPrice,
          limitPrice: orderType === 'LIMIT' ? q.quantizedPrice : null,
          executedPrice: null,
          status: 'REJECTED',
          feeUsd: 0,
          reason:
            'Chế độ LIVE Trading bị khóa an toàn mặc định (yêu cầu ALLOW_LIVE_TRADING=true, API Key backend và xác nhận thủ công).',
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.repo.saveOrder(blocked);
        this.repo.log('SECURITY', 'EXECUTION', `Blocked LIVE order attempt ${params.clientOrderId}`);
        return blocked;
      }
    }

    // TESTNET (or explicit verified LIVE) signed REST request
    const isFutures = params.venue === 'BINANCE_FUTURES';
    const apiKey =
      params.mode === 'LIVE'
        ? process.env.BINANCE_LIVE_API_KEY
        : isFutures
          ? process.env.BINANCE_FUTURES_TESTNET_API_KEY || process.env.BINANCE_TESTNET_API_KEY
          : process.env.BINANCE_TESTNET_API_KEY;
    const apiSecret =
      params.mode === 'LIVE'
        ? process.env.BINANCE_LIVE_API_SECRET
        : isFutures
          ? process.env.BINANCE_FUTURES_TESTNET_API_SECRET || process.env.BINANCE_TESTNET_API_SECRET
          : process.env.BINANCE_TESTNET_API_SECRET;

    if (!apiKey || !apiSecret) {
      const missingCreds: ExecutionOrderRecord = {
        clientOrderId: params.clientOrderId,
        exchangeOrderId: null,
        mode: params.mode,
        venue: params.venue,
        side: params.side,
        positionSide: params.positionSide,
        orderType: 'MARKET',
        requestedQtyBtc: q.quantizedQtyBtc,
        executedQtyBtc: 0,
        requestedPrice: q.quantizedPrice,
        executedPrice: null,
        status: 'REJECTED',
        feeUsd: 0,
        reason: `Chưa cấu hình ${params.mode} API Key / Secret trên biến môi trường server.`,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.saveOrder(missingCreds);
      return missingCreds;
    }

    const baseUrl =
      params.mode === 'LIVE'
        ? isFutures
          ? 'https://fapi.binance.com'
          : 'https://api.binance.com'
        : isFutures
          ? 'https://testnet.binancefuture.com'
          : 'https://testnet.binance.vision';
    const endpoint = isFutures ? '/fapi/v1/order' : '/api/v3/order';

    const queryParams = new URLSearchParams({
      symbol: 'BTCUSDT',
      side: params.side,
      type: 'MARKET',
      quantity: q.quantizedQtyBtc.toString(),
      newClientOrderId: params.clientOrderId,
      recvWindow: '5000',
      timestamp: Date.now().toString(),
    });
    const signature = signBinanceQuery(queryParams.toString(), apiSecret);
    queryParams.append('signature', signature);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${baseUrl}${endpoint}?${queryParams.toString()}`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiKey,
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const errMsg = typeof data.msg === 'string' ? data.msg : `HTTP ${res.status}`;
        const rejected: ExecutionOrderRecord = {
          clientOrderId: params.clientOrderId,
          exchangeOrderId: null,
          mode: params.mode,
          venue: params.venue,
          side: params.side,
          positionSide: params.positionSide,
          orderType: 'MARKET',
          requestedQtyBtc: q.quantizedQtyBtc,
          executedQtyBtc: 0,
          requestedPrice: q.quantizedPrice,
          executedPrice: null,
          status: 'REJECTED',
          feeUsd: 0,
          reason: `Sàn từ chối lệnh: ${errMsg}`,
          createdAt: now,
          updatedAt: Date.now(),
        };
        this.repo.saveOrder(rejected);
        this.repo.log('ERROR', 'EXECUTION', `${params.mode} order rejected: ${errMsg}`);
        return rejected;
      }

      const rawStatus = String(data.status ?? 'NEW') as ExecutionOrderRecord['status'];
      const execQty = Number(data.executedQty ?? 0);
      const cummQuote = Number(data.cummulativeQuoteQty ?? data.cumQuote ?? 0);
      const avgFill = execQty > 0 && cummQuote > 0 ? Number((cummQuote / execQty).toFixed(2)) : q.quantizedPrice;

      const accepted: ExecutionOrderRecord = {
        clientOrderId: params.clientOrderId,
        exchangeOrderId: data.orderId ? String(data.orderId) : null,
        mode: params.mode,
        venue: params.venue,
        side: params.side,
        positionSide: params.positionSide,
        orderType: 'MARKET',
        requestedQtyBtc: q.quantizedQtyBtc,
        executedQtyBtc: Number.isFinite(execQty) ? execQty : 0,
        requestedPrice: q.quantizedPrice,
        executedPrice: execQty > 0 ? avgFill : null,
        status: rawStatus,
        feeUsd: Number((cummQuote * TAKER_FEE_RATE).toFixed(2)),
        reason: `Phản hồi sàn ${params.mode}: ${rawStatus}`,
        createdAt: now,
        updatedAt: Date.now(),
      };
      this.repo.saveOrder(accepted);
      return accepted;
    } catch (err) {
      const failed: ExecutionOrderRecord = {
        clientOrderId: params.clientOrderId,
        exchangeOrderId: null,
        mode: params.mode,
        venue: params.venue,
        side: params.side,
        positionSide: params.positionSide,
        orderType: 'MARKET',
        requestedQtyBtc: q.quantizedQtyBtc,
        executedQtyBtc: 0,
        requestedPrice: q.quantizedPrice,
        executedPrice: null,
        status: 'REJECTED',
        feeUsd: 0,
        reason: `Lỗi kết nối sàn ${params.mode}: ${err instanceof Error ? err.message : 'Timeout'}`,
        createdAt: now,
        updatedAt: Date.now(),
      };
      this.repo.saveOrder(failed);
      return failed;
    }
  }

  public cancelOrder(clientOrderId: string): {
    ok: boolean;
    order: ExecutionOrderRecord | null;
    error: string | null;
  } {
    const existing = this.repo.getOrderByClientId(clientOrderId);
    if (!existing) {
      return { ok: false, order: null, error: 'Không tìm thấy lệnh với clientOrderId này.' };
    }
    if (existing.status !== 'NEW' && existing.status !== 'PARTIALLY_FILLED') {
      return {
        ok: false,
        order: existing,
        error: `Không thể hủy lệnh ở trạng thái ${existing.status}.`,
      };
    }

    const updated: ExecutionOrderRecord = {
      ...existing,
      status: 'CANCELED',
      reason: 'Người dùng hủy lệnh chờ (Canceled).',
      updatedAt: Date.now(),
    };
    this.repo.saveOrder(updated);
    this.repo.log('INFO', 'EXECUTION', `Canceled order ${clientOrderId}`);
    return { ok: true, order: updated, error: null };
  }

  public matchOpenPaperOrders(marketPrice: number, now = Date.now()): ExecutionOrderRecord[] {
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) return [];
    const openOrders = this.repo.getOpenLimitOrders();
    const updatedOrders: ExecutionOrderRecord[] = [];

    for (const order of openOrders) {
      if (order.mode !== 'PAPER' && order.mode !== 'SIMULATION') continue;

      if (order.expiresAt && now > order.expiresAt) {
        const expired: ExecutionOrderRecord = {
          ...order,
          status: 'CANCELED',
          reason: 'Lệnh Limit hết hạn (Expired).',
          updatedAt: now,
        };
        this.repo.saveOrder(expired);
        this.repo.log('INFO', 'EXECUTION', `Expired LIMIT order ${order.clientOrderId}`);
        updatedOrders.push(expired);
        continue;
      }

      const limitPrice = order.limitPrice ?? order.requestedPrice;
      if (limitPrice <= 0) continue;

      const crossed =
        (order.side === 'BUY' && marketPrice <= limitPrice) ||
        (order.side === 'SELL' && marketPrice >= limitPrice);

      if (crossed) {
        const feeUsd = Number((limitPrice * order.requestedQtyBtc * MAKER_FEE_RATE).toFixed(2));
        const filled: ExecutionOrderRecord = {
          ...order,
          executedQtyBtc: order.requestedQtyBtc,
          executedPrice: limitPrice,
          status: order.mode === 'PAPER' ? 'FILLED' : 'SIMULATED',
          feeUsd,
          reason: `Khớp Paper LIMIT @ $${limitPrice.toLocaleString('en-US')} (giá TT $${marketPrice.toLocaleString('en-US')}).`,
          updatedAt: now,
        };
        this.repo.saveOrder(filled);
        this.repo.log(
          'INFO',
          'EXECUTION',
          `Matched LIMIT ${order.side} ${order.requestedQtyBtc} BTC @ $${limitPrice}`,
        );
        updatedOrders.push(filled);
      }
    }

    return updatedOrders;
  }

  public getPaperReconciliation(params?: {
    config?: StrategyConfig;
    accountState?: RiskAccountState;
    activePosition?: Position | null;
    trades?: ClosedTrade[];
  }): PaperReconciliationReport {
    const config = params?.config ?? this.repo.getConfig();
    const accountState = params?.accountState ?? this.repo.getAccountState();
    const activePosition =
      params?.activePosition !== undefined ? params.activePosition : this.repo.getActivePosition();
    const trades = params?.trades ?? this.repo.getTrades(500);
    const openLimitOrders = this.repo.getOpenLimitOrders();

    const effLev =
      config.marketVenue === 'BINANCE_SPOT' ? 1 : Math.max(1, config.maxLeverage);

    const openPositionNotionalUsd = activePosition
      ? Number((activePosition.remainingBtc * activePosition.currentPrice).toFixed(2))
      : 0;
    const usedMarginUsd = activePosition
      ? Number(
          (
            activePosition.marginUsedUsd ??
            activePosition.notionalUsd / effLev
          ).toFixed(2),
        )
      : 0;

    const pendingOrdersMarginUsd = Number(
      openLimitOrders
        .reduce((acc, o) => {
          const px = o.limitPrice ?? o.requestedPrice;
          return acc + (px * Math.max(0, o.requestedQtyBtc - o.executedQtyBtc)) / effLev;
        }, 0)
        .toFixed(2),
    );

    const unrealizedPnlUsd = activePosition ? Number(activePosition.unrealizedPnl.toFixed(2)) : 0;
    const equityUsd = Number((accountState.equity + unrealizedPnlUsd).toFixed(2));
    const availableBalanceUsd = Math.max(
      0,
      Number((accountState.equity - usedMarginUsd - pendingOrdersMarginUsd).toFixed(2)),
    );

    const realizedPnlUsd = Number(trades.reduce((acc, t) => acc + t.pnlUsd, 0).toFixed(2));
    const totalFeesUsd = Number(
      (
        trades.reduce((acc, t) => acc + (t.feesPaidUsd ?? 0), 0) +
        (activePosition ? activePosition.feesPaidUsd : 0)
      ).toFixed(2),
    );

    const openCashDelta = activePosition ? activePosition.realizedPartialPnl : 0;
    const expectedCashEquity = Number(
      (config.initialCapital + realizedPnlUsd + openCashDelta).toFixed(2),
    );
    const discrepancyUsd = Number((accountState.equity - expectedCashEquity).toFixed(2));
    const consistent = Math.abs(discrepancyUsd) <= 5.0;

    const notes: string[] = [];
    if (consistent) {
      notes.push('Sổ cái Paper khớp cân bằng kế toán (Equity = Vốn gốc + PnL đã chốt + Chi phí vị thế mở).');
    } else {
      notes.push(`Phát hiện chênh lệch đối soát $${discrepancyUsd.toFixed(2)} so với tổng PnL lịch sử.`);
    }
    if (openLimitOrders.length > 0) {
      notes.push(`Đang khóa $${pendingOrdersMarginUsd.toFixed(2)} ký quỹ cho ${openLimitOrders.length} lệnh Limit treo.`);
    }

    return {
      timestamp: Date.now(),
      initialCapitalUsd: config.initialCapital,
      equityUsd,
      availableBalanceUsd,
      usedMarginUsd,
      pendingOrdersMarginUsd,
      openPositionNotionalUsd,
      realizedPnlUsd,
      unrealizedPnlUsd,
      totalFeesUsd,
      totalTrades: trades.length,
      openLimitOrdersCount: openLimitOrders.length,
      discrepancyUsd,
      consistent,
      notes,
    };
  }
}
