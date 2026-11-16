import { ArrowRight, CheckCircle2, ShieldAlert } from 'lucide-react';
import type {
  AgentId,
  FeedHealthTelemetry,
  PipelineCycle,
  RiskEventRecord,
  TechnicalIndicators,
} from '../engine/types';

interface PipelineDeepDiveViewProps {
  cycle: PipelineCycle | null;
  indicators: TechnicalIndicators;
  cycleHistory: PipelineCycle[];
  riskEvents: RiskEventRecord[];
  healthTelemetry: FeedHealthTelemetry | null;
  onTriggerScan: () => void;
}

const AGENT_VI_NAMES: Record<AgentId | 'PROPOSED_TRADE', string> = {
  macro_scout: 'Trinh sát Vĩ mô',
  quant_analyst: 'Chuyên gia Định lượng',
  orderflow_radar: 'Radar Sổ lệnh',
  strategy_architect: 'Kiến trúc Chiến lược',
  risk_guardian: 'Giám đốc Rủi ro',
  execution_commander: 'Chỉ huy Khớp lệnh',
  PROPOSED_TRADE: 'Đề xuất Lệnh',
};

const ARCHITECTURE_STEPS = [
  {
    code: '01. Bước A',
    agentKey: 'macro_scout' as const,
    title: 'Thu thập Vĩ mô & Đa khung M5–D1',
    detail:
      'Quét 200 nến M15 cùng klines thực đã đóng từ sàn (M5, H1, H4, D1), OBV slope, AggTrade CVD, Funding Futures (khi chọn Futures) và EMA200.',
  },
  {
    code: '02. Bước B',
    agentKey: 'quant_analyst' as const,
    title: 'Hội tụ Đa Chỉ báo & Cấu trúc BOS/CHoCH',
    detail:
      'Xác nhận hội tụ SMA/EMA chuẩn hóa, RSI(14), Wilder ADX(14), MACD(12,26,9), Bollinger Bands, VWAP, vùng giá POC/VAH/VAL và cấu trúc BOS/CHoCH.',
  },
  {
    code: '03. Bước C',
    agentKey: 'orderflow_radar' as const,
    title: 'Quét Sổ lệnh Depth20 & Thanh khoản',
    detail:
      'Đo chênh lệch Bid/Ask thực (trả UNAVAILABLE nếu mất sổ lệnh, tuyệt đối không giả lập bằng EMA), Spread bps, Z-Score khối lượng và Sweep.',
  },
  {
    code: '04. Bước D',
    agentKey: 'strategy_architect' as const,
    title: 'Kiến trúc Chiến lược & Thiết kế Playbook R:R',
    detail:
      'Chọn Playbook phù hợp chế độ thị trường (Trend / Breakout / Sweep Reversal), kiểm tra khoảng thoáng Pivot S/R và định vị Entry/SL/TP.',
  },
  {
    code: '05. Bước E',
    agentKey: 'risk_guardian' as const,
    title: 'Phản biện Chéo & Trọng tài Rủi ro Định chế',
    detail:
      'Áp dụng cho cả lệnh Auto và Manual: kiểm tra lỗ ngày/tuần, max drawdown, chuỗi thua, spread, ký quỹ khả dụng, giá thanh lý và R:R ròng.',
  },
  {
    code: '06. Bước F',
    agentKey: 'execution_commander' as const,
    title: 'Thực thi Phân tầng & Dời Stop Hòa vốn',
    detail:
      'Hỗ trợ Market/Limit trên Simulation / Paper / Binance Testnet (Live bị khóa mặc định). Khi chạm TP1 chốt 50% và kéo SL về hòa vốn.',
  },
];

export function PipelineDeepDiveView({
  cycle,
  indicators,
  cycleHistory,
  riskEvents,
  healthTelemetry,
  onTriggerScan,
}: PipelineDeepDiveViewProps) {
  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-10">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <p className="text-xs font-medium text-amber-400 mb-1">
            Kiến trúc Đa Tác tử Phản biện Định lượng V2
          </p>
          <h1 className="font-display text-2xl md:text-3xl font-bold text-slate-50">
            Quy trình Giao dịch Bitcoin từ A đến Z
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-2xl">
            Mỗi đề xuất (tự động hoặc thủ công) đều phải vượt qua 6 lớp kiểm duyệt, vòng phản biện đối kháng và cổng chặn Risk Guardian trước khi ghi nhận lệnh.
          </p>
        </div>
        <button
          type="button"
          onClick={onTriggerScan}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          Chạy Chu kỳ Phân tích Mới
        </button>
      </div>

      {/* Live Quant Telemetry Matrix */}
      <div className="py-4 border-b border-white/10 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
          <div>
            <span className="text-xs text-slate-400 block">Chế độ Thị trường</span>
            <span className="text-sm font-semibold text-slate-100 mt-1 block">
              {cycle?.regime ?? 'Đang quét'} ({cycle?.regimeConfidence ?? 0}%)
            </span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">RSI(14) / Wilder ADX(14)</span>
            <span className="text-sm font-mono font-semibold text-slate-100 tabular-nums mt-1 block">
              {indicators.rsi14.toFixed(1)} · {indicators.adx14.toFixed(1)}
            </span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">Volume Profile (POC / VAL–VAH)</span>
            <span className="text-sm font-mono font-semibold text-slate-100 tabular-nums mt-1 block">
              ${indicators.volumeProfile.poc.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">Điểm Sau Phản biện</span>
            <span className="text-sm font-mono font-semibold text-amber-400 tabular-nums mt-1 block">
              {cycle ? `${cycle.consensusScore}/100` : '--'}
            </span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">Trạng thái Dữ liệu</span>
            <span className="text-sm font-mono font-semibold text-slate-100 mt-1 block">
              {healthTelemetry?.status ?? cycle?.dataQuality ?? 'HEALTHY'}
            </span>
          </div>
        </div>

        <div className="pt-3 border-t border-white/8 grid grid-cols-2 md:grid-cols-6 gap-4 text-xs font-mono tabular-nums">
          <div>
            <span className="text-slate-500 font-sans block">SMA20 / SMA50</span>
            <span className="text-slate-200">
              ${indicators.sma20.toLocaleString('en-US', { maximumFractionDigits: 0 })} / $
              {indicators.sma50.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">EMA50 / EMA200</span>
            <span className="text-slate-200">
              ${indicators.ema50.toLocaleString('en-US', { maximumFractionDigits: 0 })} / $
              {indicators.ema200.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">
              Đa khung ({indicators.htfSource === 'EXCHANGE_KLINES' ? 'Sàn thực' : indicators.htfSource})
            </span>
            <span className="text-sky-400">
              M5:{indicators.m5Bias} H1:{indicators.h1Bias} H4:{indicators.h4Bias} D1:{indicators.d1Bias}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">Hỗ trợ / Kháng cự</span>
            <span className="text-slate-200">
              ${indicators.srLevels.nearestSupport.toLocaleString('en-US', { maximumFractionDigits: 0 })} / $
              {indicators.srLevels.nearestResistance.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">OBV Slope / Vol Z</span>
            <span className={indicators.obvSlope >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {indicators.obvSlope >= 0 ? '+' : ''}
              {indicators.obvSlope.toFixed(1)} · Z={indicators.volumeZScore.toFixed(1)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">Funding / Spread</span>
            <span className="text-slate-200">
              {indicators.fundingRate !== null
                ? `${(indicators.fundingRate * 100).toFixed(4)}%`
                : 'Spot N/A'}{' '}
              · {indicators.spreadBps.toFixed(1)}bps
            </span>
          </div>
        </div>

        {/* V2 Extended Indicator & Data Integrity Telemetry */}
        <div className="pt-3 border-t border-white/8 grid grid-cols-2 md:grid-cols-6 gap-4 text-xs font-mono tabular-nums">
          <div>
            <span className="text-slate-500 font-sans block">MACD / Signal</span>
            <span className={indicators.macdHistogram >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {indicators.macdLine.toFixed(1)} / {indicators.macdSignal.toFixed(1)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">BB Width / VWAP24</span>
            <span className="text-slate-200">
              {(indicators.bbBandwidth * 100).toFixed(2)}% · $
              {indicators.vwap24.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">Cấu trúc Sóng</span>
            <span className="text-amber-300">{indicators.structureEvent}</span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">Orderbook Source</span>
            <span className={indicators.orderbookSource === 'EXCHANGE_DEPTH' ? 'text-emerald-400' : 'text-slate-400'}>
              {indicators.orderbookSource}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">CVD ({indicators.cvdSource})</span>
            <span className={indicators.spotCvdDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {indicators.spotCvdDelta >= 0 ? '+' : ''}${indicators.spotCvdDelta.toFixed(2)}M
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-sans block">Phân loại Dữ liệu</span>
            <span className="text-sky-300">{indicators.dataStatus}</span>
          </div>
        </div>

        {cycle?.risk.confidenceDisclaimer && (
          <p className="text-[11px] text-slate-400 italic pt-1">
            Lưu ý định lượng: {cycle.risk.confidenceDisclaimer}
          </p>
        )}
      </div>

      {/* Multi-Agent Cross-Examination Transcript */}
      {cycle?.debate && (
        <section
          aria-label="Biên bản Phản biện Đa Tác tử"
          data-testid="pipeline-debate-transcript"
          className="border border-white/10 rounded-xl bg-[#0C121E] overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-100">
                Biên bản Phản biện Đa Tác tử
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">{cycle.debate.verdict}</p>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono tabular-nums shrink-0">
              <span className="text-slate-400">
                Trước phản biện: <span className="text-slate-200">{cycle.debate.preDebateScore}đ</span>
              </span>
              <span
                className={
                  cycle.debate.scoreDelta > 0
                    ? 'text-emerald-400 font-semibold'
                    : cycle.debate.scoreDelta < 0
                      ? 'text-rose-400 font-semibold'
                      : 'text-amber-400 font-semibold'
                }
              >
                Hiệu chỉnh: {cycle.debate.scoreDelta >= 0 ? `+${cycle.debate.scoreDelta}` : cycle.debate.scoreDelta}đ →{' '}
                {cycle.debate.postDebateScore}/100
              </span>
            </div>
          </div>

          <div className="divide-y divide-white/8">
            {cycle.debate.turns.map((turn) => (
              <div
                key={turn.id}
                className="px-5 py-3.5 grid grid-cols-1 md:grid-cols-12 gap-3 items-start"
              >
                <div className="md:col-span-3 text-xs">
                  <span className="font-semibold text-slate-200 block">
                    {AGENT_VI_NAMES[turn.challenger]}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Chất vấn → {AGENT_VI_NAMES[turn.target]}
                  </span>
                </div>
                <div className="md:col-span-7">
                  <h3 className="text-xs font-semibold text-slate-100">{turn.title}</h3>
                  <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{turn.argument}</p>
                </div>
                <div className="md:col-span-2 flex md:justify-end items-center text-xs font-mono font-semibold tabular-nums">
                  <span
                    className={
                      turn.stance === 'SUPPORT'
                        ? 'text-emerald-400'
                        : turn.stance === 'VETO_TRIGGER'
                          ? 'text-rose-400'
                          : 'text-amber-400'
                    }
                  >
                    {turn.stance === 'SUPPORT'
                      ? 'ỦNG HỘ'
                      : turn.stance === 'VETO_TRIGGER'
                        ? 'CHẶN VETO'
                        : 'PHẢN ĐỐI'}{' '}
                    ({turn.impactScore >= 0 ? `+${turn.impactScore}` : turn.impactScore}đ)
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5-Stage Sequential Pipeline */}
      <div className="divide-y divide-white/10 border border-white/10 rounded-xl bg-[#0C121E]">
        {ARCHITECTURE_STEPS.map((step, idx) => {
          const sig = cycle?.signals[step.agentKey];
          const isVeto = sig?.direction === 'VETO';
          return (
            <div
              key={step.agentKey}
              className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-4 items-start"
            >
              <div className="lg:col-span-4">
                <span className="text-xs font-mono text-amber-400 block">{step.code}</span>
                <h2 className="font-display text-base font-semibold text-slate-100 mt-0.5">
                  {step.title}
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Phụ trách: {sig?.name ?? step.agentKey} ({sig?.role})
                </p>
              </div>

              <div className="lg:col-span-5 text-sm text-slate-300 leading-relaxed">
                <p>{step.detail}</p>
                {sig && (
                  <p className="mt-2 text-xs font-mono text-slate-200 bg-[#070B12] px-3 py-2 rounded-lg border border-white/8">
                    Tín hiệu hiện tại: {sig.summary}
                  </p>
                )}
              </div>

              <div className="lg:col-span-3 flex flex-col lg:items-end justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-mono font-semibold tabular-nums">
                  {isVeto ? (
                    <ShieldAlert className="w-4 h-4 text-rose-400" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                  )}
                  <span
                    className={
                      sig?.direction === 'LONG'
                        ? 'text-emerald-400'
                        : sig?.direction === 'SHORT' || isVeto
                          ? 'text-rose-400'
                          : sig?.direction === 'UNAVAILABLE'
                            ? 'text-amber-400'
                            : 'text-slate-300'
                    }
                  >
                    {sig?.direction ?? 'NEUTRAL'} · {sig?.confidence ?? 0}%
                  </span>
                </div>
                {sig && (
                  <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                    {sig.dataQuality} · {sig.latencyMs}ms
                    {sig.riskFlags.length > 0 ? ` · ${sig.riskFlags[0]}` : ''}
                  </span>
                )}
                {idx < ARCHITECTURE_STEPS.length - 1 && (
                  <span className="hidden lg:inline-flex items-center gap-1 text-[11px] text-slate-500">
                    <span>Chuyển tiếp</span>
                    <ArrowRight className="w-3 h-3" aria-hidden="true" />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Risk Events Log */}
      {riskEvents.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-display text-lg font-semibold text-slate-100">
            Sự kiện Kiểm soát Rủi ro &amp; VETO (Persisted)
          </h2>
          <div className="border border-white/10 rounded-xl bg-[#0C121E] divide-y divide-white/8 text-xs">
            {riskEvents.slice(0, 12).map((ev) => (
              <div key={ev.id} className="px-4 py-2.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-rose-400 font-semibold whitespace-nowrap">
                    {ev.eventType}
                  </span>
                  <span className="text-slate-300">{ev.message}</span>
                </div>
                <span className="font-mono text-slate-500 whitespace-nowrap tabular-nums">
                  {new Date(ev.createdAt).toLocaleTimeString('vi-VN')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Decision Audit Log */}
      <div className="space-y-3">
        <h2 className="font-display text-lg font-semibold text-slate-100">
          Nhật ký Phối hợp Gần đây
        </h2>
        <div className="border border-white/10 rounded-xl bg-[#0C121E] overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-white/10 text-slate-400">
              <tr>
                <th className="py-3 px-4 font-medium">Chu kỳ</th>
                <th className="py-3 px-4 font-medium">Trạng thái</th>
                <th className="py-3 px-4 font-medium text-right">Đồng thuận</th>
                <th className="py-3 px-4 font-medium">Hành động</th>
                <th className="py-3 px-4 font-medium">Diễn giải Hội đồng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/8">
              {cycleHistory.slice(0, 10).map((item) => (
                <tr key={`${item.cycleId}-${item.timestamp}`} className="hover:bg-white/3">
                  <td className="py-2.5 px-4 font-mono tabular-nums text-slate-300 whitespace-nowrap">
                    #{item.cycleId} · {new Date(item.timestamp).toLocaleTimeString('vi-VN')}
                  </td>
                  <td className="py-2.5 px-4 text-slate-200 whitespace-nowrap">{item.regime}</td>
                  <td className="py-2.5 px-4 font-mono tabular-nums text-right text-amber-400">
                    {item.consensusScore}/100
                  </td>
                  <td className="py-2.5 px-4 font-mono whitespace-nowrap">
                    <span
                      className={
                        item.actionTaken === 'OPEN_LONG'
                          ? 'text-emerald-400'
                          : item.actionTaken === 'OPEN_SHORT'
                            ? 'text-rose-400'
                            : item.actionTaken === 'VETO_SKIP'
                              ? 'text-amber-400'
                              : 'text-slate-400'
                      }
                    >
                      {item.actionTaken}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-slate-300">{item.actionNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
