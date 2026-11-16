import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_STRATEGY_CONFIG } from '../engine/multiAgentEngine';
import { createInitialRiskAccountState } from '../engine/riskManager';
import type {
  ClosedTrade,
  ExecutionOrderRecord,
  Position,
  RiskAccountState,
  RiskEventRecord,
  StrategyConfig,
} from '../engine/types';

export interface SystemLogEntry {
  id: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SECURITY';
  category: string;
  message: string;
  createdAt: number;
}

export interface PersistedAppSnapshot {
  config: StrategyConfig;
  accountState: RiskAccountState;
  activePosition: Position | null;
  trades: ClosedTrade[];
  orders: ExecutionOrderRecord[];
  riskEvents: RiskEventRecord[];
}

export function redactSensitiveText(input: string): string {
  return input
    .replace(/([A-Za-z0-9_-]*?(?:api[_-]?key|secret|token|signature|bearer|password)\s*[:=]\s*)['"]?[A-Za-z0-9._+/=-]+['"]?/gi, '$1[REDACTED]')
    .replace(/X-MBX-APIKEY\s*:\s*[^\s,;]+/gi, 'X-MBX-APIKEY: [REDACTED]');
}

export class QuantRepository {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ??
      process.env.AEGIS_DB_PATH ??
      path.resolve(process.cwd(), 'data', 'aegis_quant.sqlite');

    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(resolvedPath);
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(resolvedPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.initSchema();
    this.ensureDefaults();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS closed_trades (
        id TEXT PRIMARY KEY,
        side TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        size_btc REAL NOT NULL,
        gross_pnl_usd REAL NOT NULL,
        pnl_usd REAL NOT NULL,
        fees_paid_usd REAL NOT NULL,
        funding_paid_usd REAL NOT NULL,
        slippage_paid_usd REAL NOT NULL,
        pnl_pct REAL NOT NULL,
        r_multiple REAL NOT NULL,
        hold_minutes REAL NOT NULL,
        outcome TEXT NOT NULL,
        exit_reason TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER NOT NULL,
        consensus_score INTEGER NOT NULL,
        regime TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_orders (
        client_order_id TEXT PRIMARY KEY,
        exchange_order_id TEXT,
        mode TEXT NOT NULL,
        venue TEXT NOT NULL,
        side TEXT NOT NULL,
        position_side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        requested_qty_btc REAL NOT NULL,
        executed_qty_btc REAL NOT NULL,
        requested_price REAL NOT NULL,
        limit_price REAL,
        executed_price REAL,
        status TEXT NOT NULL,
        fee_usd REAL NOT NULL,
        reason TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    for (const ddl of [
      'ALTER TABLE execution_orders ADD COLUMN limit_price REAL',
      'ALTER TABLE execution_orders ADD COLUMN expires_at INTEGER',
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // Column already exists
      }
    }
  }

  public ping(): boolean {
    try {
      const row = this.db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  private ensureDefaults(): void {
    const existingCfg = this.getKv<StrategyConfig>('strategy_config');
    if (!existingCfg) {
      this.setKv('strategy_config', DEFAULT_STRATEGY_CONFIG);
    }
    const existingAcc = this.getKv<RiskAccountState>('account_state');
    if (!existingAcc) {
      this.setKv('account_state', createInitialRiskAccountState(DEFAULT_STRATEGY_CONFIG.initialCapital));
    }
  }

  private getKv<T>(key: string): T | null {
    const stmt = this.db.prepare('SELECT value_json FROM kv_store WHERE key = ?');
    const row = stmt.get(key) as { value_json?: string } | undefined;
    if (!row?.value_json) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  private setKv<T>(key: string, value: T): void {
    const stmt = this.db.prepare(`
      INSERT INTO kv_store (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(key, JSON.stringify(value), Date.now());
  }

  public getConfig(): StrategyConfig {
    return {
      ...DEFAULT_STRATEGY_CONFIG,
      ...(this.getKv<Partial<StrategyConfig>>('strategy_config') ?? {}),
    };
  }

  public saveConfig(config: StrategyConfig): StrategyConfig {
    this.setKv('strategy_config', config);
    return config;
  }

  public getAccountState(): RiskAccountState {
    const cfg = this.getConfig();
    return (
      this.getKv<RiskAccountState>('account_state') ??
      createInitialRiskAccountState(cfg.initialCapital)
    );
  }

  public saveAccountState(state: RiskAccountState): RiskAccountState {
    this.setKv('account_state', state);
    return state;
  }

  public getActivePosition(): Position | null {
    return this.getKv<Position | null>('active_position');
  }

  public saveActivePosition(position: Position | null): void {
    this.setKv('active_position', position);
  }

  public upsertTrade(trade: ClosedTrade): void {
    const stmt = this.db.prepare(`
      INSERT INTO closed_trades (
        id, side, entry_price, exit_price, size_btc, gross_pnl_usd, pnl_usd,
        fees_paid_usd, funding_paid_usd, slippage_paid_usd, pnl_pct, r_multiple,
        hold_minutes, outcome, exit_reason, opened_at, closed_at, consensus_score, regime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exit_price = excluded.exit_price,
        pnl_usd = excluded.pnl_usd,
        closed_at = excluded.closed_at
    `);
    stmt.run(
      trade.id,
      trade.side,
      trade.entryPrice,
      trade.exitPrice,
      trade.sizeBtc,
      trade.grossPnlUsd,
      trade.pnlUsd,
      trade.feesPaidUsd,
      trade.fundingPaidUsd,
      trade.slippagePaidUsd,
      trade.pnlPct,
      trade.rMultiple,
      trade.holdMinutes,
      trade.outcome,
      trade.exitReason,
      trade.openedAt,
      trade.closedAt,
      trade.consensusScore,
      trade.regime,
    );
  }

  public getTrades(limit = 100): ClosedTrade[] {
    const stmt = this.db.prepare(
      'SELECT * FROM closed_trades ORDER BY closed_at DESC LIMIT ?',
    );
    const rows = stmt.all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      side: r.side === 'SHORT' ? 'SHORT' : 'LONG',
      entryPrice: Number(r.entry_price),
      exitPrice: Number(r.exit_price),
      sizeBtc: Number(r.size_btc),
      grossPnlUsd: Number(r.gross_pnl_usd),
      pnlUsd: Number(r.pnl_usd),
      feesPaidUsd: Number(r.fees_paid_usd),
      fundingPaidUsd: Number(r.funding_paid_usd),
      slippagePaidUsd: Number(r.slippage_paid_usd),
      pnlPct: Number(r.pnl_pct),
      rMultiple: Number(r.r_multiple),
      holdMinutes: Number(r.hold_minutes),
      outcome: (r.outcome as ClosedTrade['outcome']) ?? 'BREAKEVEN',
      exitReason: (r.exit_reason as ClosedTrade['exitReason']) ?? 'MANUAL_CLOSE',
      openedAt: Number(r.opened_at),
      closedAt: Number(r.closed_at),
      consensusScore: Number(r.consensus_score),
      regime: String(r.regime) as ClosedTrade['regime'],
    }));
  }

  public saveOrder(order: ExecutionOrderRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO execution_orders (
        client_order_id, exchange_order_id, mode, venue, side, position_side,
        order_type, requested_qty_btc, executed_qty_btc, requested_price,
        limit_price, executed_price, status, fee_usd, reason, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_order_id) DO UPDATE SET
        exchange_order_id = excluded.exchange_order_id,
        executed_qty_btc = excluded.executed_qty_btc,
        limit_price = excluded.limit_price,
        executed_price = excluded.executed_price,
        status = excluded.status,
        fee_usd = excluded.fee_usd,
        reason = excluded.reason,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      order.clientOrderId,
      order.exchangeOrderId,
      order.mode,
      order.venue,
      order.side,
      order.positionSide,
      order.orderType,
      order.requestedQtyBtc,
      order.executedQtyBtc,
      order.requestedPrice,
      order.limitPrice ?? null,
      order.executedPrice,
      order.status,
      order.feeUsd,
      order.reason ? redactSensitiveText(order.reason) : null,
      order.expiresAt ?? null,
      order.createdAt,
      order.updatedAt,
    );
  }

  public getOrderByClientId(clientOrderId: string): ExecutionOrderRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM execution_orders WHERE client_order_id = ?',
    );
    const r = stmt.get(clientOrderId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return this.mapOrderRow(r);
  }

  public getOrders(limit = 50): ExecutionOrderRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM execution_orders ORDER BY created_at DESC LIMIT ?',
    );
    const rows = stmt.all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOrderRow(r));
  }

  public getOpenLimitOrders(): ExecutionOrderRecord[] {
    const stmt = this.db.prepare(
      "SELECT * FROM execution_orders WHERE status IN ('NEW', 'PARTIALLY_FILLED') ORDER BY created_at ASC",
    );
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOrderRow(r));
  }

  private mapOrderRow(r: Record<string, unknown>): ExecutionOrderRecord {
    return {
      clientOrderId: String(r.client_order_id),
      exchangeOrderId: r.exchange_order_id ? String(r.exchange_order_id) : null,
      mode: r.mode as ExecutionOrderRecord['mode'],
      venue: r.venue as ExecutionOrderRecord['venue'],
      side: r.side === 'SELL' ? 'SELL' : 'BUY',
      positionSide: r.position_side === 'SHORT' ? 'SHORT' : 'LONG',
      orderType: r.order_type === 'LIMIT' ? 'LIMIT' : 'MARKET',
      requestedQtyBtc: Number(r.requested_qty_btc),
      executedQtyBtc: Number(r.executed_qty_btc),
      requestedPrice: Number(r.requested_price),
      limitPrice:
        r.limit_price !== null && r.limit_price !== undefined ? Number(r.limit_price) : null,
      executedPrice:
        r.executed_price !== null && r.executed_price !== undefined ? Number(r.executed_price) : null,
      status: r.status as ExecutionOrderRecord['status'],
      feeUsd: Number(r.fee_usd),
      reason: r.reason ? String(r.reason) : null,
      expiresAt:
        r.expires_at !== null && r.expires_at !== undefined ? Number(r.expires_at) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  public addRiskEvent(event: RiskEventRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO risk_events (id, event_type, message, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(event.id, event.eventType, redactSensitiveText(event.message), event.createdAt);
  }

  public getRiskEvents(limit = 50): RiskEventRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ?',
    );
    const rows = stmt.all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      eventType: r.event_type as RiskEventRecord['eventType'],
      message: String(r.message),
      createdAt: Number(r.created_at),
    }));
  }

  public log(level: SystemLogEntry['level'], category: string, message: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO system_logs (level, category, message, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(level, category, redactSensitiveText(message), Date.now());
  }

  public getSystemLogs(limit = 60): SystemLogEntry[] {
    const stmt = this.db.prepare(
      'SELECT * FROM system_logs ORDER BY created_at DESC LIMIT ?',
    );
    const rows = stmt.all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      level: r.level as SystemLogEntry['level'],
      category: String(r.category),
      message: String(r.message),
      createdAt: Number(r.created_at),
    }));
  }

  public resetSession(initialCapital?: number): PersistedAppSnapshot {
    const cfg = this.getConfig();
    const cap = initialCapital && initialCapital > 0 ? initialCapital : cfg.initialCapital;
    const freshAccount = createInitialRiskAccountState(cap);
    this.db.exec('DELETE FROM closed_trades; DELETE FROM execution_orders; DELETE FROM risk_events;');
    this.saveActivePosition(null);
    this.saveAccountState(freshAccount);
    this.log('INFO', 'SESSION', `Reset simulated/paper session capital to $${cap}`);
    return this.getFullSnapshot();
  }

  public getFullSnapshot(): PersistedAppSnapshot {
    return {
      config: this.getConfig(),
      accountState: this.getAccountState(),
      activePosition: this.getActivePosition(),
      trades: this.getTrades(100),
      orders: this.getOrders(50),
      riskEvents: this.getRiskEvents(50),
    };
  }

  public close(): void {
    this.db.close();
  }
}
