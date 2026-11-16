import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

export interface RawKline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

export interface HtfContext {
  h1Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h4Bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  h1Rsi: number;
  h1Ema50: number;
}

interface LiveMarketState {
  source: MarketFeedSource;
  candles: RawKline[];
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24hUsd: number;
  bestBid: number;
  bestAsk: number;
  orderbookImbalance: number;
  orderbookBids: OrderbookLevel[];
  orderbookAsks: OrderbookLevel[];
  fundingRate: number;
  htfContext?: HtfContext;
  updatedAt: number;
}

function calcEma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return Number((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
}

function computeHtfContext(h1Closes: number[], h4Closes: number[]): HtfContext {
  const lastH1 = h1Closes[h1Closes.length - 1] ?? 0;
  const h1Ema21 = calcEma(h1Closes, 21);
  const h1Ema50 = calcEma(h1Closes, 50);
  const h1Rsi = calcRsi(h1Closes, 14);

  let h1Bias: HtfContext['h1Bias'] = 'NEUTRAL';
  if (lastH1 > h1Ema21 && h1Ema21 > h1Ema50 && h1Rsi >= 48) h1Bias = 'LONG';
  else if (lastH1 < h1Ema21 && h1Ema21 < h1Ema50 && h1Rsi <= 52) h1Bias = 'SHORT';

  const lastH4 = h4Closes[h4Closes.length - 1] ?? 0;
  const h4Ema12 = calcEma(h4Closes, 12);
  const h4Ema26 = calcEma(h4Closes, 26);

  let h4Bias: HtfContext['h4Bias'] = 'NEUTRAL';
  if (lastH4 > h4Ema12 && h4Ema12 > h4Ema26) h4Bias = 'LONG';
  else if (lastH4 < h4Ema12 && h4Ema12 < h4Ema26) h4Bias = 'SHORT';

  return {
    h1Bias,
    h4Bias,
    h1Rsi,
    h1Ema50: Number(h1Ema50.toFixed(2)),
  };
}

function buildTopDepthLevels(raw: Array<[string, string]>, limit = 5): OrderbookLevel[] {
  let running = 0;
  return raw.slice(0, limit).map(([pStr, qStr]) => {
    const price = Number(pStr);
    const qty = Number(qStr);
    running += qty;
    return {
      price,
      qty: Number(qty.toFixed(4)),
      total: Number(running.toFixed(4)),
    };
  });
}

const BINANCE_REST_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

const BINANCE_WS_HOSTS = [
  'wss://data-stream.binance.vision/stream?streams=btcusdt@ticker/btcusdt@kline_15m/btcusdt@depth20@1000ms',
  'wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/btcusdt@kline_15m/btcusdt@depth20@1000ms',
];

let liveState: LiveMarketState | null = null;
const sseClients = new Set<express.Response>();
let lastBroadcastAt = 0;
let wsConn: WebSocket | null = null;
let wsHostIndex = 0;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let restPollTimer: ReturnType<typeof setInterval> | null = null;
let inflightRestRefresh: Promise<LiveMarketState | null> | null = null;

function broadcastTick(force = false): void {
  if (!liveState || sseClients.size === 0) return;
  const now = Date.now();
  if (!force && now - lastBroadcastAt < 500) return;
  lastBroadcastAt = now;

  const payload = `data: ${JSON.stringify({
    source: liveState.source,
    price: liveState.price,
    change24hPct: liveState.change24hPct,
    high24h: liveState.high24h,
    low24h: liveState.low24h,
    volume24hUsd: liveState.volume24hUsd,
    bestBid: liveState.bestBid,
    bestAsk: liveState.bestAsk,
    orderbookImbalance: liveState.orderbookImbalance,
    orderbookBids: liveState.orderbookBids,
    orderbookAsks: liveState.orderbookAsks,
    fundingRate: liveState.fundingRate,
    htfContext: liveState.htfContext,
    updatedAt: liveState.updatedAt,
    latestCandle: liveState.candles[liveState.candles.length - 1] ?? null,
  })}\n\n`;

  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function fetchJsonWithTimeout<T>(url: string, ms = 3500): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFromBinanceRest(): Promise<LiveMarketState | null> {
  for (const host of BINANCE_REST_HOSTS) {
    try {
      const [klinesJson, h1Json, h4Json, tickerJson, depthJson, fundingJson] = await Promise.all([
        fetchJsonWithTimeout<Array<Array<string | number>>>(
          `${host}/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=200`,
        ),
        fetchJsonWithTimeout<Array<Array<string | number>>>(
          `${host}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=64`,
        ).catch(() => null),
        fetchJsonWithTimeout<Array<Array<string | number>>>(
          `${host}/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=48`,
        ).catch(() => null),
        fetchJsonWithTimeout<{
          lastPrice: string;
          priceChangePercent: string;
          highPrice: string;
          lowPrice: string;
          quoteVolume: string;
          bidPrice?: string;
          askPrice?: string;
        }>(`${host}/api/v3/ticker/24hr?symbol=BTCUSDT`),
        fetchJsonWithTimeout<{
          bids: Array<[string, string]>;
          asks: Array<[string, string]>;
        }>(`${host}/api/v3/depth?symbol=BTCUSDT&limit=20`).catch(() => null),
        fetchJsonWithTimeout<{ lastFundingRate?: string }>(
          'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT',
        ).catch(() => null),
      ]);

      const candles: RawKline[] = klinesJson.map((k) => ({
        time: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }));

      const h1Closes = h1Json ? h1Json.map((k) => Number(k[4])) : candles.filter((_, i) => i % 4 === 3).map((c) => c.close);
      const h4Closes = h4Json ? h4Json.map((k) => Number(k[4])) : h1Closes.filter((_, i) => i % 4 === 3);
      const htfContext = computeHtfContext(h1Closes, h4Closes);

      const price = Number(tickerJson.lastPrice);
      let bestBid = Number(tickerJson.bidPrice || price);
      let bestAsk = Number(tickerJson.askPrice || price);
      let orderbookImbalance = 0;
      let orderbookBids: OrderbookLevel[] = [];
      let orderbookAsks: OrderbookLevel[] = [];

      if (depthJson && depthJson.bids.length > 0 && depthJson.asks.length > 0) {
        bestBid = Number(depthJson.bids[0][0]);
        bestAsk = Number(depthJson.asks[0][0]);
        orderbookBids = buildTopDepthLevels(depthJson.bids, 5);
        orderbookAsks = buildTopDepthLevels(depthJson.asks, 5);
        const bidVol = depthJson.bids.reduce((s, b) => s + Number(b[1]), 0);
        const askVol = depthJson.asks.reduce((s, a) => s + Number(a[1]), 0);
        const total = bidVol + askVol;
        orderbookImbalance = total > 0 ? Number(((bidVol - askVol) / total).toFixed(4)) : 0;
      }

      const fundingRate = fundingJson?.lastFundingRate
        ? Number(fundingJson.lastFundingRate)
        : liveState?.fundingRate ?? 0.0001;

      return {
        source: wsConn && wsConn.readyState === WebSocket.OPEN ? 'binance_ws_live' : 'binance_rest_live',
        candles,
        price,
        change24hPct: Number(tickerJson.priceChangePercent),
        high24h: Number(tickerJson.highPrice),
        low24h: Number(tickerJson.lowPrice),
        volume24hUsd: Number(tickerJson.quoteVolume),
        bestBid,
        bestAsk,
        orderbookImbalance,
        orderbookBids,
        orderbookAsks,
        fundingRate,
        htfContext,
        updatedAt: Date.now(),
      };
    } catch {
      // Try next Binance mirror host
    }
  }
  return null;
}

async function fetchFromCoinbaseFallback(): Promise<LiveMarketState | null> {
  try {
    const [candlesJson, tickerJson, statsJson] = await Promise.all([
      fetchJsonWithTimeout<Array<[number, number, number, number, number, number]>>(
        'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900',
      ),
      fetchJsonWithTimeout<{ price: string; bid: string; ask: string; volume: string }>(
        'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
      ),
      fetchJsonWithTimeout<{ open: string; high: string; low: string; volume: string }>(
        'https://api.exchange.coinbase.com/products/BTC-USD/stats',
      ),
    ]);

    const sorted = candlesJson
      .slice(0, 120)
      .reverse()
      .map((c) => ({
        time: Number(c[0]) * 1000,
        low: Number(c[1]),
        high: Number(c[2]),
        open: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
      }));

    if (sorted.length === 0) return null;
    const price = Number(tickerJson.price);
    const open24 = Number(statsJson.open || sorted[0].open);
    const change24hPct = open24 > 0 ? Number((((price - open24) / open24) * 100).toFixed(2)) : 0;

    return {
      source: 'coinbase_live',
      candles: sorted,
      price,
      change24hPct,
      high24h: Number(statsJson.high || price),
      low24h: Number(statsJson.low || price),
      volume24hUsd: Number(statsJson.volume || 0) * price,
      bestBid: Number(tickerJson.bid || price),
      bestAsk: Number(tickerJson.ask || price),
      orderbookImbalance: 0,
      orderbookBids: tickerJson.bid ? [{ price: Number(tickerJson.bid), qty: 0.5, total: 0.5 }] : [],
      orderbookAsks: tickerJson.ask ? [{ price: Number(tickerJson.ask), qty: 0.5, total: 0.5 }] : [],
      fundingRate: 0.0001,
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

async function refreshRestSnapshot(): Promise<LiveMarketState | null> {
  if (inflightRestRefresh) return inflightRestRefresh;

  inflightRestRefresh = (async () => {
    const binance = await fetchFromBinanceRest();
    if (binance && binance.candles.length > 0) {
      // Preserve freshest WS tick price if WS is actively streaming
      if (liveState && wsConn && wsConn.readyState === WebSocket.OPEN) {
        liveState.fundingRate = binance.fundingRate;
        liveState.htfContext = binance.htfContext;
        if (liveState.candles.length === 0) {
          liveState.candles = binance.candles;
        }
      } else {
        liveState = binance;
        broadcastTick(true);
      }
      return liveState;
    }

    const coinbase = await fetchFromCoinbaseFallback();
    if (coinbase && coinbase.candles.length > 0) {
      liveState = coinbase;
      broadcastTick(true);
      return liveState;
    }

    return liveState;
  })().finally(() => {
    inflightRestRefresh = null;
  });

  return inflightRestRefresh;
}

function startBinanceWebSocket(): void {
  if (wsConn && (wsConn.readyState === WebSocket.OPEN || wsConn.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    const streamUrl = BINANCE_WS_HOSTS[wsHostIndex % BINANCE_WS_HOSTS.length];
    const ws = new WebSocket(streamUrl);
    wsConn = ws;

    ws.addEventListener('open', () => {
      if (liveState) {
        liveState.source = 'binance_ws_live';
      }
    });

    ws.addEventListener('message', (event) => {
      if (!liveState) return;
      try {
        const msg = JSON.parse(String(event.data)) as {
          stream?: string;
          data?: Record<string, unknown>;
        };
        if (!msg.stream || !msg.data) return;

        if (msg.stream.includes('@ticker')) {
          const d = msg.data as {
            c?: string;
            P?: string;
            h?: string;
            l?: string;
            q?: string;
            b?: string;
            a?: string;
          };
          if (d.c) liveState.price = Number(d.c);
          if (d.P) liveState.change24hPct = Number(d.P);
          if (d.h) liveState.high24h = Number(d.h);
          if (d.l) liveState.low24h = Number(d.l);
          if (d.q) liveState.volume24hUsd = Number(d.q);
          if (d.b) liveState.bestBid = Number(d.b);
          if (d.a) liveState.bestAsk = Number(d.a);
          liveState.source = 'binance_ws_live';
          liveState.updatedAt = Date.now();

          // Sync latest candle close/high/low with tick
          const last = liveState.candles[liveState.candles.length - 1];
          if (last) {
            last.close = liveState.price;
            if (liveState.price > last.high) last.high = liveState.price;
            if (liveState.price < last.low) last.low = liveState.price;
          }
          broadcastTick(false);
        } else if (msg.stream.includes('@kline_15m')) {
          const k = (msg.data as { k?: Record<string, string | number> }).k;
          if (!k) return;
          const candle: RawKline = {
            time: Number(k.t),
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
          };
          const last = liveState.candles[liveState.candles.length - 1];
          if (last && last.time === candle.time) {
            liveState.candles[liveState.candles.length - 1] = candle;
          } else if (!last || candle.time > last.time) {
            liveState.candles = [...liveState.candles.slice(-199), candle];
          }
          liveState.price = candle.close;
          liveState.source = 'binance_ws_live';
          liveState.updatedAt = Date.now();
          broadcastTick(false);
        } else if (msg.stream.includes('@depth20')) {
          const d = msg.data as {
            bids?: Array<[string, string]>;
            asks?: Array<[string, string]>;
          };
          if (d.bids && d.asks && d.bids.length > 0 && d.asks.length > 0) {
            liveState.bestBid = Number(d.bids[0][0]);
            liveState.bestAsk = Number(d.asks[0][0]);
            liveState.orderbookBids = buildTopDepthLevels(d.bids, 5);
            liveState.orderbookAsks = buildTopDepthLevels(d.asks, 5);
            const bidVol = d.bids.reduce((s, b) => s + Number(b[1]), 0);
            const askVol = d.asks.reduce((s, a) => s + Number(a[1]), 0);
            const total = bidVol + askVol;
            if (total > 0) {
              liveState.orderbookImbalance = Number(((bidVol - askVol) / total).toFixed(4));
            }
            broadcastTick(false);
          }
        }
      } catch {
        // Ignore malformed frame
      }
    });

    ws.addEventListener('close', () => {
      wsConn = null;
      wsHostIndex = (wsHostIndex + 1) % BINANCE_WS_HOSTS.length;
      if (!wsReconnectTimer) {
        wsReconnectTimer = setTimeout(() => {
          wsReconnectTimer = null;
          startBinanceWebSocket();
        }, 3000);
      }
    });

    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        // Ignore
      }
    });
  } catch {
    // REST polling fallback continues cleanly
  }
}

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      source: liveState?.source ?? 'quant_engine_sim',
      updatedAt: liveState?.updatedAt ?? Date.now(),
    });
  });

  app.get('/api/btc-market', async (_req, res) => {
    if (!liveState || Date.now() - liveState.updatedAt > 6000) {
      await Promise.race([
        refreshRestSnapshot().catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    }
    if (liveState && liveState.candles.length > 0) {
      res.json(liveState);
      return;
    }
    res.json({
      source: 'quant_engine_sim',
      candles: [],
    });
  });

  // Real-time Server-Sent Events stream for live BTC/USDT ticks
  app.get('/api/btc-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    broadcastTick(true);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Bind port immediately so startup/health probes pass without waiting on external market APIs
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AegisBTC Quant server listening on http://0.0.0.0:${PORT}`);

    void refreshRestSnapshot().finally(() => {
      startBinanceWebSocket();
    });

    // Keep REST funding & fallback refreshed periodically
    restPollTimer = setInterval(async () => {
      const wsHealthy = wsConn && wsConn.readyState === WebSocket.OPEN;
      if (!wsHealthy) {
        await refreshRestSnapshot();
      } else {
        try {
          const f = await fetchJsonWithTimeout<{ lastFundingRate?: string }>(
            'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT',
            2500,
          );
          if (liveState && f.lastFundingRate) {
            liveState.fundingRate = Number(f.lastFundingRate);
          }
        } catch {
          // Ignore optional funding poll failure
        }
      }
    }, 4000);
    void restPollTimer;
  });
}

startServer();
