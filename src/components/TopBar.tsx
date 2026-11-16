import type { ReactNode } from 'react';

export type WorkspaceTab = 'war_room_3d' | 'pipeline_az' | 'backtest_journal' | 'strategy_config';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  botRunning: boolean;
  onToggleBot: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'war_room_3d', label: 'Mô phỏng 3D' },
  { id: 'pipeline_az', label: 'Quy trình A–Z' },
  { id: 'backtest_journal', label: 'Lịch sử & Backtest' },
  { id: 'strategy_config', label: 'Cấu hình' },
];

export function TopBar({
  activeTab,
  onSelectTab,
  botRunning,
  onToggleBot,
}: TopBarProps): ReactNode {
  return (
    <header className="h-14 w-full bg-[#0A0F1A] border-b border-white/10 px-6 flex items-center justify-between gap-8 shrink-0 z-30">
      {/* Zone 1: Single-line brand wordmark */}
      <button
        type="button"
        onClick={() => onSelectTab('war_room_3d')}
        className="font-display text-lg font-bold tracking-tight text-slate-50 hover:text-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        AegisBTC Quant
      </button>

      {/* Zone 2: 4 clean single-line text navigation links */}
      <nav aria-label="Điều hướng chính" className="hidden md:flex items-center gap-6">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`py-1.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 ${
                isActive
                  ? 'text-amber-400 border-amber-400'
                  : 'text-slate-400 border-transparent hover:text-slate-100'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 primary CTA button */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onToggleBot}
          className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            botRunning
              ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
              : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
          }`}
        >
          {botRunning ? 'Tạm dừng Bot' : 'Chạy Auto-Bot'}
        </button>
      </div>
    </header>
  );
}
