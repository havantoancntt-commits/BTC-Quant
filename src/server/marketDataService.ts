import { computeEMA, computeRSI, sanitizeCandles } from '../engine/indicators';
import type {
  Candle,
  DataClassificationStatus,
  FeedHealthStatus,
  FeedHealthTelemetry,
  FuturesMarketMetrics,
  HtfContext,
  HtfTimeframeSummary,
  MarketFeedSource,
  MarketMetadata,
  MarketSnapshot,
  MarketVenue,
  OrderbookLevel,
  TimeframeKey,
} from '../engine/types';

export const SPOT_REST_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
];

export const FUTURES_REST_HOSTS = [
  'https://fapi.binance.com',
];

export const SPOT_WS_HOSTS = [
  'wss://data-stream.binance.vision/stream?streams=btcusdt@ticker/btcusdt@kline_15m/btcusdt@depth20@1000ms/btcusdt@aggTrade',
  'wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/btcusdt@kline_15m/btcusdt@depth20@1000ms/btcusdt@aggTrade',
];

export const FUTURES_WS_HOSTS = [
  'wss://fstream.binance.com/stream?streams=btcusdt@ticker/btcusdt@kline_15m/btcusdt@depth20@500ms/btcusdt@markPrice@1s/btcusdt@aggTrade',
];

const STALE_AFTER_MS = 20000;
const AGG_TRADE_WINDOW_MS = 15 * 60 * 1000;

function extractClosedKlineCloses(rows: Array<Array<string | number>> | null, now = Date.now()): number[] {
  if (!rows || rows.length === 0) return [];
  const strictlyClosed = rows.filter((r) => {
    const closeTime = Number(r[6] ?? 0);
    return closeTime > 0 ? now > closeTime : false;
  });
  const effective = strictlyClosed.length > 0 ? strictlyClosed : rows.slice(0, -1);
  return effective.map((r) => Number(r[4])).filter((v) => Number.isFinite(v) && v > 0);
}

export function buildTopDepthLevels(raw: Array<[string, string]>, limit = 5): OrderbookLevel[] {
  let running = 0;
  return raw.slice(0, limit).map(([pStr, qStr]) => {
    const price = Number(pStr);
    const qty = Number(qStr);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty < 0) {
      return { price: 0, qty: 0, total: Number(running.toFixed(4)) };
    }
    running += qty;
    return {
      price,
      qty: Number(qty.toFixed(4)),
      total: Number(running.toFixed(4)),
    };
  });
}

function summarizeTimeframe(tf: TimeframeKey, closes: number[]): HtfTimeframeSummary {
  const sufficientData = closes.length >= 26;
  if (closes.length < 5) {
    return {
      timeframe: tf,
      bias: 'NEUTRAL',
      emaFast: 0,
      emaSlow: 0,
      rsi14: 50,
      candleCount: closes.length,
      sufficientData: false,
    };
  }
  const fastPeriod = tf === '1d' ? 10 : 21;
  const slowPeriod = tf === '1d' ? 30 : 50;
  const last = closes[closes.length - 1];
  const emaFast = computeEMA(closes, Math.min(fastPeriod, closes.length));
  const emaSlow = computeEMA(closes, Math.min(slowPeriod, closes.length));
  const rsi14 = computeRSI(closes, Math.min(14, Math.max(4, closes.length - 2)));

  let bias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (sufficientData) {
    if (last > emaFast && emaFast > emaSlow && rsi14 >= 48) bias = 'LONG';
    else if (last < emaFast && emaFast < emaSlow && rsi14 <= 52) bias = 'SHORT';
  }
  return {
    timeframe: tf,
    bias,
    emaFast: Number(emaFast.toFixed(2)),
    emaSlow: Number(emaSlow.toFixed(2)),
    rsi14: Number(rsi14.toFixed(1)),
    candleCount: closes.length,
    sufficientData,
  };
}

export function buildExchangeHtfContext(params: {
  m5Closes?: number[];
  h1Closes: number[];
  h4Closes: number[];
  d1Closes?: number[];
}): HtfContext {
  const h1 = summarizeTimeframe('1h', params.h1Closes);
  const h4 = summarizeTimeframe('4h', params.h4Closes);
  const m5 = params.m5Closes ? summarizeTimeframe('5m', params.m5Closes) : undefined;
  const d1 = params.d1Closes ? summarizeTimeframe('1d', params.d1Closes) : undefined;

  return {
    h1Bias: h1.bias,
    h4Bias: h4.bias,
    d1Bias: d1?.bias,
    m5Bias: m5?.bias,
    h1Rsi: h1.rsi14,
    h1Ema50: h1.emaSlow,
    source: h1.sufficientData && h4.sufficientData ? 'EXCHANGE_KLINES' : 'INSUFFICIENT',
    timeframes: {
      ...(m5 ? { '5m': m5 } : {}),
      '1h': h1,
      '4h': h4,
      ...(d1 ? { '1d': d1 } : {}),
    },
  };
}

export function parseBinanceKlineRows(rows: Array<Array<string | number>>): Candle[] {
  const now = Date.now();
  const raw: Candle[] = rows.map((k) => {
    const closeTime = Number(k[6] ?? 0);
    return {
      time: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      isClosed: closeTime > 0 ? now > closeTime : true,
    };
  });
  return sanitizeCandles(raw).candles;
}

export function computeFeedHealthStatus(params: {
  candlesCount: number;
  lastMessageAt: number;
  wsConnected: boolean;
  hasError: boolean;
  now?: number;
}): FeedHealthStatus {
  const now = params.now ?? Date.now();
  if (params.candlesCount === 0 && params.lastMessageAt === 0) return 'DISCONNECTED';
  const age = now - params.lastMessageAt;
  if (age > STALE_AFTER_MS * 3 && !params.wsConnected) return 'DISCONNECTED';
  if (age > STALE_AFTER_MS) return 'STALE';
  if (params.candlesCount < 60 || params.hasError) return 'INCOMPLETE';
  return 'HEALTHY';
}

export class MarketDataHub {
  private activeVenue: MarketVenue = 'BINANCE_SPOT';
  private states: Record<MarketVenue, MarketSnapshot | null> = {
    BINANCE_SPOT: null,
    BINANCE_FUTURES: null,
  };
  private healthMeta: Record<
    MarketVenue,
    {
      wsConn: WebSocket | null;
      wsHostIdx: number;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      reconnectCount: number;
      rateLimit429Count: number;
      duplicatesRemoved: number;
      candleGapsDetected: number;
      sequenceNumber: number;
      serverTimeOffsetMs: number;
      exchangeTimestamp: number;
      lastError: string | null;
      inflightRefresh: Promise<MarketSnapshot | null> | null;
    }
  > = {
    BINANCE_SPOT: {
      wsConn: null,
      wsHostIdx: 0,
      reconnectTimer: null,
      reconnectCount: 0,
      rateLimit429Count: 0,
      duplicatesRemoved: 0,
      candleGapsDetected: 0,
      sequenceNumber: 0,
      serverTimeOffsetMs: 0,
      exchangeTimestamp: 0,
      lastError: null,
      inflightRefresh: null,
    },
    BINANCE_FUTURES: {
      wsConn: null,
      wsHostIdx: 0,
      reconnectTimer: null,
      reconnectCount: 0,
      rateLimit429Count: 0,
      duplicatesRemoved: 0,
      candleGapsDetected: 0,
      sequenceNumber: 0,
      serverTimeOffsetMs: 0,
      exchangeTimestamp: 0,
      lastError: null,
      inflightRefresh: null,
    },
  };

  private aggTradesBucket: Record<MarketVenue, Array<{ time: number; signedUsdM: number }>> = {
    BINANCE_SPOT: [],
    BINANCE_FUTURES: [],
  };

  private onTickCallbacks = new Set<(snap: MarketSnapshot, force: boolean) => void>();
  private stopped = false;

  public getVenue(): MarketVenue {
    return this.activeVenue;
  }

  public setVenue(venue: MarketVenue): void {
    this.activeVenue = venue;
  }

  public subscribe(cb: (snap: MarketSnapshot, force: boolean) => void): () => void {
    this.onTickCallbacks.add(cb);
    return () => {
      this.onTickCallbacks.delete(cb);
    };
  }

  private emit(venue: MarketVenue, force: boolean): void {
    if (venue !== this.activeVenue) return;
    const snap = this.states[venue];
    if (!snap) return;
    for (const cb of this.onTickCallbacks) {
      cb(snap, force);
    }
  }

  private recordAggTrade(venue: MarketVenue, time: number, signedUsdM: number): number {
    const arr = this.aggTradesBucket[venue];
    arr.push({ time, signedUsdM });
    const cutoff = time - AGG_TRADE_WINDOW_MS;
    while (arr.length > 0 && arr[0].time < cutoff) {
      arr.shift();
    }
    const sum = arr.reduce((a, b) => a + b.signedUsdM, 0);
    return Number(sum.toFixed(2));
  }

  private getAggTradeDelta(venue: MarketVenue): number | null {
    const arr = this.aggTradesBucket[venue];
    if (arr.length === 0) return null;
    const cutoff = Date.now() - AGG_TRADE_WINDOW_MS;
    while (arr.length > 0 && arr[0].time < cutoff) {
      arr.shift();
    }
    if (arr.length === 0) return null;
    return Number(arr.reduce((a, b) => a + b.signedUsdM, 0).toFixed(2));
  }

  private async fetchJsonWithTimeout<T>(url: string, venue: MarketVenue, ms = 3500): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 429 || res.status === 418) {
        this.healthMeta[venue].rateLimit429Count++;
        throw new Error(`HTTP ${res.status} Rate Limited`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private classifyDataStatus(
    status: FeedHealthStatus,
    source: MarketFeedSource,
    orderbookSource: 'EXCHANGE_DEPTH' | 'UNAVAILABLE',
    candlesCount: number,
  ): { dataStatus: DataClassificationStatus; qualityFlags: string[] } {
    const flags: string[] = [];
    if (candlesCount === 0) {
      return { dataStatus: 'UNAVAILABLE', qualityFlags: ['NO_CANDLES'] };
    }
    if (source === 'quant_engine_sim') {
      return { dataStatus: 'SIMULATED_DATA', qualityFlags: ['SIMULATED_FEED'] };
    }
    if (orderbookSource === 'UNAVAILABLE') flags.push('ORDERBOOK_UNAVAILABLE');
    if (this.getAggTradeDelta(source.includes('futures') ? 'BINANCE_FUTURES' : 'BINANCE_SPOT') === null) {
      flags.push('AGGTRADE_WARMING_UP');
    }
    if (status === 'STALE' || status === 'DISCONNECTED') {
      flags.push(`FEED_${status}`);
      return { dataStatus: 'STALE_DATA', qualityFlags: flags };
    }
    if (status === 'INCOMPLETE') {
      flags.push('FEED_INCOMPLETE');
      return { dataStatus: 'ESTIMATED_DATA', qualityFlags: flags };
    }
    return { dataStatus: 'LIVE_DATA', qualityFlags: flags };
  }

  private buildMetadata(
    venue: MarketVenue,
    source: MarketFeedSource,
    updatedAt: number,
    orderbookSource: 'EXCHANGE_DEPTH' | 'UNAVAILABLE',
    candlesCount: number,
    status: FeedHealthStatus,
  ): MarketMetadata {
    const meta = this.healthMeta[venue];
    const classified = this.classifyDataStatus(status, source, orderbookSource, candlesCount);
    return {
      symbol: 'BTCUSDT',
      market_type: venue === 'BINANCE_FUTURES' ? 'FUTURES' : 'SPOT',
      timeframe: '15m',
      exchange_timestamp: meta.exchangeTimestamp || updatedAt,
      received_timestamp: updatedAt || Date.now(),
      sequence_number: meta.sequenceNumber,
      data_status: classified.dataStatus,
      quality_flags: classified.qualityFlags,
    };
  }

  private buildHealth(
    venue: MarketVenue,
    source: MarketFeedSource,
    updatedAt: number,
    candlesCount: number,
    orderbookSource: 'EXCHANGE_DEPTH' | 'UNAVAILABLE' = 'UNAVAILABLE',
  ): FeedHealthTelemetry {
    const meta = this.healthMeta[venue];
    const wsConnected = meta.wsConn !== null && meta.wsConn.readyState === WebSocket.OPEN;
    const ageMs = updatedAt > 0 ? Math.max(0, Date.now() - updatedAt) : 0;
    const status = computeFeedHealthStatus({
      candlesCount,
      lastMessageAt: updatedAt,
      wsConnected,
      hasError: candlesCount < 60 && meta.lastError !== null,
    });
    const classified = this.classifyDataStatus(status, source, orderbookSource, candlesCount);
    return {
      status,
      dataStatus: classified.dataStatus,
      venue,
      source,
      lastMessageAt: updatedAt,
      exchangeTimestamp: meta.exchangeTimestamp || updatedAt,
      serverTimeOffsetMs: meta.serverTimeOffsetMs,
      sequenceNumber: meta.sequenceNumber,
      ageMs,
      staleAfterMs: STALE_AFTER_MS,
      wsConnected,
      wsHeartbeatOk: wsConnected && ageMs <= STALE_AFTER_MS,
      reconnectCount: meta.reconnectCount,
      candleGapsDetected: meta.candleGapsDetected,
      duplicatesRemoved: meta.duplicatesRemoved,
      rateLimit429Count: meta.rateLimit429Count,
      qualityFlags: classified.qualityFlags,
      lastError: meta.lastError,
    };
  }

  public getSnapshot(venue = this.activeVenue): MarketSnapshot | null {
    const snap = this.states[venue];
    if (!snap) return null;
    const obSrc = snap.orderbookSource ?? 'UNAVAILABLE';
    snap.health = this.buildHealth(venue, snap.source, snap.updatedAt, snap.candles.length, obSrc);
    snap.metadata = this.buildMetadata(
      venue,
      snap.source,
      snap.updatedAt,
      obSrc,
      snap.candles.length,
      snap.health.status,
    );
    snap.aggTradeCvdDelta = this.getAggTradeDelta(venue);
    return snap;
  }

  public getAllHealth(): Record<MarketVenue, FeedHealthTelemetry> {
    const build = (v: MarketVenue): FeedHealthTelemetry => {
      const s = this.states[v];
      return this.buildHealth(
        v,
        s?.source ?? 'quant_engine_sim',
        s?.updatedAt ?? 0,
        s?.candles.length ?? 0,
        s?.orderbookSource ?? 'UNAVAILABLE',
      );
    };
    return {
      BINANCE_SPOT: build('BINANCE_SPOT'),
      BINANCE_FUTURES: build('BINANCE_FUTURES'),
    };
  }

  public async fetchHistoricalKlines(params: {
    venue: MarketVenue;
    interval: TimeframeKey;
    limit?: number;
  }): Promise<{ candles: Candle[]; source: string; warnings: string[] }> {
    const limit = Math.max(100, Math.min(1000, params.limit ?? 1000));
    const hosts = params.venue === 'BINANCE_FUTURES' ? FUTURES_REST_HOSTS : SPOT_REST_HOSTS;
    const endpoint = params.venue === 'BINANCE_FUTURES' ? '/fapi/v1/klines' : '/api/v3/klines';

    for (const host of hosts) {
      try {
        const rows = await this.fetchJsonWithTimeout<Array<Array<string | number>>>(
          `${host}${endpoint}?symbol=BTCUSDT&interval=${params.interval}&limit=${limit}`,
          params.venue,
          6000,
        );
        const raw = rows.map((k) => ({
          time: Number(k[0]),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
          isClosed: Date.now() > Number(k[6] ?? 0),
        }));
        const sanitized = sanitizeCandles(raw);
        const warnings: string[] = [];
        if (sanitized.duplicatesRemoved > 0) {
          warnings.push(`Loại bỏ ${sanitized.duplicatesRemoved} nến trùng.`);
        }
        if (sanitized.gapsDetected > 0) {
          warnings.push(`Phát hiện ${sanitized.gapsDetected} khoảng trống timestamp.`);
        }
        return {
          candles: sanitized.candles,
          source: `${params.venue === 'BINANCE_FUTURES' ? 'Binance USDⓈ-M Futures' : 'Binance Spot'} (${host.replace('https://', '')})`,
          warnings,
        };
      } catch {
        // try next host
      }
    }
    throw new Error(`Không thể tải dữ liệu lịch sử ${params.venue} (${params.interval}).`);
  }

  public async refreshRestSnapshot(venue = this.activeVenue): Promise<MarketSnapshot | null> {
    const meta = this.healthMeta[venue];
    if (meta.inflightRefresh) return meta.inflightRefresh;

    meta.inflightRefresh = (async () => {
      const result =
        venue === 'BINANCE_FUTURES'
          ? await this.fetchBinanceFuturesRest()
          : await this.fetchBinanceSpotRest();

      if (result && result.candles.length > 0) {
        const prev = this.states[venue];
        const wsHealthy = meta.wsConn && meta.wsConn.readyState === WebSocket.OPEN;
        if (prev && wsHealthy) {
          prev.htfContext = result.htfContext;
          if (venue === 'BINANCE_FUTURES') {
            prev.fundingRate = result.fundingRate;
            prev.futuresMetrics = result.futuresMetrics;
          }
          if (prev.candles.length < 60) {
            prev.candles = result.candles;
          }
        } else {
          this.states[venue] = result;
          this.emit(venue, true);
        }
        return this.getSnapshot(venue);
      }

      if (venue === 'BINANCE_SPOT') {
        const coinbase = await this.fetchCoinbaseSpotFallback();
        if (coinbase && coinbase.candles.length > 0) {
          this.states[venue] = coinbase;
          this.emit(venue, true);
          return this.getSnapshot(venue);
        }
      }
      return this.getSnapshot(venue);
    })().finally(() => {
      meta.inflightRefresh = null;
    });

    return meta.inflightRefresh;
  }

  private async fetchBinanceSpotRest(): Promise<MarketSnapshot | null> {
    const meta = this.healthMeta.BINANCE_SPOT;
    for (const host of SPOT_REST_HOSTS) {
      try {
        const [k15, k5m, k1h, k4h, k1d, tickerJson, depthJson, timeJson] = await Promise.all([
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=200`,
            'BINANCE_SPOT',
          ),
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=64`,
            'BINANCE_SPOT',
          ).catch(() => null),
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=64`,
            'BINANCE_SPOT',
          ).catch(() => null),
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=54`,
            'BINANCE_SPOT',
          ).catch(() => null),
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=45`,
            'BINANCE_SPOT',
          ).catch(() => null),
          this.fetchJsonWithTimeout<{
            lastPrice: string;
            priceChangePercent: string;
            highPrice: string;
            lowPrice: string;
            quoteVolume: string;
            bidPrice?: string;
            askPrice?: string;
            closeTime?: number;
          }>(`${host}/api/v3/ticker/24hr?symbol=BTCUSDT`, 'BINANCE_SPOT'),
          this.fetchJsonWithTimeout<{
            bids: Array<[string, string]>;
            asks: Array<[string, string]>;
          }>(`${host}/api/v3/depth?symbol=BTCUSDT&limit=20`, 'BINANCE_SPOT').catch(() => null),
          this.fetchJsonWithTimeout<{ serverTime?: number }>(
            `${host}/api/v3/time`,
            'BINANCE_SPOT',
          ).catch(() => null),
        ]);

        const now = Date.now();
        if (timeJson?.serverTime && Number.isFinite(timeJson.serverTime)) {
          meta.serverTimeOffsetMs = timeJson.serverTime - now;
          meta.exchangeTimestamp = timeJson.serverTime;
        } else if (tickerJson.closeTime) {
          meta.exchangeTimestamp = tickerJson.closeTime;
        }

        const rawCandles = parseBinanceKlineRows(k15);
        const sanitized = sanitizeCandles(rawCandles);
        meta.duplicatesRemoved += sanitized.duplicatesRemoved;
        meta.candleGapsDetected = sanitized.gapsDetected;
        meta.sequenceNumber += 1;
        meta.lastError = null;

        const htfContext = buildExchangeHtfContext({
          m5Closes: extractClosedKlineCloses(k5m, now),
          h1Closes: extractClosedKlineCloses(k1h, now),
          h4Closes: extractClosedKlineCloses(k4h, now),
          d1Closes: extractClosedKlineCloses(k1d, now),
        });

        const price = Number(tickerJson.lastPrice);
        let bestBid = Number(tickerJson.bidPrice || price);
        let bestAsk = Number(tickerJson.askPrice || price);
        let orderbookImbalance = 0;
        let orderbookSource: 'EXCHANGE_DEPTH' | 'UNAVAILABLE' = 'UNAVAILABLE';
        let orderbookBids: OrderbookLevel[] = [];
        let orderbookAsks: OrderbookLevel[] = [];

        if (depthJson && depthJson.bids.length > 0 && depthJson.asks.length > 0) {
          orderbookSource = 'EXCHANGE_DEPTH';
          bestBid = Number(depthJson.bids[0][0]);
          bestAsk = Number(depthJson.asks[0][0]);
          orderbookBids = buildTopDepthLevels(depthJson.bids, 5);
          orderbookAsks = buildTopDepthLevels(depthJson.asks, 5);
          const bidVol = depthJson.bids.reduce((s, b) => s + Number(b[1]), 0);
          const askVol = depthJson.asks.reduce((s, a) => s + Number(a[1]), 0);
          const total = bidVol + askVol;
          orderbookImbalance = total > 0 ? Number(((bidVol - askVol) / total).toFixed(4)) : 0;
        }

        const wsUp = meta.wsConn && meta.wsConn.readyState === WebSocket.OPEN;
        const source: MarketFeedSource = wsUp ? 'binance_spot_ws_live' : 'binance_spot_rest_live';
        const health = this.buildHealth('BINANCE_SPOT', source, now, sanitized.candles.length, orderbookSource);

        return {
          venue: 'BINANCE_SPOT',
          source,
          metadata: this.buildMetadata('BINANCE_SPOT', source, now, orderbookSource, sanitized.candles.length, health.status),
          health,
          candles: sanitized.candles,
          price,
          change24hPct: Number(tickerJson.priceChangePercent),
          high24h: Number(tickerJson.highPrice),
          low24h: Number(tickerJson.lowPrice),
          volume24hUsd: Number(tickerJson.quoteVolume),
          bestBid,
          bestAsk,
          orderbookImbalance,
          orderbookSource,
          orderbookBids,
          orderbookAsks,
          aggTradeCvdDelta: this.getAggTradeDelta('BINANCE_SPOT'),
          fundingRate: null, // Pure Spot market has NO perpetual funding rate
          htfContext,
          updatedAt: now,
        };
      } catch (err) {
        meta.lastError = err instanceof Error ? err.message : 'Spot REST fetch failed';
      }
    }
    return null;
  }

  private async fetchBinanceFuturesRest(): Promise<MarketSnapshot | null> {
    const meta = this.healthMeta.BINANCE_FUTURES;
    for (const host of FUTURES_REST_HOSTS) {
      try {
        const [k15, k5m, k1h, k4h, k1d, tickerJson, depthJson, premJson, oiJson, timeJson] = await Promise.all([
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=200`,
            'BINANCE_FUTURES',
          ),
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=64`,
            'BINANCE_FUTURES',
          ).catch(() => null),
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=64`,
            'BINANCE_FUTURES',
          ).catch(() => null),
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=54`,
            'BINANCE_FUTURES',
          ).catch(() => null),
          this.fetchJsonWithTimeout<Array<Array<string | number>>>(
            `${host}/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=45`,
            'BINANCE_FUTURES',
          ).catch(() => null),
          this.fetchJsonWithTimeout<{
            lastPrice: string;
            priceChangePercent: string;
            highPrice: string;
            lowPrice: string;
            quoteVolume: string;
            closeTime?: number;
          }>(`${host}/fapi/v1/ticker/24hr?symbol=BTCUSDT`, 'BINANCE_FUTURES'),
          this.fetchJsonWithTimeout<{
            bids: Array<[string, string]>;
            asks: Array<[string, string]>;
          }>(`${host}/fapi/v1/depth?symbol=BTCUSDT&limit=20`, 'BINANCE_FUTURES').catch(() => null),
          this.fetchJsonWithTimeout<{
            markPrice?: string;
            indexPrice?: string;
            lastFundingRate?: string;
            nextFundingTime?: number;
          }>(`${host}/fapi/v1/premiumIndex?symbol=BTCUSDT`, 'BINANCE_FUTURES').catch(() => null),
          this.fetchJsonWithTimeout<{ openInterest?: string }>(
            `${host}/fapi/v1/openInterest?symbol=BTCUSDT`,
            'BINANCE_FUTURES',
          ).catch(() => null),
          this.fetchJsonWithTimeout<{ serverTime?: number }>(
            `${host}/fapi/v1/time`,
            'BINANCE_FUTURES',
          ).catch(() => null),
        ]);

        const now = Date.now();
        if (timeJson?.serverTime && Number.isFinite(timeJson.serverTime)) {
          meta.serverTimeOffsetMs = timeJson.serverTime - now;
          meta.exchangeTimestamp = timeJson.serverTime;
        } else if (tickerJson.closeTime) {
          meta.exchangeTimestamp = tickerJson.closeTime;
        }

        const rawCandles = parseBinanceKlineRows(k15);
        const sanitized = sanitizeCandles(rawCandles);
        meta.duplicatesRemoved += sanitized.duplicatesRemoved;
        meta.candleGapsDetected = sanitized.gapsDetected;
        meta.sequenceNumber += 1;
        meta.lastError = null;

        const htfContext = buildExchangeHtfContext({
          m5Closes: extractClosedKlineCloses(k5m, now),
          h1Closes: extractClosedKlineCloses(k1h, now),
          h4Closes: extractClosedKlineCloses(k4h, now),
          d1Closes: extractClosedKlineCloses(k1d, now),
        });

        const price = Number(tickerJson.lastPrice);
        let bestBid = price;
        let bestAsk = price;
        let orderbookImbalance = 0;
        let orderbookSource: 'EXCHANGE_DEPTH' | 'UNAVAILABLE' = 'UNAVAILABLE';
        let orderbookBids: OrderbookLevel[] = [];
        let orderbookAsks: OrderbookLevel[] = [];

        if (depthJson && depthJson.bids.length > 0 && depthJson.asks.length > 0) {
          orderbookSource = 'EXCHANGE_DEPTH';
          bestBid = Number(depthJson.bids[0][0]);
          bestAsk = Number(depthJson.asks[0][0]);
          orderbookBids = buildTopDepthLevels(depthJson.bids, 5);
          orderbookAsks = buildTopDepthLevels(depthJson.asks, 5);
          const bidVol = depthJson.bids.reduce((s, b) => s + Number(b[1]), 0);
          const askVol = depthJson.asks.reduce((s, a) => s + Number(a[1]), 0);
          const total = bidVol + askVol;
          orderbookImbalance = total > 0 ? Number(((bidVol - askVol) / total).toFixed(4)) : 0;
        }

        const markPrice = premJson?.markPrice ? Number(premJson.markPrice) : null;
        const indexPrice = premJson?.indexPrice ? Number(premJson.indexPrice) : null;
        const lastFundingRate = premJson?.lastFundingRate ? Number(premJson.lastFundingRate) : null;
        const nextFundingTime = premJson?.nextFundingTime ? Number(premJson.nextFundingTime) : null;
        const openInterestBtc = oiJson?.openInterest ? Number(oiJson.openInterest) : null;
        const openInterestUsd =
          openInterestBtc !== null && price > 0 ? Number((openInterestBtc * price).toFixed(0)) : null;

        const futuresMetrics: FuturesMarketMetrics = {
          markPrice,
          indexPrice,
          lastFundingRate,
          nextFundingTime,
          openInterestBtc,
          openInterestUsd,
        };

        const wsUp = meta.wsConn && meta.wsConn.readyState === WebSocket.OPEN;
        const source: MarketFeedSource = wsUp
          ? 'binance_futures_ws_live'
          : 'binance_futures_rest_live';
        const health = this.buildHealth('BINANCE_FUTURES', source, now, sanitized.candles.length, orderbookSource);

        return {
          venue: 'BINANCE_FUTURES',
          source,
          metadata: this.buildMetadata('BINANCE_FUTURES', source, now, orderbookSource, sanitized.candles.length, health.status),
          health,
          candles: sanitized.candles,
          price,
          change24hPct: Number(tickerJson.priceChangePercent),
          high24h: Number(tickerJson.highPrice),
          low24h: Number(tickerJson.lowPrice),
          volume24hUsd: Number(tickerJson.quoteVolume),
          bestBid,
          bestAsk,
          orderbookImbalance,
          orderbookSource,
          orderbookBids,
          orderbookAsks,
          aggTradeCvdDelta: this.getAggTradeDelta('BINANCE_FUTURES'),
          fundingRate: lastFundingRate,
          futuresMetrics,
          htfContext,
          updatedAt: now,
        };
      } catch (err) {
        meta.lastError = err instanceof Error ? err.message : 'Futures REST fetch failed';
      }
    }
    return null;
  }

  private async fetchCoinbaseSpotFallback(): Promise<MarketSnapshot | null> {
    try {
      const [candlesJson, tickerJson, statsJson] = await Promise.all([
        this.fetchJsonWithTimeout<Array<[number, number, number, number, number, number]>>(
          'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900',
          'BINANCE_SPOT',
        ),
        this.fetchJsonWithTimeout<{ price: string; bid: string; ask: string; volume: string }>(
          'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
          'BINANCE_SPOT',
        ),
        this.fetchJsonWithTimeout<{ open: string; high: string; low: string; volume: string }>(
          'https://api.exchange.coinbase.com/products/BTC-USD/stats',
          'BINANCE_SPOT',
        ),
      ]);

      const raw = candlesJson
        .slice(0, 120)
        .reverse()
        .map((c) => ({
          time: Number(c[0]) * 1000,
          low: Number(c[1]),
          high: Number(c[2]),
          open: Number(c[3]),
          close: Number(c[4]),
          volume: Number(c[5]),
          isClosed: true,
        }));
      const sanitized = sanitizeCandles(raw);
      if (sanitized.candles.length === 0) return null;
      const price = Number(tickerJson.price);
      const open24 = Number(statsJson.open || sanitized.candles[0].open);
      const change24hPct = open24 > 0 ? Number((((price - open24) / open24) * 100).toFixed(2)) : 0;
      const now = Date.now();

      const health = this.buildHealth('BINANCE_SPOT', 'coinbase_live', now, sanitized.candles.length, 'UNAVAILABLE');
      return {
        venue: 'BINANCE_SPOT',
        source: 'coinbase_live',
        metadata: this.buildMetadata('BINANCE_SPOT', 'coinbase_live', now, 'UNAVAILABLE', sanitized.candles.length, health.status),
        health,
        candles: sanitized.candles,
        price,
        change24hPct,
        high24h: Number(statsJson.high || price),
        low24h: Number(statsJson.low || price),
        volume24hUsd: Number(statsJson.volume || 0) * price,
        bestBid: Number(tickerJson.bid || price),
        bestAsk: Number(tickerJson.ask || price),
        orderbookImbalance: 0,
        orderbookSource: 'UNAVAILABLE',
        orderbookBids: tickerJson.bid ? [{ price: Number(tickerJson.bid), qty: 0.5, total: 0.5 }] : [],
        orderbookAsks: tickerJson.ask ? [{ price: Number(tickerJson.ask), qty: 0.5, total: 0.5 }] : [],
        aggTradeCvdDelta: null,
        fundingRate: null, // Coinbase Spot does not carry perpetual funding
        updatedAt: now,
      };
    } catch {
      return null;
    }
  }

  public startWebSocket(venue: MarketVenue): void {
    if (this.stopped) return;
    const meta = this.healthMeta[venue];
    if (
      meta.wsConn &&
      (meta.wsConn.readyState === WebSocket.OPEN || meta.wsConn.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const hosts = venue === 'BINANCE_FUTURES' ? FUTURES_WS_HOSTS : SPOT_WS_HOSTS;
    const streamUrl = hosts[meta.wsHostIdx % hosts.length];

    try {
      const ws = new WebSocket(streamUrl);
      meta.wsConn = ws;

      ws.addEventListener('open', () => {
        meta.lastError = null;
        const snap = this.states[venue];
        if (snap) {
          snap.source =
            venue === 'BINANCE_FUTURES' ? 'binance_futures_ws_live' : 'binance_spot_ws_live';
        }
        // Backfill missing candles after reconnect if gap could exist
        if (meta.reconnectCount > 0) {
          void this.refreshRestSnapshot(venue);
        }
      });

      ws.addEventListener('message', (event) => {
        const snap = this.states[venue];
        if (!snap) return;
        try {
          const msg = JSON.parse(String(event.data)) as {
            stream?: string;
            data?: Record<string, unknown>;
          };
          if (!msg.stream || !msg.data) return;
          const wsSource: MarketFeedSource =
            venue === 'BINANCE_FUTURES' ? 'binance_futures_ws_live' : 'binance_spot_ws_live';

          meta.sequenceNumber += 1;

          if (msg.stream.includes('@aggTrade')) {
            const d = msg.data as { p?: string; q?: string; T?: number; E?: number; m?: boolean };
            const tradePrice = Number(d.p ?? 0);
            const tradeQty = Number(d.q ?? 0);
            const tradeTime = Number(d.T ?? d.E ?? Date.now());
            if (tradePrice > 0 && tradeQty > 0) {
              // Binance aggTrade `m === true` => buyer is market maker (aggressive SELL)
              const sign = d.m ? -1 : 1;
              const signedUsdM = (sign * tradePrice * tradeQty) / 1_000_000;
              snap.aggTradeCvdDelta = this.recordAggTrade(venue, tradeTime, signedUsdM);
              meta.exchangeTimestamp = tradeTime;
            }
          } else if (msg.stream.includes('@ticker')) {
            const d = msg.data as Record<string, string | number | undefined>;
            const nextPrice = d.c ? Number(d.c) : snap.price;
            if (!Number.isFinite(nextPrice) || nextPrice <= 0) return;

            snap.price = nextPrice;
            if (d.P && Number.isFinite(Number(d.P))) snap.change24hPct = Number(d.P);
            if (d.h && Number.isFinite(Number(d.h))) snap.high24h = Number(d.h);
            if (d.l && Number.isFinite(Number(d.l))) snap.low24h = Number(d.l);
            if (d.q && Number.isFinite(Number(d.q))) snap.volume24hUsd = Number(d.q);
            if (d.b && Number.isFinite(Number(d.b))) snap.bestBid = Number(d.b);
            if (d.a && Number.isFinite(Number(d.a))) snap.bestAsk = Number(d.a);
            if (d.E && Number.isFinite(Number(d.E))) meta.exchangeTimestamp = Number(d.E);
            snap.source = wsSource;
            snap.updatedAt = Date.now();

            const last = snap.candles[snap.candles.length - 1];
            if (last) {
              last.close = snap.price;
              if (snap.price > last.high) last.high = snap.price;
              if (snap.price < last.low) last.low = snap.price;
            }
            this.emit(venue, false);
          } else if (msg.stream.includes('@kline_15m')) {
            const k = (msg.data as { k?: Record<string, string | number | boolean>; E?: number }).k;
            if (!k) return;
            const candle: Candle = {
              time: Number(k.t),
              open: Number(k.o),
              high: Number(k.h),
              low: Number(k.l),
              close: Number(k.c),
              volume: Number(k.v),
              isClosed: Boolean(k.x),
            };
            if (!Number.isFinite(candle.close) || candle.close <= 0) return;
            if ((msg.data as { E?: number }).E) {
              meta.exchangeTimestamp = Number((msg.data as { E?: number }).E);
            }

            const last = snap.candles[snap.candles.length - 1];
            if (last && last.time === candle.time) {
              snap.candles[snap.candles.length - 1] = candle;
            } else if (!last || candle.time > last.time) {
              if (last && candle.time - last.time > 15 * 60 * 1000 * 1.6) {
                meta.candleGapsDetected++;
                void this.refreshRestSnapshot(venue);
              }
              snap.candles = [...snap.candles.slice(-199), candle];
            }
            snap.price = candle.close;
            snap.source = wsSource;
            snap.updatedAt = Date.now();
            this.emit(venue, false);
          } else if (msg.stream.includes('@depth20')) {
            const d = msg.data as {
              bids?: Array<[string, string]>;
              asks?: Array<[string, string]>;
              b?: Array<[string, string]>;
              a?: Array<[string, string]>;
              E?: number;
            };
            const bidsRaw = d.bids ?? d.b;
            const asksRaw = d.asks ?? d.a;
            if (bidsRaw && asksRaw && bidsRaw.length > 0 && asksRaw.length > 0) {
              snap.bestBid = Number(bidsRaw[0][0]);
              snap.bestAsk = Number(asksRaw[0][0]);
              snap.orderbookBids = buildTopDepthLevels(bidsRaw, 5);
              snap.orderbookAsks = buildTopDepthLevels(asksRaw, 5);
              snap.orderbookSource = 'EXCHANGE_DEPTH';
              const bidVol = bidsRaw.reduce((s, b) => s + Number(b[1]), 0);
              const askVol = asksRaw.reduce((s, a) => s + Number(a[1]), 0);
              const total = bidVol + askVol;
              if (total > 0) {
                snap.orderbookImbalance = Number(((bidVol - askVol) / total).toFixed(4));
              }
              if (d.E) meta.exchangeTimestamp = Number(d.E);
              snap.updatedAt = Date.now();
              this.emit(venue, false);
            }
          } else if (msg.stream.includes('@markPrice') && venue === 'BINANCE_FUTURES') {
            const d = msg.data as { p?: string; i?: string; r?: string; T?: number; E?: number };
            if (!snap.futuresMetrics) {
              snap.futuresMetrics = {
                markPrice: null,
                indexPrice: null,
                lastFundingRate: null,
                nextFundingTime: null,
                openInterestBtc: null,
                openInterestUsd: null,
              };
            }
            if (d.p) snap.futuresMetrics.markPrice = Number(d.p);
            if (d.i) snap.futuresMetrics.indexPrice = Number(d.i);
            if (d.r) {
              const rate = Number(d.r);
              snap.futuresMetrics.lastFundingRate = rate;
              snap.fundingRate = rate;
            }
            if (d.T) snap.futuresMetrics.nextFundingTime = Number(d.T);
            if (d.E) meta.exchangeTimestamp = Number(d.E);
            snap.updatedAt = Date.now();
            this.emit(venue, false);
          }
        } catch {
          // Ignore malformed frame
        }
      });

      ws.addEventListener('close', () => {
        meta.wsConn = null;
        if (this.stopped) return;
        meta.wsHostIdx = (meta.wsHostIdx + 1) % hosts.length;
        meta.reconnectCount++;
        const backoffMs = Math.min(30000, 2500 * Math.pow(1.4, Math.min(meta.reconnectCount, 5)));
        if (!meta.reconnectTimer) {
          meta.reconnectTimer = setTimeout(() => {
            meta.reconnectTimer = null;
            this.startWebSocket(venue);
          }, backoffMs);
        }
      });

      ws.addEventListener('error', () => {
        meta.lastError = `${venue} WebSocket error`;
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    } catch (err) {
      meta.lastError = err instanceof Error ? err.message : 'WS connect failure';
    }
  }

  public stop(): void {
    this.stopped = true;
    for (const venue of ['BINANCE_SPOT', 'BINANCE_FUTURES'] as const) {
      const meta = this.healthMeta[venue];
      if (meta.reconnectTimer) {
        clearTimeout(meta.reconnectTimer);
        meta.reconnectTimer = null;
      }
      if (meta.wsConn) {
        try {
          meta.wsConn.close();
        } catch {
          // ignore
        }
        meta.wsConn = null;
      }
    }
    this.onTickCallbacks.clear();
  }
}
