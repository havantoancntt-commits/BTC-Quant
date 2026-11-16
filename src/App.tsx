import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  extractIndicators,
  generateNextSimulatedCandle,
  generateRealisticBTCSeries,
} from './engine/indicators';
import {
  closePositionAtMarket,
  computePerformanceStats,
  createManualPosition,
  DEFAULT_STRATEGY_CONFIG,
  runDeterministicBacktest,
  runPipelineCycle,
} from './engine/multiAgentEngine';
import type {
  AgentId,
  Candle,
  ClosedTrade,
  HtfContext,
  MarketFeedSource,
  MarketScenario,
  OrderbookLevel,
  PipelineCycle,
  PipelineStage,
  Position,
  StrategyConfig,
} from './engine/types';
import type { CameraPreset } from './three/AgentWarRoomScene';
import { TopBar, type WorkspaceTab } from './components/TopBar';
import { WarRoom3DCanvas } from './components/WarRoom3DCanvas';
import { BottomDock } from './components/BottomDock';
import { PipelineDrawer } from './components/PipelineDrawer';
import { PipelineDeepDiveView } from './components/PipelineDeepDiveView';
import { BacktestJournalView } from './components/BacktestJournalView';
import { StrategyConfigView } from './components/StrategyConfigView';

const STAGE_SEQUENCE: PipelineStage[] = [
  'INGEST_MARKET',
  'QUANT_CONFLUENCE',
  'ORDERFLOW_SCAN',
  'RISK_VETO_GATE',
  'EXECUTION_SYNC',
];

function formatFeedSourceLabel(source: MarketFeedSource): string {
  switch (source) {
    case 'binance_ws_live':
      return 'Binance WS Live';
    case 'binance_rest_live':
      return 'Binance REST Live';
    case 'coinbase_live':
      return 'Coinbase Live';
    default:
      return 'Quant Engine';
  }
}

interface LiveFeedSnapshot {
  source: MarketFeedSource;
  candles: Candle[];
  price: number;
  change24hPct: number;
  bestBid: number;
  bestAsk: number;
  orderbookImbalance: number;
  fundingRate: number;
  htfContext?: HtfContext;
  updatedAt: number;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('war_room_3d');
  const [botRunning, setBotRunning] = useState<boolean>(true);
  const [config, setConfig] = useState<StrategyConfig>(DEFAULT_STRATEGY_CONFIG);

  // Market & Pipeline State
  const [dataSource, setDataSource] = useState<MarketFeedSource>('quant_engine_sim');
  const [candles, setCandles] = useState<Candle[]>(() =>
    generateRealisticBTCSeries(120, 92400, 20261115),
  );
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [liveChange24hPct, setLiveChange24hPct] = useState<number | null>(null);
  const [bestBid, setBestBid] = useState<number | null>(null);
  const [bestAsk, setBestAsk] = useState<number | null>(null);
  const [orderbookBids, setOrderbookBids] = useState<OrderbookLevel[]>([]);
  const [orderbookAsks, setOrderbookAsks] = useState<OrderbookLevel[]>([]);
  const [liveOrderbookImbalance, setLiveOrderbookImbalance] = useState<number | undefined>(
    undefined,
  );
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [fundingRate, setFundingRate] = useState<number>(0.00012);
  const [htfContext, setHtfContext] = useState<HtfContext | undefined>(undefined);
  const [scenario, setScenario] = useState<MarketScenario>('auto_live');

  // Trading Portfolio & Cycle State
  const [equity, setEquity] = useState<number>(DEFAULT_STRATEGY_CONFIG.initialCapital);
  const [activePosition, setActivePosition] = useState<Position | null>(null);
  const [liveTrades, setLiveTrades] = useState<ClosedTrade[]>([]);
  const [equityHistory, setEquityHistory] = useState<number[]>([
    DEFAULT_STRATEGY_CONFIG.initialCapital,
  ]);

  const [cycleHistory, setCycleHistory] = useState<PipelineCycle[]>([]);
  const [currentCycle, setCurrentCycle] = useState<PipelineCycle | null>(null);
  const [activeStage, setActiveStage] = useState<PipelineStage>('INGEST_MARKET');

  // 3D War Room Controls
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(null);
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true,
  );
  const [simSpeed, setSimSpeed] = useState<number>(1);
  const [activePreset, setActivePreset] = useState<CameraPreset>('overview');
  const [cameraRequest, setCameraRequest] = useState<{
    preset: CameraPreset;
    agentId?: AgentId | null;
    seq: number;
  } | null>(null);

  const cycleCounterRef = useRef<number>(1);
  const stageIdxRef = useRef<number>(0);
  const liveSnapshotRef = useRef<LiveFeedSnapshot | null>(null);

  // Latest state refs for clean interval & SSE execution
  const stateRef = useRef({
    candles,
    fundingRate,
    equity,
    activePosition,
    config,
    scenario,
    dataSource,
    liveOrderbookImbalance,
    htfContext,
  });
  stateRef.current = {
    candles,
    fundingRate,
    equity,
    activePosition,
    config,
    scenario,
    dataSource,
    liveOrderbookImbalance,
    htfContext,
  };

  // Initial backtest baseline for KPI verification
  const initialBacktest = useMemo(
    () => runDeterministicBacktest(config, 360),
    [config],
  );

  // Execute one full A-to-Z cycle on live or simulated candles
  const executeCycleStep = useCallback(
    (advanceCandle: boolean, scenarioOverride?: MarketScenario) => {
      const s = stateRef.current;
      const activeScenario = scenarioOverride ?? s.scenario;
      const stepNum = cycleCounterRef.current++;
      const useLiveFeed =
        activeScenario === 'auto_live' && s.dataSource !== 'quant_engine_sim';

      let nextCandles = s.candles;
      if (useLiveFeed && liveSnapshotRef.current && liveSnapshotRef.current.candles.length >= 60) {
        nextCandles = liveSnapshotRef.current.candles;
      } else if (advanceCandle && !useLiveFeed) {
        const newCandle = generateNextSimulatedCandle(s.candles, activeScenario, stepNum);
        nextCandles = [...s.candles.slice(-199), newCandle];
        setCandles(nextCandles);
      }

      const liveImb = useLiveFeed
        ? liveSnapshotRef.current?.orderbookImbalance ?? s.liveOrderbookImbalance
        : undefined;
      const liveHtf = useLiveFeed
        ? liveSnapshotRef.current?.htfContext ?? s.htfContext
        : undefined;

      const result = runPipelineCycle({
        cycleId: stepNum,
        candles: nextCandles,
        fundingRate: s.fundingRate,
        equity: s.equity,
        activePosition: s.activePosition,
        config: s.config,
        scenarioHint: activeScenario,
        liveOrderbookImbalance: liveImb,
        htfContext: liveHtf,
      });

      setCurrentCycle(result.cycle);
      setCycleHistory((prev) => [result.cycle, ...prev].slice(0, 30));
      setActivePosition(result.nextPosition);
      setEquity(result.equityAfter);

      if (result.closedTrade) {
        setLiveTrades((prev) => [result.closedTrade!, ...prev]);
        setEquityHistory((prev) => [...prev, result.equityAfter]);
      }
    },
    [],
  );

  // Hydrate initial 200 M15 candles & subscribe to real-time /api/btc-stream SSE ticks
  useEffect(() => {
    let mounted = true;
    let eventSource: EventSource | null = null;
    let backfillingHistory = false;

    const hydrateMarketPayload = (
      data: {
        source: MarketFeedSource;
        candles?: Candle[];
        price?: number;
        change24hPct?: number;
        bestBid?: number;
        bestAsk?: number;
        orderbookImbalance?: number;
        orderbookBids?: OrderbookLevel[];
        orderbookAsks?: OrderbookLevel[];
        fundingRate?: number;
        htfContext?: HtfContext;
        updatedAt?: number;
      },
      runInitialCycle: boolean,
    ): boolean => {
      if (!mounted || data.source === 'quant_engine_sim' || !data.candles || data.candles.length < 60) {
        return false;
      }
      const latestClose = data.price ?? data.candles[data.candles.length - 1].close;
      const snap: LiveFeedSnapshot = {
        source: data.source,
        candles: data.candles,
        price: latestClose,
        change24hPct: data.change24hPct ?? 0,
        bestBid: data.bestBid ?? latestClose,
        bestAsk: data.bestAsk ?? latestClose,
        orderbookImbalance: data.orderbookImbalance ?? 0,
        fundingRate: data.fundingRate ?? 0.0001,
        htfContext: data.htfContext,
        updatedAt: data.updatedAt ?? Date.now(),
      };
      liveSnapshotRef.current = snap;

      if (stateRef.current.scenario === 'auto_live') {
        setDataSource(snap.source);
        setCandles(snap.candles);
        setLivePrice(snap.price);
        setLiveChange24hPct(snap.change24hPct);
        setBestBid(snap.bestBid);
        setBestAsk(snap.bestAsk);
        if (Array.isArray(data.orderbookBids) && data.orderbookBids.length > 0) {
          setOrderbookBids(data.orderbookBids);
        }
        if (Array.isArray(data.orderbookAsks) && data.orderbookAsks.length > 0) {
          setOrderbookAsks(data.orderbookAsks);
        }
        setLiveOrderbookImbalance(snap.orderbookImbalance);
        setFundingRate(snap.fundingRate);
        if (snap.htfContext) {
          setHtfContext(snap.htfContext);
        }
        setLastTickAt(snap.updatedAt);
      }

      if (runInitialCycle) {
        const firstCycleId = cycleCounterRef.current++;
        const firstRun = runPipelineCycle({
          cycleId: firstCycleId,
          candles: snap.candles,
          fundingRate: snap.fundingRate,
          equity: DEFAULT_STRATEGY_CONFIG.initialCapital,
          activePosition: null,
          config: DEFAULT_STRATEGY_CONFIG,
          scenarioHint: 'auto_live',
          liveOrderbookImbalance: snap.orderbookImbalance,
          htfContext: snap.htfContext,
        });
        setCurrentCycle(firstRun.cycle);
        setCycleHistory([firstRun.cycle]);
        setActivePosition(firstRun.nextPosition);
        setEquity(firstRun.equityAfter);
      }
      return true;
    };

    const applyLiveTick = (tick: {
      source?: MarketFeedSource;
      price?: number;
      change24hPct?: number;
      bestBid?: number;
      bestAsk?: number;
      orderbookImbalance?: number;
      orderbookBids?: OrderbookLevel[];
      orderbookAsks?: OrderbookLevel[];
      fundingRate?: number;
      htfContext?: HtfContext;
      updatedAt?: number;
      latestCandle?: Candle | null;
    }) => {
      if (!mounted || !tick.source || tick.source === 'quant_engine_sim') return;
      const prevSnap = liveSnapshotRef.current;

      if ((!prevSnap || prevSnap.candles.length < 60) && !backfillingHistory) {
        backfillingHistory = true;
        fetch('/api/btc-market')
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => {
            if (payload) hydrateMarketPayload(payload, false);
          })
          .catch(() => {})
          .finally(() => {
            backfillingHistory = false;
          });
      }

      let nextCandles = prevSnap?.candles ?? [];

      if (tick.latestCandle && Number.isFinite(tick.latestCandle.close)) {
        const incoming = tick.latestCandle;
        const last = nextCandles[nextCandles.length - 1];
        if (last && last.time === incoming.time) {
          nextCandles = [...nextCandles.slice(0, -1), incoming];
        } else if (!last || incoming.time > last.time) {
          nextCandles = [...nextCandles.slice(-199), incoming];
        }
      } else if (typeof tick.price === 'number' && nextCandles.length > 0) {
        const last = nextCandles[nextCandles.length - 1];
        const updatedLast: Candle = {
          ...last,
          close: tick.price,
          high: Math.max(last.high, tick.price),
          low: Math.min(last.low, tick.price),
        };
        nextCandles = [...nextCandles.slice(0, -1), updatedLast];
      }

      const nextPrice =
        typeof tick.price === 'number'
          ? tick.price
          : nextCandles[nextCandles.length - 1]?.close ?? prevSnap?.price ?? 0;

      const updatedSnap: LiveFeedSnapshot = {
        source: tick.source,
        candles: nextCandles,
        price: nextPrice,
        change24hPct:
          typeof tick.change24hPct === 'number'
            ? tick.change24hPct
            : prevSnap?.change24hPct ?? 0,
        bestBid: typeof tick.bestBid === 'number' ? tick.bestBid : prevSnap?.bestBid ?? nextPrice,
        bestAsk: typeof tick.bestAsk === 'number' ? tick.bestAsk : prevSnap?.bestAsk ?? nextPrice,
        orderbookImbalance:
          typeof tick.orderbookImbalance === 'number'
            ? tick.orderbookImbalance
            : prevSnap?.orderbookImbalance ?? 0,
        fundingRate:
          typeof tick.fundingRate === 'number'
            ? tick.fundingRate
            : prevSnap?.fundingRate ?? 0.0001,
        htfContext: tick.htfContext ?? prevSnap?.htfContext,
        updatedAt: typeof tick.updatedAt === 'number' ? tick.updatedAt : Date.now(),
      };
      liveSnapshotRef.current = updatedSnap;

      if (stateRef.current.scenario === 'auto_live') {
        setDataSource(updatedSnap.source);
        if (updatedSnap.candles.length >= 60) {
          setCandles(updatedSnap.candles);
        }
        setLivePrice(updatedSnap.price);
        setLiveChange24hPct(updatedSnap.change24hPct);
        setBestBid(updatedSnap.bestBid);
        setBestAsk(updatedSnap.bestAsk);
        if (Array.isArray(tick.orderbookBids) && tick.orderbookBids.length > 0) {
          setOrderbookBids(tick.orderbookBids);
        }
        if (Array.isArray(tick.orderbookAsks) && tick.orderbookAsks.length > 0) {
          setOrderbookAsks(tick.orderbookAsks);
        }
        setLiveOrderbookImbalance(updatedSnap.orderbookImbalance);
        setFundingRate(updatedSnap.fundingRate);
        if (updatedSnap.htfContext) {
          setHtfContext(updatedSnap.htfContext);
        }
        setLastTickAt(updatedSnap.updatedAt);

        // Keep open position unrealized PnL synced tick-by-tick in live mode
        setActivePosition((prev) => {
          if (!prev) return prev;
          const unrealized =
            prev.side === 'LONG'
              ? (updatedSnap.price - prev.entryPrice) * prev.remainingBtc
              : (prev.entryPrice - updatedSnap.price) * prev.remainingBtc;
          return {
            ...prev,
            currentPrice: updatedSnap.price,
            unrealizedPnl: Number(unrealized.toFixed(2)),
            unrealizedPnlPct: Number(
              (((unrealized + prev.realizedPartialPnl) / prev.notionalUsd) * 100).toFixed(2),
            ),
          };
        });
      }
    };

    async function bootstrapMarket() {
      let hydratedLive = false;
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 3500);
        const res = await fetch('/api/btc-market', { signal: controller.signal });
        window.clearTimeout(timer);
        if (res.ok && mounted) {
          const data = await res.json();
          hydratedLive = hydrateMarketPayload(data, true);
        }
      } catch {
        // Fallback deterministic engine remains active until SSE/backfill completes
      }

      if (mounted && !hydratedLive) {
        executeCycleStep(false);
      }

      // Open real-time SSE stream for sub-second exchange tick updates
      if (mounted && typeof EventSource !== 'undefined') {
        eventSource = new EventSource('/api/btc-stream');
        eventSource.onmessage = (event) => {
          try {
            const parsed = JSON.parse(event.data);
            applyLiveTick(parsed);
          } catch {
            // Ignore malformed SSE event
          }
        };
      }
    }

    bootstrapMarket();
    return () => {
      mounted = false;
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [executeCycleStep]);

  // Continuous multi-agent pipeline pacing loop
  useEffect(() => {
    if (!botRunning) return;
    const intervalMs = Math.max(380, Math.round(1350 / simSpeed));
    const timer = window.setInterval(() => {
      const nextStageIdx = (stageIdxRef.current + 1) % STAGE_SEQUENCE.length;
      stageIdxRef.current = nextStageIdx;
      setActiveStage(STAGE_SEQUENCE[nextStageIdx]);

      // When pipeline wraps back to stage 0, evaluate next candle / live snapshot
      if (nextStageIdx === 0) {
        executeCycleStep(true);
      }
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [botRunning, simSpeed, executeCycleStep]);

  // Keyboard shortcut 'H' to toggle bottom 3D control dock
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === 'h' &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLSelectElement)
      ) {
        setDockCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSelectAgent = useCallback((agentId: AgentId | null) => {
    setSelectedAgentId(agentId);
    if (agentId) {
      setDrawerOpen(true);
      setActivePreset('agent_focus');
      setCameraRequest((prev) => ({
        preset: 'agent_focus',
        agentId,
        seq: (prev?.seq ?? 0) + 1,
      }));
    }
  }, []);

  const handleSelectCameraPreset = useCallback((preset: CameraPreset) => {
    setActivePreset(preset);
    if (preset !== 'agent_focus') {
      setSelectedAgentId(null);
    }
    setCameraRequest((prev) => ({
      preset,
      seq: (prev?.seq ?? 0) + 1,
    }));
  }, []);

  const handleTriggerScan = useCallback(() => {
    stageIdxRef.current = 4;
    setActiveStage('EXECUTION_SYNC');
    executeCycleStep(true);
  }, [executeCycleStep]);

  const handleChangeScenario = useCallback(
    (next: MarketScenario) => {
      setScenario(next);
      stateRef.current.scenario = next;

      if (next === 'auto_live' && liveSnapshotRef.current) {
        const snap = liveSnapshotRef.current;
        setDataSource(snap.source);
        if (snap.candles.length >= 60) {
          setCandles(snap.candles);
          stateRef.current.candles = snap.candles;
        }
        setLivePrice(snap.price);
        setLiveChange24hPct(snap.change24hPct);
        setBestBid(snap.bestBid);
        setBestAsk(snap.bestAsk);
        setLiveOrderbookImbalance(snap.orderbookImbalance);
        setFundingRate(snap.fundingRate);
        setLastTickAt(snap.updatedAt);
      }

      executeCycleStep(next !== 'auto_live', next);
    },
    [executeCycleStep],
  );

  const handleUpdateConfig = useCallback(
    (nextCfg: StrategyConfig) => {
      setConfig(nextCfg);
      if (liveTrades.length === 0 && !activePosition) {
        setEquity(nextCfg.initialCapital);
        setEquityHistory([nextCfg.initialCapital]);
      }
    },
    [liveTrades.length, activePosition],
  );

  const handleOpenManualOrder = useCallback((side: 'LONG' | 'SHORT') => {
    const s = stateRef.current;
    if (s.activePosition) return;
    const stepNum = cycleCounterRef.current++;
    const useLiveFeed =
      s.scenario === 'auto_live' && s.dataSource !== 'quant_engine_sim';
    const liveImb = useLiveFeed
      ? liveSnapshotRef.current?.orderbookImbalance ?? s.liveOrderbookImbalance
      : undefined;
    const liveHtf = useLiveFeed
      ? liveSnapshotRef.current?.htfContext ?? s.htfContext
      : undefined;

    const newPos = createManualPosition({
      id: `TRD-${stepNum.toString().padStart(4, '0')}`,
      side,
      candles: s.candles,
      fundingRate: s.fundingRate,
      equity: s.equity,
      config: s.config,
      scenarioHint: s.scenario,
      liveOrderbookImbalance: liveImb,
      htfContext: liveHtf,
    });

    const entryFee = Math.max(0, -newPos.realizedPartialPnl);
    const nextEq = Number((s.equity - entryFee).toFixed(2));
    setEquity(nextEq);
    stateRef.current.equity = nextEq;

    setActivePosition(newPos);
    stateRef.current.activePosition = newPos;
    setActiveStage('EXECUTION_SYNC');
    stageIdxRef.current = 4;

    setCurrentCycle((prev) => {
      if (!prev) return prev;
      const updated: PipelineCycle = {
        ...prev,
        cycleId: stepNum,
        stage: 'EXECUTION_SYNC',
        actionTaken: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        actionNote: `Khớp lệnh thủ công ${side} ${newPos.sizeBtc} BTC @ $${newPos.entryPrice.toLocaleString('en-US')} · SL $${newPos.stopLoss.toLocaleString('en-US')}.`,
      };
      setCycleHistory((hist) => [updated, ...hist].slice(0, 30));
      return updated;
    });
  }, []);

  const handleClosePosition = useCallback((closeRatio: 0.5 | 1) => {
    const s = stateRef.current;
    if (!s.activePosition) return;

    const useLiveFeed =
      s.scenario === 'auto_live' && s.dataSource !== 'quant_engine_sim';
    const exitPrice =
      useLiveFeed && liveSnapshotRef.current?.price
        ? liveSnapshotRef.current.price
        : s.candles[s.candles.length - 1]?.close ?? s.activePosition.currentPrice;

    const res = closePositionAtMarket({
      position: s.activePosition,
      exitPrice,
      equity: s.equity,
      closeRatio,
      useBreakEvenAfterTp1: s.config.useBreakEvenAfterTp1,
    });

    setActivePosition(res.nextPosition);
    stateRef.current.activePosition = res.nextPosition;
    setEquity(res.equityAfter);
    stateRef.current.equity = res.equityAfter;

    if (res.closedTrade) {
      setLiveTrades((prev) => [res.closedTrade!, ...prev]);
      setEquityHistory((prev) => [...prev, res.equityAfter]);
    }
  }, []);

  const isUsingLiveStream =
    scenario === 'auto_live' && dataSource !== 'quant_engine_sim';
  const currentPrice =
    isUsingLiveStream && livePrice !== null
      ? livePrice
      : candles[candles.length - 1]?.close ?? 92400;
  const open24h = candles[Math.max(0, candles.length - 96)]?.open ?? currentPrice;
  const change24hPct =
    isUsingLiveStream && liveChange24hPct !== null
      ? liveChange24hPct
      : ((currentPrice - open24h) / open24h) * 100;

  const indicators = useMemo(
    () =>
      extractIndicators(
        candles,
        fundingRate,
        scenario,
        isUsingLiveStream ? liveOrderbookImbalance : undefined,
        isUsingLiveStream ? htfContext : undefined,
        lastTickAt ?? undefined,
      ),
    [candles, fundingRate, scenario, isUsingLiveStream, liveOrderbookImbalance, htfContext, lastTickAt],
  );

  const liveStats = useMemo(
    () =>
      computePerformanceStats(
        config.initialCapital,
        equity + (activePosition ? activePosition.unrealizedPnl : 0),
        liveTrades,
        equityHistory,
      ),
    [config.initialCapital, equity, activePosition, liveTrades, equityHistory],
  );

  const syncPayload = useMemo(
    () => ({
      candles,
      cycle: currentCycle,
      activeStage,
      selectedAgentId,
      simSpeed,
      hasActivePosition: activePosition !== null,
      positionSide: activePosition?.side ?? null,
      drawerOpen,
    }),
    [
      candles,
      currentCycle,
      activeStage,
      selectedAgentId,
      simSpeed,
      activePosition,
      drawerOpen,
    ],
  );

  return (
    <div
      className="min-h-screen w-full bg-[#080C14] text-slate-100 flex flex-col"
      data-bot-state={botRunning ? 'running' : 'paused'}
    >
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        botRunning={botRunning}
        onToggleBot={() => setBotRunning((v) => !v)}
      />

      {/* Compact Mobile Navigation Row (only shown on < md viewports) */}
      <nav
        aria-label="Điều hướng di động"
        className="flex md:hidden items-center gap-1 px-3 py-2 bg-[#0A0F1A] border-b border-white/10 overflow-x-auto"
      >
        {(
          [
            ['war_room_3d', '3D Agents'],
            ['pipeline_az', 'Quy trình A–Z'],
            ['backtest_journal', 'Backtest'],
            ['strategy_config', 'Cấu hình'],
          ] as Array<[WorkspaceTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === id
                ? 'bg-amber-500 text-slate-950'
                : 'text-slate-300 bg-white/5'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 relative">
        {activeTab === 'war_room_3d' && (
          <div className="relative w-full h-[calc(100vh-3.5rem)] overflow-hidden">
            {/* Full-Viewport 3D Spatial War Room */}
            <WarRoom3DCanvas
              syncPayload={syncPayload}
              cameraRequest={cameraRequest}
              onSelectAgent={handleSelectAgent}
            />

            {/* Top-Left Compact Telemetry Overlay (Unboxed tabular figures, no backdrop-blur) */}
            <div className="fixed top-28 md:top-16 left-3 md:left-4 z-20 bg-[#0C121E]/92 border border-white/12 rounded-xl px-3 md:px-4 py-2 md:py-3 max-w-[calc(100vw-11rem)] md:max-w-[calc(100vw-2rem)] shadow-xl pointer-events-auto">
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
                <div>
                  <span
                    data-testid="btc-feed-source"
                    className="text-[11px] text-slate-400 block font-mono tabular-nums"
                  >
                    BTC/USDT ·{' '}
                    {isUsingLiveStream
                      ? formatFeedSourceLabel(dataSource)
                      : scenario !== 'auto_live'
                        ? 'Mô phỏng Kịch bản'
                        : 'Quant Engine'}
                    {isUsingLiveStream && lastTickAt
                      ? ` · ${new Date(lastTickAt).toLocaleTimeString('vi-VN', { hour12: false })}`
                      : ''}
                  </span>
                  <div className="flex items-baseline gap-2">
                    <span
                      data-testid="btc-live-price"
                      className="font-mono text-xl font-bold text-slate-50 tabular-nums"
                    >
                      ${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span
                      data-testid="btc-live-change"
                      className={`font-mono text-xs font-semibold tabular-nums ${
                        change24hPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {change24hPct >= 0 ? '+' : ''}
                      {change24hPct.toFixed(2)}%
                    </span>
                  </div>
                  {isUsingLiveStream && bestBid !== null && bestAsk !== null && (
                    <span
                      data-testid="btc-live-spread"
                      className="hidden sm:block font-mono text-[10px] text-slate-400 tabular-nums mt-0.5"
                    >
                      Bid ${bestBid.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Ask ${bestAsk.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  )}
                </div>

                <div className="h-7 w-px bg-white/10 hidden sm:block" aria-hidden="true" />

                <div>
                  <span className="text-[11px] text-slate-400 block">Vốn Phiên Thực tế</span>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
                      ${liveStats.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    {liveStats.totalPnlUsd !== 0 && (
                      <span
                        className={`font-mono text-[11px] font-semibold tabular-nums ${
                          liveStats.totalPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {liveStats.totalPnlUsd >= 0 ? '+' : ''}$
                        {liveStats.totalPnlUsd.toLocaleString('en-US', {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        })}
                      </span>
                    )}
                  </div>
                </div>

                <div className="hidden sm:block">
                  <span className="text-[11px] text-slate-400 block">Tỷ lệ thắng Chiến lược</span>
                  <span className="font-mono text-sm font-semibold text-emerald-400 tabular-nums">
                    {initialBacktest.stats.winRatePct}% · PF {initialBacktest.stats.profitFactor}
                  </span>
                </div>
              </div>
            </div>

            {/* Right Collapsible Agent Council & Order Execution Drawer */}
            <PipelineDrawer
              open={drawerOpen}
              onToggleOpen={() => setDrawerOpen((v) => !v)}
              candles={candles}
              cycle={currentCycle}
              activeStage={activeStage}
              selectedAgentId={selectedAgentId}
              onSelectAgent={handleSelectAgent}
              activePosition={activePosition}
              currentPrice={currentPrice}
              bestBid={bestBid}
              bestAsk={bestAsk}
              orderbookBids={orderbookBids}
              orderbookAsks={orderbookAsks}
              orderbookImbalance={indicators.orderbookImbalance}
              liveTrades={liveTrades}
              isUsingLiveStream={isUsingLiveStream}
              onOpenOrder={handleOpenManualOrder}
              onClosePosition={handleClosePosition}
            />

            {/* Bottom Collapsible 3D Control Dock */}
            <BottomDock
              collapsed={dockCollapsed}
              onToggleCollapse={() => setDockCollapsed((v) => !v)}
              activePreset={activePreset}
              onSelectPreset={handleSelectCameraPreset}
              simSpeed={simSpeed}
              onChangeSpeed={setSimSpeed}
              scenario={scenario}
              onChangeScenario={handleChangeScenario}
              onTriggerScan={handleTriggerScan}
            />
          </div>
        )}

        {activeTab === 'pipeline_az' && (
          <PipelineDeepDiveView
            cycle={currentCycle}
            indicators={indicators}
            cycleHistory={cycleHistory}
            onTriggerScan={handleTriggerScan}
          />
        )}

        {activeTab === 'backtest_journal' && (
          <BacktestJournalView
            config={config}
            liveTrades={liveTrades}
            initialBacktest={initialBacktest}
          />
        )}

        {activeTab === 'strategy_config' && (
          <StrategyConfigView
            config={config}
            onUpdateConfig={handleUpdateConfig}
          />
        )}
      </main>
    </div>
  );
}
