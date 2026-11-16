import { useMemo, useState, type MouseEvent } from 'react';
import { Download } from 'lucide-react';
import type { BacktestReport, ClosedTrade, StrategyConfig } from '../engine/types';
import { formatTradesAsCsv, runDeterministicBacktest } from '../engine/multiAgentEngine';

interface BacktestJournalViewProps {
  config: StrategyConfig;
  liveTrades: ClosedTrade[];
  initialBacktest: BacktestReport;
}

type TradeFilter = 'ALL' | 'WIN' | 'LOSS' | 'LONG' | 'SHORT';

export function BacktestJournalView({
  config,
  liveTrades,
  initialBacktest,
}: BacktestJournalViewProps) {
  const [report, setReport] = useState<BacktestReport>(initialBacktest);
  const [candleHorizon, setCandleHorizon] = useState<number>(360);
  const [filter, setFilter] = useState<TradeFilter>('ALL');
  const [sourceTab, setSourceTab] = useState<'backtest' | 'live'>('backtest');
  const [hoverCurveIdx, setHoverCurveIdx] = useState<number | null>(null);

  const handleRunBacktest = (count: number) => {
    setCandleHorizon(count);
    const next = runDeterministicBacktest(config, count);
    setReport(next);
    setSourceTab('backtest');
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

  // Build SVG path for Equity Curve
  const equitySvg = useMemo(() => {
    const pts = report.equityCurve;
    if (pts.length < 2) return null;
    const minEq = Math.min(...pts.map((p) => p.equity));
    const maxEq = Math.max(...pts.map((p) => p.equity));
    const range = Math.max(maxEq - minEq, 1);
    const w = 880;
    const h = 210;
    const padX = 12;
    const padY = 16;

    const coords = pts.map((p, idx) => {
      const x = padX + (idx / (pts.length - 1)) * (w - padX * 2);
      const y = padY + (1 - (p.equity - minEq) / range) * (h - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const linePath = `M${coords.join(' L')}`;
    const areaPath = `${linePath} L${(w - padX).toFixed(1)},${h - padY} L${padX},${h - padY} Z`;
    return { w, h, linePath, areaPath, minEq, maxEq };
  }, [report.equityCurve]);

  const handleExportCsv = () => {
    const csv = formatTradesAsCsv(filteredTrades);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `aegisbtc-${sourceTab}-journal.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const hoveredCurvePoint =
    hoverCurveIdx !== null && hoverCurveIdx >= 0 && hoverCurveIdx < report.equityCurve.length
      ? report.equityCurve[hoverCurveIdx]
      : null;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      {/* Header & Backtest Runner */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <p className="text-xs font-medium text-amber-400 mb-1">
            Kiểm chứng Chiến lược &amp; Sổ lệnh
          </p>
          <h1 className="font-display text-2xl md:text-3xl font-bold text-slate-50">
            Hiệu suất Backtest &amp; Nhật ký Giao dịch
          </h1>
          <p className="text-sm text-slate-400 mt-1.5">
            Đánh giá tỷ lệ thắng, Profit Factor, Sharpe và Drawdown dựa trên cấu hình quản trị rủi ro hiện tại.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => handleRunBacktest(360)}
            className={`px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
              candleHorizon === 360
                ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                : 'bg-[#111827] text-slate-200 border border-white/12 hover:border-amber-400'
            }`}
          >
            Chạy Backtest (360 nến)
          </button>
          <button
            type="button"
            onClick={() => handleRunBacktest(720)}
            className={`px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
              candleHorizon === 720
                ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                : 'bg-[#111827] text-slate-200 border border-white/12 hover:border-amber-400'
            }`}
          >
            Chạy Backtest (720 nến)
          </button>
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

      {/* KPI Metrics Row (Clean hairline divider grid, tabular-nums) */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-6 py-4 px-5 bg-[#0C121E] border border-white/10 rounded-xl">
        <div>
          <span className="text-xs text-slate-400 block">Vốn cuối kỳ</span>
          <span className="font-mono text-lg font-bold text-slate-50 tabular-nums mt-1 block">
            ${report.stats.equity.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
        </div>
        <div>
          <span className="text-xs text-slate-400 block">Tỷ lệ Thắng (Win Rate)</span>
          <span className="font-mono text-lg font-bold text-emerald-400 tabular-nums mt-1 block">
            {report.stats.winRatePct}%
          </span>
        </div>
        <div>
          <span className="text-xs text-slate-400 block">Profit Factor / Sharpe</span>
          <span className="font-mono text-lg font-bold text-amber-400 tabular-nums mt-1 block">
            {report.stats.profitFactor} · {report.stats.sharpeProxy}
          </span>
        </div>
        <div>
          <span className="text-xs text-slate-400 block">Kỳ vọng / Lệnh</span>
          <span className="font-mono text-lg font-bold text-slate-100 tabular-nums mt-1 block">
            {report.stats.expectancyR >= 0 ? '+' : ''}
            {report.stats.expectancyR}R
          </span>
        </div>
        <div>
          <span className="text-xs text-slate-400 block">Max Drawdown</span>
          <span className="font-mono text-lg font-bold text-rose-400 tabular-nums mt-1 block">
            -{report.stats.maxDrawdownPct}%
          </span>
        </div>
        <div>
          <span className="text-xs text-slate-400 block">Lệnh Risk đã VETO</span>
          <span className="font-mono text-lg font-bold text-slate-200 tabular-nums mt-1 block">
            {report.vetoedSetups} kèo nhiễu
          </span>
        </div>
      </div>

      {/* Equity Curve with Interactive Crosshair */}
      {equitySvg && (
        <div className="bg-[#0C121E] border border-white/10 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Đường cong Tăng trưởng Vốn ({report.candlesTested} nến M15)
            </h2>
            {hoveredCurvePoint ? (
              <span className="font-mono text-xs tabular-nums text-amber-300">
                {new Date(hoveredCurvePoint.time).toLocaleString('vi-VN', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}{' '}
                · Vốn ${hoveredCurvePoint.equity.toLocaleString('en-US')} · BTC $
                {hoveredCurvePoint.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </span>
            ) : (
              <span className="font-mono text-xs tabular-nums text-emerald-400">
                {report.stats.totalPnlPct >= 0 ? '+' : ''}
                {report.stats.totalPnlPct}% ({report.stats.wins} thắng · {report.stats.losses} thua · {report.stats.breakevens} hòa)
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
            className="w-full h-52 bg-[#070B12] rounded-lg border border-white/8 cursor-crosshair"
            role="img"
            aria-label="Biểu đồ đường cong tăng trưởng vốn Backtest"
          >
            <defs>
              <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10B981" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#10B981" stopOpacity="0.0" />
              </linearGradient>
            </defs>
            <path d={equitySvg.areaPath} fill="url(#equityGrad)" />
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

      {/* Trade Ledger Table */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Source switch */}
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

          {/* Outcome / Side Filter */}
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
                ? 'Chưa có lệnh tất toán trong phiên hiện tại. Bot đang quét điểm hội tụ chuẩn để vào lệnh.'
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
                  <th className="py-3 px-4 font-medium text-right">Khối lượng</th>
                  <th className="py-3 px-4 font-medium text-right">R-Multiple</th>
                  <th className="py-3 px-4 font-medium text-right">Lợi nhuận (USD)</th>
                  <th className="py-3 px-4 font-medium">Lý do Thoát</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/8 font-mono tabular-nums">
                {filteredTrades.slice(0, 40).map((t) => (
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
                    <td className="py-2.5 px-4 text-right text-slate-300">{t.sizeBtc} BTC</td>
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
                      {t.exitReason === 'TP2_TARGET'
                        ? 'Đạt mục tiêu TP2'
                        : t.exitReason === 'BREAKEVEN_STOP'
                          ? 'Chốt TP1 + Hòa vốn'
                          : t.exitReason === 'TP1_TRAILING'
                            ? 'Chốt Trailing Stop'
                            : t.exitReason === 'MANUAL_CLOSE'
                              ? 'Chốt lệnh thủ công'
                              : 'Cắt lỗ bảo vệ (SL)'}
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
