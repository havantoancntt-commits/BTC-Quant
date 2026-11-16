import { Lock, OctagonAlert, RefreshCw, RotateCcw } from 'lucide-react';
import {
  DEFAULT_STRATEGY_CONFIG,
  normalizeAgentWeights,
  STRATEGY_PRESETS,
} from '../engine/multiAgentEngine';
import type {
  ExecutionMode,
  HealthDependencyEntry,
  MarketVenue,
  PaperReconciliationReport,
  RiskAccountState,
  StrategyConfig,
} from '../engine/types';

export interface CredentialsStatus {
  testnetSpotConfigured: boolean;
  testnetFuturesConfigured: boolean;
  liveTradingAllowedByEnv: boolean;
  liveCredentialsConfigured: boolean;
  geminiConfigured: boolean;
}

export interface SystemLogItem {
  id: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SECURITY';
  category: string;
  message: string;
  createdAt: number;
}

interface StrategyConfigViewProps {
  config: StrategyConfig;
  onUpdateConfig: (next: StrategyConfig) => void;
  accountState: RiskAccountState;
  credentials: CredentialsStatus | null;
  healthDependencies?: Record<string, HealthDependencyEntry> | null;
  reconciliation?: PaperReconciliationReport | null;
  systemLogs: SystemLogItem[];
  onToggleEmergencyStop: () => void;
  onResetSession: () => void;
}

export function StrategyConfigView({
  config,
  onUpdateConfig,
  accountState,
  credentials,
  healthDependencies,
  reconciliation,
  systemLogs,
  onToggleEmergencyStop,
  onResetSession,
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
  const effectiveMaxLev = config.marketVenue === 'BINANCE_SPOT' ? 1 : config.maxLeverage;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-7">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <p className="text-xs font-medium text-amber-400 mb-1">
            Kiến trúc Thực thi, Bảo vệ Tài khoản &amp; Persistence SQLite
          </p>
          <h1 className="font-display text-2xl md:text-3xl font-bold text-slate-50">
            Cấu hình Chiến lược &amp; Sàn Giao dịch
          </h1>
          <p className="text-sm text-slate-400 mt-1.5">
            Tất cả thông số được kiểm tra, đồng bộ backend và lưu bền vững qua SQLite. API Keys chỉ tồn tại ở biến môi trường server.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToggleEmergencyStop}
            data-testid="config-kill-switch-btn"
            className={`px-3.5 py-2 border text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
              accountState.emergencyStopActive
                ? 'bg-rose-600 text-white border-rose-400'
                : 'bg-[#111827] text-rose-300 border-rose-500/35 hover:border-rose-400'
            }`}
          >
            <OctagonAlert className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{accountState.emergencyStopActive ? 'Gỡ Kill Switch' : 'Kill Switch'}</span>
          </button>
          <button
            type="button"
            onClick={onResetSession}
            className="px-3.5 py-2 bg-[#111827] hover:bg-slate-800 border border-white/12 text-xs font-medium text-slate-200 rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
            <span>Reset Phiên</span>
          </button>
          <button
            type="button"
            onClick={() => onUpdateConfig(DEFAULT_STRATEGY_CONFIG)}
            className="px-3.5 py-2 bg-[#111827] hover:bg-slate-800 border border-white/12 text-xs font-medium text-slate-200 rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            <span>Chuẩn Quỹ</span>
          </button>
        </div>
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

      {/* Venue & Execution Mode */}
      <div className="bg-[#0C121E] border border-white/10 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Nguồn Dữ liệu Sàn (Spot / Futures) &amp; Chế độ Khớp lệnh
          </h2>
          <span className="text-xs font-mono text-slate-400">
            Đòn bẩy hiệu dụng: {effectiveMaxLev}x ({config.marketVenue === 'BINANCE_SPOT' ? 'Spot khóa 1x' : 'USDⓈ-M Futures'})
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div>
            <label htmlFor="cfg-venue" className="text-xs font-medium text-slate-300 block mb-2">
              Thị trường Dữ liệu (Tách biệt Spot/Futures)
            </label>
            <select
              id="cfg-venue"
              data-testid="config-venue-select"
              value={config.marketVenue}
              onChange={(e) => updateField('marketVenue', e.target.value as MarketVenue)}
              className="w-full bg-[#070B12] border border-white/12 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-400 cursor-pointer"
            >
              <option value="BINANCE_SPOT">BINANCE_SPOT (Không Funding / 1x)</option>
              <option value="BINANCE_FUTURES">BINANCE_FUTURES (Mark/Index/OI/Funding)</option>
            </select>
          </div>

          <div>
            <label htmlFor="cfg-exec-mode" className="text-xs font-medium text-slate-300 block mb-2">
              Tầng Thực thi Lệnh (Staged Execution)
            </label>
            <select
              id="cfg-exec-mode"
              data-testid="config-exec-mode-select"
              value={config.executionMode}
              onChange={(e) => updateField('executionMode', e.target.value as ExecutionMode)}
              className="w-full bg-[#070B12] border border-white/12 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-400 cursor-pointer"
            >
              <option value="SIMULATION">SIMULATION (Mô phỏng cục bộ)</option>
              <option value="PAPER">PAPER (Giá sàn thực · Sổ lệnh giả lập)</option>
              <option value="TESTNET">TESTNET (Binance Testnet API đã ký HMAC)</option>
              <option value="LIVE" disabled={!credentials?.liveTradingAllowedByEnv}>
                LIVE (Khóa an toàn mặc định {credentials?.liveTradingAllowedByEnv ? '· Đã mở Env' : '· Disabled'})
              </option>
            </select>
          </div>

          <div>
            <label htmlFor="cfg-sizing" className="text-xs font-medium text-slate-300 block mb-2">
              Phương pháp Tính Cỡ Lệnh
            </label>
            <select
              id="cfg-sizing"
              value={config.sizingMethod}
              onChange={(e) =>
                updateField('sizingMethod', e.target.value as StrategyConfig['sizingMethod'])
              }
              className="w-full bg-[#070B12] border border-white/12 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-400 cursor-pointer"
            >
              <option value="FIXED_FRACTIONAL">FIXED_FRACTIONAL (Chuẩn bảo toàn vốn)</option>
              <option value="HALF_KELLY">HALF_KELLY (Có trần cap Risk %)</option>
            </select>
          </div>
        </div>

        {/* Credentials Status Read-Only Telemetry (Zero Secret Exposure) */}
        <div className="p-3 rounded-lg bg-[#070B12] border border-white/8 flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono">
          <span className="flex items-center gap-1.5 text-slate-400">
            <Lock className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            <span>Trạng thái ENV Backend (Không lộ khóa ra Frontend):</span>
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <span className={credentials?.testnetSpotConfigured ? 'text-emerald-400' : 'text-slate-500'}>
              Testnet Spot: {credentials?.testnetSpotConfigured ? 'READY' : 'UNCONFIGURED'}
            </span>
            <span className={credentials?.testnetFuturesConfigured ? 'text-emerald-400' : 'text-slate-500'}>
              Testnet Futures: {credentials?.testnetFuturesConfigured ? 'READY' : 'UNCONFIGURED'}
            </span>
            <span className={credentials?.geminiConfigured ? 'text-emerald-400' : 'text-slate-500'}>
              Gemini AI: {credentials?.geminiConfigured ? 'READY' : 'OPTIONAL/OFF'}
            </span>
            <span className={credentials?.liveTradingAllowedByEnv ? 'text-amber-400' : 'text-rose-400'}>
              LIVE GATE: {credentials?.liveTradingAllowedByEnv ? 'ENV_ENABLED' : 'LOCKED'}
            </span>
          </div>
        </div>
      </div>

      {/* Capital & Institutional Risk Controls */}
      <div className="bg-[#0C121E] border border-white/10 rounded-xl p-6 space-y-6">
        <h2 className="font-display text-base font-semibold text-slate-100 border-b border-white/8 pb-3">
          Quản trị Vốn &amp; Circuit Breakers Risk Guardian
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
              <span>Rủi ro Tối đa / Lệnh</span>
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
              htmlFor="cfg-leverage"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Đòn bẩy Trần (Futures)</span>
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

          <div>
            <label
              htmlFor="cfg-consensus"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Ngưỡng Đồng thuận</span>
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
              <span>Tỷ lệ R:R Tối thiểu</span>
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
              htmlFor="cfg-daily-loss"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Giới hạn Lỗ Ngày / MaxDD</span>
              <span className="font-mono tabular-nums text-rose-400">
                -{config.maxDailyLossPct}% / -{config.maxDrawdownPct}%
              </span>
            </label>
            <input
              id="cfg-daily-loss"
              type="range"
              min={1}
              max={10}
              step={0.5}
              value={config.maxDailyLossPct}
              onChange={(e) => updateField('maxDailyLossPct', Number(e.target.value))}
              className="w-full accent-rose-500 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-max-dd"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Ngắt Mạch Max Drawdown</span>
              <span className="font-mono tabular-nums text-rose-400">
                -{config.maxDrawdownPct}%
              </span>
            </label>
            <input
              id="cfg-max-dd"
              type="range"
              min={4}
              max={25}
              step={1}
              value={config.maxDrawdownPct}
              onChange={(e) => updateField('maxDrawdownPct', Number(e.target.value))}
              className="w-full accent-rose-500 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-consec-loss"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Chuỗi Thua Cooldown ({config.cooldownMinutesAfterLoss}p)</span>
              <span className="font-mono tabular-nums text-amber-400">
                {config.maxConsecutiveLosses} lệnh
              </span>
            </label>
            <input
              id="cfg-consec-loss"
              type="range"
              min={2}
              max={6}
              step={1}
              value={config.maxConsecutiveLosses}
              onChange={(e) => updateField('maxConsecutiveLosses', Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-spread"
              className="flex items-center justify-between text-xs font-medium text-slate-300 mb-2"
            >
              <span>Spread Trần (bps)</span>
              <span className="font-mono tabular-nums text-slate-200">
                {config.maxSpreadBps} bps
              </span>
            </label>
            <input
              id="cfg-spread"
              type="range"
              min={5}
              max={50}
              step={1}
              value={config.maxSpreadBps}
              onChange={(e) => updateField('maxSpreadBps', Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>
        </div>

        {/* Protection Toggles */}
        <div className="pt-4 border-t border-white/8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={config.autoExecute}
              onChange={(e) => updateField('autoExecute', e.target.checked)}
              className="mt-0.5 accent-amber-500"
            />
            <span>
              <strong className="block font-medium">Tự động Khớp lệnh</strong>
              <span className="text-slate-400">Cho phép Auto-Bot vào lệnh khi đạt chuẩn.</span>
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
              <span className="text-slate-400">Chốt 50% tại TP1 và kéo Stop về Entry.</span>
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
              <span className="text-slate-400">Cấm mở lệnh khi ADX và độ nén kém.</span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={config.requireClosedCandle}
              onChange={(e) => updateField('requireClosedCandle', e.target.checked)}
              className="mt-0.5 accent-amber-500"
            />
            <span>
              <strong className="block font-medium">Chờ Nến Đóng Cửa</strong>
              <span className="text-slate-400">Không mở lệnh mới trên nến M15 chưa đóng.</span>
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

        <div className="h-2 w-full rounded-full overflow-hidden flex bg-slate-800">
          <div
            className="bg-sky-400 h-full transition-all"
            style={{ width: `${normalizedShares.macro_scout}%` }}
          />
          <div
            className="bg-indigo-400 h-full transition-all"
            style={{ width: `${normalizedShares.quant_analyst}%` }}
          />
          <div
            className="bg-teal-400 h-full transition-all"
            style={{ width: `${normalizedShares.orderflow_radar}%` }}
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

      {/* Dependency Health Matrix (/api/health) */}
      {healthDependencies && (
        <div
          data-testid="dependency-health-matrix"
          className="bg-[#0C121E] border border-white/10 rounded-xl p-6 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Ma trận Sức khỏe Hệ thống &amp; Phụ thuộc (/api/health)
            </h2>
            {reconciliation && (
              <span
                className={`text-xs font-mono tabular-nums ${
                  reconciliation.consistent ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                Ledger Reconciliation: {reconciliation.consistent ? 'CONSISTENT' : 'MISMATCH'} ($
                {reconciliation.availableBalanceUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} khả dụng)
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
            {Object.entries(healthDependencies).map(([key, entry]) => (
              <div
                key={key}
                className="p-3 rounded-lg bg-[#070B12] border border-white/8 space-y-1"
              >
                <div className="flex items-center justify-between gap-2 font-mono">
                  <span className="text-slate-300 truncate">{key}</span>
                  <span
                    className={`font-semibold shrink-0 ${
                      entry.status === 'HEALTHY'
                        ? 'text-emerald-400'
                        : entry.status === 'DOWN'
                          ? 'text-rose-400'
                          : entry.status === 'DEGRADED'
                            ? 'text-amber-400'
                            : 'text-slate-400'
                    }`}
                  >
                    {entry.status}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-snug">{entry.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Risk Account State & Persisted Audit Logs */}
      <div className="bg-[#0C121E] border border-white/10 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Trạng thái Tài khoản Rủi ro &amp; Nhật ký Hệ thống (SQLite)
          </h2>
          <span className="font-mono text-xs tabular-nums text-slate-400">
            Daily PnL: {accountState.dailyPnlUsd >= 0 ? '+' : ''}${accountState.dailyPnlUsd.toFixed(2)} ·
            Weekly PnL: {accountState.weeklyPnlUsd >= 0 ? '+' : ''}${accountState.weeklyPnlUsd.toFixed(2)} ·
            Chuỗi thua: {accountState.consecutiveLosses}
          </span>
        </div>

        <div className="divide-y divide-white/8 text-xs font-mono max-h-56 overflow-y-auto">
          {systemLogs.length === 0 ? (
            <p className="text-slate-400 py-3 font-sans">Chưa có bản ghi kiểm toán hệ thống.</p>
          ) : (
            systemLogs.slice(0, 15).map((log) => (
              <div key={log.id} className="py-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={
                      log.level === 'SECURITY' || log.level === 'ERROR'
                        ? 'text-rose-400 font-semibold'
                        : log.level === 'WARN'
                          ? 'text-amber-400 font-semibold'
                          : 'text-sky-400'
                    }
                  >
                    [{log.level}]
                  </span>
                  <span className="text-slate-400">{log.category}</span>
                  <span className="text-slate-200 truncate font-sans">{log.message}</span>
                </div>
                <span className="text-slate-500 whitespace-nowrap tabular-nums">
                  {new Date(log.createdAt).toLocaleTimeString('vi-VN')}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
