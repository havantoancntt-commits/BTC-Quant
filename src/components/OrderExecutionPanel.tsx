import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, OctagonAlert, ShieldAlert, X } from 'lucide-react';
import type {
  ClosedTrade,
  ExecutionOrderRecord,
  FeedHealthStatus,
  OrderbookLevel,
  PaperReconciliationReport,
  PipelineCycle,
  Position,
  StrategyConfig,
} from '../engine/types';

interface OrderExecutionDeskProps {
  activePosition: Position | null;
  cycle: PipelineCycle | null;
  currentPrice: number;
  config: StrategyConfig;
  emergencyStopActive: boolean;
  dataQuality: FeedHealthStatus;
  reconciliation?: PaperReconciliationReport | null;
  manualRejectionReason: string | null;
  onDismissRejection: () => void;
  onToggleEmergencyStop: () => void;
  onOpenOrder: (
    side: 'LONG' | 'SHORT',
    options?: { orderType: 'MARKET' | 'LIMIT'; limitPrice?: number },
  ) => void;
  onClosePosition: (closeRatio: 0.5 | 1) => void;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function formatUsd(val: number, decimals = 2): string {
  return val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function OrderExecutionDesk({
  activePosition,
  cycle,
  currentPrice,
  config,
  emergencyStopActive,
  dataQuality,
  reconciliation,
  manualRejectionReason,
  onDismissRejection,
  onToggleEmergencyStop,
  onOpenOrder,
  onClosePosition,
}: OrderExecutionDeskProps) {
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPriceInput, setLimitPriceInput] = useState<string>('');

  if (activePosition) {
    const totalPnl = activePosition.unrealizedPnl + activePosition.realizedPartialPnl;
    const isProfit = totalPnl >= 0;
    const livePrice = activePosition.currentPrice || currentPrice;

    const isLong = activePosition.side === 'LONG';
    const minRef = isLong ? activePosition.initialStopLoss : activePosition.takeProfit2;
    const maxRef = isLong ? activePosition.takeProfit2 : activePosition.initialStopLoss;
    const span = Math.max(1, maxRef - minRef);

    const toPct = (price: number) => {
      const raw = isLong
        ? ((price - activePosition.initialStopLoss) / span) * 100
        : ((activePosition.initialStopLoss - price) / span) * 100;
      return clampPct(raw);
    };

    const entryPct = toPct(activePosition.entryPrice);
    const tp1Pct = toPct(activePosition.takeProfit1);
    const currentPct = toPct(livePrice);
    const currentSlPct = toPct(activePosition.stopLoss);

    return (
      <section
        aria-label="Quản trị lệnh đang mở"
        data-testid="active-order-desk"
        className="pt-3 border-t border-white/10 space-y-2.5"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              {isLong ? (
                <ArrowUpRight className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="w-4 h-4 text-rose-400" aria-hidden="true" />
              )}
              <span className={isLong ? 'text-emerald-400' : 'text-rose-400'}>
                {isLong ? 'LỆNH MUA · LONG' : 'LỆNH BÁN · SHORT'}
              </span>
              <span className="text-slate-400 font-mono text-[10px]">
                {activePosition.executionMode} · {activePosition.venue === 'BINANCE_FUTURES' ? 'FUTURES' : 'SPOT'}
              </span>
            </div>
            <p className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
              {activePosition.id} · Còn {activePosition.remainingBtc} / {activePosition.sizeBtc} BTC · $
              {formatUsd(activePosition.notionalUsd, 0)}
            </p>
          </div>

          <div className="text-right font-mono tabular-nums">
            <span
              data-testid="active-order-pnl"
              className={`text-sm font-bold block ${
                isProfit ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {isProfit ? '+' : ''}${formatUsd(totalPnl)}
            </span>
            <span
              className={`text-[11px] ${
                isProfit ? 'text-emerald-400/80' : 'text-rose-400/80'
              }`}
            >
              {activePosition.unrealizedPnlPct >= 0 ? '+' : ''}
              {activePosition.unrealizedPnlPct.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Institutional Risk-to-Reward Price Ladder */}
        <div className="space-y-1">
          <div className="relative h-2 w-full rounded-full bg-slate-800/90 overflow-visible">
            <div
              className="absolute top-0 bottom-0 bg-rose-500/35 rounded-l-full"
              style={{
                left: `${Math.min(currentSlPct, entryPct)}%`,
                width: `${Math.max(1, Math.abs(entryPct - currentSlPct))}%`,
              }}
            />
            <div
              className="absolute top-0 bottom-0 bg-emerald-500/30 rounded-r-full"
              style={{
                left: `${entryPct}%`,
                width: `${Math.max(1, 100 - entryPct)}%`,
              }}
            />
            <span
              className="absolute -top-0.5 w-0.5 h-3 bg-amber-400"
              style={{ left: `${entryPct}%` }}
              title={`Entry $${formatUsd(activePosition.entryPrice)}`}
            />
            <span
              className="absolute -top-0.5 w-0.5 h-3 bg-sky-400"
              style={{ left: `${tp1Pct}%` }}
              title={`TP1 $${formatUsd(activePosition.takeProfit1)}`}
            />
            <span
              className="absolute -top-1 w-2.5 h-4 -ml-1 rounded-sm bg-white border border-slate-950 shadow"
              style={{ left: `${currentPct}%` }}
              title={`Giá hiện tại $${formatUsd(livePrice)}`}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-slate-500">
            <span>SL</span>
            <span className="text-amber-400/90">Vào</span>
            <span className="text-sky-400/90">TP1 (50%)</span>
            <span className="text-emerald-400/90">TP2</span>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-[11px] font-mono tabular-nums">
          <div>
            <span className="text-slate-500 block font-sans">Giá vào</span>
            <span className="text-slate-100">${formatUsd(activePosition.entryPrice, 0)}</span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">
              Cắt lỗ {activePosition.tp1Hit ? '(BE)' : ''}
            </span>
            <span className={activePosition.tp1Hit ? 'text-amber-300' : 'text-rose-400'}>
              ${formatUsd(activePosition.stopLoss, 0)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">TP1</span>
            <span className={activePosition.tp1Hit ? 'text-slate-500 line-through' : 'text-sky-400'}>
              ${formatUsd(activePosition.takeProfit1, 0)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">TP2</span>
            <span className="text-emerald-400">${formatUsd(activePosition.takeProfit2, 0)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400">
          <span>
            Ký quỹ: <strong className="text-slate-200">${formatUsd(activePosition.marginUsedUsd, 0)}</strong>
          </span>
          <span>
            Thanh lý:{' '}
            <strong className={activePosition.liquidationPrice ? 'text-amber-300' : 'text-slate-400'}>
              {activePosition.liquidationPrice
                ? `$${formatUsd(activePosition.liquidationPrice, 0)}`
                : 'Spot 1x (No Liq)'}
            </strong>
          </span>
        </div>

        <div className="flex items-center gap-2 pt-0.5">
          {!activePosition.tp1Hit && (
            <button
              type="button"
              onClick={() => onClosePosition(0.5)}
              className="flex-1 py-1.5 px-2.5 text-xs font-medium rounded-lg bg-sky-500/14 text-sky-300 border border-sky-400/30 hover:bg-sky-500/24 transition-colors cursor-pointer whitespace-nowrap"
            >
              Chốt 50% (Dời BE)
            </button>
          )}
          <button
            type="button"
            onClick={() => onClosePosition(1)}
            data-testid="close-position-btn"
            className="flex-1 py-1.5 px-2.5 text-xs font-medium rounded-lg bg-white/8 text-slate-100 border border-white/15 hover:bg-white/16 transition-colors flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <X className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />
            <span>Đóng lệnh ngay</span>
          </button>
        </div>
      </section>
    );
  }

  const risk = cycle?.risk;
  const isVetoed = cycle?.actionTaken === 'VETO_SKIP';
  const sizingLabel =
    config.sizingMethod === 'FIXED_FRACTIONAL' ? 'Fixed Fractional' : 'Half-Kelly';

  return (
    <section
      aria-label="Bảng đặt lệnh Mua Bán BTC"
      data-testid="standby-order-desk"
      className="pt-3 border-t border-white/10 space-y-2.5"
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-200">
          {sizingLabel} · {config.executionMode}
        </span>
        {risk && (
          <span className="font-mono tabular-nums text-[11px] text-slate-400">
            {risk.positionSizeBtc} BTC · Net 1:{risk.netRewardRiskRatio}
          </span>
        )}
      </div>

      {/* Explicit Manual Rejection Alert */}
      {manualRejectionReason && (
        <div
          role="alert"
          data-testid="manual-order-rejection"
          className="p-2.5 rounded-lg bg-rose-500/12 border border-rose-500/35 text-[11px] text-rose-200 flex items-start justify-between gap-2"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" aria-hidden="true" />
            <div>
              <strong className="block font-semibold text-rose-300">RISK BLOCKED — Lệnh bị từ chối</strong>
              <span>{manualRejectionReason}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismissRejection}
            aria-label="Đóng thông báo từ chối"
            className="text-rose-300 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {emergencyStopActive && (
        <div
          data-testid="kill-switch-banner"
          className="p-2 rounded-lg bg-rose-500/15 border border-rose-500/40 text-[11px] text-rose-200 flex items-center justify-between gap-2"
        >
          <span className="font-semibold">KILL SWITCH ĐANG BẬT — Đã khóa mở lệnh mới</span>
          <button
            type="button"
            onClick={onToggleEmergencyStop}
            className="px-2 py-0.5 rounded bg-rose-500 text-white text-[10px] font-semibold cursor-pointer whitespace-nowrap"
          >
            Gỡ khóa
          </button>
        </div>
      )}

      {isVetoed && cycle?.actionNote && !manualRejectionReason && (
        <div className="flex items-start gap-2 text-[11px] text-amber-300 leading-snug">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" aria-hidden="true" />
          <span>{cycle.actionNote}</span>
        </div>
      )}

      {dataQuality !== 'HEALTHY' && (
        <div className="text-[11px] text-amber-300 font-mono">
          Cảnh báo nguồn giá: {dataQuality} — Risk Guardian sẽ chặn mở lệnh nếu dữ liệu quá hạn.
        </div>
      )}

      {risk && (
        <div className="grid grid-cols-3 gap-2 text-[11px] font-mono tabular-nums text-slate-300">
          <div>
            <span className="text-slate-500 block font-sans">Giá khớp</span>
            <span>${formatUsd(currentPrice, 0)}</span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Cỡ rủi ro</span>
            <span className="text-amber-300">
              {risk.effectiveRiskPct}% ({risk.effectiveLeverage}x)
            </span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Khả dụng</span>
            <span className="text-slate-200">
              ${formatUsd(reconciliation?.availableBalanceUsd ?? risk.marginRequiredUsd, 0)}
            </span>
          </div>
        </div>
      )}

      {/* Order Type Toggle: MARKET vs LIMIT */}
      <div className="flex items-center gap-2">
        <div className="grid grid-cols-2 gap-1 bg-[#070B12] p-0.5 rounded-lg border border-white/10 shrink-0">
          {(['MARKET', 'LIMIT'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setOrderType(t);
                if (t === 'LIMIT' && !limitPriceInput && currentPrice > 0) {
                  setLimitPriceInput(String(Math.round(currentPrice)));
                }
              }}
              data-testid={`order-type-${t.toLowerCase()}`}
              className={`px-2 py-1 text-[10px] font-mono font-semibold rounded transition-colors cursor-pointer ${
                orderType === t
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {orderType === 'LIMIT' && (
          <input
            type="number"
            step="10"
            min="1"
            aria-label="Giá Limit (USDT)"
            data-testid="limit-price-input"
            placeholder={String(Math.round(currentPrice))}
            value={limitPriceInput}
            onChange={(e) => setLimitPriceInput(e.target.value)}
            className="flex-1 min-w-0 bg-[#070B12] border border-white/15 rounded-lg px-2.5 py-1 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-amber-400"
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() =>
            onOpenOrder('LONG', {
              orderType,
              limitPrice: orderType === 'LIMIT' ? Number(limitPriceInput) || currentPrice : undefined,
            })
          }
          data-testid="manual-buy-btn"
          className="py-2 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
        >
          <ArrowUpRight className="w-4 h-4" aria-hidden="true" />
          <span>{orderType === 'LIMIT' ? 'Limit Mua' : 'Đặt Lệnh Mua'}</span>
        </button>
        <button
          type="button"
          onClick={() =>
            onOpenOrder('SHORT', {
              orderType,
              limitPrice: orderType === 'LIMIT' ? Number(limitPriceInput) || currentPrice : undefined,
            })
          }
          data-testid="manual-sell-btn"
          className="py-2 px-3 rounded-lg bg-rose-500 hover:bg-rose-400 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
        >
          <ArrowDownRight className="w-4 h-4" aria-hidden="true" />
          <span>{orderType === 'LIMIT' ? 'Limit Bán' : 'Đặt Lệnh Bán'}</span>
        </button>
      </div>

      <button
        type="button"
        onClick={onToggleEmergencyStop}
        data-testid="kill-switch-btn"
        className={`w-full py-1.5 px-3 rounded-lg border text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
          emergencyStopActive
            ? 'bg-rose-600 text-white border-rose-400'
            : 'bg-[#070B12] text-rose-300 border-rose-500/30 hover:border-rose-400'
        }`}
      >
        <OctagonAlert className="w-3.5 h-3.5" aria-hidden="true" />
        <span>
          {emergencyStopActive ? 'Đang kích hoạt Emergency Kill Switch' : 'Emergency Stop / Kill Switch'}
        </span>
      </button>
    </section>
  );
}

interface OrderbookAndLedgerTabProps {
  bestBid: number | null;
  bestAsk: number | null;
  orderbookBids: OrderbookLevel[];
  orderbookAsks: OrderbookLevel[];
  orderbookImbalance: number;
  orderbookSource?: 'EXCHANGE_DEPTH' | 'UNAVAILABLE';
  liveTrades: ClosedTrade[];
  orders: ExecutionOrderRecord[];
  reconciliation?: PaperReconciliationReport | null;
  isUsingLiveStream: boolean;
  onCancelOrder?: (clientOrderId: string) => void;
}

export function OrderbookAndLedgerTab({
  bestBid,
  bestAsk,
  orderbookBids,
  orderbookAsks,
  orderbookImbalance,
  orderbookSource = 'UNAVAILABLE',
  liveTrades,
  orders,
  reconciliation,
  isUsingLiveStream,
  onCancelOrder,
}: OrderbookAndLedgerTabProps) {
  const sortedAsks = orderbookAsks.slice(0, 5).reverse();
  const topBids = orderbookBids.slice(0, 5);

  const maxDepthTotal = Math.max(
    0.001,
    ...sortedAsks.map((a) => a.total),
    ...topBids.map((b) => b.total),
  );

  const spreadUsd =
    bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : 0;
  const midPrice =
    bestBid !== null && bestAsk !== null && bestBid > 0 ? (bestAsk + bestBid) / 2 : 0;
  const spreadBps = midPrice > 0 ? (spreadUsd / midPrice) * 10000 : 0;

  const bidPressurePct = Math.round(clampPct(((orderbookImbalance + 1) / 2) * 100));
  const askPressurePct = 100 - bidPressurePct;

  return (
    <div className="space-y-4">
      {/* Real-Time Top-5 Orderbook Depth Ladder */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-200">
            Sổ Lệnh Thực tế (Top 5 Bid / Ask)
          </span>
          <span className="font-mono text-[11px] tabular-nums text-slate-400">
            {isUsingLiveStream && orderbookSource === 'EXCHANGE_DEPTH'
              ? 'Binance Depth20'
              : orderbookSource === 'UNAVAILABLE'
                ? 'UNAVAILABLE'
                : 'Mô phỏng'}
          </span>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
            <span className="text-emerald-400">Bid {bidPressurePct}%</span>
            <span className="text-rose-400">Ask {askPressurePct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-rose-500/40 overflow-hidden flex">
            <div
              className="h-full bg-emerald-400 transition-all duration-300"
              style={{ width: `${bidPressurePct}%` }}
            />
          </div>
        </div>

        {sortedAsks.length > 0 || topBids.length > 0 ? (
          <div
            data-testid="orderbook-depth-ladder"
            className="text-[11px] font-mono tabular-nums space-y-0.5"
          >
            <div className="grid grid-cols-3 text-[10px] text-slate-500 pb-1 font-sans">
              <span>Giá (USDT)</span>
              <span className="text-right">KL (BTC)</span>
              <span className="text-right">Tích lũy</span>
            </div>

            {sortedAsks.map((ask) => {
              const barPct = clampPct((ask.total / maxDepthTotal) * 100);
              return (
                <div
                  key={`ask-${ask.price}`}
                  className="relative grid grid-cols-3 py-0.5 px-1.5 rounded overflow-hidden"
                >
                  <div
                    className="absolute inset-y-0 right-0 bg-rose-500/16 pointer-events-none"
                    style={{ width: `${barPct}%` }}
                  />
                  <span className="relative text-rose-400">${formatUsd(ask.price)}</span>
                  <span className="relative text-right text-slate-200">
                    {ask.qty.toFixed(4)}
                  </span>
                  <span className="relative text-right text-slate-400">
                    {ask.total.toFixed(3)}
                  </span>
                </div>
              );
            })}

            <div className="py-1 px-1.5 my-0.5 border-y border-white/10 flex items-center justify-between text-[10px] text-slate-400">
              <span>Spread thị trường</span>
              <span className="text-slate-200">
                ${spreadUsd.toFixed(2)} ({spreadBps.toFixed(1)} bps)
              </span>
            </div>

            {topBids.map((bid) => {
              const barPct = clampPct((bid.total / maxDepthTotal) * 100);
              return (
                <div
                  key={`bid-${bid.price}`}
                  className="relative grid grid-cols-3 py-0.5 px-1.5 rounded overflow-hidden"
                >
                  <div
                    className="absolute inset-y-0 right-0 bg-emerald-500/16 pointer-events-none"
                    style={{ width: `${barPct}%` }}
                  />
                  <span className="relative text-emerald-400">${formatUsd(bid.price)}</span>
                  <span className="relative text-right text-slate-200">
                    {bid.qty.toFixed(4)}
                  </span>
                  <span className="relative text-right text-slate-400">
                    {bid.total.toFixed(3)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-slate-400 py-2">
            Đang đồng bộ thanh khoản Bid/Ask...
          </p>
        )}
      </div>

      {/* Paper Balance Reconciliation Summary */}
      {reconciliation && (
        <div
          data-testid="paper-reconciliation-box"
          className="pt-3 border-t border-white/10 space-y-1.5 text-[11px] font-mono tabular-nums"
        >
          <div className="flex items-center justify-between text-xs font-sans">
            <span className="font-semibold text-slate-200">Đối soát Số dư Ví (Ledger)</span>
            <span
              className={`font-mono font-semibold ${
                reconciliation.consistent ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {reconciliation.consistent ? 'CÂN BẰNG OK' : `CHÊNH $${reconciliation.discrepancyUsd.toFixed(2)}`}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-300">
            <span>Khả dụng: ${formatUsd(reconciliation.availableBalanceUsd, 0)}</span>
            <span className="text-right">Ký quỹ giữ: ${formatUsd(reconciliation.usedMarginUsd, 0)}</span>
            <span>Lệnh chờ: ${formatUsd(reconciliation.pendingOrdersMarginUsd, 0)}</span>
            <span className="text-right">Phí đã trừ: ${formatUsd(reconciliation.totalFeesUsd, 2)}</span>
          </div>
        </div>
      )}

      {/* Persisted Execution Orders */}
      {orders.length > 0 && (
        <div className="pt-3 border-t border-white/10 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-200">Lệnh Gửi Sàn / Adapter ({orders.length})</span>
            <span className="text-[11px] text-slate-500">SQLite</span>
          </div>
          <div className="divide-y divide-white/8 text-[11px] font-mono tabular-nums">
            {orders.slice(0, 6).map((o) => (
              <div key={o.clientOrderId} className="py-1.5 flex items-center justify-between gap-2">
                <div>
                  <span className="text-slate-200">
                    {o.orderType} {o.side} {o.requestedQtyBtc} BTC
                  </span>
                  <span className="block text-[10px] text-slate-500">
                    {o.mode} ·{' '}
                    <strong className={o.status === 'NEW' ? 'text-amber-300' : 'text-slate-400'}>
                      {o.status}
                    </strong>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-300">
                    ${formatUsd(o.executedPrice ?? o.limitPrice ?? o.requestedPrice, 0)}
                  </span>
                  {o.status === 'NEW' && onCancelOrder && (
                    <button
                      type="button"
                      onClick={() => onCancelOrder(o.clientOrderId)}
                      data-testid={`cancel-order-${o.clientOrderId}`}
                      className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 hover:bg-rose-500/35 border border-rose-500/30 text-[10px] cursor-pointer"
                    >
                      Hủy
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Session Execution History */}
      <div className="pt-3 border-t border-white/10 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-200">
            Nhật ký Tất toán ({liveTrades.length})
          </span>
          <span className="text-[11px] text-slate-500">Net PnL sau phí</span>
        </div>

        {liveTrades.length === 0 ? (
          <p className="text-xs text-slate-400 py-2 leading-relaxed">
            Chưa có lệnh tất toán. Mọi lệnh thủ công và tự động đều phải được Risk Guardian duyệt.
          </p>
        ) : (
          <div className="divide-y divide-white/8 text-[11px]">
            {liveTrades.slice(0, 8).map((t) => (
              <div key={`${t.id}-${t.closedAt}`} className="py-2 flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 font-mono tabular-nums">
                    <span
                      className={`font-semibold ${
                        t.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {t.side === 'LONG' ? 'MUA' : 'BÁN'}
                    </span>
                    <span className="text-slate-500">{t.id}</span>
                  </div>
                  <div className="font-mono tabular-nums text-slate-400 mt-0.5">
                    ${formatUsd(t.entryPrice, 0)} → ${formatUsd(t.exitPrice, 0)} · Phí ${t.feesPaidUsd.toFixed(1)}
                  </div>
                </div>
                <div className="text-right font-mono tabular-nums">
                  <span
                    className={`font-semibold block ${
                      t.pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {t.pnlUsd >= 0 ? '+' : ''}${formatUsd(t.pnlUsd)}
                  </span>
                  <span className="text-slate-500">
                    {t.rMultiple >= 0 ? '+' : ''}
                    {t.rMultiple}R
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
