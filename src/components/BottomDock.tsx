import { ChevronDown, ChevronUp, Play, Eye } from 'lucide-react';
import type { MarketScenario } from '../engine/types';
import type { CameraPreset } from '../three/AgentWarRoomScene';

interface BottomDockProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  activePreset: CameraPreset;
  onSelectPreset: (preset: CameraPreset) => void;
  simSpeed: number;
  onChangeSpeed: (speed: number) => void;
  scenario: MarketScenario;
  onChangeScenario: (scenario: MarketScenario) => void;
  onTriggerScan: () => void;
}

const CAMERA_PRESETS: Array<{ id: CameraPreset; label: string }> = [
  { id: 'overview', label: 'Toàn cảnh' },
  { id: 'btc_core', label: 'Lõi BTC' },
  { id: 'risk_desk', label: 'Khiên Risk' },
];

const SCENARIOS: Array<{ id: MarketScenario; label: string }> = [
  { id: 'auto_live', label: 'Thị trường Thực' },
  { id: 'bull_breakout', label: 'Bứt phá Tăng' },
  { id: 'liquidity_sweep', label: 'Quét Thanh khoản' },
  { id: 'choppy_range', label: 'Sideway Nhiễu' },
];

export function BottomDock({
  collapsed,
  onToggleCollapse,
  activePreset,
  onSelectPreset,
  simSpeed,
  onChangeSpeed,
  scenario,
  onChangeScenario,
  onTriggerScan,
}: BottomDockProps) {
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center pointer-events-none"
      style={{ maxWidth: 'min(980px, 95vw)' }}
    >
      {/* Collapse / Expand tab attached to top edge of dock */}
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        className="pointer-events-auto mb-1.5 px-3 py-1 bg-[#0E1525]/95 border border-white/12 rounded-t-lg text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
      >
        {collapsed ? (
          <>
            <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
            <span>Hiện điều khiển 3D (H)</span>
          </>
        ) : (
          <>
            <ChevronDown className="w-3.5 h-3.5 text-amber-400" />
            <span>Ẩn điều khiển (H)</span>
          </>
        )}
      </button>

      {!collapsed && (
        <div className="pointer-events-auto bg-[#0C121E]/95 border border-white/12 rounded-xl px-3.5 py-2 shadow-2xl flex flex-wrap md:flex-nowrap items-center justify-center gap-2.5 md:gap-3">
          {/* Camera Presets */}
          <div className="flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5 text-slate-400 mr-1" aria-hidden="true" />
            <div className="flex items-center gap-1 bg-[#070B12] p-1 rounded-lg border border-white/8">
              {CAMERA_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelectPreset(p.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    activePreset === p.id
                      ? 'bg-amber-500 text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="h-5 w-px bg-white/10 hidden sm:block" aria-hidden="true" />

          {/* Simulation Speed */}
          <div className="flex items-center gap-1 bg-[#070B12] p-1 rounded-lg border border-white/8">
            {[1, 2, 4].map((spd) => (
              <button
                key={spd}
                type="button"
                onClick={() => onChangeSpeed(spd)}
                className={`px-2 py-1 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  simSpeed === spd
                    ? 'bg-slate-700 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-white/10 hidden sm:block" aria-hidden="true" />

          {/* Market Regime / Scenario Selector */}
          <div className="flex items-center gap-2">
            <label htmlFor="market-scenario-select" className="text-xs text-slate-400 whitespace-nowrap">
              Kịch bản:
            </label>
            <select
              id="market-scenario-select"
              value={scenario}
              onChange={(e) => onChangeScenario(e.target.value as MarketScenario)}
              className="bg-[#070B12] border border-white/12 text-slate-100 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-amber-400 cursor-pointer"
            >
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* Immediate Trigger */}
          <button
            type="button"
            onClick={onTriggerScan}
            className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Quét Chu kỳ Mới</span>
          </button>
        </div>
      )}
    </div>
  );
}
