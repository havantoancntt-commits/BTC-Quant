import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_BTC_FILTERS,
  ExchangeExecutionService,
  MAKER_FEE_RATE,
  floorToStepSize,
  quantizeAndValidateOrder,
  roundToTickSize,
  signBinanceQuery,
} from './exchangeExecutor';
import {
  buildExchangeHtfContext,
  computeFeedHealthStatus,
} from './marketDataService';
import { QuantRepository, redactSensitiveText } from './repository';
import { createQuantServerApp } from '../../server';

test('Exchange precision filters: tickSize, stepSize floor, minQty, minNotional validation', () => {
  assert.equal(roundToTickSize(92345.678, 0.01), 92345.68);
  assert.equal(floorToStepSize(0.123456, 0.00001), 0.12345);

  const validOrder = quantizeAndValidateOrder({
    price: 92500.123,
    qtyBtc: 0.025678,
    filters: DEFAULT_BTC_FILTERS,
  });
  assert.equal(validOrder.valid, true);
  assert.equal(validOrder.quantizedPrice, 92500.12);
  assert.equal(validOrder.quantizedQtyBtc, 0.02567);

  const tinyOrder = quantizeAndValidateOrder({
    price: 90000,
    qtyBtc: 0.00005, // ~$4.5 < $10 minNotional
    filters: DEFAULT_BTC_FILTERS,
  });
  assert.equal(tinyOrder.valid, false);
  assert.ok(tinyOrder.error?.includes('minNotional'));
});

test('HMAC-SHA256 Binance query signature matches expected deterministic hex output', () => {
  const sig = signBinanceQuery('symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.01&timestamp=1700000000000', 'test_secret');
  assert.equal(sig.length, 64);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(
    sig,
    signBinanceQuery('symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.01&timestamp=1700000000000', 'test_secret'),
  );
});

test('redactSensitiveText scrubs API keys, secrets, tokens, and headers from logs', () => {
  const raw = 'Error calling Binance X-MBX-APIKEY: myTopSecretKey123&apiKey=abc123&secret=xyz987';
  const scrubbed = redactSensitiveText(raw);
  assert.equal(scrubbed.includes('myTopSecretKey123'), false);
  assert.equal(scrubbed.includes('abc123'), false);
  assert.equal(scrubbed.includes('xyz987'), false);
  assert.ok(scrubbed.includes('[REDACTED]'));
});

test('MarketDataService HTF context and feed health status distinguish HEALTHY/STALE/INCOMPLETE/DISCONNECTED', () => {
  const risingCloses = Array.from({ length: 60 }, (_, i) => 85000 + i * 250);
  const htf = buildExchangeHtfContext({
    m5Closes: risingCloses,
    h1Closes: risingCloses,
    h4Closes: risingCloses,
    d1Closes: risingCloses,
  });
  assert.equal(htf.source, 'EXCHANGE_KLINES');
  assert.equal(htf.h1Bias, 'LONG');
  assert.equal(htf.h4Bias, 'LONG');
  assert.equal(htf.d1Bias, 'LONG');

  const now = 1_700_000_000_000;
  assert.equal(
    computeFeedHealthStatus({ lastMessageAt: 0, candlesCount: 0, wsConnected: false, hasError: true, now }),
    'DISCONNECTED',
  );
  assert.equal(
    computeFeedHealthStatus({ lastMessageAt: now - 5000, candlesCount: 20, wsConnected: true, hasError: false, now }),
    'INCOMPLETE',
  );
  assert.equal(
    computeFeedHealthStatus({ lastMessageAt: now - 35000, candlesCount: 200, wsConnected: false, hasError: false, now }),
    'STALE',
  );
  assert.equal(
    computeFeedHealthStatus({ lastMessageAt: now - 2000, candlesCount: 200, wsConnected: true, hasError: false, now }),
    'HEALTHY',
  );
});

test('SQLite QuantRepository persists config, trades, orders, risk events, and redacts logs across re-open', () => {
  const tmpFile = path.join(os.tmpdir(), `aegis-repo-test-${Date.now()}.sqlite`);
  try {
    const repo1 = new QuantRepository(tmpFile);
    assert.equal(repo1.ping(), true);
    const cfg = repo1.getConfig();
    repo1.saveConfig({ ...cfg, marketVenue: 'BINANCE_FUTURES', maxLeverage: 4 });
    repo1.upsertTrade({
      id: 'TRD-SQL-1',
      side: 'LONG',
      entryPrice: 90000,
      exitPrice: 91200,
      sizeBtc: 0.1,
      grossPnlUsd: 120,
      pnlUsd: 112.75,
      feesPaidUsd: 7.25,
      fundingPaidUsd: 0,
      slippagePaidUsd: 0,
      pnlPct: 1.25,
      rMultiple: 1.5,
      holdMinutes: 45,
      outcome: 'WIN',
      exitReason: 'TP2_TARGET',
      openedAt: Date.now() - 45 * 60000,
      closedAt: Date.now(),
      consensusScore: 80,
      regime: 'Mở rộng Xu hướng Tăng',
    });
    repo1.log('WARN', 'AUTH_TEST', 'apiKey=SECRET_TOKEN_XYZ failed');
    repo1.close();

    // Re-open fresh instance from same SQLite file
    const repo2 = new QuantRepository(tmpFile);
    const snap = repo2.getFullSnapshot();
    assert.equal(snap.config.marketVenue, 'BINANCE_FUTURES');
    assert.equal(snap.config.maxLeverage, 4);
    assert.equal(snap.trades.length, 1);
    assert.equal(snap.trades[0].id, 'TRD-SQL-1');

    const logs = repo2.getSystemLogs(10);
    assert.ok(logs.some((l) => l.message.includes('[REDACTED]') && !l.message.includes('SECRET_TOKEN_XYZ')));
    repo2.close();
  } finally {
    fs.rmSync(tmpFile, { force: true });
    fs.rmSync(`${tmpFile}-wal`, { force: true });
    fs.rmSync(`${tmpFile}-shm`, { force: true });
  }
});

test('ExchangeExecutionService enforces idempotency, Paper MARKET & LIMIT resting/matching/cancel/expiry, and locks LIVE trading by default', async () => {
  const repo = new QuantRepository(':memory:');
  const execSvc = new ExchangeExecutionService(repo);

  const paper1 = await execSvc.executeOrder({
    clientOrderId: 'ORD-PAPER-001',
    mode: 'PAPER',
    venue: 'BINANCE_SPOT',
    side: 'BUY',
    positionSide: 'LONG',
    qtyBtc: 0.05,
    referencePrice: 91000,
  });
  assert.equal(paper1.status, 'FILLED');
  assert.equal(paper1.executedQtyBtc, 0.05);
  assert.ok(paper1.feeUsd > 0);

  // Duplicate clientOrderId must return idempotent existing record without re-executing
  const paperDup = await execSvc.executeOrder({
    clientOrderId: 'ORD-PAPER-001',
    mode: 'PAPER',
    venue: 'BINANCE_SPOT',
    side: 'BUY',
    positionSide: 'LONG',
    qtyBtc: 0.05,
    referencePrice: 91000,
  });
  assert.equal(paperDup.exchangeOrderId, paper1.exchangeOrderId);
  assert.equal(repo.getOrders(10).length, 1);

  // Resting BUY LIMIT below market -> NEW + locks pending margin
  const restingLimit = await execSvc.executeOrder({
    clientOrderId: 'ORD-LIMIT-REST',
    mode: 'PAPER',
    venue: 'BINANCE_SPOT',
    side: 'BUY',
    positionSide: 'LONG',
    orderType: 'LIMIT',
    qtyBtc: 0.1,
    referencePrice: 91000,
    limitPrice: 89000,
  });
  assert.equal(restingLimit.status, 'NEW');
  assert.equal(restingLimit.limitPrice, 89000);
  assert.equal(restingLimit.executedQtyBtc, 0);

  const recBefore = execSvc.getPaperReconciliation();
  assert.equal(recBefore.pendingOrdersMarginUsd, 8900);
  assert.equal(recBefore.openLimitOrdersCount, 1);
  assert.equal(recBefore.consistent, true);

  // Market drops to 88950 -> crosses resting BUY LIMIT @ 89000 -> fills at limitPrice with MAKER_FEE_RATE
  const matched = execSvc.matchOpenPaperOrders(88950, Date.now());
  assert.equal(matched.length, 1);
  assert.equal(matched[0].status, 'FILLED');
  assert.equal(matched[0].executedPrice, 89000);
  assert.equal(matched[0].feeUsd, Number((89000 * 0.1 * MAKER_FEE_RATE).toFixed(2)));

  // Resting SELL LIMIT above market that expires
  const expOrder = await execSvc.executeOrder({
    clientOrderId: 'ORD-LIMIT-EXP',
    mode: 'PAPER',
    venue: 'BINANCE_SPOT',
    side: 'SELL',
    positionSide: 'SHORT',
    orderType: 'LIMIT',
    qtyBtc: 0.05,
    referencePrice: 90000,
    limitPrice: 94000,
    expiresInMs: 60_000,
  });
  assert.equal(expOrder.status, 'NEW');
  const expiredRes = execSvc.matchOpenPaperOrders(90500, expOrder.expiresAt! + 5000);
  assert.equal(expiredRes.length, 1);
  assert.equal(expiredRes[0].status, 'CANCELED');

  // Marketable BUY LIMIT >= refPrice fills immediately
  const mktLimit = await execSvc.executeOrder({
    clientOrderId: 'ORD-LIMIT-MKT',
    mode: 'PAPER',
    venue: 'BINANCE_SPOT',
    side: 'BUY',
    positionSide: 'LONG',
    orderType: 'LIMIT',
    qtyBtc: 0.05,
    referencePrice: 91000,
    limitPrice: 91500,
  });
  assert.equal(mktLimit.status, 'FILLED');

  // LIVE trading must be REJECTED by default unless ALLOW_LIVE_TRADING=true + credentials + explicit override
  const prevAllow = process.env.ALLOW_LIVE_TRADING;
  delete process.env.ALLOW_LIVE_TRADING;
  const liveBlocked = await execSvc.executeOrder({
    clientOrderId: 'ORD-LIVE-BLOCKED',
    mode: 'LIVE',
    venue: 'BINANCE_SPOT',
    side: 'BUY',
    positionSide: 'LONG',
    qtyBtc: 0.05,
    referencePrice: 91000,
    confirmLiveOverride: false,
  });
  assert.equal(liveBlocked.status, 'REJECTED');
  assert.ok(liveBlocked.reason?.includes('LIVE'));
  if (prevAllow !== undefined) process.env.ALLOW_LIVE_TRADING = prevAllow;
  repo.close();
});

test('HTTP Server API: 10-dependency /api/health, config clamping, emergency stop, LIMIT/cancel/reconcile & AI fallback', async () => {
  const { app, repo, marketHub } = createQuantServerApp({ dbPath: ':memory:', startMarketFeeds: false });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const requestJson = (urlPath: string, method = 'GET', body?: unknown) =>
    new Promise<{ status: number; data: any }>((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          agent: false,
          headers: payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                Connection: 'close',
              }
            : { Connection: 'close' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode ?? 0,
                data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  try {
    const healthRes = await requestJson('/api/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.data.ok, true);
    assert.equal(healthRes.data.status, 'HEALTHY');
    assert.ok(healthRes.data.credentials);
    const depKeys = [
      'apiServer',
      'database',
      'marketDataRest',
      'marketDataWs',
      'orderbookFeed',
      'fundingFeed',
      'agentEngine',
      'riskEngine',
      'paperTradingEngine',
      'executionEngine',
    ];
    for (const k of depKeys) {
      assert.ok(healthRes.data.dependencies?.[k], `/api/health must include dependency ${k}`);
    }

    // Update config & verify clamping + persistence
    const cfgRes = await requestJson('/api/config', 'PUT', {
      marketVenue: 'BINANCE_FUTURES',
      maxLeverage: 99,
      riskPerTradePct: 1.5,
    });
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.data.config.marketVenue, 'BINANCE_FUTURES');
    assert.equal(cfgRes.data.config.maxLeverage, 5, 'Server must clamp excessive leverage <= 5');

    // Emergency Stop toggle
    const stopRes = await requestJson('/api/risk/emergency-stop', 'POST', { active: true });
    assert.equal(stopRes.status, 200);
    assert.equal(stopRes.data.accountState.emergencyStopActive, true);

    // Paper Market Execution Order endpoint
    const ordRes = await requestJson('/api/execution/order', 'POST', {
      clientOrderId: 'HTTP-PAPER-1',
      mode: 'PAPER',
      venue: 'BINANCE_SPOT',
      side: 'BUY',
      positionSide: 'LONG',
      qtyBtc: 0.02,
      referencePrice: 92000,
    });
    assert.equal(ordRes.status, 200);
    assert.equal(ordRes.data.order.status, 'FILLED');

    // Resting Paper LIMIT order + Reconcile + Cancel endpoint
    const lmtRes = await requestJson('/api/execution/order', 'POST', {
      clientOrderId: 'HTTP-LIMIT-1',
      mode: 'PAPER',
      venue: 'BINANCE_SPOT',
      side: 'BUY',
      positionSide: 'LONG',
      orderType: 'LIMIT',
      qtyBtc: 0.05,
      referencePrice: 92000,
      limitPrice: 88000,
    });
    assert.equal(lmtRes.status, 200);
    assert.equal(lmtRes.data.order.status, 'NEW');
    assert.equal(lmtRes.data.reconciliation.openLimitOrdersCount, 1);
    assert.equal(lmtRes.data.reconciliation.pendingOrdersMarginUsd, 880);

    const recRes = await requestJson('/api/execution/reconcile');
    assert.equal(recRes.status, 200);
    assert.equal(recRes.data.reconciliation.consistent, true);
    assert.equal(recRes.data.reconciliation.openLimitOrdersCount, 1);

    const cancelRes = await requestJson('/api/execution/cancel', 'POST', {
      clientOrderId: 'HTTP-LIMIT-1',
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.order.status, 'CANCELED');
    assert.equal(cancelRes.data.reconciliation.pendingOrdersMarginUsd, 0);

    // Invalid LIVE order must fail with 422
    const liveRes = await requestJson('/api/execution/order', 'POST', {
      clientOrderId: 'HTTP-LIVE-1',
      mode: 'LIVE',
      venue: 'BINANCE_SPOT',
      side: 'BUY',
      positionSide: 'LONG',
      qtyBtc: 0.02,
      referencePrice: 92000,
    });
    assert.equal(liveRes.status, 422);

    // State retrieval verifies persistence across calls
    const stateRes = await requestJson('/api/state');
    assert.equal(stateRes.data.accountState.emergencyStopActive, true);
    assert.equal(stateRes.data.orders.length, 3);
    assert.ok(stateRes.data.reconciliation);

    // Gemini advisory without key returns graceful unavailable payload
    const prevGem = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const aiRes = await requestJson('/api/ai/analyze', 'POST', {
      price: 92000,
      venue: 'BINANCE_SPOT',
      regime: 'Tích lũy Nén Biến động',
      indicators: {
        ema21: 91900,
        ema50: 91500,
        ema200: 90000,
        rsi14: 55,
        adx14: 22,
        atr14: 350,
        atrPct: 0.38,
        spreadBps: 1.2,
        orderbookImbalance: 0.1,
        volumeRatio: 1.1,
        htfSource: 'EXCHANGE_KLINES',
        h1Bias: 'LONG',
        h4Bias: 'LONG',
        d1Bias: 'LONG',
        volumeProfile: { poc: 91800, vah: 92200, val: 91200, lookbackBars: 96 },
        fundingRate: null,
      },
      councilDirection: 'LONG',
      councilScore: 72,
    });
    assert.equal(aiRes.status, 200);
    assert.equal(aiRes.data.advisory.configured, false);
    if (prevGem !== undefined) process.env.GEMINI_API_KEY = prevGem;
  } finally {
    marketHub.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    repo.close();
  }
});
