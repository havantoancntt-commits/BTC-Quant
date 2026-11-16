import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import {
  extractIndicators,
  generateNextSimulatedCandle,
  generateRealisticBTCSeries,
} from './engine/indicators';
import {
  closePositionAtMarket,
  computePerformanceStats,
  createInitialRiskAccountState,
  createManualPosition,
  DEFAULT_SLIPPAGE_RATE,
  DEFAULT_STRATEGY_CONFIG,
  runPipelineCycle,
  updateRiskAccountOnTradeClose,
} from './engine/multiAgentEngine';
import { runSimulationBacktest } from './engine/backtestEngine';
import type {
  AgentId,
  Candle,
  ClosedTrade,
  DataClassificationStatus,
  ExecutionOrderRecord,
  FeedHealthStatus,
  FeedHealthTelemetry,
  FuturesMarketMetrics,
  GeminiAdvisoryResponse,
  HealthDependencyEntry,
  HtfContext,
  MarketFeedSource,
  MarketScenario,
  MarketVenue,
  OrderbookLevel,
  PaperReconciliationReport,
  PipelineCycle,
  PipelineStage,
  Position,
  RiskAccountState,
  RiskEventRecord,
  StrategyConfig,
} from './engine/types';
import type { CameraPreset } from './three/AgentWarRoomScene';
import { TopBar, type WorkspaceTab } from './components/TopBar';
import { WarRoom3DCanvas } from './components/WarRoom3DCanvas';
import { BottomDock } from './components/BottomDock';
import { PipelineDrawer } from './components/PipelineDrawer';
import { PipelineDeepDiveView } from './components/PipelineDeepDiveView';
import { BacktestJournalView } from './components/BacktestJournalView';
import {
  StrategyConfigView,
  type CredentialsStatus,
  type SystemLogItem,
} from './components/StrategyConfigView';

const STAGE_SEQUENCE: PipelineStage[] = [
  'INGEST_MARKET',
  'QUANT_CONFLUENCE',
  'ORDERFLOW_SCAN',
  'STRATEGY_SYNTHESIS',
  'RISK_VETO_GATE',
  'EXECUTION_SYNC',
];

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI ErrorBoundary caught:', error.message, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#080C14] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-md bg-[#0C121E] border border-rose-500/40 rounded-xl p-6 space-y-3">
            <h1 className="font-display text-lg font-bold text-rose-400">
              Lỗi hiển thị hệ thống đã được cô lập
            </h1>
            <p className="text-xs text-slate-300 font-mono">{this.state.message}</p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="px-4 py-2 bg-amber-500 text-slate-950 text-xs font-semibold rounded-lg cursor-pointer"
            >
              Khôi phục giao diện
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function formatFeedSourceLabel(source: MarketFeedSource, venue: MarketVenue): string {
  const venuePrefix = venue === 'BINANCE_FUTURES' ? 'Futures' : 'Spot';
  switch (source) {
    case 'binance_spot_ws_live':
    case 'binance_futures_ws_live':
    case 'binance_ws_live':
      return `Binance ${venuePrefix} WS`;
    case 'binance_spot_rest_live':
    case 'binance_futures_rest_live':
    case 'binance_rest_live':
      return `Binance ${venuePrefix} REST`;
    case 'coinbase_live':
      return 'Coinbase Spot';
    default:
      return 'Simulated Feed';
  }
}

interface LiveFeedSnapshot {
  venue: MarketVenue;
  source: MarketFeedSource;
  health?: FeedHealthTelemetry;
  candles: Candle[];
  price: number;
  change24hPct: number;
  bestBid: number;
  bestAsk: number;
  orderbookImbalance: number;
  orderbookSource: 'EXCHANGE_DEPTH' | 'UNAVAILABLE';
  aggTradeCvdDelta: number | null;
  fundingRate: number | null;
  futuresMetrics?: FuturesMarketMetrics;
  htfContext?: HtfContext;
  updatedAt: number;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('war_room_3d');
  const [botRunning, setBotRunning] = useState<boolean>(true);
  const [config, setConfig] = useState<StrategyConfig>(DEFAULT_STRATEGY_CONFIG);

  // Market & Feed Health State
  const [dataSource, setDataSource] = useState<MarketFeedSource>('quant_engine_sim');
  const [feedHealth, setFeedHealth] = useState<FeedHealthTelemetry | null>(null);
  const [candles, setCandles] = useState<Candle[]>(() =>
    generateRealisticBTCSeries(120, 92400, 20261115),
  );
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [liveChange24hPct, setLiveChange24hPct] = useState<number | null>(null);
  const [bestBid, setBestBid] = useState<number | null>(null);
  const [bestAsk, setBestAsk] = useState<number | null>(null);
  const [orderbookBids, setOrderbookBids] = useState<OrderbookLevel[]>([]);
  const [orderbookAsks, setOrderbookAsks] = useState<OrderbookLevel[]>([]);
  const [orderbookSource, setOrderbookSource] = useState<'EXCHANGE_DEPTH' | 'UNAVAILABLE'>(
    'UNAVAILABLE',
  );
  const [liveOrderbookImbalance, setLiveOrderbookImbalance] = useState<number | undefined>(
    undefined,
  );
  const [aggTradeCvdDelta, setAggTradeCvdDelta] = useState<number | null>(null);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [fundingRate, setFundingRate] = useState<number | null>(null);
  const [futuresMetrics, setFuturesMetrics] = useState<FuturesMarketMetrics | undefined>(undefined);
  const [htfContext, setHtfContext] = useState<HtfContext | undefined>(undefined);
  const [scenario, setScenario] = useState<MarketScenario>('auto_live');

  // Persisted Portfolio, Orders, Reconciliation & Risk State
  const [equity, setEquity] = useState<number>(DEFAULT_STRATEGY_CONFIG.initialCapital);
  const [accountState, setAccountState] = useState<RiskAccountState>(() =>
    createInitialRiskAccountState(DEFAULT_STRATEGY_CONFIG.initialCapital),
  );
  const [activePosition, setActivePosition] = useState<Position | null>(null);
  const [liveTrades, setLiveTrades] = useState<ClosedTrade[]>([]);
  const [orders, setOrders] = useState<ExecutionOrderRecord[]>([]);
  const [reconciliation, setReconciliation] = useState<PaperReconciliationReport | null>(null);
  const [healthDependencies, setHealthDependencies] = useState<
    Record<string, HealthDependencyEntry> | null
  >(null);
  const [riskEvents, setRiskEvents] = useState<RiskEventRecord[]>([]);
  const [credentials, setCredentials] = useState<CredentialsStatus | null>(null);
  const [systemLogs, setSystemLogs] = useState<SystemLogItem[]>([]);
  const [equityHistory, setEquityHistory] = useState<number[]>([
    DEFAULT_STRATEGY_CONFIG.initialCapital,
  ]);
  const [manualRejectionReason, setManualRejectionReason] = useState<string | null>(null);

  // Gemini Advisory State
  const [geminiAdvisory, setGeminiAdvisory] = useState<GeminiAdvisoryResponse | null>(null);
  const [geminiLoading, setGeminiLoading] = useState<boolean>(false);

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

  const stateRef = useRef({
    candles,
    fundingRate,
    equity,
    accountState,
    activePosition,
    config,
    scenario,
    dataSource,
    feedHealth,
    bestBid,
    bestAsk,
    liveOrderbookImbalance,
    aggTradeCvdDelta,
    reconciliation,
    htfContext,
  });
  stateRef.current = {
    candles,
    fundingRate,
    equity,
    accountState,
    activePosition,
    config,
    scenario,
    dataSource,
    feedHealth,
    bestBid,
    bestAsk,
    liveOrderbookImbalance,
    aggTradeCvdDelta,
    reconciliation,
    htfContext,
  };

  // Sync state transitions to SQLite backend
  const syncServerState = useCallback(
    (payload: {
      accountState?: RiskAccountState;
      activePosition?: Position | null;
      newTrade?: ClosedTrade | null;
      riskEvent?: RiskEventRecord | null;
    }) => {
      void fetch('/api/state/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    },
    [],
  );

  // Dispatch order to Execution Adapter (SIMULATION / PAPER / TESTNET)
  const submitExecutionOrder = useCallback(
    async (params: {
      clientOrderId: string;
      side: 'BUY' | 'SELL';
      positionSide: 'LONG' | 'SHORT';
      orderType?: 'MARKET' | 'LIMIT';
      qtyBtc: number;
      referencePrice: number;
      limitPrice?: number;
      expiresInMs?: number;
    }): Promise<ExecutionOrderRecord | null> => {
      try {
        const res = await fetch('/api/execution/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...params,
            mode: stateRef.current.config.executionMode,
            venue: stateRef.current.config.marketVenue,
          }),
        });
        const data = await res.json();
        if (data?.order) {
          setOrders((prev) => {
            const withoutDup = prev.filter((o) => o.clientOrderId !== data.order.clientOrderId);
            return [data.order, ...withoutDup].slice(0, 50);
          });
        }
        if (data?.reconciliation) {
          setReconciliation(data.reconciliation);
        }
        return data?.order ?? null;
      } catch {
        return null;
      }
    },
    [],
  );

  const handleCancelOrder = useCallback(async (clientOrderId: string) => {
    try {
      const res = await fetch('/api/execution/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientOrderId }),
      });
      const data = await res.json();
      if (data?.order) {
        setOrders((prev) =>
          prev.map((o) => (o.clientOrderId === clientOrderId ? data.order : o)),
        );
      }
      if (data?.reconciliation) {
        setReconciliation(data.reconciliation);
      }
    } catch {
      // Ignore transient network errors
    }
  }, []);

  // Hydrate persisted SQLite state + /api/health dependency matrix on mount
  useEffect(() => {
    let mounted = true;
    fetch('/api/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!mounted || !data?.ok) return;
        if (data.config) setConfig(data.config);
        if (data.accountState) {
          setAccountState(data.accountState);
          setEquity(data.accountState.equity);
        }
        if (data.activePosition !== undefined) {
          setActivePosition(data.activePosition);
        }
        if (Array.isArray(data.trades)) {
          setLiveTrades(data.trades);
        }
        if (Array.isArray(data.orders)) {
          setOrders(data.orders);
        }
        if (data.reconciliation) {
          setReconciliation(data.reconciliation);
        }
        if (Array.isArray(data.riskEvents)) {
          setRiskEvents(data.riskEvents);
        }
        if (data.credentials) {
          setCredentials(data.credentials);
        }
        if (Array.isArray(data.systemLogs)) {
          setSystemLogs(data.systemLogs);
        }
      })
      .catch(() => {});

    const fetchHealth = () => {
      fetch('/api/health')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!mounted || !data) return;
          if (data.dependencies) setHealthDependencies(data.dependencies);
          if (data.credentials) setCredentials(data.credentials);
        })
        .catch(() => {});
    };
    fetchHealth();
    const healthTimer = window.setInterval(fetchHealth, 15000);

    return () => {
      mounted = false;
      window.clearInterval(healthTimer);
    };
  }, []);

  const initialBacktest = useMemo(
    () => runSimulationBacktest(config, 360),
    [config],
  );

  const computeCurrentSpreadBps = (bid: number | null, ask: number | null): number => {
    if (bid === null || ask === null || bid <= 0 || ask < bid) return 0;
    const mid = (bid + ask) / 2;
    return mid > 0 ? ((ask - bid) / mid) * 10000 : 0;
  };

  // Execute one full A-to-Z pipeline cycle
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
      const liveCvd = useLiveFeed
        ? liveSnapshotRef.current?.aggTradeCvdDelta ?? s.aggTradeCvdDelta
        : null;
      const liveHtf = useLiveFeed
        ? liveSnapshotRef.current?.htfContext ?? s.htfContext
        : undefined;
      const liveFunding =
        useLiveFeed && s.config.marketVenue === 'BINANCE_FUTURES'
          ? liveSnapshotRef.current?.fundingRate ?? s.fundingRate
          : activeScenario !== 'auto_live'
            ? 0.0001
            : null;
      const dataQuality: FeedHealthStatus =
        activeScenario !== 'auto_live'
          ? 'HEALTHY'
          : s.feedHealth?.status ?? (useLiveFeed ? 'HEALTHY' : 'INCOMPLETE');

      const spreadBps = useLiveFeed ? computeCurrentSpreadBps(s.bestBid, s.bestAsk) : 1.5;

      const result = runPipelineCycle({
        cycleId: stepNum,
        candles: nextCandles,
        fundingRate: liveFunding,
        equity: s.equity,
        activePosition: s.activePosition,
        config: s.config,
        scenarioHint: activeScenario,
        liveOrderbookImbalance: liveImb,
        spreadBps,
        realAggTradeCvdDelta: liveCvd,
        htfContext: liveHtf,
        accountState: s.accountState,
        dataQuality,
        slippageRate: s.config.executionMode === 'SIMULATION' ? 0 : DEFAULT_SLIPPAGE_RATE,
        pendingOrdersMarginUsd: s.reconciliation?.pendingOrdersMarginUsd ?? 0,
      });

      setCurrentCycle(result.cycle);
      setCycleHistory((prev) => [result.cycle, ...prev].slice(0, 30));
      setActivePosition(result.nextPosition);
      setEquity(result.equityAfter);
      if (result.nextAccountState) {
        setAccountState(result.nextAccountState);
      }

      // Persist auto trade open/close + execution adapter record
      const openedNewPosition =
        !s.activePosition &&
        result.nextPosition &&
        (result.cycle.actionTaken === 'OPEN_LONG' || result.cycle.actionTaken === 'OPEN_SHORT');

      if (openedNewPosition && result.nextPosition) {
        void submitExecutionOrder({
          clientOrderId: result.nextPosition.id,
          side: result.nextPosition.side === 'LONG' ? 'BUY' : 'SELL',
          positionSide: result.nextPosition.side,
          qtyBtc: result.nextPosition.sizeBtc,
          referencePrice: result.nextPosition.entryPrice,
        });
        syncServerState({
          accountState: result.nextAccountState ?? s.accountState,
          activePosition: result.nextPosition,
        });
      }

      if (result.closedTrade) {
        setLiveTrades((prev) => [result.closedTrade!, ...prev]);
        setEquityHistory((prev) => [...prev, result.equityAfter]);
        syncServerState({
          accountState: result.nextAccountState ?? s.accountState,
          activePosition: result.nextPosition,
          newTrade: result.closedTrade,
        });
      }
    },
    [submitExecutionOrder, syncServerState],
  );

  // Hydrate market & subscribe to SSE for selected venue (BINANCE_SPOT vs BINANCE_FUTURES)
  const selectedVenue = config.marketVenue;
  useEffect(() => {
    let mounted = true;
    let eventSource: EventSource | null = null;
    let backfillingHistory = false;

    const hydrateMarketPayload = (
      data: {
        venue?: MarketVenue;
        source: MarketFeedSource;
        health?: FeedHealthTelemetry;
        candles?: Candle[];
        price?: number;
        change24hPct?: number;
        bestBid?: number;
        bestAsk?: number;
        orderbookImbalance?: number;
        orderbookSource?: 'EXCHANGE_DEPTH' | 'UNAVAILABLE';
        orderbookBids?: OrderbookLevel[];
        orderbookAsks?: OrderbookLevel[];
        aggTradeCvdDelta?: number | null;
        fundingRate?: number | null;
        futuresMetrics?: FuturesMarketMetrics;
        htfContext?: HtfContext;
        updatedAt?: number;
      },
      runInitialCycle: boolean,
    ): boolean => {
      if (!mounted || data.source === 'quant_engine_sim' || !data.candles || data.candles.length < 60) {
        if (data.health) setFeedHealth(data.health);
        return false;
      }
      const latestClose = data.price ?? data.candles[data.candles.length - 1].close;
      const hasDepth =
        data.orderbookSource === 'EXCHANGE_DEPTH' ||
        (Array.isArray(data.orderbookBids) && data.orderbookBids.length > 0);
      const snap: LiveFeedSnapshot = {
        venue: data.venue ?? selectedVenue,
        source: data.source,
        health: data.health,
        candles: data.candles,
        price: latestClose,
        change24hPct: data.change24hPct ?? 0,
        bestBid: data.bestBid ?? latestClose,
        bestAsk: data.bestAsk ?? latestClose,
        orderbookImbalance: data.orderbookImbalance ?? 0,
        orderbookSource: hasDepth ? 'EXCHANGE_DEPTH' : 'UNAVAILABLE',
        aggTradeCvdDelta: data.aggTradeCvdDelta ?? null,
        fundingRate: data.fundingRate ?? null,
        futuresMetrics: data.futuresMetrics,
        htfContext: data.htfContext,
        updatedAt: data.updatedAt ?? Date.now(),
      };
      liveSnapshotRef.current = snap;

      if (stateRef.current.scenario === 'auto_live') {
        setDataSource(snap.source);
        if (snap.health) setFeedHealth(snap.health);
        setCandles(snap.candles);
        setLivePrice(snap.price);
        setLiveChange24hPct(snap.change24hPct);
        setBestBid(snap.bestBid);
        setBestAsk(snap.bestAsk);
        setOrderbookSource(snap.orderbookSource);
        setAggTradeCvdDelta(snap.aggTradeCvdDelta);
        if (Array.isArray(data.orderbookBids) && data.orderbookBids.length > 0) {
          setOrderbookBids(data.orderbookBids);
        }
        if (Array.isArray(data.orderbookAsks) && data.orderbookAsks.length > 0) {
          setOrderbookAsks(data.orderbookAsks);
        }
        setLiveOrderbookImbalance(hasDepth ? snap.orderbookImbalance : undefined);
        setFundingRate(snap.fundingRate);
        setFuturesMetrics(snap.futuresMetrics);
        if (snap.htfContext) {
          setHtfContext(snap.htfContext);
        }
        setLastTickAt(snap.updatedAt);
      }

      if (runInitialCycle) {
        const firstCycleId = cycleCounterRef.current++;
        const s = stateRef.current;
        const firstRun = runPipelineCycle({
          cycleId: firstCycleId,
          candles: snap.candles,
          fundingRate: snap.venue === 'BINANCE_FUTURES' ? snap.fundingRate : null,
          equity: s.equity,
          activePosition: s.activePosition,
          config: s.config,
          scenarioHint: 'auto_live',
          liveOrderbookImbalance: hasDepth ? snap.orderbookImbalance : undefined,
          spreadBps: computeCurrentSpreadBps(snap.bestBid, snap.bestAsk),
          realAggTradeCvdDelta: snap.aggTradeCvdDelta,
          htfContext: snap.htfContext,
          accountState: s.accountState,
          dataQuality: snap.health?.status ?? 'HEALTHY',
        });
        setCurrentCycle(firstRun.cycle);
        setCycleHistory((prev) => [firstRun.cycle, ...prev].slice(0, 30));
        setActivePosition(firstRun.nextPosition);
        setEquity(firstRun.equityAfter);
      }
      return true;
    };

    const applyLiveTick = (tick: {
      venue?: MarketVenue;
      source?: MarketFeedSource;
      health?: FeedHealthTelemetry;
      price?: number;
      change24hPct?: number;
      bestBid?: number;
      bestAsk?: number;
      orderbookImbalance?: number;
      orderbookSource?: 'EXCHANGE_DEPTH' | 'UNAVAILABLE';
      orderbookBids?: OrderbookLevel[];
      orderbookAsks?: OrderbookLevel[];
      aggTradeCvdDelta?: number | null;
      fundingRate?: number | null;
      futuresMetrics?: FuturesMarketMetrics;
      htfContext?: HtfContext;
      updatedAt?: number;
      latestCandle?: Candle | null;
    }) => {
      if (!mounted) return;
      if (tick.health) setFeedHealth(tick.health);
      if (!tick.source || tick.source === 'quant_engine_sim') return;
      if (tick.venue && tick.venue !== stateRef.current.config.marketVenue) return;

      const prevSnap = liveSnapshotRef.current;
      if ((!prevSnap || prevSnap.venue !== selectedVenue || prevSnap.candles.length < 60) && !backfillingHistory) {
        backfillingHistory = true;
        fetch(`/api/btc-market?venue=${encodeURIComponent(selectedVenue)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => {
            if (payload) hydrateMarketPayload(payload, false);
          })
          .catch(() => {})
          .finally(() => {
            backfillingHistory = false;
          });
      }

      let nextCandles = prevSnap?.venue === selectedVenue ? prevSnap.candles : [];
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
      const tickHasDepth =
        tick.orderbookSource === 'EXCHANGE_DEPTH' ||
        (Array.isArray(tick.orderbookBids) && tick.orderbookBids.length > 0);

      const updatedSnap: LiveFeedSnapshot = {
        venue: tick.venue ?? selectedVenue,
        source: tick.source,
        health: tick.health ?? prevSnap?.health,
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
        orderbookSource: tick.orderbookSource ?? (tickHasDepth ? 'EXCHANGE_DEPTH' : prevSnap?.orderbookSource ?? 'UNAVAILABLE'),
        aggTradeCvdDelta:
          tick.aggTradeCvdDelta !== undefined
            ? tick.aggTradeCvdDelta
            : prevSnap?.aggTradeCvdDelta ?? null,
        fundingRate:
          tick.fundingRate !== undefined ? tick.fundingRate : prevSnap?.fundingRate ?? null,
        futuresMetrics: tick.futuresMetrics ?? prevSnap?.futuresMetrics,
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
        setOrderbookSource(updatedSnap.orderbookSource);
        setAggTradeCvdDelta(updatedSnap.aggTradeCvdDelta);
        if (Array.isArray(tick.orderbookBids) && tick.orderbookBids.length > 0) {
          setOrderbookBids(tick.orderbookBids);
        }
        if (Array.isArray(tick.orderbookAsks) && tick.orderbookAsks.length > 0) {
          setOrderbookAsks(tick.orderbookAsks);
        }
        setLiveOrderbookImbalance(
          updatedSnap.orderbookSource === 'EXCHANGE_DEPTH'
            ? updatedSnap.orderbookImbalance
            : undefined,
        );
        setFundingRate(updatedSnap.fundingRate);
        setFuturesMetrics(updatedSnap.futuresMetrics);
        if (updatedSnap.htfContext) {
          setHtfContext(updatedSnap.htfContext);
        }
        setLastTickAt(updatedSnap.updatedAt);

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
            unrealizedPnlPct:
              prev.notionalUsd > 0
                ? Number(
                    (((unrealized + prev.realizedPartialPnl) / prev.notionalUsd) * 100).toFixed(2),
                  )
                : 0,
          };
        });
      }
    };

    async function bootstrapMarket() {
      let hydratedLive = false;
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 3500);
        const res = await fetch(`/api/btc-market?venue=${encodeURIComponent(selectedVenue)}`, {
          signal: controller.signal,
        });
        window.clearTimeout(timer);
        if (res.ok && mounted) {
          const data = await res.json();
          hydratedLive = hydrateMarketPayload(data, true);
        }
      } catch {
        // Fallback remains isolated until SSE completes
      }

      if (mounted && !hydratedLive) {
        executeCycleStep(false);
      }

      if (mounted && typeof EventSource !== 'undefined') {
        eventSource = new EventSource(`/api/btc-stream?venue=${encodeURIComponent(selectedVenue)}`);
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
  }, [executeCycleStep, selectedVenue]);

  // Continuous multi-agent pipeline pacing loop
  useEffect(() => {
    if (!botRunning) return;
    const intervalMs = Math.max(380, Math.round(1350 / simSpeed));
    const timer = window.setInterval(() => {
      const nextStageIdx = (stageIdxRef.current + 1) % STAGE_SEQUENCE.length;
      stageIdxRef.current = nextStageIdx;
      setActiveStage(STAGE_SEQUENCE[nextStageIdx]);

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
    stageIdxRef.current = STAGE_SEQUENCE.length - 1;
    setActiveStage('EXECUTION_SYNC');
    executeCycleStep(true);
  }, [executeCycleStep]);

  const handleChangeScenario = useCallback(
    (next: MarketScenario) => {
      setManualRejectionReason(null);
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
        setFuturesMetrics(snap.futuresMetrics);
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
        setAccountState((prev) => ({
          ...prev,
          equity: nextCfg.initialCapital,
          peakEquity: Math.max(prev.peakEquity, nextCfg.initialCapital),
          dailyStartEquity: nextCfg.initialCapital,
          weeklyStartEquity: nextCfg.initialCapital,
        }));
      }
      void fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextCfg),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((res) => {
          if (res?.config) setConfig(res.config);
        })
        .catch(() => {});
    },
    [liveTrades.length, activePosition],
  );

  const handleToggleEmergencyStop = useCallback(() => {
    const nextActive = !stateRef.current.accountState.emergencyStopActive;
    const nextAcc: RiskAccountState = {
      ...stateRef.current.accountState,
      emergencyStopActive: nextActive,
    };
    setAccountState(nextAcc);
    stateRef.current.accountState = nextAcc;

    const ev: RiskEventRecord = {
      id: `EV-KILL-${Date.now()}`,
      eventType: 'EMERGENCY_STOP',
      message: nextActive
        ? 'KÍCH HOẠT KILL SWITCH: Khóa toàn bộ lệnh mở mới (Auto & Manual).'
        : 'ĐÃ GỠ KILL SWITCH: Cho phép hệ thống đánh giá lại điều kiện vào lệnh.',
      createdAt: Date.now(),
    };
    setRiskEvents((prev) => [ev, ...prev].slice(0, 40));

    void fetch('/api/risk/emergency-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: nextActive }),
    }).catch(() => {});
  }, []);

  const handleResetSession = useCallback(() => {
    const cap = stateRef.current.config.initialCapital;
    const freshAcc = createInitialRiskAccountState(cap);
    setAccountState(freshAcc);
    setEquity(cap);
    setActivePosition(null);
    setLiveTrades([]);
    setOrders([]);
    setRiskEvents([]);
    setEquityHistory([cap]);
    setManualRejectionReason(null);

    void fetch('/api/risk/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialCapital: cap }),
    }).catch(() => {});
  }, []);

  // Manual LONG / SHORT strictly gated by Risk Guardian WITHOUT consensus inflation (supports MARKET + LIMIT)
  const handleOpenManualOrder = useCallback(
    async (
      side: 'LONG' | 'SHORT',
      options?: { orderType: 'MARKET' | 'LIMIT'; limitPrice?: number },
    ) => {
      const s = stateRef.current;
      if (s.activePosition) return;
      const orderType = options?.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET';
      const limitPrice = options?.limitPrice;
      if (orderType === 'LIMIT' && (!limitPrice || !Number.isFinite(limitPrice) || limitPrice <= 0)) {
        setManualRejectionReason('Giá Limit phải lớn hơn 0.');
        return;
      }

      const stepNum = cycleCounterRef.current++;
      const useLiveFeed =
        s.scenario === 'auto_live' && s.dataSource !== 'quant_engine_sim';
      const liveImb = useLiveFeed
        ? liveSnapshotRef.current?.orderbookImbalance ?? s.liveOrderbookImbalance
        : undefined;
      const liveCvd = useLiveFeed
        ? liveSnapshotRef.current?.aggTradeCvdDelta ?? s.aggTradeCvdDelta
        : null;
      const liveHtf = useLiveFeed
        ? liveSnapshotRef.current?.htfContext ?? s.htfContext
        : undefined;
      const spreadBps = useLiveFeed ? computeCurrentSpreadBps(s.bestBid, s.bestAsk) : 1.5;
      const dataQuality: FeedHealthStatus =
        s.scenario !== 'auto_live'
          ? 'HEALTHY'
          : s.feedHealth?.status ?? (useLiveFeed ? 'HEALTHY' : 'INCOMPLETE');

      const result = createManualPosition({
        id: `TRD-${stepNum.toString().padStart(4, '0')}`,
        side,
        candles: s.candles,
        fundingRate: s.config.marketVenue === 'BINANCE_FUTURES' ? s.fundingRate : null,
        equity: s.equity,
        config: s.config,
        scenarioHint: s.scenario,
        liveOrderbookImbalance: liveImb,
        spreadBps,
        realAggTradeCvdDelta: liveCvd,
        htfContext: liveHtf,
        accountState: s.accountState,
        dataQuality,
        hasActivePosition: Boolean(s.activePosition),
        slippageRate: s.config.executionMode === 'SIMULATION' ? 0 : DEFAULT_SLIPPAGE_RATE,
        pendingOrdersMarginUsd: s.reconciliation?.pendingOrdersMarginUsd ?? 0,
      });

      if (!result.approved || !result.position) {
        const reason =
          result.rejectionReason ?? 'Risk Guardian từ chối lệnh thủ công do không đạt chuẩn an toàn.';
        setManualRejectionReason(reason);
        const ev: RiskEventRecord = {
          id: `EV-MAN-${Date.now()}`,
          eventType: 'MANUAL_REJECTED',
          message: `Từ chối lệnh thủ công ${side}: ${reason}`,
          createdAt: Date.now(),
        };
        setRiskEvents((prev) => [ev, ...prev].slice(0, 40));
        syncServerState({ riskEvent: ev });
        return;
      }

      setManualRejectionReason(null);
      const refPrice = s.candles[s.candles.length - 1]?.close ?? result.position.entryPrice;
      const isRestingLimit =
        orderType === 'LIMIT' &&
        limitPrice !== undefined &&
        ((side === 'LONG' && limitPrice < refPrice) || (side === 'SHORT' && limitPrice > refPrice));

      if (isRestingLimit && limitPrice !== undefined) {
        const orderRecord = await submitExecutionOrder({
          clientOrderId: result.position.id,
          side: side === 'LONG' ? 'BUY' : 'SELL',
          positionSide: side,
          orderType: 'LIMIT',
          qtyBtc: result.position.sizeBtc,
          referencePrice: refPrice,
          limitPrice,
          expiresInMs: 3600_000,
        });
        setActiveStage('EXECUTION_SYNC');
        stageIdxRef.current = STAGE_SEQUENCE.length - 1;
        setCurrentCycle((prev) => {
          if (!prev) return prev;
          const updated: PipelineCycle = {
            ...prev,
            cycleId: stepNum,
            stage: 'EXECUTION_SYNC',
            actionNote: `Đặt lệnh chờ LIMIT ${side} ${result.position!.sizeBtc} BTC @ $${limitPrice.toLocaleString('en-US')} (${orderRecord?.status ?? 'NEW'}).`,
          };
          setCycleHistory((hist) => [updated, ...hist].slice(0, 30));
          return updated;
        });
        return;
      }

      const newPos = result.position;
      const nextEq = result.equityAfter;
      const nextAcc: RiskAccountState = {
        ...s.accountState,
        lastOrderAt: newPos.openedAt,
      };

      setEquity(nextEq);
      stateRef.current.equity = nextEq;
      setAccountState(nextAcc);
      stateRef.current.accountState = nextAcc;
      setActivePosition(newPos);
      stateRef.current.activePosition = newPos;
      setActiveStage('EXECUTION_SYNC');
      stageIdxRef.current = STAGE_SEQUENCE.length - 1;

      void submitExecutionOrder({
        clientOrderId: newPos.id,
        side: side === 'LONG' ? 'BUY' : 'SELL',
        positionSide: side,
        orderType,
        qtyBtc: newPos.sizeBtc,
        referencePrice: newPos.entryPrice,
        limitPrice,
      });
      syncServerState({
        accountState: nextAcc,
        activePosition: newPos,
      });

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
    },
    [submitExecutionOrder, syncServerState],
  );

  const handleClosePosition = useCallback(
    (closeRatio: 0.5 | 1) => {
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
        slippageRate: s.config.executionMode === 'SIMULATION' ? 0 : DEFAULT_SLIPPAGE_RATE,
      });

      setActivePosition(res.nextPosition);
      stateRef.current.activePosition = res.nextPosition;
      setEquity(res.equityAfter);
      stateRef.current.equity = res.equityAfter;

      let nextAcc = s.accountState;
      if (res.closedTrade) {
        nextAcc = updateRiskAccountOnTradeClose(
          s.accountState,
          res.closedTrade,
          res.equityAfter,
          s.config,
          Date.now(),
        );
        setAccountState(nextAcc);
        stateRef.current.accountState = nextAcc;
        setLiveTrades((prev) => [res.closedTrade!, ...prev]);
        setEquityHistory((prev) => [...prev, res.equityAfter]);
      }

      syncServerState({
        accountState: nextAcc,
        activePosition: res.nextPosition,
        newTrade: res.closedTrade ?? undefined,
      });
    },
    [syncServerState],
  );

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
        config.marketVenue === 'BINANCE_FUTURES' ? fundingRate : null,
        scenario,
        isUsingLiveStream ? liveOrderbookImbalance : undefined,
        isUsingLiveStream ? htfContext : undefined,
        lastTickAt ?? undefined,
        isUsingLiveStream ? computeCurrentSpreadBps(bestBid, bestAsk) : 1.5,
        isUsingLiveStream ? aggTradeCvdDelta : null,
      ),
    [
      candles,
      config.marketVenue,
      fundingRate,
      scenario,
      isUsingLiveStream,
      liveOrderbookImbalance,
      htfContext,
      lastTickAt,
      bestBid,
      bestAsk,
      aggTradeCvdDelta,
    ],
  );

  const handleRequestGeminiAdvisory = useCallback(async () => {
    setGeminiLoading(true);
    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price: currentPrice,
          venue: config.marketVenue,
          regime: currentCycle?.regime ?? 'Tích lũy Nén Biến động',
          indicators,
          councilDirection: currentCycle?.dominantDirection ?? 'NEUTRAL',
          councilScore: currentCycle?.consensusScore ?? 50,
        }),
      });
      const data = await res.json();
      if (data?.advisory) {
        setGeminiAdvisory(data.advisory);
      }
    } catch {
      setGeminiAdvisory({
        configured: false,
        model: null,
        generatedAt: Date.now(),
        verdict: 'UNAVAILABLE',
        confidencePct: 0,
        rationale: 'Không thể kết nối dịch vụ AI Advisory backend.',
        riskWarnings: [],
        disclaimer: 'Chỉ mang tính tham khảo.',
      });
    } finally {
      setGeminiLoading(false);
    }
  }, [currentPrice, config.marketVenue, currentCycle, indicators]);

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

  const dataQualityStatus: FeedHealthStatus =
    scenario !== 'auto_live'
      ? 'HEALTHY'
      : feedHealth?.status ?? (isUsingLiveStream ? 'HEALTHY' : 'INCOMPLETE');

  const standardizedDataStatus: DataClassificationStatus =
    scenario !== 'auto_live'
      ? 'SIMULATED_DATA'
      : feedHealth?.dataStatus ?? indicators.dataStatus;

  return (
    <AppErrorBoundary>
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

        <main className="flex-1 relative">
          {activeTab === 'war_room_3d' && (
            <div className="relative w-full h-[calc(100vh-3.5rem)] overflow-hidden">
              <WarRoom3DCanvas
                syncPayload={syncPayload}
                cameraRequest={cameraRequest}
                onSelectAgent={handleSelectAgent}
              />

              {/* Top-Left Compact Telemetry Overlay */}
              <div className="fixed top-28 md:top-16 left-3 md:left-4 z-20 bg-[#0C121E]/95 border border-white/12 rounded-xl px-3 md:px-4 py-2 md:py-3 max-w-[calc(100vw-11rem)] md:max-w-[calc(100vw-2rem)] shadow-xl pointer-events-auto">
                <div className="flex flex-wrap items-center gap-2 mb-1.5 text-[10px] font-mono">
                  <span
                    data-testid="data-integrity-badge"
                    className={`px-1.5 py-0.5 rounded border font-semibold ${
                      standardizedDataStatus === 'SIMULATED_DATA'
                        ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                        : standardizedDataStatus === 'LIVE_DATA'
                          ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                          : 'border-rose-500/40 text-rose-300 bg-rose-500/10'
                    }`}
                  >
                    {standardizedDataStatus}
                  </span>
                  <span className="px-1.5 py-0.5 rounded border border-white/15 text-slate-300">
                    {config.marketVenue === 'BINANCE_FUTURES' ? 'USDⓈ-M Futures' : 'Binance Spot'}
                  </span>
                  <span className="px-1.5 py-0.5 rounded border border-white/15 text-sky-300">
                    {config.executionMode}
                  </span>
                  {accountState.emergencyStopActive && (
                    <span className="px-1.5 py-0.5 rounded border border-rose-500/60 bg-rose-500/20 text-rose-300 font-semibold">
                      KILL SWITCH
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
                  <div>
                    <span
                      data-testid="btc-feed-source"
                      className="text-[11px] text-slate-400 block font-mono tabular-nums"
                    >
                      BTC/USDT · {formatFeedSourceLabel(dataSource, config.marketVenue)}
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
                        {config.marketVenue === 'BINANCE_FUTURES' && futuresMetrics?.markPrice
                          ? ` · Mark $${futuresMetrics.markPrice.toLocaleString('en-US', { maximumFractionDigits: 1 })}`
                          : ''}
                      </span>
                    )}
                  </div>

                  <div className="h-7 w-px bg-white/10 hidden sm:block" aria-hidden="true" />

                  <div>
                    <span className="text-[11px] text-slate-400 block">Vốn Phiên ({config.executionMode})</span>
                    <div className="flex items-baseline gap-2">
                      <span
                        data-testid="session-equity-value"
                        className="font-mono text-sm font-semibold text-slate-100 tabular-nums"
                      >
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
                    <span className="text-[11px] text-slate-400 block">
                      {config.marketVenue === 'BINANCE_FUTURES' ? 'Funding / Open Interest' : 'Spot Leverage Cap'}
                    </span>
                    <span className="font-mono text-xs font-semibold text-slate-200 tabular-nums">
                      {config.marketVenue === 'BINANCE_FUTURES'
                        ? `${fundingRate !== null ? `${(fundingRate * 100).toFixed(4)}%` : '--'} · OI ${
                            futuresMetrics?.openInterestBtc
                              ? `${Math.round(futuresMetrics.openInterestBtc).toLocaleString('en-US')} BTC`
                              : '--'
                          }`
                        : 'Spot 1x · N/A Funding'}
                    </span>
                  </div>
                </div>
              </div>

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
                orderbookSource={isUsingLiveStream ? orderbookSource : 'UNAVAILABLE'}
                liveTrades={liveTrades}
                orders={orders}
                reconciliation={reconciliation}
                isUsingLiveStream={isUsingLiveStream}
                config={config}
                emergencyStopActive={accountState.emergencyStopActive}
                dataQuality={dataQualityStatus}
                manualRejectionReason={manualRejectionReason}
                onDismissRejection={() => setManualRejectionReason(null)}
                onToggleEmergencyStop={handleToggleEmergencyStop}
                onOpenOrder={handleOpenManualOrder}
                onCancelOrder={handleCancelOrder}
                onClosePosition={handleClosePosition}
                geminiAdvisory={geminiAdvisory}
                geminiLoading={geminiLoading}
                onRequestGeminiAdvisory={handleRequestGeminiAdvisory}
              />

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
              riskEvents={riskEvents}
              healthTelemetry={feedHealth}
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
              accountState={accountState}
              credentials={credentials}
              healthDependencies={healthDependencies}
              reconciliation={reconciliation}
              systemLogs={systemLogs}
              onToggleEmergencyStop={handleToggleEmergencyStop}
              onResetSession={handleResetSession}
            />
          )}
        </main>
      </div>
    </AppErrorBoundary>
  );
}
