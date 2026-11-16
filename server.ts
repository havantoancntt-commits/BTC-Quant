import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STRATEGY_CONFIG } from './src/engine/multiAgentEngine';
import type {
  ClosedTrade,
  ExecutionMode,
  HealthDependencyEntry,
  MarketVenue,
  Position,
  RiskAccountState,
  RiskEventRecord,
  StrategyConfig,
  TimeframeKey,
} from './src/engine/types';
import {
  ExchangeExecutionService,
  getExchangeCredentialsStatus,
} from './src/server/exchangeExecutor';
import { generateGeminiQuantAdvisory } from './src/server/geminiAdvisor';
import { MarketDataHub } from './src/server/marketDataService';
import { QuantRepository } from './src/server/repository';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const VALID_VENUES = new Set<MarketVenue>(['BINANCE_SPOT', 'BINANCE_FUTURES']);
const VALID_MODES = new Set<ExecutionMode>(['SIMULATION', 'PAPER', 'TESTNET', 'LIVE']);
const VALID_INTERVALS = new Set<TimeframeKey>(['5m', '15m', '1h', '4h', '1d']);

function createRateLimiter(maxRequests: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${req.ip || 'local'}:${req.path}`;
    const now = Date.now();
    const bucket = hits.get(key);
    if (!bucket || now > bucket.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count++;
    if (bucket.count > maxRequests) {
      res.status(429).json({
        ok: false,
        error: 'Quá nhiều yêu cầu trong thời gian ngắn (Rate limit). Vui lòng thử lại sau.',
      });
      return;
    }
    next();
  };
}

function sanitizeConfigInput(raw: unknown, base: StrategyConfig): StrategyConfig {
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<StrategyConfig>;
  const clamp = (val: unknown, min: number, max: number, fallback: number) => {
    const n = Number(val);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };

  return {
    initialCapital: clamp(r.initialCapital, 1000, 10000000, base.initialCapital),
    sizingMethod:
      r.sizingMethod === 'HALF_KELLY' || r.sizingMethod === 'FIXED_FRACTIONAL'
        ? r.sizingMethod
        : base.sizingMethod,
    riskPerTradePct: clamp(r.riskPerTradePct, 0.25, 3.0, base.riskPerTradePct),
    maxLeverage: clamp(r.maxLeverage, 1, 5, base.maxLeverage),
    maxDailyLossPct: clamp(r.maxDailyLossPct, 0.5, 15, base.maxDailyLossPct),
    maxWeeklyLossPct: clamp(r.maxWeeklyLossPct, 1, 30, base.maxWeeklyLossPct),
    maxDrawdownPct: clamp(r.maxDrawdownPct, 2, 40, base.maxDrawdownPct),
    maxConsecutiveLosses: Math.round(
      clamp(r.maxConsecutiveLosses, 1, 10, base.maxConsecutiveLosses),
    ),
    cooldownMinutesAfterLoss: Math.round(
      clamp(r.cooldownMinutesAfterLoss, 1, 240, base.cooldownMinutesAfterLoss),
    ),
    maxSpreadBps: clamp(r.maxSpreadBps, 2, 100, base.maxSpreadBps),
    minConsensusScore: Math.round(clamp(r.minConsensusScore, 50, 95, base.minConsensusScore)),
    minRewardRisk: clamp(r.minRewardRisk, 1.2, 5.0, base.minRewardRisk),
    autoExecute: typeof r.autoExecute === 'boolean' ? r.autoExecute : base.autoExecute,
    useBreakEvenAfterTp1:
      typeof r.useBreakEvenAfterTp1 === 'boolean'
        ? r.useBreakEvenAfterTp1
        : base.useBreakEvenAfterTp1,
    vetoChoppyMarket:
      typeof r.vetoChoppyMarket === 'boolean' ? r.vetoChoppyMarket : base.vetoChoppyMarket,
    requireClosedCandle:
      typeof r.requireClosedCandle === 'boolean'
        ? r.requireClosedCandle
        : base.requireClosedCandle,
    marketVenue:
      r.marketVenue && VALID_VENUES.has(r.marketVenue) ? r.marketVenue : base.marketVenue,
    executionMode:
      r.executionMode && VALID_MODES.has(r.executionMode) ? r.executionMode : base.executionMode,
    agentWeights: {
      macro_scout: clamp(r.agentWeights?.macro_scout, 0.05, 0.8, base.agentWeights.macro_scout),
      quant_analyst: clamp(
        r.agentWeights?.quant_analyst,
        0.05,
        0.8,
        base.agentWeights.quant_analyst,
      ),
      orderflow_radar: clamp(
        r.agentWeights?.orderflow_radar,
        0.05,
        0.8,
        base.agentWeights.orderflow_radar,
      ),
    },
  };
}

export function createQuantServerApp(options?: { dbPath?: string; startMarketFeeds?: boolean }) {
  const feedsEnabled = options?.startMarketFeeds !== false;
  const app = express();
  const repo = new QuantRepository(options?.dbPath);
  const marketHub = new MarketDataHub();
  const executor = new ExchangeExecutionService(repo);
  const savedConfig = repo.getConfig();
  marketHub.setVenue(savedConfig.marketVenue);

  app.use(express.json({ limit: '512kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const postLimiter = createRateLimiter(30, 60_000);
  const aiLimiter = createRateLimiter(12, 60_000);

  // Health & Readiness Endpoint with Real Dependency Checks
  app.get('/api/health', (req, res) => {
    const activeVenue = marketHub.getVenue();
    const snap = marketHub.getSnapshot(activeVenue);
    const venueHealth = snap?.health ?? marketHub.getAllHealth()[activeVenue];
    const dbOk = repo.ping();
    const acc = repo.getAccountState();
    const reconcile = executor.getPaperReconciliation();

    const dependencies: Record<string, HealthDependencyEntry> = {
      apiServer: { status: 'HEALTHY', detail: 'Express API đang phản hồi' },
      database: dbOk
        ? { status: 'HEALTHY', detail: 'SQLite WAL sẵn sàng' }
        : { status: 'DOWN', detail: 'Lỗi kết nối SQLite' },
      marketDataRest: !feedsEnabled
        ? { status: 'STANDBY', detail: 'Tắt feed nền (Chế độ kiểm thử)' }
        : snap && snap.candles.length >= 30
          ? { status: 'HEALTHY', detail: `${snap.candles.length} nến · Nguồn ${snap.source}` }
          : { status: 'DEGRADED', detail: 'Đang đồng bộ nến REST từ sàn' },
      marketDataWs: !feedsEnabled
        ? { status: 'STANDBY', detail: 'Tắt WS nền (Chế độ kiểm thử)' }
        : venueHealth.wsConnected
          ? { status: 'HEALTHY', detail: `WS Open · Seq #${venueHealth.sequenceNumber}` }
          : { status: 'DEGRADED', detail: `WS chưa mở (Reconnects: ${venueHealth.reconnectCount})` },
      orderbookFeed: !feedsEnabled
        ? { status: 'STANDBY', detail: 'Orderbook standby' }
        : snap?.orderbookSource === 'EXCHANGE_DEPTH'
          ? { status: 'HEALTHY', detail: `Top-20 Depth sẵn sàng (${snap.orderbookImbalance})` }
          : { status: 'DEGRADED', detail: 'Chưa nhận được sổ lệnh Depth20' },
      fundingFeed:
        activeVenue === 'BINANCE_SPOT'
          ? { status: 'STANDBY', detail: 'Spot 1x không dùng Funding' }
          : snap?.fundingRate !== null && snap?.fundingRate !== undefined
            ? { status: 'HEALTHY', detail: `Funding ${(snap.fundingRate * 100).toFixed(4)}%` }
            : { status: feedsEnabled ? 'DEGRADED' : 'STANDBY', detail: 'Chờ dữ liệu MarkPrice/Funding' },
      agentEngine: { status: 'HEALTHY', detail: 'Hội đồng 6 Agent & Phản biện sẵn sàng' },
      riskEngine: acc.emergencyStopActive
        ? { status: 'DEGRADED', detail: 'Kill Switch đang khóa mở lệnh mới' }
        : { status: 'HEALTHY', detail: 'Khiên VETO & Circuit Breakers đang hoạt động' },
      paperTradingEngine: reconcile.consistent
        ? { status: 'HEALTHY', detail: `Sổ cái cân bằng ($${reconcile.equityUsd.toLocaleString('en-US')})` }
        : { status: 'DEGRADED', detail: `Chênh lệch đối soát $${reconcile.discrepancyUsd.toFixed(2)}` },
      executionEngine: { status: 'HEALTHY', detail: 'Adapter Simulation / Paper / Testnet / Locked Live sẵn sàng' },
    };

    const feedReady = !feedsEnabled || (venueHealth.status === 'HEALTHY' && (snap?.candles.length ?? 0) >= 30);
    const overallOk = dbOk && feedReady;
    const overallStatus = !dbOk ? 'DOWN' : overallOk ? 'HEALTHY' : 'DEGRADED';

    const statusCode = !dbOk || (req.query.strict === '1' && !overallOk) ? 503 : 200;

    res.status(statusCode).json({
      ok: overallOk,
      status: overallStatus,
      venue: activeVenue,
      source: snap?.source ?? 'quant_engine_sim',
      health: venueHealth,
      allVenues: marketHub.getAllHealth(),
      dependencies,
      credentials: getExchangeCredentialsStatus(),
      updatedAt: snap?.updatedAt ?? Date.now(),
    });
  });

  // Live Spot or Futures Market Snapshot
  app.get('/api/btc-market', async (req, res) => {
    const requestedVenue = String(req.query.venue || marketHub.getVenue()) as MarketVenue;
    const venue: MarketVenue = VALID_VENUES.has(requestedVenue)
      ? requestedVenue
      : marketHub.getVenue();

    if (venue !== marketHub.getVenue()) {
      marketHub.setVenue(venue);
      if (feedsEnabled) marketHub.startWebSocket(venue);
    }

    const current = marketHub.getSnapshot(venue);
    if (feedsEnabled && (!current || Date.now() - current.updatedAt > 6000)) {
      await Promise.race([
        marketHub.refreshRestSnapshot(venue).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    }

    const snap = marketHub.getSnapshot(venue);
    if (snap && snap.candles.length > 0) {
      executor.matchOpenPaperOrders(snap.price);
      res.json(snap);
      return;
    }

    const emptyHealth = marketHub.getAllHealth()[venue];
    res.json({
      venue,
      source: 'quant_engine_sim',
      metadata: {
        symbol: 'BTCUSDT',
        market_type: venue === 'BINANCE_FUTURES' ? 'FUTURES' : 'SPOT',
        timeframe: '15m',
        exchange_timestamp: Date.now(),
        received_timestamp: Date.now(),
        sequence_number: emptyHealth.sequenceNumber,
        data_status: 'UNAVAILABLE',
        quality_flags: ['NO_MARKET_FEED'],
      },
      health: emptyHealth,
      orderbookSource: 'UNAVAILABLE',
      aggTradeCvdDelta: null,
      candles: [],
      updatedAt: Date.now(),
    });
  });

  // Real Historical BTC Klines Loader for Mode B Historical Backtest
  app.get('/api/historical-klines', async (req, res) => {
    const reqVenue = String(req.query.venue || 'BINANCE_SPOT') as MarketVenue;
    const venue: MarketVenue = VALID_VENUES.has(reqVenue) ? reqVenue : 'BINANCE_SPOT';
    const reqInterval = String(req.query.interval || '15m') as TimeframeKey;
    const interval: TimeframeKey = VALID_INTERVALS.has(reqInterval) ? reqInterval : '15m';
    const limit = Math.max(100, Math.min(1000, Number(req.query.limit) || 1000));

    try {
      const data = await marketHub.fetchHistoricalKlines({ venue, interval, limit });
      repo.log(
        'INFO',
        'BACKTEST_DATA',
        `Fetched ${data.candles.length} historical ${interval} candles from ${venue}`,
      );
      res.json({ ok: true, venue, interval, ...data });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to load historical BTC klines',
      });
    }
  });

  // Real-time Server-Sent Events Stream (with max client limit)
  const MAX_SSE_CLIENTS = 50;
  const sseClients = new Set<express.Response>();
  let lastBroadcastAt = 0;

  const pushSseSnapshot = (snap: ReturnType<MarketDataHub['getSnapshot']>, force = false) => {
    if (!snap || sseClients.size === 0) return;
    const now = Date.now();
    if (!force && now - lastBroadcastAt < 450) return;
    lastBroadcastAt = now;

    const payload = `data: ${JSON.stringify({
      venue: snap.venue,
      source: snap.source,
      metadata: snap.metadata,
      health: snap.health,
      price: snap.price,
      change24hPct: snap.change24hPct,
      high24h: snap.high24h,
      low24h: snap.low24h,
      volume24hUsd: snap.volume24hUsd,
      bestBid: snap.bestBid,
      bestAsk: snap.bestAsk,
      orderbookImbalance: snap.orderbookImbalance,
      orderbookSource: snap.orderbookSource ?? 'UNAVAILABLE',
      orderbookBids: snap.orderbookBids,
      orderbookAsks: snap.orderbookAsks,
      aggTradeCvdDelta: snap.aggTradeCvdDelta ?? null,
      fundingRate: snap.fundingRate,
      futuresMetrics: snap.futuresMetrics,
      htfContext: snap.htfContext,
      updatedAt: snap.updatedAt,
      latestCandle: snap.candles[snap.candles.length - 1] ?? null,
    })}\n\n`;

    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  marketHub.subscribe((snap, force) => {
    if (snap.price > 0) {
      executor.matchOpenPaperOrders(snap.price);
    }
    pushSseSnapshot(snap, force);
  });

  app.get('/api/btc-stream', (req, res) => {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      res.status(503).json({ ok: false, error: 'Quá giới hạn kết nối SSE đồng thời.' });
      return;
    }

    const reqVenue = String(req.query.venue || marketHub.getVenue()) as MarketVenue;
    if (VALID_VENUES.has(reqVenue) && reqVenue !== marketHub.getVenue()) {
      marketHub.setVenue(reqVenue);
      if (feedsEnabled) {
        marketHub.startWebSocket(reqVenue);
        void marketHub.refreshRestSnapshot(reqVenue);
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    const snap = marketHub.getSnapshot(marketHub.getVenue());
    if (snap) pushSseSnapshot(snap, true);

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

  // Persisted State & Audit Endpoints
  app.get('/api/state', (_req, res) => {
    res.json({
      ok: true,
      ...repo.getFullSnapshot(),
      reconciliation: executor.getPaperReconciliation(),
      credentials: getExchangeCredentialsStatus(),
      systemLogs: repo.getSystemLogs(40),
    });
  });

  app.put('/api/config', postLimiter, (req, res) => {
    const current = repo.getConfig();
    const sanitized = sanitizeConfigInput(req.body, current);
    repo.saveConfig(sanitized);
    if (sanitized.marketVenue !== marketHub.getVenue()) {
      marketHub.setVenue(sanitized.marketVenue);
      if (feedsEnabled) {
        marketHub.startWebSocket(sanitized.marketVenue);
        void marketHub.refreshRestSnapshot(sanitized.marketVenue);
      }
    }
    repo.log(
      'INFO',
      'CONFIG',
      `Updated strategy config (venue=${sanitized.marketVenue}, mode=${sanitized.executionMode}, sizing=${sanitized.sizingMethod} ${sanitized.riskPerTradePct}%)`,
    );
    res.json({ ok: true, config: sanitized });
  });

  app.post('/api/state/sync', postLimiter, (req, res) => {
    const body = req.body as {
      accountState?: RiskAccountState;
      activePosition?: Position | null;
      newTrade?: ClosedTrade | null;
      riskEvent?: RiskEventRecord | null;
    };
    if (!body || typeof body !== 'object') {
      res.status(400).json({ ok: false, error: 'Payload đồng bộ không hợp lệ.' });
      return;
    }
    if (body.accountState && Number.isFinite(body.accountState.equity)) {
      repo.saveAccountState(body.accountState);
    }
    if (body.activePosition !== undefined) {
      repo.saveActivePosition(body.activePosition);
    }
    if (body.newTrade && body.newTrade.id) {
      repo.upsertTrade(body.newTrade);
    }
    if (body.riskEvent && body.riskEvent.id) {
      repo.addRiskEvent(body.riskEvent);
    }
    res.json({ ok: true });
  });

  app.post('/api/risk/emergency-stop', postLimiter, (req, res) => {
    const active = Boolean((req.body as { active?: boolean })?.active ?? true);
    const acc = repo.getAccountState();
    const nextAcc: RiskAccountState = {
      ...acc,
      emergencyStopActive: active,
    };
    repo.saveAccountState(nextAcc);
    repo.addRiskEvent({
      id: `EV-KILL-${Date.now()}`,
      eventType: 'EMERGENCY_STOP',
      message: active
        ? 'KÍCH HOẠT KILL SWITCH: Khóa toàn bộ lệnh mở mới (Auto & Manual).'
        : 'ĐÃ GỠ KILL SWITCH: Cho phép hệ thống đánh giá lại điều kiện vào lệnh.',
      createdAt: Date.now(),
    });
    repo.log('SECURITY', 'KILL_SWITCH', `Emergency stop set to ${active}`);
    res.json({ ok: true, accountState: nextAcc });
  });

  app.post('/api/risk/reset', postLimiter, (req, res) => {
    const initialCapital = Number((req.body as { initialCapital?: number })?.initialCapital);
    const snapshot = repo.resetSession(
      Number.isFinite(initialCapital) && initialCapital >= 1000 ? initialCapital : undefined,
    );
    res.json({ ok: true, ...snapshot });
  });

  // Staged Order Execution Adapter (Simulation / Paper / Testnet / Locked Live)
  app.post('/api/execution/order', postLimiter, async (req, res) => {
    const body = req.body as {
      clientOrderId?: string;
      mode?: ExecutionMode;
      venue?: MarketVenue;
      side?: 'BUY' | 'SELL';
      positionSide?: 'LONG' | 'SHORT';
      orderType?: 'MARKET' | 'LIMIT';
      qtyBtc?: number;
      referencePrice?: number;
      limitPrice?: number;
      expiresInMs?: number;
      confirmLiveOverride?: boolean;
    };

    if (
      !body ||
      typeof body.clientOrderId !== 'string' ||
      body.clientOrderId.length < 4 ||
      (body.side !== 'BUY' && body.side !== 'SELL') ||
      (body.positionSide !== 'LONG' && body.positionSide !== 'SHORT') ||
      !Number.isFinite(Number(body.qtyBtc)) ||
      Number(body.qtyBtc) <= 0 ||
      !Number.isFinite(Number(body.referencePrice)) ||
      Number(body.referencePrice) <= 0
    ) {
      res.status(400).json({ ok: false, error: 'Tham số đặt lệnh không hợp lệ.' });
      return;
    }

    const cfg = repo.getConfig();
    const mode: ExecutionMode = body.mode && VALID_MODES.has(body.mode) ? body.mode : cfg.executionMode;
    const venue: MarketVenue =
      body.venue && VALID_VENUES.has(body.venue) ? body.venue : cfg.marketVenue;

    const record = await executor.executeOrder({
      clientOrderId: body.clientOrderId,
      mode,
      venue,
      side: body.side,
      positionSide: body.positionSide,
      orderType: body.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
      qtyBtc: Number(body.qtyBtc),
      referencePrice: Number(body.referencePrice),
      limitPrice:
        body.limitPrice !== undefined && Number.isFinite(Number(body.limitPrice))
          ? Number(body.limitPrice)
          : undefined,
      expiresInMs:
        body.expiresInMs !== undefined && Number.isFinite(Number(body.expiresInMs))
          ? Number(body.expiresInMs)
          : undefined,
      confirmLiveOverride: Boolean(body.confirmLiveOverride),
    });

    res.status(record.status === 'REJECTED' ? 422 : 200).json({
      ok: record.status !== 'REJECTED',
      order: record,
      reconciliation: executor.getPaperReconciliation(),
    });
  });

  app.post('/api/execution/cancel', postLimiter, (req, res) => {
    const body = req.body as { clientOrderId?: string };
    if (!body || typeof body.clientOrderId !== 'string' || body.clientOrderId.length < 4) {
      res.status(400).json({ ok: false, error: 'clientOrderId không hợp lệ.' });
      return;
    }
    const result = executor.cancelOrder(body.clientOrderId);
    res.status(result.ok ? 200 : 400).json({
      ...result,
      reconciliation: executor.getPaperReconciliation(),
    });
  });

  app.get('/api/execution/reconcile', (req, res) => {
    const matchPrice = Number(req.query.price);
    if (Number.isFinite(matchPrice) && matchPrice > 0) {
      executor.matchOpenPaperOrders(matchPrice);
    }
    res.json({
      ok: true,
      reconciliation: executor.getPaperReconciliation(),
      orders: repo.getOrders(50),
    });
  });

  // Optional Server-Side Gemini AI Quantitative Advisory (Never bypasses Risk Guardian)
  app.post('/api/ai/analyze', aiLimiter, async (req, res) => {
    const body = req.body as {
      price?: number;
      venue?: MarketVenue;
      regime?: StrategyConfig['marketVenue'] | string;
      indicators?: Parameters<typeof generateGeminiQuantAdvisory>[0]['indicators'];
      councilDirection?: 'LONG' | 'SHORT' | 'NEUTRAL';
      councilScore?: number;
    };

    if (
      !body ||
      !Number.isFinite(Number(body.price)) ||
      Number(body.price) <= 0 ||
      !body.indicators
    ) {
      res.status(400).json({ ok: false, error: 'Thiếu dữ liệu chỉ báo hợp lệ để phân tích AI.' });
      return;
    }

    const result = await generateGeminiQuantAdvisory({
      price: Number(body.price),
      venue: body.venue && VALID_VENUES.has(body.venue) ? body.venue : DEFAULT_STRATEGY_CONFIG.marketVenue,
      regime: (body.regime as Parameters<typeof generateGeminiQuantAdvisory>[0]['regime']) ?? 'Tích lũy Nén Biến động',
      indicators: body.indicators,
      councilDirection:
        body.councilDirection === 'LONG' || body.councilDirection === 'SHORT'
          ? body.councilDirection
          : 'NEUTRAL',
      councilScore: Number.isFinite(Number(body.councilScore)) ? Number(body.councilScore) : 50,
    });
    res.json({ ok: true, advisory: result });
  });

  return { app, repo, marketHub };
}

async function startServer() {
  const { app, marketHub, repo } = createQuantServerApp({ startMarketFeeds: true });

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

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`AegisBTC Quant server listening on http://0.0.0.0:${PORT}`);

    // Warm both Spot & Futures non-blocking after binding port 3000
    const initVenue = marketHub.getVenue();
    void marketHub.refreshRestSnapshot(initVenue).finally(() => {
      marketHub.startWebSocket(initVenue);
    });

    const restPollTimer = setInterval(async () => {
      const v = marketHub.getVenue();
      const health = marketHub.getAllHealth()[v];
      if (!health.wsConnected) {
        await marketHub.refreshRestSnapshot(v);
      } else if (v === 'BINANCE_FUTURES') {
        // Refresh Open Interest + HTF context periodically even when WS is up
        await marketHub.refreshRestSnapshot(v);
      }
    }, 10000);

    const shutdown = () => {
      clearInterval(restPollTimer);
      marketHub.stop();
      repo.close();
      server.close(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}

// Start server only when executed as entrypoint
const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);
if (isEntrypoint) {
  void startServer();
}
