import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_STRATEGY_CONFIG,
  normalizeAgentWeights,
  STRATEGY_PRESETS,
} from '../engine/multiAgentEngine';
import type { StrategyConfig } from '../engine/types';

interface StrategyConfigViewProps {
  config: StrategyConfig;
  onUpdateConfig: (next: StrategyConfig) => void;
}

export function StrategyConfigView({
  config,
  onUpdateConfig,
}: StrategyConfigViewProps) {
  const updateField = <K extends keyof StrategyConfig>(key: K, val: StrategyConfig[K]) => {
    onUpdateConfig({ ...config, [key]: val });
  };

  const updateWeight = (
    agent: keyof StrategyConfig['agentWeights'],
    val: number,
  ) => {
    onUpdateConfig({
      ...config,
      agentWeights: {
        ...config.agentWeights,
        [agent]: val,
      },
    });
  };

  const normalizedShares = normalizeAgentWeights(config.agentWeights);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <p className="text-xs font-medium text-amber-400 mb-1">
            Tham số Quản trị Rủi ro &amp; Hội đồng Agents
          </p>
          <h1 className="font-display text-2xl md:text-3xl font-bold text-slate-50">
            Cấu hình Chiến lược Tự động
          </h1>
          <p className="text-sm text-slate-400 mt-1.5">
            Mọi điều chỉnh được áp dụng trực tiếp vào luồng khớp lệnh 3D và bộ kiểm thử Backtest.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onUpdateConfig(DEFAULT_STRATEGY_CONFIG)}
          className="px-3.5 py-2 bg-[#111827] hover:bg-slate-800 border border-white/12 text-xs font-medium text-slate-200 rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap self-start sm:self-auto"
        >
          <RotateCcw className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          <span>Khôi phục Chuẩn Quỹ</span>
        </button>
      </div>

      {/* Institutional Presets Bar */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {STRATEGY_PRESETS.map((preset) => {
          const isMatched =
            config.riskPerTradePct === preset.config.riskPerTradePct &&
            config.minConsensusScore === preset.config.minConsensusScore &&
            config.maxLeverage === preset.config.maxLeverage;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onUpdateConfig({ ...config, ...preset.config })}
              className={`text-left px-4 py-3 rounded-xl border transition-colors cursor-pointer ${
                isMatched
                  ? 'bg-amber-500/12 border-amber-400/60'
                  : 'bg-[#0C121E] border-white/10 hover:border-white/25'
              }`}
            >
              <span className="text-sm font-semibold text-slate-100 block">{preset.name}</span>
              <span className="text-xs text-slate-400 font-mono tabular-nums mt-0.5 block">
                {preset.subtitle}
              </span>
            </button>
          );
        })}
      </div>

      {/* Capital & Risk Controls */}
      <div className="bg-[#0C121E] border border-white/10 rounded-xl p-6 space-y-6">
        <h2 className="font-display text-base font-semibold text-slate-100 border-b border-white/8 pb-3">
          Quản trị Vốn &amp; Kỷ luật Risk Guardian
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label
              htmlFor="cfg-capital"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Vốn Khởi tạo (USD)</span>
              <span className="font-mono tabular-nums text-amber-400">
                ${config.initialCapital.toLocaleString('en-US')}
              </span>
            </label>
            <input
              id="cfg-capital"
              type="number"
              min={1000}
              max={10000000}
              step={5000}
              value={config.initialCapital}
              onChange={(e) =>
                updateField('initialCapital', Math.max(1000, Number(e.target.value) || 10000))
              }
              className="w-full bg-[#070B12] border border-white/12 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-amber-400"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-risk-pct"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Rủi ro Tối đa / Lệnh (Half-Kelly Cap)</span>
              <span className="font-mono tabular-nums text-amber-400">
                {config.riskPerTradePct}%
              </span>
            </label>
            <input
              id="cfg-risk-pct"
              type="range"
              min={0.5}
              max={3.0}
              step={0.25}
              value={config.riskPerTradePct}
              onChange={(e) => updateField('riskPerTradePct', Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-consensus"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Ngưỡng Đồng thuận Tối thiểu (0–100)</span>
              <span className="font-mono tabular-nums text-amber-400">
                {config.minConsensusScore}/100
              </span>
            </label>
            <input
              id="cfg-consensus"
              type="range"
              min={58}
              max={88}
              step={2}
              value={config.minConsensusScore}
              onChange={(e) => updateField('minConsensusScore', Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-min-rr"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Tỷ lệ Risk : Reward Tối thiểu</span>
              <span className="font-mono tabular-nums text-amber-400">
                1 : {config.minRewardRisk}
              </span>
            </label>
            <input
              id="cfg-min-rr"
              type="range"
              min={1.6}
              max={3.5}
              step={0.1}
              value={config.minRewardRisk}
              onChange={(e) => updateField('minRewardRisk', Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-leverage"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Đòn bẩy Trần (Max Leverage)</span>
              <span className="font-mono tabular-nums text-amber-400">
                {config.maxLeverage}x
              </span>
            </label>
            <input
              id="cfg-leverage"
              type="range"
              min={1}
              max={5}
              step={0.5}
              value={config.maxLeverage}
              onChange={(e) => updateField('maxLeverage', Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>
        </div>

        {/* Protection Toggles */}
        <div className="pt-4 border-t border-white/8 grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={config.autoExecute}
              onChange={(e) => updateField('autoExecute', e.target.checked)}
              className="mt-0.5 accent-amber-500"
            />
            <span>
              <strong className="block font-medium">Tự động Khớp lệnh</strong>
              <span className="text-slate-400">Cho phép Execution Commander mở vị thế khi đạt chuẩn.</span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={config.useBreakEvenAfterTp1}
              onChange={(e) => updateField('useBreakEvenAfterTp1', e.target.checked)}
              className="mt-0.5 accent-amber-500"
            />
            <span>
              <strong className="block font-medium">Dời SL Hòa vốn sau TP1</strong>
              <span className="text-slate-400">Khóa 50% lãi tại TP1 và kéo Stop về điểm vào lệnh.</span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={config.vetoChoppyMarket}
              onChange={(e) => updateField('vetoChoppyMarket', e.target.checked)}
              className="mt-0.5 accent-amber-500"
            />
            <span>
              <strong className="block font-medium">VETO Vùng Sideway Nhiễu</strong>
              <span className="text-slate-400">Cấm vào lệnh khi ADX và biến động xuống dưới ngưỡng.</span>
            </span>
          </label>
        </div>
      </div>

      {/* Agent Weight Matrix */}
      <div className="bg-[#0C121E] border border-white/10 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Trọng số Biểu quyết của Đội Agents Phân tích
          </h2>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            Tỷ trọng chuẩn hóa: {normalizedShares.macro_scout}% / {normalizedShares.quant_analyst}% /{' '}
            {normalizedShares.orderflow_radar}%
          </span>
        </div>

        {/* Visual Normalized Share Bar */}
        <div className="h-2 w-full rounded-full overflow-hidden flex bg-slate-800">
          <div
            className="bg-sky-400 h-full transition-all"
            style={{ width: `${normalizedShares.macro_scout}%` }}
            title={`Vĩ mô ${normalizedShares.macro_scout}%`}
          />
          <div
            className="bg-indigo-400 h-full transition-all"
            style={{ width: `${normalizedShares.quant_analyst}%` }}
            title={`Định lượng ${normalizedShares.quant_analyst}%`}
          />
          <div
            className="bg-teal-400 h-full transition-all"
            style={{ width: `${normalizedShares.orderflow_radar}%` }}
            title={`Sổ lệnh ${normalizedShares.orderflow_radar}%`}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label
              htmlFor="w-macro"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Trinh sát Vĩ mô</span>
              <span className="font-mono tabular-nums text-sky-400">
                {(config.agentWeights.macro_scout * 100).toFixed(0)}%
              </span>
            </label>
            <input
              id="w-macro"
              type="range"
              min={0.1}
              max={0.6}
              step={0.05}
              value={config.agentWeights.macro_scout}
              onChange={(e) => updateWeight('macro_scout', Number(e.target.value))}
              className="w-full accent-sky-400 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor="w-quant"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Chuyên gia Định lượng</span>
              <span className="font-mono tabular-nums text-indigo-400">
                {(config.agentWeights.quant_analyst * 100).toFixed(0)}%
              </span>
            </label>
            <input
              id="w-quant"
              type="range"
              min={0.1}
              max={0.7}
              step={0.05}
              value={config.agentWeights.quant_analyst}
              onChange={(e) => updateWeight('quant_analyst', Number(e.target.value))}
              className="w-full accent-indigo-400 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor="w-orderflow"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Radar Sổ lệnh</span>
              <span className="font-mono tabular-nums text-teal-400">
                {(config.agentWeights.orderflow_radar * 100).toFixed(0)}%
              </span>
            </label>
            <input
              id="w-orderflow"
              type="range"
              min={0.1}
              max={0.6}
              step={0.05}
              value={config.agentWeights.orderflow_radar}
              onChange={(e) => updateWeight('orderflow_radar', Number(e.target.value))}
              className="w-full accent-teal-400 cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
