import { useState, type MouseEvent } from 'react';
import { computeEMASeries } from '../engine/indicators';
import type { Candle, Position } from '../engine/types';

interface MarketMiniChartProps {
  candles: Candle[];
  activePosition: Position | null;
}

export function MarketMiniChart({ candles, activePosition }: MarketMiniChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const viewCandles = candles.slice(-42);

  if (viewCandles.length === 0) {
    return (
      <div className="h-36 flex items-center justify-center text-xs text-slate-400">
        Đang tải dữ liệu nến BTC/USDT...
      </div>
    );
  }

  const closes = candles.map((c) => c.close);
  const ema21All = computeEMASeries(closes, 21);
  const ema50All = computeEMASeries(closes, 50);
  const ema21 = ema21All.slice(-viewCandles.length);
  const ema50 = ema50All.slice(-viewCandles.length);

  const lows = viewCandles.map((c) => c.low);
  const highs = viewCandles.map((c) => c.high);
  if (activePosition) {
    const posPrices = [
      activePosition.stopLoss,
      activePosition.entryPrice,
      activePosition.takeProfit1,
      activePosition.takeProfit2,
    ];
    lows.push(...posPrices);
    highs.push(...posPrices);
  }

  const minPrice = Math.min(...lows) * 0.9992;
  const maxPrice = Math.max(...highs) * 1.0008;
  const priceRange = Math.max(maxPrice - minPrice, 1);

  const width = 340;
  const height = 140;
  const padX = 6;
  const padY = 10;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const xAt = (i: number) =>
    padX + (i / Math.max(viewCandles.length - 1, 1)) * plotW;
  const yAt = (p: number) =>
    padY + (1 - (p - minPrice) / priceRange) * plotH;

  const ema21Path = ema21
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
    .join(' ');
  const ema50Path = ema50
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
    .join(' ');

  const barW = Math.max(2.5, plotW / viewCandles.length - 2);
  const lastCandle = viewCandles[viewCandles.length - 1];
  const hoveredCandle =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < viewCandles.length
      ? viewCandles[hoverIdx]
      : null;

  const handleMouseMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * width;
    const norm = Math.max(0, Math.min(1, (relX - padX) / plotW));
    const idx = Math.round(norm * Math.max(viewCandles.length - 1, 0));
    setHoverIdx(idx);
  };

  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5 min-h-[16px]">
        {hoveredCandle ? (
          <span className="font-mono tabular-nums text-slate-300 truncate">
            {new Date(hoveredCandle.time).toLocaleTimeString('vi-VN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}{' '}
            · H ${hoveredCandle.high.toLocaleString('en-US', { maximumFractionDigits: 0 })} · L $
            {hoveredCandle.low.toLocaleString('en-US', { maximumFractionDigits: 0 })} · C $
            {hoveredCandle.close.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
        ) : (
          <span>BTC/USDT · M15</span>
        )}
        <span className="tabular-nums shrink-0 ml-2">
          <span className="text-amber-400">EMA21</span>
          <span className="mx-1.5 text-slate-600">/</span>
          <span className="text-sky-400">EMA50</span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        className="w-full h-34 bg-[#070B12] rounded-lg border border-white/10 cursor-crosshair"
        role="img"
        aria-label="Biểu đồ nến BTC/USDT và vùng vào lệnh"
      >
        {/* Subtle horizontal reference lines */}
        {[0.25, 0.5, 0.75].map((frac) => (
          <line
            key={frac}
            x1={padX}
            y1={padY + plotH * frac}
            x2={width - padX}
            y2={padY + plotH * frac}
            stroke="rgba(148,163,184,0.08)"
            strokeDasharray="3 3"
          />
        ))}

        {/* Live spot price hairline */}
        <line
          x1={padX}
          y1={yAt(lastCandle.close)}
          x2={width - padX}
          y2={yAt(lastCandle.close)}
          stroke="rgba(226,232,240,0.28)"
          strokeWidth="0.8"
          strokeDasharray="2 2"
        />

        {/* Active Position Entry / SL / TP1 / TP2 lines */}
        {activePosition && (
          <>
            <line
              x1={padX}
              y1={yAt(activePosition.takeProfit2)}
              x2={width - padX}
              y2={yAt(activePosition.takeProfit2)}
              stroke="#10B981"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text
              x={width - padX - 2}
              y={Math.max(10, yAt(activePosition.takeProfit2) - 3)}
              textAnchor="end"
              fill="#34D399"
              fontSize="8.5"
              fontFamily="monospace"
            >
              TP2
            </text>

            <line
              x1={padX}
              y1={yAt(activePosition.takeProfit1)}
              x2={width - padX}
              y2={yAt(activePosition.takeProfit1)}
              stroke="#38BDF8"
              strokeWidth="0.9"
              strokeDasharray="2 3"
            />
            <text
              x={width - padX - 2}
              y={Math.max(10, yAt(activePosition.takeProfit1) - 3)}
              textAnchor="end"
              fill="#38BDF8"
              fontSize="8.5"
              fontFamily="monospace"
            >
              TP1
            </text>

            <line
              x1={padX}
              y1={yAt(activePosition.entryPrice)}
              x2={width - padX}
              y2={yAt(activePosition.entryPrice)}
              stroke="#F59E0B"
              strokeWidth="1"
            />
            <text
              x={width - padX - 2}
              y={Math.max(10, yAt(activePosition.entryPrice) - 3)}
              textAnchor="end"
              fill="#FBBF24"
              fontSize="8.5"
              fontFamily="monospace"
            >
              ENTRY
            </text>

            <line
              x1={padX}
              y1={yAt(activePosition.stopLoss)}
              x2={width - padX}
              y2={yAt(activePosition.stopLoss)}
              stroke="#EF4444"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text
              x={width - padX - 2}
              y={Math.max(10, yAt(activePosition.stopLoss) - 3)}
              textAnchor="end"
              fill="#FB7185"
              fontSize="8.5"
              fontFamily="monospace"
            >
              SL
            </text>
          </>
        )}

        {/* Candles */}
        {viewCandles.map((c, idx) => {
          const x = xAt(idx);
          const yOpen = yAt(c.open);
          const yClose = yAt(c.close);
          const yHigh = yAt(c.high);
          const yLow = yAt(c.low);
          const isBull = c.close >= c.open;
          const color = isBull ? '#10B981' : '#EF4444';
          const bodyTop = Math.min(yOpen, yClose);
          const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
          const isHovered = hoverIdx === idx;
          return (
            <g key={c.time} opacity={hoverIdx === null || isHovered ? 1 : 0.68}>
              <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth="1" />
              <rect
                x={x - barW / 2}
                y={bodyTop}
                width={barW}
                height={bodyH}
                fill={color}
                rx="0.5"
              />
            </g>
          );
        })}

        {/* Hover Crosshair */}
        {hoveredCandle && hoverIdx !== null && (
          <line
            x1={xAt(hoverIdx)}
            y1={padY}
            x2={xAt(hoverIdx)}
            y2={height - padY}
            stroke="rgba(248,250,252,0.35)"
            strokeWidth="0.9"
            strokeDasharray="2 2"
          />
        )}

        {/* EMA overlays */}
        <path d={ema50Path} fill="none" stroke="#38BDF8" strokeWidth="1.2" opacity="0.8" />
        <path d={ema21Path} fill="none" stroke="#F59E0B" strokeWidth="1.4" />
      </svg>
    </div>
  );
}
