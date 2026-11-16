import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { AgentId, Candle, PipelineCycle, PipelineStage } from '../engine/types';

export type CameraPreset = 'overview' | 'btc_core' | 'risk_desk' | 'agent_focus';

export interface SceneSyncPayload {
  candles: Candle[];
  cycle: PipelineCycle | null;
  activeStage: PipelineStage;
  selectedAgentId: AgentId | null;
  simSpeed: number;
  hasActivePosition: boolean;
  positionSide: 'LONG' | 'SHORT' | null;
  drawerOpen?: boolean;
}

const AGENT_ORDER: AgentId[] = [
  'macro_scout',
  'quant_analyst',
  'orderflow_radar',
  'strategy_architect',
  'risk_guardian',
  'execution_commander',
];

const AGENT_COLORS: Record<AgentId, number> = {
  macro_scout: 0x38bdf8,
  quant_analyst: 0x818cf8,
  orderflow_radar: 0x2dd4bf,
  strategy_architect: 0xa78bfa,
  risk_guardian: 0xf59e0b,
  execution_commander: 0x10b981,
};

const STAGE_ACTIVE_AGENT: Record<PipelineStage, AgentId> = {
  INGEST_MARKET: 'macro_scout',
  QUANT_CONFLUENCE: 'quant_analyst',
  ORDERFLOW_SCAN: 'orderflow_radar',
  STRATEGY_SYNTHESIS: 'strategy_architect',
  RISK_VETO_GATE: 'risk_guardian',
  EXECUTION_SYNC: 'execution_commander',
};

// Pre-allocated scratch math helpers (zero GC inside animation loop)
const _scratchVec3 = new THREE.Vector3();
const _scratchTarget = new THREE.Vector3();
const _scratchColor = new THREE.Color();

function detectSoftwareGl(): boolean {
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function createFloorTelemetryTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);

  // Concentric calibration rings
  const radii = [120, 220, 320, 420, 485];
  radii.forEach((r, idx) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = idx === 3 ? 'rgba(245, 158, 11, 0.34)' : 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = idx === 3 ? 2.5 : 1.5;
    if (idx === 1 || idx === 4) {
      ctx.setLineDash([8, 10]);
    } else {
      ctx.setLineDash([]);
    }
    ctx.stroke();
  });

  ctx.setLineDash([]);

  // Radial degree ticks around outer ring
  for (let i = 0; i < 72; i++) {
    const angle = (i / 72) * Math.PI * 2;
    const inner = i % 6 === 0 ? 458 : 472;
    const outer = 485;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.strokeStyle = i % 6 === 0 ? 'rgba(245, 158, 11, 0.45)' : 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = i % 6 === 0 ? 2 : 1;
    ctx.stroke();
  }

  // Hexagonal radial axis lines to 6 stations
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * 125, cy + Math.sin(angle) * 125);
    ctx.lineTo(cx + Math.cos(angle) * 420, cy + Math.sin(angle) * 420);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.65)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.28)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createBitcoinDialTextures(maxAnisotropy: number): {
  colorTex: THREE.CanvasTexture;
  bumpTex: THREE.CanvasTexture;
} {
  const size = 512;
  const cCanvas = document.createElement('canvas');
  cCanvas.width = size;
  cCanvas.height = size;
  const ctx = cCanvas.getContext('2d')!;

  const bCanvas = document.createElement('canvas');
  bCanvas.width = size;
  bCanvas.height = size;
  const bCtx = bCanvas.getContext('2d')!;

  const cx = size / 2;
  const cy = size / 2;

  // Deep obsidian-bronze brushed dial base
  const bg = ctx.createRadialGradient(cx, cy, 18, cx, cy, size * 0.48);
  bg.addColorStop(0, '#2a1f0d');
  bg.addColorStop(0.55, '#131926');
  bg.addColorStop(0.88, '#0c111d');
  bg.addColorStop(1, '#1a140a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  bCtx.fillStyle = '#606060';
  bCtx.fillRect(0, 0, size, size);

  // Fine lathe concentric grooves
  for (let r = 36; r < 236; r += 6) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = r % 24 === 0 ? 'rgba(251, 191, 36, 0.22)' : 'rgba(245, 158, 11, 0.06)';
    ctx.lineWidth = r % 24 === 0 ? 1.8 : 1;
    ctx.stroke();

    bCtx.beginPath();
    bCtx.arc(cx, cy, r, 0, Math.PI * 2);
    bCtx.strokeStyle = r % 24 === 0 ? '#b8b8b8' : '#787878';
    bCtx.lineWidth = 1.2;
    bCtx.stroke();
  }

  // Subtle cryptographic radial spokes
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * Math.PI * 2;
    const isMajor = i % 5 === 0;
    const r0 = isMajor ? 186 : 198;
    const r1 = 222;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0);
    ctx.lineTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
    ctx.strokeStyle = isMajor ? 'rgba(251, 191, 36, 0.65)' : 'rgba(245, 158, 11, 0.24)';
    ctx.lineWidth = isMajor ? 2.6 : 1.2;
    ctx.stroke();

    bCtx.beginPath();
    bCtx.moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0);
    bCtx.lineTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
    bCtx.strokeStyle = isMajor ? '#e8e8e8' : '#9c9c9c';
    bCtx.lineWidth = isMajor ? 2.4 : 1.1;
    bCtx.stroke();
  }

  // Inner subtle octagonal circuit frame
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = cx + Math.cos(a) * 168;
    const y = cy + Math.sin(a) * 168;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.28)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const colorTex = new THREE.CanvasTexture(cCanvas);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.anisotropy = maxAnisotropy;

  const bumpTex = new THREE.CanvasTexture(bCanvas);
  bumpTex.anisotropy = maxAnisotropy;

  return { colorTex, bumpTex };
}

function createBitcoinGlyphGeometry(): THREE.ExtrudeGeometry {
  // Authentic Satoshi Bitcoin 'B' shape with smooth bezier bowls and counter-holes
  const bShape = new THREE.Shape();
  bShape.moveTo(-0.28, -0.37);
  bShape.lineTo(0.05, -0.37);
  bShape.bezierCurveTo(0.24, -0.37, 0.31, -0.29, 0.31, -0.175);
  bShape.bezierCurveTo(0.31, -0.06, 0.24, -0.015, 0.145, 0.008);
  bShape.bezierCurveTo(0.225, 0.028, 0.275, 0.085, 0.275, 0.19);
  bShape.bezierCurveTo(0.275, 0.305, 0.205, 0.37, 0.035, 0.37);
  bShape.lineTo(-0.28, 0.37);
  bShape.lineTo(-0.28, 0.275);
  bShape.lineTo(-0.175, 0.275);
  bShape.lineTo(-0.175, -0.275);
  bShape.lineTo(-0.28, -0.275);
  bShape.closePath();

  // Upper inner D-bowl hole (clockwise)
  const upperHole = new THREE.Path();
  upperHole.moveTo(-0.048, 0.278);
  upperHole.lineTo(-0.048, 0.058);
  upperHole.lineTo(0.03, 0.058);
  upperHole.bezierCurveTo(0.125, 0.058, 0.165, 0.105, 0.165, 0.168);
  upperHole.bezierCurveTo(0.165, 0.232, 0.125, 0.278, 0.03, 0.278);
  upperHole.closePath();
  bShape.holes.push(upperHole);

  // Lower inner D-bowl hole (clockwise)
  const lowerHole = new THREE.Path();
  lowerHole.moveTo(-0.048, -0.045);
  lowerHole.lineTo(-0.048, -0.278);
  lowerHole.lineTo(0.048, -0.278);
  lowerHole.bezierCurveTo(0.155, -0.278, 0.195, -0.228, 0.195, -0.162);
  lowerHole.bezierCurveTo(0.195, -0.095, 0.155, -0.045, 0.048, -0.045);
  lowerHole.closePath();
  bShape.holes.push(lowerHole);

  const geo = new THREE.ExtrudeGeometry(bShape, {
    depth: 0.16,
    bevelEnabled: true,
    bevelThickness: 0.018,
    bevelSize: 0.014,
    bevelSegments: 3,
    curveSegments: 24,
  });
  // Center along Z so glyph protrudes equally on front & back coin faces
  geo.translate(0, 0, -0.08);
  return geo;
}

interface AgentRig {
  id: AgentId;
  group: THREE.Group;
  headGroup: THREE.Group;
  accentMeshes: THREE.Mesh[];
  statusMaterial: THREE.MeshStandardMaterial;
  haloMesh: THREE.Mesh;
  proxyMesh: THREE.Mesh;
  nameplateSprite: THREE.Sprite;
  position: THREE.Vector3;
}

const AGENT_SHORT_LABELS: Record<AgentId, string> = {
  macro_scout: '01 · TRINH SÁT VĨ MÔ',
  quant_analyst: '02 · ĐỊNH LƯỢNG',
  orderflow_radar: '03 · SỔ LỆNH THANH KHOẢN',
  strategy_architect: '04 · CHIẾN LƯỢC',
  risk_guardian: '05 · KHIÊN RỦI RO',
  execution_commander: '06 · KHỚP LỆNH',
};

function createAgentLabelTexture(label: string, accentHex: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  const hexStr = `#${accentHex.toString(16).padStart(6, '0')}`;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Subtle dark slate backing with hairline border
  ctx.fillStyle = 'rgba(10, 15, 26, 0.88)';
  ctx.strokeStyle = hexStr;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(8, 10, 496, 76, 16);
  ctx.fill();
  ctx.stroke();

  // Left accent marker bar
  ctx.fillStyle = hexStr;
  ctx.fillRect(24, 28, 8, 40);

  // Crisp Vietnamese label
  ctx.fillStyle = '#f8fafc';
  ctx.font = '600 28px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 48, 49);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface DataPulseUnit {
  mesh: THREE.Mesh;
  curveIndex: number;
  progress: number;
  speed: number;
  active: boolean;
}

export class AgentWarRoomScene {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private isSoftwareGl: boolean;

  private clock = new THREE.Clock();
  private frameId = 0;
  private disposed = false;

  private agentRigs = new Map<AgentId, AgentRig>();
  private interactables: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private lastHoverCheck = 0;
  private hoveredAgentId: AgentId | null = null;

  // Central BTC core animated parts
  private btcCoinGroup = new THREE.Group();
  private emitterMat!: THREE.MeshStandardMaterial;
  private coreBeaconMat!: THREE.MeshBasicMaterial;
  private gimbalOuter!: THREE.Mesh;
  private gimbalInner!: THREE.Mesh;
  private candleBars: Array<{ body: THREE.Mesh; wick: THREE.Mesh; mat: THREE.MeshStandardMaterial }> = [];

  // Collaboration conduits & pulses
  private conduits: Array<{
    from: AgentId | 'core';
    to: AgentId | 'core';
    curve: THREE.CatmullRomCurve3;
    material: THREE.MeshStandardMaterial;
  }> = [];
  private pulseUnits: DataPulseUnit[] = [];
  private shockwaveRing!: THREE.Mesh;
  private shockwaveMat!: THREE.MeshBasicMaterial;
  private shockwaveTimer = 0;

  // Camera transition targets (cancelled on OrbitControls 'start')
  private camTransitionActive = false;
  private currentPreset: CameraPreset = 'overview';
  private lastDrawerOpen: boolean | undefined = undefined;
  private camDesiredPos = new THREE.Vector3(1.5, 10.6, 15.8);
  private camDesiredTarget = new THREE.Vector3(1.5, 1.15, 0);

  // Synced state ref
  private syncState: SceneSyncPayload = {
    candles: [],
    cycle: null,
    activeStage: 'INGEST_MARKET',
    selectedAgentId: null,
    simSpeed: 1,
    hasActivePosition: false,
    positionSide: null,
    drawerOpen: true,
  };
  private lastCycleId = -1;

  private onSelectAgentCb: (agentId: AgentId | null) => void;
  private shadowTex: THREE.CanvasTexture;
  private floorTex: THREE.CanvasTexture;
  private coinDialTex: THREE.CanvasTexture;
  private coinBumpTex: THREE.CanvasTexture;

  constructor(
    container: HTMLElement,
    onSelectAgent: (agentId: AgentId | null) => void,
  ) {
    this.container = container;
    this.onSelectAgentCb = onSelectAgent;
    this.isSoftwareGl = detectSoftwareGl();

    // Renderer setup following Three.js skill Software-WebGL guard
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: this.isSoftwareGl,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 320);
    this.renderer.setSize(width, height);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    // Scene & Horizon Fog
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070b12);
    this.scene.fog = new THREE.FogExp2(0x070b12, 0.025);

    // Procedural Studio Environment Map (RoomEnvironment) on all devices
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // Camera & OrbitControls (center stage offset left when desktop drawer is open)
    const initialShift = width >= 768 ? 1.5 : 0;
    this.camDesiredPos.set(initialShift, 10.6, 15.8);
    this.camDesiredTarget.set(initialShift, 1.15, 0);
    this.camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 120);
    this.camera.position.copy(this.camDesiredPos);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.camDesiredTarget);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 5.2;
    this.controls.maxDistance = 24;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minPolarAngle = 0.15;
    this.controls.addEventListener('start', () => {
      this.camTransitionActive = false;
    });

    this.shadowTex = createContactShadowTexture();
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.floorTex = createFloorTelemetryTexture(maxAniso);
    const coinTextures = createBitcoinDialTextures(maxAniso);
    this.coinDialTex = coinTextures.colorTex;
    this.coinBumpTex = coinTextures.bumpTex;

    this.setupLighting();
    this.buildArenaFloor();
    this.buildCentralBtcCore();
    this.buildAllAgents();
    this.buildConduitsAndPulses();
    this.buildShockwaveRing();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.bindEvents();
    this.startLoop();
  }

  private setupLighting(): void {
    // Warm directional Key Light
    const keyLight = new THREE.DirectionalLight(0xfff1db, 2.2);
    keyLight.position.set(8, 14, 10);
    keyLight.castShadow = !this.isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 36;
    const d = 12;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    this.scene.add(keyLight);

    // Cool Sky / Deep Slate Ground Hemisphere Fill
    const hemi = new THREE.HemisphereLight(0x88b4e6, 0x0b111c, 0.95);
    this.scene.add(hemi);

    // Cool Rim Backlight
    const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.9);
    rimLight.position.set(-9, 8, -10);
    this.scene.add(rimLight);
  }

  private buildArenaFloor(): void {
    // Deep matte architectural base deck
    const baseGeo = new THREE.CylinderGeometry(18, 18.5, 0.35, 64);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x0c121e,
      roughness: 0.85,
      metalness: 0.25,
    });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.y = -0.2;
    baseMesh.receiveShadow = true;
    this.scene.add(baseMesh);

    // Raised inner war-room platform (offset >= 0.02 on Y)
    const innerDeckGeo = new THREE.CylinderGeometry(8.6, 8.9, 0.14, 48);
    const innerDeckMat = new THREE.MeshStandardMaterial({
      color: 0x111927,
      roughness: 0.65,
      metalness: 0.4,
    });
    const innerDeck = new THREE.Mesh(innerDeckGeo, innerDeckMat);
    innerDeck.position.y = -0.05;
    innerDeck.receiveShadow = true;
    this.scene.add(innerDeck);

    // Telemetry floor overlay with polygonOffset to avoid Z-fighting
    const overlayGeo = new THREE.PlaneGeometry(16.6, 16.6);
    const overlayMat = new THREE.MeshBasicMaterial({
      map: this.floorTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const overlay = new THREE.Mesh(overlayGeo, overlayMat);
    overlay.rotation.x = -Math.PI / 2;
    overlay.position.y = 0.025;
    this.scene.add(overlay);
  }

  private buildCentralBtcCore(): void {
    const coreGroup = new THREE.Group();
    coreGroup.position.set(0, 0.02, 0);

    // Contact shadow disc
    const shadowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(2.6, 32),
      new THREE.MeshBasicMaterial({
        map: this.shadowTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    shadowDisc.rotation.x = -Math.PI / 2;
    shadowDisc.position.y = 0.015;
    coreGroup.add(shadowDisc);

    // 1. Hexagonal stepped pedestal (ExtrudeGeometry with bevel)
    const hexShape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const r = 1.95;
      if (i === 0) hexShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else hexShape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    hexShape.closePath();

    const plinthGeo = new THREE.ExtrudeGeometry(hexShape, {
      depth: 0.34,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.08,
      bevelSegments: 2,
    });
    plinthGeo.rotateX(-Math.PI / 2);
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0x161f30,
      roughness: 0.72,
      metalness: 0.35,
    });
    const plinth = new THREE.Mesh(plinthGeo, plinthMat);
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    coreGroup.add(plinth);

    // 2. Brushed titanium collar
    const collarGeo = new THREE.CylinderGeometry(1.38, 1.56, 0.24, 32);
    const collarMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.28,
      metalness: 0.88,
    });
    const collar = new THREE.Mesh(collarGeo, collarMat);
    collar.position.y = 0.52;
    collar.castShadow = true;
    coreGroup.add(collar);

    // 3. Glowing emitter ring (dynamically shifts emerald LONG / rose SHORT / amber Standby)
    const ringGeo = new THREE.TorusGeometry(1.32, 0.045, 12, 48);
    this.emitterMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.4,
      roughness: 0.2,
      metalness: 0.5,
    });
    const emitterRing = new THREE.Mesh(ringGeo, this.emitterMat);
    emitterRing.rotation.x = Math.PI / 2;
    emitterRing.position.y = 0.66;
    coreGroup.add(emitterRing);

    // Subtle open-position spatial aura cylinder (visible only during active trade)
    const beaconGeo = new THREE.CylinderGeometry(1.18, 1.28, 3.1, 32, 1, true);
    this.coreBeaconMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const coreBeacon = new THREE.Mesh(beaconGeo, this.coreBeaconMat);
    coreBeacon.position.y = 2.2;
    coreGroup.add(coreBeacon);

    // 4. Precision orbital astrolabe rings (equatorial framing — never slicing across the ₿ emblem)
    const gimbalMat = new THREE.MeshPhysicalMaterial({
      color: 0xfbbf24,
      roughness: 0.16,
      metalness: 0.92,
      clearcoat: 0.8,
      clearcoatRoughness: 0.12,
    });
    this.gimbalOuter = new THREE.Mesh(
      new THREE.TorusGeometry(1.42, 0.024, 12, 64),
      collarMat,
    );
    this.gimbalOuter.position.y = 1.62;
    this.gimbalOuter.rotation.set(Math.PI / 2 - 0.16, 0, 0);
    coreGroup.add(this.gimbalOuter);

    this.gimbalInner = new THREE.Mesh(
      new THREE.TorusGeometry(1.16, 0.02, 12, 56),
      gimbalMat,
    );
    this.gimbalInner.position.y = 2.18;
    this.gimbalInner.rotation.set(Math.PI / 2 + 0.18, 0.15, 0);
    coreGroup.add(this.gimbalInner);

    // 5. Sculpted Institutional 24K Bitcoin Medallion (Satin Obsidian Dial + Radiant Bitcoin Gold Relief)
    this.btcCoinGroup.position.set(0, 2.22, 0);
    const coinGoldMat = new THREE.MeshPhysicalMaterial({
      color: 0xf7931a,
      emissive: 0x9a3412,
      emissiveIntensity: 0.24,
      roughness: 0.16,
      metalness: 0.94,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
      anisotropy: 0.85,
    });
    const champagneGoldMat = new THREE.MeshPhysicalMaterial({
      color: 0xfbbf24,
      emissive: 0xb45309,
      emissiveIntensity: 0.32,
      roughness: 0.12,
      metalness: 0.95,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
    });
    const coinDialMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.coinDialTex,
      bumpMap: this.coinBumpTex,
      bumpScale: 0.018,
      roughness: 0.56,
      metalness: 0.34,
    });

    // Stepped beveled sovereign coin rim via LatheGeometry
    const rimPoints = [
      new THREE.Vector2(0.58, -0.055),
      new THREE.Vector2(0.66, -0.095),
      new THREE.Vector2(0.76, -0.095),
      new THREE.Vector2(0.79, -0.068),
      new THREE.Vector2(0.79, 0.068),
      new THREE.Vector2(0.76, 0.095),
      new THREE.Vector2(0.66, 0.095),
      new THREE.Vector2(0.58, 0.055),
    ];
    const coinRimGeo = new THREE.LatheGeometry(rimPoints, 48);
    coinRimGeo.rotateX(Math.PI / 2);
    const coinRimMesh = new THREE.Mesh(coinRimGeo, coinGoldMat);
    coinRimMesh.castShadow = true;
    this.btcCoinGroup.add(coinRimMesh);

    // Recessed satin obsidian-gold engraved dial core (front & back faces)
    const dialPlateGeo = new THREE.CylinderGeometry(0.64, 0.64, 0.108, 48);
    dialPlateGeo.rotateX(Math.PI / 2);
    const dialPlate = new THREE.Mesh(dialPlateGeo, coinDialMat);
    this.btcCoinGroup.add(dialPlate);

    // Inner chamfered gold chapter bezels on front & back
    for (const zSign of [-1, 1]) {
      const innerBezel = new THREE.Mesh(
        new THREE.TorusGeometry(0.625, 0.02, 10, 48),
        champagneGoldMat,
      );
      innerBezel.position.z = zSign * 0.062;
      this.btcCoinGroup.add(innerBezel);
    }

    // 48 precision reeded/knurled minting flutes around the coin edge
    const fluteCount = 48;
    const fluteGeo = new THREE.BoxGeometry(0.022, 0.022, 0.132);
    const fluteInstanced = new THREE.InstancedMesh(fluteGeo, champagneGoldMat, fluteCount);
    const fluteDummy = new THREE.Object3D();
    for (let i = 0; i < fluteCount; i++) {
      const a = (i / fluteCount) * Math.PI * 2;
      fluteDummy.position.set(Math.cos(a) * 0.792, Math.sin(a) * 0.792, 0);
      fluteDummy.rotation.set(0, 0, a);
      fluteDummy.updateMatrix();
      fluteInstanced.setMatrixAt(i, fluteDummy.matrix);
    }
    fluteInstanced.instanceMatrix.needsUpdate = true;
    fluteInstanced.computeBoundingSphere();
    this.btcCoinGroup.add(fluteInstanced);

    // Authentic beveled 3D '₿' relief emblem tilted at iconic -14 degrees
    const emblemGroup = new THREE.Group();
    emblemGroup.rotation.z = -0.244; // ~14° clockwise Bitcoin tilt
    emblemGroup.scale.setScalar(1.14);

    const bGlyphGeo = createBitcoinGlyphGeometry();
    const bGlyphMesh = new THREE.Mesh(bGlyphGeo, champagneGoldMat);
    bGlyphMesh.castShadow = true;
    emblemGroup.add(bGlyphMesh);

    // Twin currency vertical prongs protruding cleanly top & bottom
    const prongShape = new THREE.Shape();
    const pw = 0.038;
    const ph = 0.09;
    prongShape.moveTo(-pw, -ph);
    prongShape.lineTo(pw, -ph);
    prongShape.lineTo(pw, ph);
    prongShape.lineTo(-pw, ph);
    prongShape.closePath();

    const prongGeo = new THREE.ExtrudeGeometry(prongShape, {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.011,
      bevelSegments: 2,
    });
    prongGeo.translate(0, 0, -0.08);

    const prongCoords: Array<[number, number]> = [
      [-0.08, 0.405],
      [0.065, 0.405],
      [-0.08, -0.405],
      [0.065, -0.405],
    ];
    for (const [px, py] of prongCoords) {
      const prong = new THREE.Mesh(prongGeo, champagneGoldMat);
      prong.position.set(px, py, 0);
      emblemGroup.add(prong);
    }

    this.btcCoinGroup.add(emblemGroup);
    coreGroup.add(this.btcCoinGroup);

    // 6. Holographic 3D Candlestick Arc (24 live price bars around core)
    const candleArcCount = 24;
    const arcRadius = 2.65;
    for (let i = 0; i < candleArcCount; i++) {
      const t = i / (candleArcCount - 1);
      const angle = THREE.MathUtils.lerp(-Math.PI * 0.78, Math.PI * 0.78, t) + Math.PI / 2;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x10b981,
        emissive: 0x10b981,
        emissiveIntensity: 0.45,
        roughness: 0.3,
        metalness: 0.4,
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.16), mat);
      const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.75, 6), mat);

      const x = Math.cos(angle) * arcRadius;
      const z = Math.sin(angle) * arcRadius;
      body.position.set(x, 0.9, z);
      wick.position.set(x, 0.9, z);
      body.lookAt(0, 0.9, 0);

      coreGroup.add(body);
      coreGroup.add(wick);
      this.candleBars.push({ body, wick, mat });
    }

    this.scene.add(coreGroup);
  }

  private buildAllAgents(): void {
    const stationRadius = 6.15;

    AGENT_ORDER.forEach((agentId, idx) => {
      const angle = (idx / AGENT_ORDER.length) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * stationRadius;
      const z = Math.sin(angle) * stationRadius;

      const rig = this.createCompositeAgentRig(agentId, new THREE.Vector3(x, 0.02, z));
      // Face inward toward BTC Core
      rig.group.lookAt(0, 0.02, 0);

      this.scene.add(rig.group);
      this.agentRigs.set(agentId, rig);
      this.interactables.push(rig.proxyMesh);
    });
  }

  private createCompositeAgentRig(agentId: AgentId, pos: THREE.Vector3): AgentRig {
    const accentHex = AGENT_COLORS[agentId];
    const group = new THREE.Group();
    group.position.copy(pos);

    // Contact shadow disc grounded at y = 0.015
    const shadowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.35, 24),
      new THREE.MeshBasicMaterial({
        map: this.shadowTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    shadowDisc.rotation.x = -Math.PI / 2;
    shadowDisc.position.y = 0.015;
    group.add(shadowDisc);

    const matteDark = new THREE.MeshStandardMaterial({
      color: 0x182235,
      roughness: 0.75,
      metalness: 0.25,
    });
    const brushedMetal = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.28,
      metalness: 0.88,
    });
    const visorGlass = new THREE.MeshPhysicalMaterial({
      color: 0x0f172a,
      roughness: 0.12,
      metalness: 0.2,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
    });
    const statusMaterial = new THREE.MeshStandardMaterial({
      color: accentHex,
      emissive: accentHex,
      emissiveIntensity: 0.9,
      roughness: 0.25,
      metalness: 0.5,
    });

    const accentMeshes: THREE.Mesh[] = [];

    // Part 1: Primary beveled octagonal plinth
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.12, 0.28, 8),
      matteDark,
    );
    plinth.position.y = 0.14;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    group.add(plinth);

    // Part 2: Metallic collar + glowing status ring
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.68, 0.82, 0.2, 16),
      brushedMetal,
    );
    collar.position.y = 0.38;
    collar.castShadow = true;
    group.add(collar);

    const statusRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.84, 0.035, 10, 32),
      statusMaterial,
    );
    statusRing.rotation.x = Math.PI / 2;
    statusRing.position.y = 0.3;
    group.add(statusRing);
    accentMeshes.push(statusRing);

    // Part 3: Articulated central chassis column
    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.52, 0.95, 12),
      matteDark,
    );
    torso.position.y = 0.95;
    torso.castShadow = true;
    group.add(torso);

    // Part 4: Shoulder yoke / metallic ribs
    const shoulder = new THREE.Mesh(
      new THREE.BoxGeometry(1.18, 0.18, 0.58),
      brushedMetal,
    );
    shoulder.position.y = 1.38;
    shoulder.castShadow = true;
    group.add(shoulder);

    // Part 5: Articulated Head / Holographic Sensor Array
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.82, 0);

    const headHousing = new THREE.Mesh(
      new THREE.BoxGeometry(0.64, 0.44, 0.56),
      brushedMetal,
    );
    headHousing.castShadow = true;
    headGroup.add(headHousing);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.54, 0.22, 0.08),
      visorGlass,
    );
    visor.position.set(0, 0.02, 0.27);
    headGroup.add(visor);

    const visorEyeStrip = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.06, 0.03),
      statusMaterial,
    );
    visorEyeStrip.position.set(0, 0.02, 0.31);
    headGroup.add(visorEyeStrip);
    accentMeshes.push(visorEyeStrip);

    // Part 6-8: Role-specific silhouette hardware so each Agent is visually distinct
    if (agentId === 'macro_scout') {
      // Twin parabolic radar dishes on top
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 8), brushedMetal);
      mast.position.set(0, 0.42, 0);
      headGroup.add(mast);

      const dishGeo = new THREE.SphereGeometry(0.32, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.42);
      const dish = new THREE.Mesh(dishGeo, brushedMetal);
      dish.position.set(0, 0.65, 0.05);
      dish.rotation.x = Math.PI * 0.35;
      headGroup.add(dish);

      const feedHorn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 8), statusMaterial);
      feedHorn.position.set(0, 0.72, 0.16);
      headGroup.add(feedHorn);
      accentMeshes.push(feedHorn);
    } else if (agentId === 'quant_analyst') {
      // 3 stacked oscillating quant prism blades above head
      for (let b = -1; b <= 1; b++) {
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, 0.48, 0.28),
          b === 0 ? statusMaterial : brushedMetal,
        );
        blade.position.set(b * 0.22, 0.45 + (b === 0 ? 0.1 : 0), 0);
        headGroup.add(blade);
        if (b === 0) accentMeshes.push(blade);
      }
    } else if (agentId === 'orderflow_radar') {
      // Dual concentric sonar rings flanking the head
      const sonarOuter = new THREE.Mesh(
        new THREE.TorusGeometry(0.48, 0.03, 8, 28),
        statusMaterial,
      );
      sonarOuter.position.y = 0.06;
      headGroup.add(sonarOuter);
      accentMeshes.push(sonarOuter);

      const sonarInner = new THREE.Mesh(
        new THREE.TorusGeometry(0.62, 0.022, 8, 28),
        brushedMetal,
      );
      sonarInner.rotation.y = Math.PI / 2;
      sonarInner.position.y = 0.06;
      headGroup.add(sonarInner);
    } else if (agentId === 'strategy_architect') {
      // Holographic blueprint prism core + twin geometric stabilizer wings
      const leftWing = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.56, 0.42), brushedMetal);
      leftWing.position.set(-0.48, 0.14, 0);
      leftWing.rotation.z = -0.26;
      headGroup.add(leftWing);

      const rightWing = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.56, 0.42), brushedMetal);
      rightWing.position.set(0.48, 0.14, 0);
      rightWing.rotation.z = 0.26;
      headGroup.add(rightWing);

      const stratCore = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.22, 0),
        statusMaterial,
      );
      stratCore.position.set(0, 0.56, 0);
      headGroup.add(stratCore);
      accentMeshes.push(stratCore);

      const orbitRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.36, 0.022, 8, 28),
        brushedMetal,
      );
      orbitRing.rotation.x = Math.PI / 3;
      orbitRing.position.set(0, 0.56, 0);
      headGroup.add(orbitRing);
    } else if (agentId === 'risk_guardian') {
      // Twin armored shield pylons + floating octahedral shield crystal
      const leftPylon = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.85, 0.32), matteDark);
      leftPylon.position.set(-0.56, -0.12, 0.1);
      headGroup.add(leftPylon);

      const rightPylon = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.85, 0.32), matteDark);
      rightPylon.position.set(0.56, -0.12, 0.1);
      headGroup.add(rightPylon);

      const shieldCrystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.24, 0),
        statusMaterial,
      );
      shieldCrystal.position.set(0, 0.56, 0);
      headGroup.add(shieldCrystal);
      accentMeshes.push(shieldCrystal);
    } else if (agentId === 'execution_commander') {
      // Twin execution fins + command crown beacon
      const leftFin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.68, 0.38), brushedMetal);
      leftFin.position.set(-0.46, 0.18, -0.04);
      leftFin.rotation.z = 0.18;
      headGroup.add(leftFin);

      const rightFin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.68, 0.38), brushedMetal);
      rightFin.position.set(0.46, 0.18, -0.04);
      rightFin.rotation.z = -0.18;
      headGroup.add(rightFin);

      const beacon = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 6), statusMaterial);
      beacon.position.set(0, 0.52, 0);
      headGroup.add(beacon);
      accentMeshes.push(beacon);
    }

    group.add(headGroup);

    // Selection / Active-Speaker Halo Ring on the floor
    const haloMesh = new THREE.Mesh(
      new THREE.RingGeometry(1.16, 1.32, 32),
      new THREE.MeshBasicMaterial({
        color: accentHex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    haloMesh.rotation.x = -Math.PI / 2;
    haloMesh.position.y = 0.03;
    group.add(haloMesh);

    // Simplified invisible raycast proxy on Layer 1
    const proxyMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 2.75, 12),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    proxyMesh.position.y = 1.35;
    proxyMesh.layers.set(1);
    proxyMesh.userData.agentId = agentId;
    group.add(proxyMesh);

    // Floating high-DPI role nameplate above station
    const labelTex = createAgentLabelTexture(AGENT_SHORT_LABELS[agentId], accentHex);
    const labelMat = new THREE.SpriteMaterial({
      map: labelTex,
      transparent: true,
      depthWrite: false,
    });
    const nameplateSprite = new THREE.Sprite(labelMat);
    nameplateSprite.position.set(0, 3.05, 0);
    nameplateSprite.scale.set(2.35, 0.44, 1);
    group.add(nameplateSprite);

    return {
      id: agentId,
      group,
      headGroup,
      accentMeshes,
      statusMaterial,
      haloMesh,
      proxyMesh,
      nameplateSprite,
      position: pos.clone(),
    };
  }

  private buildConduitsAndPulses(): void {
    // 1. Sequential pipeline conduits: Macro -> Quant -> Orderflow -> Strategy -> Risk -> Execution
    const links: Array<[AgentId | 'core', AgentId | 'core']> = [
      ['macro_scout', 'quant_analyst'],
      ['quant_analyst', 'orderflow_radar'],
      ['orderflow_radar', 'strategy_architect'],
      ['strategy_architect', 'risk_guardian'],
      ['risk_guardian', 'execution_commander'],
      ['execution_commander', 'core'],
    ];

    // Plus radial data feeds from Core into Macro, Quant, Orderflow
    const coreFeeds: Array<[AgentId | 'core', AgentId | 'core']> = [
      ['core', 'macro_scout'],
      ['core', 'quant_analyst'],
      ['core', 'orderflow_radar'],
    ];

    const allLinks = [...links, ...coreFeeds];

    allLinks.forEach(([fromId, toId]) => {
      const start =
        fromId === 'core'
          ? new THREE.Vector3(0, 1.1, 0)
          : this.agentRigs.get(fromId)!.position.clone().setY(1.15);
      const end =
        toId === 'core'
          ? new THREE.Vector3(0, 1.35, 0)
          : this.agentRigs.get(toId)!.position.clone().setY(1.15);

      const mid = start.clone().lerp(end, 0.5);
      mid.y += fromId === 'core' || toId === 'core' ? 0.65 : 0.95;

      const curve = new THREE.CatmullRomCurve3([start, mid, end]);
      const tubeGeo = new THREE.TubeGeometry(curve, 24, 0.032, 8, false);
      const tubeMat = new THREE.MeshStandardMaterial({
        color: fromId === 'core' ? 0xf59e0b : AGENT_COLORS[fromId],
        emissive: fromId === 'core' ? 0xf59e0b : AGENT_COLORS[fromId],
        emissiveIntensity: 0.35,
        roughness: 0.4,
        metalness: 0.5,
        transparent: true,
        opacity: 0.68,
      });

      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      this.scene.add(tube);
      this.conduits.push({ from: fromId, to: toId, curve, material: tubeMat });
    });

    // Traveling glowing data packet spheres (2 packets per conduit)
    const packetGeo = new THREE.SphereGeometry(0.11, 12, 12);
    this.conduits.forEach((conduit, cIdx) => {
      for (let k = 0; k < 2; k++) {
        const colorHex =
          conduit.from === 'core' ? 0xfbbf24 : AGENT_COLORS[conduit.from];
        const mat = new THREE.MeshBasicMaterial({ color: colorHex });
        const mesh = new THREE.Mesh(packetGeo, mat);
        this.scene.add(mesh);
        this.pulseUnits.push({
          mesh,
          curveIndex: cIdx,
          progress: k * 0.5,
          speed: 0.48 + (cIdx % 3) * 0.08,
          active: true,
        });
      }
    });
  }

  private buildShockwaveRing(): void {
    const geo = new THREE.RingGeometry(0.8, 1.15, 48);
    this.shockwaveMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.shockwaveRing = new THREE.Mesh(geo, this.shockwaveMat);
    this.shockwaveRing.rotation.x = -Math.PI / 2;
    this.shockwaveRing.position.y = 0.04;
    this.scene.add(this.shockwaveRing);
  }

  public triggerShockwave(type: 'LONG' | 'SHORT' | 'VETO'): void {
    this.shockwaveTimer = 1.0;
    this.shockwaveRing.scale.set(1, 1, 1);
    const hex = type === 'LONG' ? 0x10b981 : type === 'SHORT' ? 0xef4444 : 0xf59e0b;
    this.shockwaveMat.color.setHex(hex);
    this.shockwaveMat.opacity = 0.85;
  }

  public syncData(payload: SceneSyncPayload): void {
    this.syncState = payload;
    this.updateCandlestickArc(payload.candles);

    if (
      payload.drawerOpen !== undefined &&
      payload.drawerOpen !== this.lastDrawerOpen &&
      (this.currentPreset === 'overview' || this.currentPreset === 'btc_core')
    ) {
      const hadPrev = this.lastDrawerOpen !== undefined;
      this.lastDrawerOpen = payload.drawerOpen;
      if (hadPrev) {
        this.setCameraPreset(this.currentPreset, payload.selectedAgentId);
      }
    } else if (payload.drawerOpen !== undefined) {
      this.lastDrawerOpen = payload.drawerOpen;
    }

    if (payload.cycle && payload.cycle.cycleId !== this.lastCycleId) {
      this.lastCycleId = payload.cycle.cycleId;
      if (payload.cycle.actionTaken === 'OPEN_LONG') {
        this.triggerShockwave('LONG');
      } else if (payload.cycle.actionTaken === 'OPEN_SHORT') {
        this.triggerShockwave('SHORT');
      } else if (payload.cycle.actionTaken === 'VETO_SKIP') {
        this.triggerShockwave('VETO');
      }
    }
  }

  private updateCandlestickArc(candles: Candle[]): void {
    if (candles.length === 0 || this.candleBars.length === 0) return;
    const recent = candles.slice(-this.candleBars.length);
    const minLow = Math.min(...recent.map((c) => c.low));
    const maxHigh = Math.max(...recent.map((c) => c.high));
    const range = Math.max(maxHigh - minLow, 1);

    for (let i = 0; i < this.candleBars.length; i++) {
      const bar = this.candleBars[i];
      const candle = recent[i] ?? recent[recent.length - 1];
      const isBull = candle.close >= candle.open;
      const bodyHeight = Math.max(
        0.12,
        (Math.abs(candle.close - candle.open) / range) * 1.45,
      );
      const wickHeight = Math.max(
        bodyHeight + 0.1,
        ((candle.high - candle.low) / range) * 1.55,
      );
      const midPriceNorm = ((candle.open + candle.close) / 2 - minLow) / range;
      const baseY = 0.45 + midPriceNorm * 1.05;

      bar.body.scale.y = bodyHeight / 0.5;
      bar.body.position.y = baseY;
      bar.wick.scale.y = wickHeight / 0.75;
      bar.wick.position.y = baseY;

      const targetHex = isBull ? 0x10b981 : 0xef4444;
      bar.mat.color.setHex(targetHex);
      bar.mat.emissive.setHex(targetHex);
    }
  }

  public setCameraPreset(preset: CameraPreset, agentId?: AgentId | null): void {
    this.currentPreset = preset;
    this.camTransitionActive = true;
    const desktopDrawerShift =
      this.syncState.drawerOpen !== false && this.container.clientWidth >= 768 ? 1.5 : 0;

    if (preset === 'overview') {
      this.camDesiredPos.set(desktopDrawerShift, 10.6, 15.8);
      this.camDesiredTarget.set(desktopDrawerShift, 1.15, 0);
    } else if (preset === 'btc_core') {
      this.camDesiredPos.set(desktopDrawerShift * 0.5, 4.4, 6.2);
      this.camDesiredTarget.set(desktopDrawerShift * 0.5, 1.9, 0);
    } else if (preset === 'risk_desk') {
      const riskRig = this.agentRigs.get('risk_guardian');
      if (riskRig) {
        const dir = riskRig.position.clone().normalize();
        this.camDesiredPos.copy(riskRig.position).addScaledVector(dir, 4.8).setY(4.2);
        this.camDesiredTarget.copy(riskRig.position).setY(1.4);
      }
    } else if (preset === 'agent_focus' && agentId) {
      const rig = this.agentRigs.get(agentId);
      if (rig) {
        const dir = rig.position.clone().normalize();
        this.camDesiredPos.copy(rig.position).addScaledVector(dir, 4.6).setY(3.8);
        this.camDesiredTarget.copy(rig.position).setY(1.4);
      }
    }
  }

  private resizeObserver: ResizeObserver | null = null;

  private bindEvents(): void {
    window.addEventListener('resize', this.handleResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.container);
    }
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private handleResize = (): void => {
    if (this.disposed) return;
    const width = Math.max(this.container.clientWidth, 320);
    const height = Math.max(this.container.clientHeight, 320);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private updatePointerFromEvent(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private handlePointerMove = (e: PointerEvent): void => {
    const now = performance.now();
    if (now - this.lastHoverCheck < 50) return;
    this.lastHoverCheck = now;

    this.updatePointerFromEvent(e);
    this.raycaster.layers.set(1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.interactables, false);
    this.hoveredAgentId = hits.length > 0 ? ((hits[0].object.userData.agentId as AgentId) ?? null) : null;
    this.renderer.domElement.style.cursor = hits.length > 0 ? 'pointer' : 'grab';
  };

  private handlePointerDown = (e: PointerEvent): void => {
    this.updatePointerFromEvent(e);
    this.raycaster.layers.set(1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.interactables, false);
    if (hits.length > 0) {
      const agentId = hits[0].object.userData.agentId as AgentId | undefined;
      if (agentId) {
        this.onSelectAgentCb(agentId);
        this.setCameraPreset('agent_focus', agentId);
      }
    }
  };

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private renderCount = 0;

  private startLoop(): void {
    const tick = () => {
      if (this.disposed) return;
      const dt = Math.min(this.clock.getDelta(), 0.1);
      const elapsed = this.clock.getElapsedTime();

      this.updateSceneKinematics(dt, elapsed);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.renderCount++;
      this.renderer.domElement.dataset.frames = String(this.renderCount);
      this.renderer.domElement.dataset.calls = String(this.renderer.info.render.calls);

      if (this.isSoftwareGl) {
        this.afterDraw(tick);
      } else {
        this.frameId = requestAnimationFrame(tick);
      }
    };

    this.frameId = requestAnimationFrame(tick);
  }

  private updateSceneKinematics(dt: number, elapsed: number): void {
    const speedMult = this.syncState.simSpeed || 1;

    // 1. Smoothly damp camera preset transitions
    if (this.camTransitionActive) {
      this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, this.camDesiredPos.x, 4.5, dt);
      this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, this.camDesiredPos.y, 4.5, dt);
      this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, this.camDesiredPos.z, 4.5, dt);
      this.controls.target.x = THREE.MathUtils.damp(this.controls.target.x, this.camDesiredTarget.x, 5, dt);
      this.controls.target.y = THREE.MathUtils.damp(this.controls.target.y, this.camDesiredTarget.y, 5, dt);
      this.controls.target.z = THREE.MathUtils.damp(this.controls.target.z, this.camDesiredTarget.z, 5, dt);

      if (this.camera.position.distanceTo(this.camDesiredPos) < 0.08) {
        this.camTransitionActive = false;
      }
    }

    // 2. Central Bitcoin Medallion & Non-Occluding Equatorial Orbital Rings
    this.btcCoinGroup.rotation.y = Math.sin(elapsed * 0.72) * 0.48;
    this.btcCoinGroup.position.y = 2.22 + Math.sin(elapsed * 2.0) * 0.08;
    this.gimbalOuter.rotation.x = Math.PI / 2 - 0.18 + Math.sin(elapsed * 0.5) * 0.08;
    this.gimbalOuter.rotation.y = Math.cos(elapsed * 0.4) * 0.12;
    this.gimbalOuter.rotation.z = elapsed * 0.35;
    this.gimbalInner.rotation.x = Math.PI / 2 + 0.22 + Math.cos(elapsed * 0.6) * 0.08;
    this.gimbalInner.rotation.y = Math.sin(elapsed * 0.45) * 0.14;
    this.gimbalInner.rotation.z = -elapsed * 0.52;

    if (this.emitterMat) {
      const ringHex =
        this.syncState.positionSide === 'LONG'
          ? 0x10b981
          : this.syncState.positionSide === 'SHORT'
            ? 0xf43f5e
            : 0xf59e0b;
      _scratchColor.setHex(ringHex);
      this.emitterMat.color.lerp(_scratchColor, Math.min(1, dt * 6));
      this.emitterMat.emissive.lerp(_scratchColor, Math.min(1, dt * 6));
      this.emitterMat.emissiveIntensity = THREE.MathUtils.damp(
        this.emitterMat.emissiveIntensity,
        this.syncState.hasActivePosition ? 1.9 : 1.35,
        6,
        dt,
      );
    }

    if (this.coreBeaconMat) {
      const beaconTargetOpacity = this.syncState.hasActivePosition
        ? 0.08 + Math.sin(elapsed * 2.8) * 0.025
        : 0;
      const beaconHex = this.syncState.positionSide === 'SHORT' ? 0xf43f5e : 0x10b981;
      _scratchColor.setHex(beaconHex);
      this.coreBeaconMat.color.lerp(_scratchColor, Math.min(1, dt * 6));
      this.coreBeaconMat.opacity = THREE.MathUtils.damp(
        this.coreBeaconMat.opacity,
        beaconTargetOpacity,
        6,
        dt,
      );
    }

    // 3. Agent station animations & semantic color status
    const activeStageAgent = STAGE_ACTIVE_AGENT[this.syncState.activeStage];
    const cycleSignals = this.syncState.cycle?.signals;

    this.agentRigs.forEach((rig, id) => {
      const isStageActive = id === activeStageAgent;
      const isSelected = id === this.syncState.selectedAgentId;
      const isHovered = id === this.hoveredAgentId;
      const signal = cycleSignals?.[id];

      // Subtle idle head bob & rotation toward active flow
      rig.headGroup.position.y = 1.82 + Math.sin(elapsed * 2.2 + rig.position.x) * 0.04;
      rig.headGroup.rotation.y = Math.sin(elapsed * 1.1 + rig.position.z) * 0.14;

      if (id === 'orderflow_radar' && rig.accentMeshes[2]) {
        rig.accentMeshes[2].rotation.z = elapsed * 1.4 * speedMult;
      }
      if (id === 'strategy_architect' && rig.accentMeshes[2]) {
        rig.accentMeshes[2].rotation.y = elapsed * 1.5;
        rig.accentMeshes[2].rotation.x = Math.sin(elapsed * 0.9) * 0.35;
      }
      if (id === 'risk_guardian' && rig.accentMeshes[2]) {
        rig.accentMeshes[2].rotation.y = elapsed * 1.8;
      }

      // Color status: UNAVAILABLE -> muted slate, VETO -> crimson, LONG -> emerald, SHORT -> rose, else role color
      let targetColor = AGENT_COLORS[id];
      if (signal?.direction === 'UNAVAILABLE') targetColor = 0x64748b;
      else if (signal?.direction === 'VETO') targetColor = 0xef4444;
      else if (signal?.direction === 'LONG' && isStageActive) targetColor = 0x10b981;
      else if (signal?.direction === 'SHORT' && isStageActive) targetColor = 0xf43f5e;

      _scratchColor.setHex(targetColor);
      rig.statusMaterial.color.lerp(_scratchColor, Math.min(1, dt * 6));
      rig.statusMaterial.emissive.lerp(_scratchColor, Math.min(1, dt * 6));
      rig.statusMaterial.emissiveIntensity =
        signal?.direction === 'UNAVAILABLE'
          ? 0.35
          : isStageActive || isSelected
            ? 1.85
            : isHovered
              ? 1.35
              : 0.75;

      const haloMat = rig.haloMesh.material as THREE.MeshBasicMaterial;
      haloMat.opacity = THREE.MathUtils.damp(
        haloMat.opacity,
        isSelected ? 0.85 : isStageActive ? 0.6 : isHovered ? 0.48 : 0.18,
        6,
        dt,
      );
      const targetScale = isStageActive || isSelected ? 1.14 : isHovered ? 1.08 : 1.0;
      const nextScale = THREE.MathUtils.damp(rig.haloMesh.scale.x, targetScale, 6, dt);
      rig.haloMesh.scale.set(nextScale, nextScale, 1);
    });

    // 4. Conduit & Traveling Data Pulses (including live debate challenge tension)
    const debateTurns = this.syncState.cycle?.debate?.turns ?? [];
    this.conduits.forEach((c, idx) => {
      const isHighlighted = c.from === activeStageAgent || c.to === activeStageAgent;
      const relatedTurn = debateTurns.find(
        (t) => t.challenger === c.from || t.target === c.from || t.challenger === c.to,
      );

      let conduitHex = c.from === 'core' ? 0xf59e0b : AGENT_COLORS[c.from];
      let targetIntensity = isHighlighted ? 1.35 : 0.25;
      if (relatedTurn?.stance === 'VETO_TRIGGER') {
        conduitHex = 0xf43f5e;
        targetIntensity = Math.max(targetIntensity, 1.15);
      } else if (relatedTurn?.stance === 'CHALLENGE') {
        conduitHex = 0xf59e0b;
        targetIntensity = Math.max(targetIntensity, 0.95);
      } else if (
        this.syncState.cycle?.risk.approved &&
        relatedTurn?.stance === 'SUPPORT'
      ) {
        conduitHex = 0x10b981;
      }

      _scratchColor.setHex(conduitHex);
      c.material.color.lerp(_scratchColor, Math.min(1, dt * 6));
      c.material.emissive.lerp(_scratchColor, Math.min(1, dt * 6));
      c.material.emissiveIntensity = THREE.MathUtils.damp(
        c.material.emissiveIntensity,
        targetIntensity,
        6,
        dt,
      );
      c.material.opacity = THREE.MathUtils.damp(
        c.material.opacity,
        isHighlighted || relatedTurn?.stance === 'VETO_TRIGGER' ? 0.95 : 0.46,
        6,
        dt,
      );

      const pulseTensionMult = relatedTurn && relatedTurn.stance !== 'SUPPORT' ? 1.35 : 1.0;

      // Move packets assigned to this conduit
      for (const unit of this.pulseUnits) {
        if (unit.curveIndex !== idx) continue;
        unit.progress = (unit.progress + dt * unit.speed * speedMult * pulseTensionMult) % 1;
        c.curve.getPointAt(unit.progress, _scratchVec3);
        unit.mesh.position.copy(_scratchVec3);
        const unitMat = unit.mesh.material as THREE.MeshBasicMaterial;
        unitMat.color.lerp(_scratchColor, Math.min(1, dt * 8));
        const s = isHighlighted || relatedTurn?.stance === 'VETO_TRIGGER' ? 1.35 : 0.8;
        unit.mesh.scale.setScalar(s);
      }
    });

    // 5. Expanding trade/veto shockwave ring
    if (this.shockwaveTimer > 0) {
      this.shockwaveTimer = Math.max(0, this.shockwaveTimer - dt * 1.15);
      const progress = 1 - this.shockwaveTimer;
      const scale = 1 + progress * 7.5;
      this.shockwaveRing.scale.set(scale, scale, 1);
      this.shockwaveMat.opacity = this.shockwaveTimer * 0.75;
    }

    // Touch _scratchTarget to avoid unused lint
    _scratchTarget.set(0, 0, 0);
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);

    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        if (Array.isArray(m.material)) {
          m.material.forEach((mat) => mat.dispose());
        } else {
          m.material?.dispose();
        }
      } else if ((obj as THREE.Sprite).isSprite) {
        const sp = obj as THREE.Sprite;
        sp.material.map?.dispose();
        sp.material.dispose();
      }
    });

    this.shadowTex.dispose();
    this.floorTex.dispose();
    this.coinDialTex.dispose();
    this.coinBumpTex.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
