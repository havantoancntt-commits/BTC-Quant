import { useMemo, useState, type ChangeEvent, type MouseEvent } from 'react';
import { AlertTriangle, Database, Download, Upload } from 'lucide-react';
import { formatTradesAsCsv } from '../engine/multiAgentEngine';
import {
  parseHistoricalCsv,
  runHistoricalBacktest,
  runSimulationBacktest,
} from '../engine/backtestEngine';
import type { BacktestReport, ClosedTrade, StrategyConfig, TimeframeKey } from '../engine/types';

interface BacktestJournalViewProps {
  config: StrategyConfig;
  liveTrades: ClosedTrade[];
  initialBacktest: BacktestReport;
}

type TradeFilter = 'ALL' | 'WIN' | 'LOSS' | 'LONG' | 'SHORT';

function formatUsd(val: number, decimals = 0): string {
  return val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function BacktestJournalView({
  config,
  liveTrades,
  initialBacktest,
}: BacktestJournalViewProps) {
  const [report, setReport] = useState<BacktestReport>(initialBacktest);
  const [simHorizon, setSimHorizon] = useState<number>(360);
  const [histInterval, setHistInterval] = useState<TimeframeKey>('15m');
  const [loadingHist, setLoadingHist] = useState<boolean>(false);
  const [histError, setHistError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TradeFilter>('ALL');
  const [sourceTab, setSourceTab] = useState<'backtest' | 'live'>('backtest');
  const [hoverCurveIdx, setHoverCurveIdx] = useState<number | null>(null);

  const handleRunSimulation = (count: number) => {
    setHistError(null);
    setSimHorizon(count);
    const next = runSimulationBacktest(config, count);
    setReport(next);
    setSourceTab('backtest');
  };

  const handleFetchBinanceHistorical = async () => {
    setLoadingHist(true);
    setHistError(null);
    try {
      const res = await fetch(
        `/api/historical-klines?venue=${encodeURIComponent(config.marketVenue)}&interval=${encodeURIComponent(histInterval)}&limit=1000`,
      );
      const data = await res.json();
      if (!res.ok || !data?.ok || !Array.isArray(data.candles) || data.candles.length < 80) {
        throw new Error(data?.error ?? 'Không tải đủ nến lịch sử từ sàn Binance.');
      }
      const next = runHistoricalBacktest({
        candles: data.candles,
        config,
        dataSourceLabel: `HISTORICAL DATA · ${config.marketVenue} ${histInterval} (${data.candles.length} nến thực)`,
        fundingRate: config.marketVenue === 'BINANCE_FUTURES' ? 0.0001 : 0,
      });
      setReport(next);
      setSourceTab('backtest');
    } catch (err) {
      setHistError(err instanceof Error ? err.message : 'Lỗi tải dữ liệu lịch sử.');
    } finally {
      setLoadingHist(false);
    }
  };

  const handleCsvUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setHistError(null);
    try {
      const text = await file.text();
      const parsed = parseHistoricalCsv(text);
      if (parsed.candles.length < 80) {
        setHistError(
          `CSV chỉ có ${parsed.candles.length} nến hợp lệ (cần tối thiểu 80 nến OHLCV). ${parsed.warnings.join(' ')}`,
        );
        return;
      }
      const next = runHistoricalBacktest({
        candles: parsed.candles,
        config,
        dataSourceLabel: `HISTORICAL CSV · ${file.name} (${parsed.candles.length} nến)`,
        fundingRate: config.marketVenue === 'BINANCE_FUTURES' ? 0.0001 : 0,
      });
      setReport(next);
      setSourceTab('backtest');
    } catch (err) {
      setHistError(err instanceof Error ? err.message : 'Không thể đọc tệp CSV.');
    } finally {
      e.target.value = '';
    }
  };

  const activeTrades = sourceTab === 'live' ? liveTrades : report.trades;

  const filteredTrades = useMemo(() => {
    return activeTrades.filter((t) => {
      if (filter === 'WIN') return t.outcome === 'WIN';
      if (filter === 'LOSS') return t.outcome === 'LOSS';
      if (filter === 'LONG') return t.side === 'LONG';
      if (filter === 'SHORT') return t.side === 'SHORT';
      return true;
    });
  }, [activeTrades, filter]);

  // Multi-Line SVG Curve: Strategy Equity + Buy & Hold + EMA21/50 Benchmark
  const equitySvg = useMemo(() => {
    const pts = report.equityCurve;
    if (pts.length < 2) return null;
    const allVals = pts.flatMap((p) => [p.equity, p.buyHoldEquity, p.benchmarkEquity ?? p.buyHoldEquity]);
    const minEq = Math.min(...allVals);
    const maxEq = Math.max(...allVals);
    const range = Math.max(maxEq - minEq, 1);
    const w = 880;
    const h = 220;
    const padX = 12;
    const padY = 16;

    const toCoords = (selector: (p: (typeof pts)[number]) => number) =>
      pts.map((p, idx) => {
        const x = padX + (idx / (pts.length - 1)) * (w - padX * 2);
        const y = padY + (1 - (selector(p) - minEq) / range) * (h - padY * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });

    const stratCoords = toCoords((p) => p.equity);
    const bhCoords = toCoords((p) => p.buyHoldEquity);
    const emaBenchCoords = toCoords((p) => p.benchmarkEquity ?? p.buyHoldEquity);
    const linePath = `M${stratCoords.join(' L')}`;
    const bhPath = `M${bhCoords.join(' L')}`;
    const emaBenchPath = `M${emaBenchCoords.join(' L')}`;
    const areaPath = `${linePath} L${(w - padX).toFixed(1)},${h - padY} L${padX},${h - padY} Z`;
    return { w, h, linePath, bhPath, emaBenchPath, areaPath, minEq, maxEq };
  }, [report.equityCurve]);

  const handleExportCsv = () => {
    const csv = formatTradesAsCsv(filteredTrades);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `aegisbtc-${sourceTab}-${report.mode.toLowerCase()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const hoveredCurvePoint =
    hoverCurveIdx !== null && hoverCurveIdx >= 0 && hoverCurveIdx < report.equityCurve.length
      ? report.equityCurve[hoverCurveIdx]
      : null;

  const totalCostsUsd =
    report.stats.totalFeesUsd + report.stats.totalFundingUsd + report.stats.totalSlippageUsd;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-7">
      {/* Header & Dual Mode Controls */}
      <div className="flex flex-col gap-4 border-b border-white/10 pb-6">
        <div className="max-w-3xl">
          <p className="text-xs font-medium text-amber-400 mb-1">
            Kiểm chứng Định lượng Độc lập: Mode A (Mô phỏng) &amp; Mode B (Lịch sử Thực)
          </p>
          <h1 className="font-display text-2xl md:text-3xl font-bold text-slate-50">
            Hiệu suất Backtest &amp; Nhật ký Giao dịch
          </h1>
          <p className="text-sm text-slate-400 mt-1.5">
            Backtest tuân thủ quy tắc nhân quả nghiêm ngặt (chỉ đọc nến quá khứ, SL ưu tiên trước TP khi nến trùng, có Phí + Trượt giá + Funding).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleRunSimulation(360)}
            data-testid="backtest-sim-360"
            className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
              report.isSimulatedData && simHorizon === 360
                ? 'bg-amber-500 text-slate-950'
                : 'bg-[#111827] text-slate-200 border border-white/12 hover:border-amber-400'
            }`}
          >
            Mode A: Mô phỏng 360 nến
          </button>
          <button
            type="button"
            onClick={() => handleRunSimulation(720)}
            className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
              report.isSimulatedData && simHorizon === 720
                ? 'bg-amber-500 text-slate-950'
                : 'bg-[#111827] text-slate-200 border border-white/12 hover:border-amber-400'
            }`}
          >
            Mode A: Mô phỏng 720 nến
          </button>

          <select
            aria-label="Khung thời gian dữ liệu lịch sử"
            value={histInterval}
            onChange={(e) => setHistInterval(e.target.value as TimeframeKey)}
            className="px-2.5 py-2 text-xs bg-[#111827] text-slate-200 border border-white/12 rounded-lg focus:outline-none focus:border-amber-400 cursor-pointer"
          >
            <option value="15m">15m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
          </select>

          <button
            type="button"
            onClick={handleFetchBinanceHistorical}
            disabled={loadingHist}
            data-testid="backtest-load-historical"
            className={`px-3 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50 ${
              !report.isSimulatedData
                ? 'bg-emerald-500 text-slate-950'
                : 'bg-[#111827] text-emerald-300 border border-emerald-500/35 hover:border-emerald-400'
            }`}
          >
            <Database className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{loadingHist ? 'Đang tải...' : 'Mode B: 1,000 nến Binance Thực'}</span>
          </button>

          <label className="px-3 py-2 text-xs font-medium rounded-lg bg-[#111827] text-slate-200 border border-white/12 hover:border-amber-400 flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
            <Upload className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
            <span>Nhập CSV</span>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={handleCsvUpload}
              className="sr-only"
              data-testid="backtest-csv-input"
            />
          </label>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredTrades.length === 0}
            className="px-3 py-2 text-xs font-medium rounded-lg bg-[#111827] text-slate-200 border border-white/12 hover:border-amber-400 disabled:opacity-40 flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            <span>Xuất CSV</span>
          </button>
        </div>
      </div>

      {/* Explicit Data Integrity Banner */}
      <div
        data-testid="backtest-mode-banner"
        className={`px-4 py-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs ${
          report.isSimulatedData
            ? 'bg-amber-500/10 border-amber-500/35 text-amber-200'
            : 'bg-emerald-500/10 border-emerald-500/35 text-emerald-200'
        }`}
      >
        <div className="flex items-start sm:items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
          <span>
            <strong className="font-mono mr-2">
              [{report.isSimulatedData ? 'SIMULATED DATA' : 'HISTORICAL DATA'}]
            </strong>
            {report.isSimulatedData
              ? 'Kết quả từ chuỗi mô phỏng tổng hợp để kiểm tra logic engine — KHÔNG phải bằng chứng hiệu quả thực chiến.'
              : `${report.dataSourceLabel} · Đã kiểm tra thứ tự thời gian & nhân quả (${report.duplicatesRemoved} trùng lặp đã lọc, ${report.gapsDetected} gap).`}
          </span>
        </div>
        {report.dateRange && (
          <span className="font-mono text-[11px] tabular-nums whitespace-nowrap opacity-85">
            {new Date(report.dateRange.startTime).toLocaleDateString('vi-VN')} →{' '}
            {new Date(report.dateRange.endTime).toLocaleDateString('vi-VN')}
          </span>
        )}
      </div>

      {histError && (
        <div role="alert" className="px-4 py-2.5 rounded-lg bg-rose-500/15 border border-rose-500/35 text-xs text-rose-200">
          {histError}
        </div>
      )}

      {report.validationWarnings.length > 0 && (
        <div className="px-4 py-2.5 rounded-lg bg-[#0C121E] border border-white/10 text-xs text-slate-300">
          <strong className="text-amber-400">Cảnh báo dữ liệu:</strong>{' '}
          {report.validationWarnings.join(' · ')}
        </div>
      )}

      {/* Institutional KPI Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 py-4 px-5 bg-[#0C121E] border border-white/10 rounded-xl font-mono tabular-nums">
        <div>
          <span className="font-sans text-[11px] text-slate-400 block">Vốn cuối / Lợi nhuận ròng</span>
          <span className="text-base font-bold text-slate-50 mt-1 block">
            ${formatUsd(report.stats.equity)}
          </span>
          <span className={`text-[11px] ${report.stats.netProfitUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {report.stats.netProfitUsd >= 0 ? '+' : ''}${formatUsd(report.stats.netProfitUsd)} ({report.stats.totalPnlPct}%)
          </span>
        </div>

        <div>
          <span className="font-sans text-[11px] text-slate-400 block">Buy &amp; Hold / Alpha</span>
          <span className="text-base font-bold text-slate-200 mt-1 block">
            {report.buyAndHoldReturnPct >= 0 ? '+' : ''}{report.buyAndHoldReturnPct}%
          </span>
          <span className={`text-[11px] ${report.alphaVsBuyAndHoldPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            Alpha: {report.alphaVsBuyAndHoldPct >= 0 ? '+' : ''}{report.alphaVsBuyAndHoldPct}%
          </span>
        </div>

        <div>
          <span className="font-sans text-[11px] text-slate-400 block">Win Rate / Số lệnh</span>
          <span className="text-base font-bold text-emerald-400 mt-1 block">
            {report.stats.winRatePct}%
          </span>
          <span className="text-[11px] text-slate-400">
            {report.stats.wins}W · {report.stats.losses}L · {report.stats.breakevens}BE
          </span>
        </div>

        <div>
          <span className="font-sans text-[11px] text-slate-400 block">Profit Factor / Expectancy</span>
          <span className="text-base font-bold text-amber-400 mt-1 block">
            PF {report.stats.profitFactor}
          </span>
          <span className="text-[11px] text-slate-300">
            {report.stats.expectancyR >= 0 ? '+' : ''}{report.stats.expectancyR}R (${formatUsd(report.stats.expectancyUsd)})
          </span>
        </div>

        <div>
          <span className="font-sans text-[11px] text-slate-400 block">Sharpe / Sortino / MaxDD</span>
          <span className="text-base font-bold text-slate-100 mt-1 block">
            {report.stats.sharpeRatio} / {report.stats.sortinoRatio}
          </span>
          <span className="text-[11px] text-rose-400">
            MaxDD -{report.stats.maxDrawdownPct}% ({report.stats.maxDrawdownDurationBars} nến)
          </span>
        </div>

        <div>
          <span className="font-sans text-[11px] text-slate-400 block">Chi phí &amp; Giữ lệnh TB</span>
          <span className="text-base font-bold text-rose-300 mt-1 block">
            -${formatUsd(totalCostsUsd, 1)}
          </span>
          <span className="text-[11px] text-slate-400">
            Hold {report.stats.avgHoldMinutes}m · {report.vetoedSetups} VETO
          </span>
        </div>
      </div>

      {/* V2 Institutional Ratios + Cost Sub-Bar */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 px-5 py-3 bg-[#0C121E] border border-white/10 rounded-xl text-xs font-mono tabular-nums">
        <div>
          <span className="font-sans text-slate-500 block">CAGR / Calmar Ratio</span>
          <span className="text-slate-100">
            {report.stats.cagrPct >= 0 ? '+' : ''}{report.stats.cagrPct}% · {report.stats.calmarRatio}
          </span>
        </div>
        <div>
          <span className="font-sans text-slate-500 block">Recovery / Exposure</span>
          <span className="text-sky-300">
            {report.stats.recoveryFactor}x · {report.stats.exposurePct}%
          </span>
        </div>
        <div>
          <span className="font-sans text-slate-500 block">EMA21/50 Benchmark</span>
          <span className={report.alphaVsBenchmarkPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {report.benchmarkEmaReturnPct >= 0 ? '+' : ''}{report.benchmarkEmaReturnPct}% (α {report.alphaVsBenchmarkPct >= 0 ? '+' : ''}{report.alphaVsBenchmarkPct}%)
          </span>
        </div>
        <div>
          <span className="font-sans text-slate-500 block">Gross Profit / Loss</span>
          <span className="text-emerald-400">+${formatUsd(report.stats.grossProfitUsd)}</span>
          <span className="text-slate-600"> / </span>
          <span className="text-rose-400">-${formatUsd(report.stats.grossLossUsd)}</span>
        </div>
        <div>
          <span className="font-sans text-slate-500 block">Avg Win / Avg Loss</span>
          <span className="text-emerald-400">+${formatUsd(report.stats.avgWinUsd)}</span>
          <span className="text-slate-600"> / </span>
          <span className="text-rose-400">-${formatUsd(report.stats.avgLossUsd)}</span>
        </div>
        <div>
          <span className="font-sans text-slate-500 block">Fees / Slip / Funding</span>
          <span className="text-slate-200">
            ${formatUsd(report.stats.totalFeesUsd, 1)} / ${formatUsd(report.stats.totalSlippageUsd, 1)} / ${formatUsd(report.stats.totalFundingUsd, 1)}
          </span>
        </div>
      </div>

      {/* Equity Curve vs Buy & Hold */}
      {equitySvg && (
        <div className="bg-[#0C121E] border border-white/10 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-4">
              <h2 className="font-display text-sm font-semibold text-slate-100">
                Đường cong Vốn vs Buy &amp; Hold ({report.candlesTested} nến)
              </h2>
              <div className="flex items-center gap-3 text-[11px] font-mono">
                <span className="text-emerald-400">— Chiến lược</span>
                <span className="text-sky-400">--- EMA21/50</span>
                <span className="text-slate-400">--- Buy &amp; Hold</span>
              </div>
            </div>
            {hoveredCurvePoint ? (
              <span className="font-mono text-xs tabular-nums text-amber-300">
                {new Date(hoveredCurvePoint.time).toLocaleString('vi-VN', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}{' '}
                · Chiến lược ${formatUsd(hoveredCurvePoint.equity)} · EMA ${formatUsd(hoveredCurvePoint.benchmarkEquity ?? hoveredCurvePoint.buyHoldEquity)} · B&amp;H ${formatUsd(hoveredCurvePoint.buyHoldEquity)} · BTC ${formatUsd(hoveredCurvePoint.price)}
              </span>
            ) : (
              <span className="font-mono text-xs tabular-nums text-slate-400">
                Min ${formatUsd(equitySvg.minEq)} · Max ${formatUsd(equitySvg.maxEq)}
              </span>
            )}
          </div>
          <svg
            viewBox={`0 0 ${equitySvg.w} ${equitySvg.h}`}
            onMouseMove={(e: MouseEvent<SVGSVGElement>) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * equitySvg.w;
              const norm = Math.max(0, Math.min(1, (relX - 12) / (equitySvg.w - 24)));
              setHoverCurveIdx(Math.round(norm * (report.equityCurve.length - 1)));
            }}
            onMouseLeave={() => setHoverCurveIdx(null)}
            className="w-full h-56 bg-[#070B12] rounded-lg border border-white/8 cursor-crosshair"
            role="img"
            aria-label="Biểu đồ đường cong vốn Backtest so với Buy and Hold"
          >
            <defs>
              <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10B981" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#10B981" stopOpacity="0.0" />
              </linearGradient>
            </defs>
            <path d={equitySvg.areaPath} fill="url(#equityGrad)" />
            <path
              d={equitySvg.bhPath}
              fill="none"
              stroke="#64748B"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
            <path
              d={equitySvg.emaBenchPath}
              fill="none"
              stroke="#38BDF8"
              strokeWidth="1.4"
              strokeDasharray="3 3"
            />
            <path d={equitySvg.linePath} fill="none" stroke="#10B981" strokeWidth="2.2" />
            {hoveredCurvePoint && hoverCurveIdx !== null && (
              <line
                x1={12 + (hoverCurveIdx / Math.max(report.equityCurve.length - 1, 1)) * (equitySvg.w - 24)}
                y1={12}
                x2={12 + (hoverCurveIdx / Math.max(report.equityCurve.length - 1, 1)) * (equitySvg.w - 24)}
                y2={equitySvg.h - 12}
                stroke="rgba(251,191,36,0.55)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            )}
          </svg>
        </div>
      )}

      {/* Long/Short & Market Regime Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#0C121E] border border-white/10 rounded-xl p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Hiệu suất Theo Chiều Lệnh (LONG vs SHORT)
          </h2>
          <table className="w-full text-left text-xs font-mono tabular-nums">
            <thead className="border-b border-white/10 text-slate-400 font-sans">
              <tr>
                <th className="py-2">Chiều</th>
                <th className="py-2 text-right">Số lệnh</th>
                <th className="py-2 text-right">Win Rate</th>
                <th className="py-2 text-right">Avg R</th>
                <th className="py-2 text-right">Net PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/8">
              {[report.longBreakdown, report.shortBreakdown].map((row) => (
                <tr key={row.side}>
                  <td className={`py-2.5 font-semibold ${row.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {row.side}
                  </td>
                  <td className="py-2.5 text-right text-slate-200">{row.trades}</td>
                  <td className="py-2.5 text-right text-slate-200">{row.winRatePct}%</td>
                  <td className="py-2.5 text-right text-slate-300">
                    {row.avgR >= 0 ? '+' : ''}{row.avgR}R
                  </td>
                  <td className={`py-2.5 text-right font-semibold ${row.netPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {row.netPnlUsd >= 0 ? '+' : ''}${formatUsd(row.netPnlUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-[#0C121E] border border-white/10 rounded-xl p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Hiệu suất Theo Trạng thái Thị trường (Regime)
          </h2>
          {report.regimeBreakdown.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">Chưa có lệnh nào được thực thi trong chuỗi dữ liệu.</p>
          ) : (
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead className="border-b border-white/10 text-slate-400 font-sans">
                <tr>
                  <th className="py-2">Regime</th>
                  <th className="py-2 text-right">Lệnh</th>
                  <th className="py-2 text-right">Win%</th>
                  <th className="py-2 text-right">Net PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/8">
                {report.regimeBreakdown.map((r) => (
                  <tr key={r.regime}>
                    <td className="py-2 font-sans text-slate-200">{r.regime}</td>
                    <td className="py-2 text-right text-slate-300">{r.trades}</td>
                    <td className="py-2 text-right text-slate-200">{r.winRatePct}%</td>
                    <td className={`py-2 text-right font-semibold ${r.netPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {r.netPnlUsd >= 0 ? '+' : ''}${formatUsd(r.netPnlUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Walk-Forward, In-Sample / Out-of-Sample & Overfitting Audit */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#0C121E] border border-white/10 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-100">
              In-Sample / Out-of-Sample &amp; Walk-Forward
            </h2>
            <span
              className={`px-2 py-0.5 text-[11px] font-mono font-semibold border rounded ${
                report.overfittingRisk === 'LOW'
                  ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                  : report.overfittingRisk === 'HIGH'
                    ? 'border-rose-500/40 text-rose-300 bg-rose-500/10'
                    : 'border-amber-500/40 text-amber-300 bg-amber-500/10'
              }`}
            >
              OVERFIT RISK: {report.overfittingRisk}
            </span>
          </div>
          <p className="text-xs text-slate-400">{report.overfittingNotes}</p>

          {report.inSampleStats && report.outOfSampleStats && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-white/8 text-xs font-mono tabular-nums">
              <div>
                <span className="font-sans text-slate-400 block">Train (50% đầu)</span>
                <span className="text-slate-100">
                  {report.inSampleStats.totalTrades}L · Win {report.inSampleStats.winRatePct}% ·{' '}
                  {report.inSampleStats.totalPnlPct >= 0 ? '+' : ''}{report.inSampleStats.totalPnlPct}%
                </span>
              </div>
              {report.validationStats && (
                <div>
                  <span className="font-sans text-slate-400 block">Validation (25% giữa)</span>
                  <span className="text-slate-100">
                    {report.validationStats.totalTrades}L · Win {report.validationStats.winRatePct}% ·{' '}
                    {report.validationStats.totalPnlPct >= 0 ? '+' : ''}{report.validationStats.totalPnlPct}%
                  </span>
                </div>
              )}
              <div>
                <span className="font-sans text-slate-400 block">Out-of-Sample (25% cuối)</span>
                <span className="text-slate-100">
                  {report.outOfSampleStats.totalTrades}L · Win {report.outOfSampleStats.winRatePct}% ·{' '}
                  {report.outOfSampleStats.totalPnlPct >= 0 ? '+' : ''}{report.outOfSampleStats.totalPnlPct}%
                </span>
              </div>
            </div>
          )}

          {report.walkForwardWindows.length > 0 && (
            <div className="pt-2 border-t border-white/8 space-y-1.5 text-xs font-mono tabular-nums">
              {report.walkForwardWindows.map((wf) => (
                <div key={wf.label} className="flex items-center justify-between text-slate-300">
                  <span className="font-sans">{wf.label} ({wf.candlesCount} nến)</span>
                  <span>
                    {wf.stats.totalTrades}L · Win {wf.stats.winRatePct}% ·{' '}
                    <span className={wf.stats.netProfitUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {wf.stats.netProfitUsd >= 0 ? '+' : ''}${formatUsd(wf.stats.netProfitUsd)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Parameter Sensitivity Grid */}
        <div className="bg-[#0C121E] border border-white/10 rounded-xl p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Độ nhạy Tham số (Ngưỡng Đồng thuận ±6đ)
          </h2>
          {report.sensitivityGrid.length === 0 ? (
            <p className="text-xs text-slate-400">Không đủ dữ liệu cho kiểm tra độ nhạy.</p>
          ) : (
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead className="border-b border-white/10 text-slate-400 font-sans">
                <tr>
                  <th className="py-2">Min Score</th>
                  <th className="py-2 text-right">Số lệnh</th>
                  <th className="py-2 text-right">Win Rate</th>
                  <th className="py-2 text-right">PF</th>
                  <th className="py-2 text-right">Net Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/8">
                {report.sensitivityGrid.map((pt) => (
                  <tr key={pt.minConsensusScore}>
                    <td className="py-2 text-amber-300">
                      {pt.minConsensusScore}/100
                      {pt.minConsensusScore === config.minConsensusScore ? ' (Hiện tại)' : ''}
                    </td>
                    <td className="py-2 text-right text-slate-200">{pt.totalTrades}</td>
                    <td className="py-2 text-right text-slate-200">{pt.winRatePct}%</td>
                    <td className="py-2 text-right text-slate-300">{pt.profitFactor}</td>
                    <td className={`py-2 text-right font-semibold ${pt.netProfitUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {pt.netProfitUsd >= 0 ? '+' : ''}${formatUsd(pt.netProfitUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Trade Ledger Table */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-1 bg-[#0C121E] p-1 rounded-lg border border-white/10 self-start">
            <button
              type="button"
              onClick={() => setSourceTab('backtest')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                sourceTab === 'backtest'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sổ lệnh Backtest ({report.trades.length})
            </button>
            <button
              type="button"
              onClick={() => setSourceTab('live')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                sourceTab === 'live'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Lệnh Thực tế Phiên ({liveTrades.length})
            </button>
          </div>

          <div className="flex items-center gap-1 bg-[#0C121E] p-1 rounded-lg border border-white/10 self-start">
            {(
              [
                ['ALL', 'Tất cả'],
                ['WIN', 'Thắng'],
                ['LOSS', 'Thua'],
                ['LONG', 'LONG'],
                ['SHORT', 'SHORT'],
              ] as Array<[TradeFilter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  filter === key
                    ? 'bg-slate-700 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="border border-white/10 rounded-xl bg-[#0C121E] overflow-x-auto">
          {filteredTrades.length === 0 ? (
            <div className="py-12 px-6 text-center text-sm text-slate-400">
              {sourceTab === 'live'
                ? 'Chưa có lệnh tất toán trong phiên hiện tại. Dữ liệu phiên được lưu tự động vào SQLite.'
                : 'Không có giao dịch nào khớp với bộ lọc hiện tại.'}
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-slate-400">
                <tr>
                  <th className="py-3 px-4 font-medium">Mã lệnh</th>
                  <th className="py-3 px-4 font-medium">Chiều</th>
                  <th className="py-3 px-4 font-medium text-right">Giá vào</th>
                  <th className="py-3 px-4 font-medium text-right">Giá thoát</th>
                  <th className="py-3 px-4 font-medium text-right">Phí + Funding</th>
                  <th className="py-3 px-4 font-medium text-right">R-Multiple</th>
                  <th className="py-3 px-4 font-medium text-right">Net PnL (USD)</th>
                  <th className="py-3 px-4 font-medium">Lý do Thoát</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/8 font-mono tabular-nums">
                {filteredTrades.slice(0, 50).map((t) => (
                  <tr key={`${t.id}-${t.closedAt}`} className="hover:bg-white/3">
                    <td className="py-2.5 px-4 text-slate-300">{t.id}</td>
                    <td
                      className={`py-2.5 px-4 font-semibold ${
                        t.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {t.side}
                    </td>
                    <td className="py-2.5 px-4 text-right text-slate-200">
                      ${t.entryPrice.toLocaleString('en-US')}
                    </td>
                    <td className="py-2.5 px-4 text-right text-slate-200">
                      ${t.exitPrice.toLocaleString('en-US')}
                    </td>
                    <td className="py-2.5 px-4 text-right text-slate-400">
                      ${((t.feesPaidUsd ?? 0) + (t.fundingPaidUsd ?? 0)).toFixed(2)}
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-semibold ${
                        t.rMultiple > 0
                          ? 'text-emerald-400'
                          : t.rMultiple < 0
                            ? 'text-rose-400'
                            : 'text-slate-400'
                      }`}
                    >
                      {t.rMultiple >= 0 ? '+' : ''}
                      {t.rMultiple}R
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-semibold ${
                        t.pnlUsd > 0
                          ? 'text-emerald-400'
                          : t.pnlUsd < 0
                            ? 'text-rose-400'
                            : 'text-slate-400'
                      }`}
                    >
                      {t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toLocaleString('en-US')}
                    </td>
                    <td className="py-2.5 px-4 font-sans text-slate-300">
                      {t.exitReason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
