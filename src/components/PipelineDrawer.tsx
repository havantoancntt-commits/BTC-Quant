import { useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import type {
  AgentId,
  Candle,
  ClosedTrade,
  OrderbookLevel,
  PipelineCycle,
  PipelineStage,
  Position,
} from '../engine/types';
import { MarketMiniChart } from './MarketMiniChart';
import { OrderbookAndLedgerTab, OrderExecutionDesk } from './OrderExecutionPanel';

interface PipelineDrawerProps {
  open: boolean;
  onToggleOpen: () => void;
  candles: Candle[];
  cycle: PipelineCycle | null;
  activeStage: PipelineStage;
  selectedAgentId: AgentId | null;
  onSelectAgent: (id: AgentId) => void;
  activePosition: Position | null;
  currentPrice: number;
  bestBid: number | null;
  bestAsk: number | null;
  orderbookBids: OrderbookLevel[];
  orderbookAsks: OrderbookLevel[];
  orderbookImbalance: number;
  liveTrades: ClosedTrade[];
  isUsingLiveStream: boolean;
  onOpenOrder: (side: 'LONG' | 'SHORT') => void;
  onClosePosition: (closeRatio: 0.5 | 1) => void;
}

const STAGE_LABELS: Array<{ stage: PipelineStage; agentId: AgentId; step: string }> = [
  { stage: 'INGEST_MARKET', agentId: 'macro_scout', step: '01' },
  { stage: 'QUANT_CONFLUENCE', agentId: 'quant_analyst', step: '02' },
  { stage: 'ORDERFLOW_SCAN', agentId: 'orderflow_radar', step: '03' },
  { stage: 'RISK_VETO_GATE', agentId: 'risk_guardian', step: '04' },
  { stage: 'EXECUTION_SYNC', agentId: 'execution_commander', step: '05' },
];

function directionTextColor(dir: string): string {
  if (dir === 'LONG') return 'text-emerald-400';
  if (dir === 'SHORT' || dir === 'VETO') return 'text-rose-400';
  return 'text-slate-400';
}

function directionLabel(dir: string): string {
  if (dir === 'LONG') return 'MUA (LONG)';
  if (dir === 'SHORT') return 'BÁN (SHORT)';
  if (dir === 'VETO') return 'CHẶN (VETO)';
  return 'QUAN SÁT';
}

export function PipelineDrawer({
  open,
  onToggleOpen,
  candles,
  cycle,
  activeStage,
  selectedAgentId,
  onSelectAgent,
  activePosition,
  currentPrice,
  bestBid,
  bestAsk,
  orderbookBids,
  orderbookAsks,
  orderbookImbalance,
  liveTrades,
  isUsingLiveStream,
  onOpenOrder,
  onClosePosition,
}: PipelineDrawerProps) {
  const [drawerTab, setDrawerTab] = useState<'council' | 'orders'>('council');

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggleOpen}
        aria-label="Mở bảng Hội đồng Agent & Lệnh"
        className="fixed top-28 md:top-16 right-4 z-20 px-3 py-2 bg-[#0C121E]/95 border border-white/12 rounded-lg text-xs font-medium text-slate-200 hover:text-white flex items-center gap-2 cursor-pointer shadow-lg"
      >
        <PanelRightOpen className="w-4 h-4 text-amber-400" aria-hidden="true" />
        <span>
          {activePosition
            ? `${activePosition.side} · ${activePosition.unrealizedPnl + activePosition.realizedPartialPnl >= 0 ? '+' : ''}$${(activePosition.unrealizedPnl + activePosition.realizedPartialPnl).toFixed(0)}`
            : 'Hội đồng & Lệnh'}
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Bảng điều phối Hội đồng Agents và Đặt lệnh"
      className="fixed top-28 md:top-16 right-4 bottom-3 md:bottom-24 w-[376px] max-w-[calc(100vw-2rem)] bg-[#0C121E] border border-white/12 rounded-xl z-30 flex flex-col overflow-hidden shadow-2xl"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3 shrink-0">
        <div>
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Hội đồng Agents &amp; Thực thi Lệnh
          </h2>
          <p className="text-xs text-slate-400 tabular-nums">
            {cycle ? `${cycle.regime} · Đồng thuận ${cycle.consensusScore}/100` : 'Đang đồng bộ chu kỳ...'}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleOpen}
          aria-label="Thu gọn bảng Agent"
          className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/5 transition-colors cursor-pointer"
        >
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Mini Candlestick & Entry/SL/TP1/TP2 Chart */}
        <MarketMiniChart candles={candles} activePosition={activePosition} />

        {/* Prestigious Buy/Sell & Active Position Management Desk */}
        <OrderExecutionDesk
          activePosition={activePosition}
          cycle={cycle}
          currentPrice={currentPrice}
          onOpenOrder={onOpenOrder}
          onClosePosition={onClosePosition}
        />

        {/* Segmented Switch: 5 Agents Council | Orderbook & Session Ledger */}
        <div className="pt-3 border-t border-white/10 space-y-3">
          <div
            role="tablist"
            aria-label="Chế độ xem Hội đồng và Sổ lệnh"
            className="grid grid-cols-2 gap-1 bg-[#070B12] p-1 rounded-lg border border-white/10"
          >
            <button
              type="button"
              role="tab"
              aria-selected={drawerTab === 'council'}
              onClick={() => setDrawerTab('council')}
              className={`py-1.5 px-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                drawerTab === 'council'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Hội đồng 5 Agents
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={drawerTab === 'orders'}
              onClick={() => setDrawerTab('orders')}
              data-testid="tab-orderbook-ledger"
              className={`py-1.5 px-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                drawerTab === 'orders'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sổ Lệnh &amp; Khớp
            </button>
          </div>

          {drawerTab === 'council' ? (
            <div className="space-y-3">
              {cycle?.debate && (
                <div
                  data-testid="drawer-debate-summary"
                  className="pt-1 pb-2.5 border-b border-white/10 space-y-1.5"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-200">Phiên Phản biện Chéo</span>
                    <span className="font-mono tabular-nums text-slate-300">
                      Trước {cycle.debate.preDebateScore} →{' '}
                      <span
                        className={
                          cycle.debate.scoreDelta > 0
                            ? 'text-emerald-400 font-semibold'
                            : cycle.debate.scoreDelta < 0
                              ? 'text-rose-400 font-semibold'
                              : 'text-amber-400 font-semibold'
                        }
                      >
                        {cycle.debate.postDebateScore}đ
                      </span>
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    {cycle.debate.verdict}
                  </p>
                  <div className="divide-y divide-white/6">
                    {cycle.debate.turns.slice(0, 3).map((turn) => (
                      <div
                        key={turn.id}
                        className="py-1.5 flex items-baseline justify-between gap-2 text-[11px]"
                      >
                        <span className="text-slate-300 truncate">{turn.title}</span>
                        <span
                          className={`font-mono font-semibold tabular-nums whitespace-nowrap shrink-0 ${
                            turn.stance === 'SUPPORT'
                              ? 'text-emerald-400'
                              : turn.stance === 'VETO_TRIGGER'
                                ? 'text-rose-400'
                                : 'text-amber-400'
                          }`}
                        >
                          {turn.stance === 'SUPPORT'
                            ? 'Ủng hộ'
                            : turn.stance === 'VETO_TRIGGER'
                              ? 'Chặn'
                              : 'Phản đối'}{' '}
                          {turn.impactScore >= 0 ? `+${turn.impactScore}` : turn.impactScore}đ
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Luồng cộng tác 5 Agents</span>
                <span>Nhấn để soi 3D</span>
              </div>

              <div className="divide-y divide-white/8">
                {STAGE_LABELS.map(({ stage, agentId, step }) => {
                  const sig = cycle?.signals[agentId];
                  const isStageActive = activeStage === stage;
                  const isSelected = selectedAgentId === agentId;
                  return (
                    <button
                      key={agentId}
                      type="button"
                      onClick={() => onSelectAgent(agentId)}
                      className={`w-full text-left py-2.5 px-2.5 rounded-lg transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-amber-500/12'
                          : isStageActive
                            ? 'bg-white/5'
                            : 'hover:bg-white/4'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-slate-100 whitespace-nowrap">
                          {step} · {sig?.name ?? agentId}
                        </span>
                        <span
                          className={`font-mono font-semibold tabular-nums whitespace-nowrap ${directionTextColor(
                            sig?.direction ?? 'NEUTRAL',
                          )}`}
                        >
                          {directionLabel(sig?.direction ?? 'NEUTRAL')} · {sig?.confidence ?? 50}%
                        </span>
                      </div>

                      {sig && (
                        <>
                          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                            {sig.summary}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono tabular-nums text-slate-300">
                            {sig.metrics.map((m, mIdx) => (
                              <span key={m.label}>
                                {mIdx > 0 && <span className="text-slate-600 mr-2">·</span>}
                                <span className="text-slate-500">{m.label}: </span>
                                <span>{m.value}</span>
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <OrderbookAndLedgerTab
              bestBid={bestBid}
              bestAsk={bestAsk}
              orderbookBids={orderbookBids}
              orderbookAsks={orderbookAsks}
              orderbookImbalance={orderbookImbalance}
              liveTrades={liveTrades}
              isUsingLiveStream={isUsingLiveStream}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
