import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
	EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, VignetteEffect,
	ToneMappingEffect, ToneMappingMode
} from 'postprocessing';
import { createNoise2D } from 'simplex-noise';
import { tierForPct, GARRISON, TIERS, type Tier } from './tiers';
import { CharacterPool, type CharState, type Role } from './characters';
import { Scenery } from './scenery';

export type Team = 'bull' | 'bear';
export type Cls = 'spear' | 'duelist' | 'archer' | 'guardian' | 'chariot';
export type SpawnInput = { wallet: string; kind: Team | 'buy' | 'sell'; usd: number; pct: number; quiet?: boolean };

export type BattleEvent = {
	type: 'spawn' | 'kill' | 'legend' | 'duel' | 'strike' | 'volley' | 'sudden';
	team: Team; tier: string; cls: Cls; wallet: string; usd: number; pct: number;
};

export type Commander = { wallet: string; kills: number; tier: string; team: Team };
export type Comp = Record<Cls, number>;

export type Stats = {
	bulls: number; bears: number; bullPower: number; bearPower: number;
	frontPct: number; casualtiesBull: number; casualtiesBear: number; fps: number;
	round: number; winBull: number; winBear: number;
	phase: 'battle' | 'victory'; winner: Team | null; warPhase: WarPhase;
	totalKills: number; biggestWhaleUsd: number; biggestWhaleWallet: string;
	commanders: Commander[]; bullComp: Comp; bearComp: Comp;
};

export type Overlay = {
	tracked: { x: number; y: number; on: boolean; tier: string; team: Team; hp: number; maxHp: number; kills: number; wallet: string }[];
	titans: { x: number; y: number; on: boolean; label: string; team: Team; hp: number; maxHp: number }[];
	kills: { x: number; y: number; on: boolean; team: Team; age: number }[];
};

type Unit = {
	team: Team; sign: number; cls: Cls; ranged: boolean;
	tier: string; scale: number; hp: number; maxHp: number; dmg: number;
	standoff: number; speed: number;
	wallet: string; x: number; z: number; rank: number; bob: number; age: number;
	cd: number; kills: number; idx: number; dying: number;
	tracked: boolean; legend: boolean; melee: boolean;
	// duel state
	target: Unit | null; retarget: number; atkCd: number; strike: number; face: number;
	tint: number; struck: number; swingSide: number;
	// formation posting: quantized file (slot) across the field, rank depth (row) behind the front
	lane: number; slot: number; row: number; frontJitter: number; flank: boolean;
	// articulation: wheel/limb angle accumulator + last position (for distance-driven spin)
	spin: number; px: number; pz: number;
	// index into the animated character pool (−1 until claimed / models still loading)
	char: number;
};

// the war is a brawl, not a parade: the hosts collide and fight almost the whole
// time. The phases now mostly colour the drama (a brief muster, a charge horn, a
// short regroup) while MELEE dominates — units seek and kill continuously.
export type WarPhase = 'form' | 'advance' | 'charge' | 'melee' | 'regroup';
const PHASE_CYCLE = 34; // seconds per full rhythm
function phaseAt(t: number): WarPhase {
	const T = t % PHASE_CYCLE;
	return T < 2 ? 'form' : T < 4 ? 'advance' : T < 6 ? 'charge' : T < 30 ? 'melee' : 'regroup';
}

// per-class attack pacing (seconds between strikes)
const ATK_CD: Record<Cls, number> = { spear: 1.05, duelist: 0.55, archer: 1.15, guardian: 2.4, chariot: 1.35 };
const KILL_TEMPO = 2.1; // global lethality multiplier (per-hit = dmg * cd * tempo) — fights bite
const ACQUIRE_R = 18; // how far a melee unit will lock onto an enemy

const FRONT_MAX = 72;
const CAP = FRONT_MAX + 30; // deep rear behind each host for the siege line + spawn
// the price ladder is scaled: one world unit == PCT_PER_UNIT percent of price move
// from the campaign anchor. This decouples the physical size of the field from the
// price range, so the war can be fought over a big battlefield while a gate still
// falls at a sane move (~±FRONT_MAX*0.9*PCT_PER_UNIT ≈ ±45%).
const PCT_PER_UNIT = 0.7;
// the fighting band runs deep so a big host reads as a massed army with real depth
const ARENA_Z = 46;
// the battlefield is a bounded board floating in a dark void
const BOARD_W = 340;
const BOARD_D = 280;
const ROAD_Z = 13; // horizontal road across the map
const MELEE = 4.2;
const SPEED = 8; // deliberate marching pace — the charge multiplier provides the sprint
const UNIT_SCALE = 2.35;

const CLASS_STATS: Record<Cls, { hpMul: number; dmgMul: number; scaleMul: number; ranged: boolean; standoff: number; speedMul: number }> = {
	spear: { hpMul: 1.0, dmgMul: 1.0, scaleMul: 1.0, ranged: false, standoff: 0.8, speedMul: 1.0 },
	duelist: { hpMul: 0.78, dmgMul: 1.9, scaleMul: 0.95, ranged: false, standoff: 0.6, speedMul: 1.45 },
	archer: { hpMul: 0.55, dmgMul: 1.7, scaleMul: 0.9, ranged: true, standoff: 13, speedMul: 1.05 },
	guardian: { hpMul: 2.6, dmgMul: 2.5, scaleMul: 1.0, ranged: false, standoff: 0.9, speedMul: 0.62 },
	// the war chariot is the battlefield's tank: fast, armored, tramples through the line
	chariot: { hpMul: 2.2, dmgMul: 1.7, scaleMul: 1.05, ranged: false, standoff: 1.4, speedMul: 1.75 }
};

const GOLD = new THREE.Color('#2fd66b');
const CRIMSON = new THREE.Color('#ff5560');

// The battlefield is a hill whose summit is the market cap.
const HILL_H = 1.1; // gentle rolling terrain — the war map is near-flat, not a peak
const HILL_SIG = FRONT_MAX * 0.85;
function hillY(x: number): number { return HILL_H * Math.exp(-(x * x) / (2 * HILL_SIG * HILL_SIG)); }
// ground height a unit stands on — matches the terrain's z-taper so nothing floats at the rim
function groundY(x: number, z: number): number {
	const zTaper = THREE.MathUtils.clamp(1 - (Math.abs(z) - ARENA_Z) / 14, 0, 1);
	return hillY(x) * zTaper;
}

function hash01(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0) / 4294967296;
}
function pickClass(tier: string, seed: number): Cls {
	if (tier === 'TITAN') return 'guardian';
	if (tier === 'CHAMPION') return 'chariot'; // champions ride to war
	// melee-forward mix: the war is decided blade to blade, archers in support
	if (seed < 0.34) return 'spear';
	if (seed < 0.68) return 'duelist';
	return 'archer';
}

// ---------- toon look ----------

function toonMaterial(): THREE.MeshToonMaterial {
	const steps = new Uint8Array([70, 135, 200, 255]);
	const grad = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
	grad.minFilter = THREE.NearestFilter; grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
	return new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: grad });
}

type Palette = { cloth: string; clothDark: string; skin: string; metal: string; wood: string; leather: string; accent: string };
// night-war hosts: deep emerald vs blood crimson linen, blackened bronze, firelight gold
const PAL: Record<Team, Palette> = {
	bull: { cloth: '#2ce46e', clothDark: '#14a04a', skin: '#c98d4f', metal: '#c49238', wood: '#7e5228', leather: '#5c4028', accent: '#ffd34d' },
	bear: { cloth: '#ff4256', clothDark: '#b52738', skin: '#b97e42', metal: '#c49238', wood: '#6e4522', leather: '#523524', accent: '#ffd34d' }
};

function paint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
	const c = new THREE.Color(hex);
	const n = g.attributes.position.count;
	const arr = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
	g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
	return g;
}

function buildArrowGeo(): THREE.BufferGeometry {
	const shaft = paint(new THREE.CylinderGeometry(0.035, 0.035, 1.2, 5), '#8a5a2b');
	const tip = paint(new THREE.ConeGeometry(0.09, 0.22, 6), '#dfe4ea'); tip.translate(0, 0.7, 0);
	const fl = paint(new THREE.BoxGeometry(0.18, 0.22, 0.02), '#ffffff'); fl.translate(0, -0.58, 0);
	const m = mergeGeometries([shaft, tip, fl], false)!; m.computeVertexNormals(); return m;
}

// ---------- environment textures ----------

function groundTexture(): THREE.Texture {
	const c = document.createElement('canvas'); c.width = c.height = 512;
	const x = c.getContext('2d')!;
	x.fillStyle = '#b0a996'; x.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 18000; i++) { const v = 165 + Math.random() * 80; x.fillStyle = `rgba(${v},${v - 6},${v - 20},${Math.random() * 0.4})`; x.fillRect(Math.random() * 512, Math.random() * 512, 2, 2); }
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 3); t.anisotropy = 4; return t;
}
function skyTexture(): THREE.Texture {
	// a black-metal night: violet-black void, dense stars, a pale blood moon
	const c = document.createElement('canvas'); c.width = 512; c.height = 512;
	const x = c.getContext('2d')!;
	const g = x.createLinearGradient(0, 0, 0, 512);
	g.addColorStop(0, '#050309'); g.addColorStop(0.5, '#0a0510'); g.addColorStop(0.82, '#140911'); g.addColorStop(1, '#1a0c10');
	x.fillStyle = g; x.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 340; i++) {
		const sx = Math.random() * 512, sy = Math.pow(Math.random(), 1.5) * 360;
		x.fillStyle = `rgba(210,205,255,${0.07 + Math.random() * 0.42})`;
		x.beginPath(); x.arc(sx, sy, 0.3 + Math.random() * 1.1, 0, Math.PI * 2); x.fill();
	}
	// the blood moon — a pale disc ringed in dull crimson haze
	const mx = 396, my = 92;
	const halo = x.createRadialGradient(mx, my, 8, mx, my, 88);
	halo.addColorStop(0, 'rgba(255,120,110,0.30)'); halo.addColorStop(0.4, 'rgba(160,50,60,0.12)'); halo.addColorStop(1, 'rgba(0,0,0,0)');
	x.fillStyle = halo; x.fillRect(mx - 90, my - 90, 180, 180);
	const disc = x.createRadialGradient(mx - 6, my - 6, 2, mx, my, 26);
	disc.addColorStop(0, '#ffe9df'); disc.addColorStop(0.75, '#e8b5a4'); disc.addColorStop(1, '#b06a5e');
	x.fillStyle = disc; x.beginPath(); x.arc(mx, my, 26, 0, Math.PI * 2); x.fill();
	// faint craters
	x.fillStyle = 'rgba(140,80,70,0.25)';
	for (const [cx, cy, cr] of [[388, 84, 5], [404, 100, 4], [392, 102, 3], [408, 82, 2.5]] as const) { x.beginPath(); x.arc(cx, cy, cr, 0, Math.PI * 2); x.fill(); }
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function radialTexture(hex: string): THREE.Texture {
	const c = document.createElement('canvas'); c.width = c.height = 128;
	const x = c.getContext('2d')!;
	const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, hex); g.addColorStop(1, 'rgba(0,0,0,0)');
	x.fillStyle = g; x.fillRect(0, 0, 128, 128);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// horizontal gradient, transparent at x=0 → solid at x=1 (for the front-line liquidity buffer)
function edgeGradTexture(r: number, g: number, b: number): THREE.Texture {
	const c = document.createElement('canvas'); c.width = 64; c.height = 8;
	const x = c.getContext('2d')!;
	const grad = x.createLinearGradient(0, 0, 64, 0);
	grad.addColorStop(0, `rgba(${r},${g},${b},0)`); grad.addColorStop(0.72, `rgba(${r},${g},${b},0.12)`); grad.addColorStop(1, `rgba(${r},${g},${b},0.42)`);
	x.fillStyle = grad; x.fillRect(0, 0, 64, 8);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Battle {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private composer!: EffectComposer;

	private units: Unit[] = [];
	private nextId = 0;
	private frontX = 0;
	private terrainH: (x: number, z: number) => number = () => 0;

	private arrowMesh!: THREE.InstancedMesh;
	private PROJ = 320;
	private proj!: { active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; dmg: number; team: Team; life: number }[];
	private projHead = 0;

	private raf = 0; private last = 0; private time = 0; private frame = 0;
	private focus = false; private trackWallet: string | null = null;
	private shake = 0; private statTick = 0; private fpsAvg = 60;
	private quality = 2; private qualTick = 0;
	private unbind: (() => void)[] = [];
	private timeScale = 1; private slowmo = 0; private momentum = 0;
	// war campaign: front advances to a base → theater falls → resets with the newer mcap
	private phase: 'battle' | 'victory' = 'battle';
	private winner: Team | null = null;
	private campaign = 1;
	private wonUntil = 0;
	private winsBull = 0; private winsBear = 0;
	private warClock = 0; private battlePhase: WarPhase = 'form';
	// war intensity: 0 → 1 the longer a campaign runs — musters bloodier reinforcements
	private sudden = 0; private suddenAnnounced = false;
	// massed archery: volleys loose together on a shared signal during the standoff phases
	private volleyT = 3; private volleyWindow = 0; private volleyAnnounced = false;
	// the first strike after the horns sound lands in slow motion
	private awaitClash = false;
	// single combat before the hosts — one champion from each side meets in no-man's land
	private duelA: Unit | null = null; private duelB: Unit | null = null;
	onCampaign: ((r: { winner: Team; campaign: number }) => void) | null = null;
	private reinB = 0; private reinS = 0; private accB = 0; private accS = 0;
	private killFx: { x: number; z: number; team: Team; until: number }[] = [];
	private decals!: THREE.InstancedMesh; private DECAL_N = 200; private decalHead = 0;
	private decalLife!: Float32Array; private decalBase!: Float32Array; private decalX!: Float32Array; private decalZ!: Float32Array;

	private commanders = new Map<string, { kills: number; tier: string; team: Team; usd: number }>();
	private totalKills = 0; private biggestWhaleUsd = 0; private biggestWhaleWallet = '';
	private lastGarrison = { bulls: 60, bears: 60 };

	private camYaw = 0.06; private camPitch = 0.4; private camZoom = 0.6; private zoomPunch = 0;
	// cinematic "featured combatant": hold on one legend for a beat so the camera
	// doesn't twitch between heroes; prefer gods, then whoever has fought longest
	private featuredWallet: string | null = null; private featuredUntil = 0;
	private panX = 0; private panZ = 0; private keys = new Set<string>();
	private manualUntil = 0; private dragging = false; private lastPtr = { x: 0, y: 0 };

	private sparks!: THREE.Points; private sparkPos!: Float32Array; private sparkVel!: Float32Array; private sparkLife!: Float32Array; private sparkColor!: Float32Array; private sparkHead = 0; private SPARK_N = 1500;
	private FXLIGHT_N = 5; private fxLights: THREE.PointLight[] = [];
	private fxLightLife = new Float32Array(5); private fxLightMax = new Float32Array(5); private fxLightPeak = new Float32Array(5); private fxLightHead = 0;
	private souls!: THREE.Points; private soulPos!: Float32Array; private soulVel!: Float32Array; private soulLife!: Float32Array; private soulColor!: Float32Array; private soulHead = 0; private SOUL_N = 400;

	private auras: THREE.Group[] = [];
	private capitalBull!: THREE.Group; private capitalBear!: THREE.Group; private frontLine!: THREE.Mesh;
	private flags: THREE.Mesh[] = [];
	private dummy = new THREE.Object3D(); private tmpColor = new THREE.Color();
	private chars = new CharacterPool();
	private scenery = new Scenery();
	// units over this many alive per side stop mustering reinforcements; real trades
	// always deploy. Keeps the field a readable clash of pro characters, not a mob.
	private SIDE_CAP = 120;

	// the intro must not release the player into an empty field while ~20MB of
	// character models are still streaming in
	get modelsReady(): boolean { return this.chars.ready; }
	private _camTarget = new THREE.Vector3(); private _camPos = new THREE.Vector3();
	private q = new THREE.Quaternion(); private upV = new THREE.Vector3(0, 1, 0); private vTmp = new THREE.Vector3();

	casualtiesBull = 0; casualtiesBear = 0;

	onStats: ((s: Stats) => void) | null = null;
	onOverlay: ((o: Overlay) => void) | null = null;
	onEvent: ((e: BattleEvent) => void) | null = null;

	constructor(canvas: HTMLCanvasElement) {
		// powerPreference deliberately left default: forcing 'high-performance' on
		// dual-GPU laptops routes WebGL to the discrete GPU while the page composites
		// on the integrated one — a known Chrome path that can paint the canvas white.
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
		this.renderer.setSize(innerWidth, innerHeight);
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.toneMapping = THREE.NoToneMapping;

		this.scene.background = skyTexture();
		// cold fog so the far field falls gently away into night — atmospheric depth
		this.scene.fog = new THREE.FogExp2(0x0f0d18, 0.0019);

		this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 700);
		this.camera.position.set(0, 40, 60);
		this.camera.lookAt(0, 3, 0);

		this.buildComposer();
		this.buildLights();
		this.buildGround();
		this.buildProps();
		this.buildSiege();
		this.capitalBull = this.buildCapital('bull', -CAP);
		this.capitalBear = this.buildCapital('bear', CAP);
		this.frontLine = this.buildFrontLine();
		this.buildGroundText();
		this.buildMcapTicks();
		this.buildMcapSign();
		this.buildArrows();
		this.buildSparks();
		this.buildSouls();
		this.buildSmoke();
		this.buildEmbers();
		this.buildStandards();
		this.buildUnitShadows();
		this.buildDecals();
		this.buildAuras();

		// the whole army streams in as real animated characters; units spawned before
		// the models arrive simply pop in once ready (claim() no-ops until then)
		this.chars.load(this.scene).catch(() => {});
		// real CC0 world models (trees, rocks, castles, crates) dress the field on arrival
		this.scenery
			.load(this.scene, ['tree_single_A', 'tree_single_B', 'rock_single_A', 'rock_single_C', 'rock_single_E', 'crate_A_big', 'barrel', 'building_castle_green', 'building_castle_red'])
			.then(() => this.dressScenery())
			.catch(() => {});

		this.on(window, 'resize', () => this.resize());
		// GPU resets (driver TDR, tab backgrounding) must not leave a dead canvas
		this.on(canvas, 'webglcontextlost', (e) => e.preventDefault());
		this.on(canvas, 'webglcontextrestored', () => {
			this.composer.dispose();
			this.buildComposer();
			this.fxOk = true; this.fxChecked = false;
			this.resize();
		});
		this.bindCamera(canvas);
	}

	private on(t: EventTarget, k: string, fn: EventListener, opt?: AddEventListenerOptions) {
		t.addEventListener(k, fn, opt);
		this.unbind.push(() => t.removeEventListener(k, fn));
	}

	// ---------- pipeline ----------

	// post-processing self-defence: if the composer can't produce a sane frame on this
	// GPU/driver (no float render targets, broken pass → all-white output), drop to a
	// direct render with built-in tone mapping instead of showing a white screen.
	private fxOk = true; private fxChecked = false;

	private buildComposer() {
		const gl = this.renderer.getContext();
		const floatOk = this.renderer.capabilities.isWebGL2
			? !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))
			: !!gl.getExtension('OES_texture_half_float');
		this.composer = new EffectComposer(this.renderer, { multisampling: 0, frameBufferType: floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType });
		this.composer.addPass(new RenderPass(this.scene, this.camera));

		// bloom on the true highlights, ACES tone map, deep cinematic vignette. The
		// desaturated, filmic look now comes from the scene itself (muted ground +
		// natural character tints), not a post grade — a colour-grade effect chained
		// after tone mapping blew the ground out to white, so it is done in-scene.
		const bloom = new BloomEffect({ intensity: 0.6, luminanceThreshold: 0.7, luminanceSmoothing: 0.28, mipmapBlur: true, radius: 0.72 });
		const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
		const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.6 });
		this.composer.addPass(new EffectPass(this.camera, bloom, tone, vignette));
		this.composer.addPass(new EffectPass(this.camera, new SMAAEffect()));
	}

	private buildLights() {
		// dramatic night: a low ambient bed so forms keep their shadowed side, a strong
		// cold moonlight KEY that sculpts every character, a warm low fill to lift the
		// dark side off pure black, and a blood-red rim for menace. Directional shading
		// gives the models real volume even without shadow maps.
		this.scene.add(new THREE.HemisphereLight(0x6d7db0, 0x2a2018, 1.05));
		const moon = new THREE.DirectionalLight(0xd0ddff, 2.9);
		moon.position.set(-40, 66, 30); moon.castShadow = true; moon.shadow.mapSize.set(1024, 1024);
		const s = 100; moon.shadow.camera.left = -s; moon.shadow.camera.right = s; moon.shadow.camera.top = s; moon.shadow.camera.bottom = -s; moon.shadow.camera.far = 220; moon.shadow.bias = -0.0004;
		this.scene.add(moon);
		const fill = new THREE.DirectionalLight(0xffb060, 0.45);
		fill.position.set(30, 20, 40); this.scene.add(fill);
		const rim = new THREE.DirectionalLight(0xff5a4a, 0.95);
		rim.position.set(38, 30, -46);
		this.scene.add(rim);

		// dynamic combat lights: a fixed pool, all added now at intensity 0 so
		// brightening them later never re-permutes the material shaders (the whole
		// point — the render pipeline must never hitch or blow out). Falcon strikes
		// and their impacts flare these so the night actually reacts to the fighting.
		for (let i = 0; i < this.FXLIGHT_N; i++) {
			const l = new THREE.PointLight(0xffffff, 0, 46, 2);
			l.position.set(0, -999, 0);
			this.scene.add(l);
			this.fxLights.push(l);
		}
	}

	private flareLight(x: number, y: number, z: number, hex: number, peak: number, dist: number, life: number) {
		const i = this.fxLightHead; this.fxLightHead = (this.fxLightHead + 1) % this.FXLIGHT_N;
		const l = this.fxLights[i];
		l.color.setHex(hex); l.position.set(x, y, z); l.distance = dist; l.intensity = peak;
		this.fxLightPeak[i] = peak; this.fxLightLife[i] = life; this.fxLightMax[i] = life;
	}

	private updateLights(dt: number) {
		for (let i = 0; i < this.FXLIGHT_N; i++) {
			if (this.fxLightLife[i] <= 0) continue;
			this.fxLightLife[i] -= dt;
			const k = Math.max(0, this.fxLightLife[i] / this.fxLightMax[i]);
			// ease out with a faint flicker so firelight feels alive, then snap dark
			this.fxLights[i].intensity = k * k * this.fxLightPeak[i] * (0.85 + Math.sin(this.time * 40 + i) * 0.15);
			if (this.fxLightLife[i] <= 0) { this.fxLights[i].intensity = 0; this.fxLights[i].position.y = -999; }
		}
	}

	private buildGround() {
		const mat = new THREE.MeshToonMaterial({ map: groundTexture(), vertexColors: true, gradientMap: (toonMaterial() as THREE.MeshToonMaterial).gradientMap });
		const geo = new THREE.PlaneGeometry(BOARD_W, BOARD_D, 210, 160);
		const noise2D = createNoise2D(() => 0.42);
		const pos = geo.attributes.position as THREE.BufferAttribute;
		const colors = new Float32Array(pos.count * 3);
		// A real night battlefield, not a candy-coloured game board: dark muted grass
		// across the whole field, a churned-mud scar of trampled earth down the fighting
		// lane, and only a WHISPER of team-coloured soil out toward each host's castle.
		const grass = new THREE.Color('#3c4e2d');   // moonlit turf
		const mud = new THREE.Color('#3a3021');     // churned battle-earth
		const bullEarth = new THREE.Color('#445831'); // faint cool green near the bull keep
		const bearEarth = new THREE.Color('#524030'); // faint ashen brown near the bear keep
		const roadCol = new THREE.Color('#302921');
		const c = new THREE.Color(), tint = new THREE.Color();
		for (let i = 0; i < pos.count; i++) {
			const px = pos.getX(i), py = pos.getY(i);
			const zTaper = THREE.MathUtils.clamp(1 - (Math.abs(py) - ARENA_Z) / 14, 0, 1);
			const edge = THREE.MathUtils.clamp(Math.min((BOARD_W / 2 - Math.abs(px)) / 10, (BOARD_D / 2 - Math.abs(py)) / 10), 0, 1);
			const h = hillY(px) * zTaper + noise2D(px * 0.05, py * 0.05) * 0.35 * edge;
			pos.setZ(i, h);
			c.copy(grass);
			// subtle team-earth influence, neutral at centre, strongest toward the bases
			const side = THREE.MathUtils.clamp(px / (CAP * 0.8), -1, 1);
			tint.copy(side < 0 ? bullEarth : bearEarth);
			c.lerp(tint, Math.pow(Math.abs(side), 1.6) * 0.55);
			// organic tonal patches
			const patch = noise2D(px * 0.09, py * 0.09) * 0.5 + 0.5;
			c.multiplyScalar(0.82 + patch * 0.26);
			// trampled churned-mud scar down the middle where the armies grind
			const band = 1 - THREE.MathUtils.clamp(Math.abs(px) / 20, 0, 1);
			c.lerp(mud, THREE.MathUtils.clamp(band * (0.4 + noise2D(px * 0.22, py * 0.22) * 0.22), 0, 0.75));
			// the old road, now a faint worn track rather than painted asphalt
			const roadDist = Math.abs(py - ROAD_Z);
			if (roadDist < 2.2) c.lerp(roadCol, THREE.MathUtils.clamp(1 - (roadDist - 1.3) / 0.9, 0, 0.7));
			colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
		}
		this.terrainH = (x, z) => {
			const zTaper = THREE.MathUtils.clamp(1 - (Math.abs(z) - ARENA_Z) / 14, 0, 1);
			return hillY(x) * zTaper;
		};
		geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		geo.computeVertexNormals();
		const g = new THREE.Mesh(geo, mat); g.rotation.x = -Math.PI / 2; g.receiveShadow = true; this.scene.add(g);
		// dark board skirt so the map reads as a diorama floating in the void
		// top face sits below the terrain's deepest noise valley (−0.35) — if it pokes above,
		// it occludes the ground from shallow camera angles and reads as black puddles
		const skirt = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, 3.4, BOARD_D), new THREE.MeshBasicMaterial({ color: 0x181410 }));
		skirt.position.y = -2.25; this.scene.add(skirt);
		// soft pedestal glow beneath the floating diorama
		const glow = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W * 2.1, BOARD_D * 2.3), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(70,120,95,0.5)'), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
		glow.rotation.x = -Math.PI / 2; glow.position.y = -3.6; this.scene.add(glow);
	}

	private buildProps() {
		// The only procedural set-dressing left is the war-torches: self-lit ember
		// points that make the night feel lit. Trees, rocks, castles, banners and
		// crates are real CC0 models placed by the Scenery loader once it streams in.
		const poles: THREE.BufferGeometry[] = [];
		const flames: THREE.BufferGeometry[] = [];
		const torchAt = (x: number, z: number) => {
			const y = this.terrainH(x, z);
			const pole = paint(new THREE.CylinderGeometry(0.09, 0.13, 2.6, 5), '#2e2318'); pole.translate(x, y + 1.3, z);
			const cage = paint(new THREE.CylinderGeometry(0.24, 0.18, 0.3, 5), '#1c1712'); cage.translate(x, y + 2.7, z);
			poles.push(pole, cage);
			const fl = paint(new THREE.ConeGeometry(0.22, 0.62, 6), '#ffb14a'); fl.translate(x, y + 3.1, z);
			const core = paint(new THREE.SphereGeometry(0.12, 6, 5), '#ffe6a0'); core.translate(x, y + 2.92, z);
			flames.push(fl, core);
		};
		for (let tx = -96; tx <= 96; tx += 16) { torchAt(tx, ROAD_Z - 4.2); torchAt(tx + 8, ROAD_Z + 4.2); }
		for (const cx of [-CAP, CAP]) for (const [dx, dz] of [[-9, -9], [9, -9], [-9, 9], [9, 9]] as const) torchAt(cx + dx, dz);
		const pm = mergeGeometries(poles, false)!; pm.computeVertexNormals();
		this.scene.add(new THREE.Mesh(pm, toonMaterial()));
		const fm = mergeGeometries(flames, false)!;
		this.scene.add(new THREE.Mesh(fm, new THREE.MeshBasicMaterial({ vertexColors: true }))); // unlit — burns bright at night
	}

	// ---------- siege line: catapults ranked at the rear that lob flaming boulders ----------
	private catapults: { arm: THREE.Group; muzzle: THREE.Object3D; team: Team; sign: number; bx: number; bz: number; cd: number; anim: number; fired: boolean }[] = [];
	private boulders: { mesh: THREE.Mesh; active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number; team: Team; spin: number }[] = [];
	private readonly COCK = -0.5;   // arm winched down, throwing end low
	private readonly ARMTOP = 0.95; // arm flung up and over on release

	private buildSiege() {
		// a pool of hot boulders that arc over the whole field
		const rockGeo = new THREE.IcosahedronGeometry(0.9, 0);
		const glowGeo = new THREE.SphereGeometry(1.7, 8, 8);
		for (let i = 0; i < 16; i++) {
			const mesh = new THREE.Mesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x2a1c14, emissive: new THREE.Color(0xff5a1e), emissiveIntensity: 1.5, roughness: 1, metalness: 0 }));
			const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
			mesh.add(glow); mesh.visible = false; mesh.frustumCulled = false;
			this.scene.add(mesh);
			this.boulders.push({ mesh, active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, team: 'bull', spin: Math.random() * 6 });
		}
		// three catapults per host, ranked across the rear just in front of the keep
		for (const team of ['bull', 'bear'] as Team[]) {
			const sign = team === 'bull' ? -1 : 1;
			const bx = sign * (CAP - 8);
			for (const bz of [-ARENA_Z * 0.55, 0, ARENA_Z * 0.55]) this.buildCatapult(team, sign, bx, bz);
		}
	}

	private buildCatapult(team: Team, sign: number, x: number, z: number) {
		const grp = new THREE.Group();
		grp.position.set(x, this.terrainH(x, z), z);
		grp.rotation.y = sign < 0 ? 0 : Math.PI; // local +x throws at the enemy
		const wood = '#43301c', darkWood = '#2c2012', iron = '#6b6f78';
		const statics: THREE.BufferGeometry[] = [];
		const box = (w: number, h: number, d: number, hex: string, px: number, py: number, pz: number, rot = 0) => {
			const g = paint(new THREE.BoxGeometry(w, h, d), hex); if (rot) g.rotateZ(rot); g.translate(px, py, pz); statics.push(g);
		};
		box(5.4, 0.5, 0.5, wood, 0, 0.3, -1.5); box(5.4, 0.5, 0.5, wood, 0, 0.3, 1.5); // skids
		box(0.5, 0.4, 3.6, darkWood, -1.9, 0.4, 0); box(0.5, 0.4, 3.6, darkWood, 1.5, 0.4, 0); // cross ties
		box(0.45, 3.4, 0.45, wood, -0.6, 1.9, -1.4, 0.3); box(0.45, 3.4, 0.45, wood, -0.6, 1.9, 1.4, 0.3); // A-frame
		const axle = paint(new THREE.CylinderGeometry(0.16, 0.16, 3.6, 6), iron); axle.rotateX(Math.PI / 2); axle.translate(1.4, 0.65, 0); statics.push(axle);
		for (const wz of [-1.6, 1.6]) { const w = paint(new THREE.CylinderGeometry(0.95, 0.95, 0.34, 10), darkWood); w.rotateX(Math.PI / 2); w.translate(1.4, 0.65, wz); statics.push(w); }
		const sm = mergeGeometries(statics, false)!; sm.computeVertexNormals();
		grp.add(new THREE.Mesh(sm, toonMaterial()));
		// throwing arm on a pivot at the top of the A-frame
		const arm = new THREE.Group(); arm.position.set(-0.6, 3.2, 0);
		const armParts: THREE.BufferGeometry[] = [];
		const beam = paint(new THREE.BoxGeometry(6.6, 0.34, 0.34), wood); beam.translate(2.1, 0, 0); armParts.push(beam);
		const cw = paint(new THREE.BoxGeometry(1.1, 1.1, 1.1), iron); cw.translate(-1.5, 0, 0); armParts.push(cw); // counterweight
		const bucket = paint(new THREE.CylinderGeometry(0.55, 0.36, 0.6, 8), darkWood); bucket.translate(5.1, 0.3, 0); armParts.push(bucket);
		const am = mergeGeometries(armParts, false)!; am.computeVertexNormals();
		arm.add(new THREE.Mesh(am, toonMaterial()));
		arm.rotation.z = this.COCK;
		const muzzle = new THREE.Object3D(); muzzle.position.set(5.1, 0.6, 0); arm.add(muzzle);
		grp.add(arm);
		this.scene.add(grp);
		this.catapults.push({ arm, muzzle, team, sign, bx: x, bz: z, cd: 2.5 + Math.random() * 5, anim: 0, fired: false });
	}

	private launchBoulder(c: Battle['catapults'][number]) {
		const b = this.boulders.find((x) => !x.active); if (!b) return;
		const p = new THREE.Vector3(); c.muzzle.getWorldPosition(p);
		// aim into the enemy host just past the front line
		const tx = this.frontX + (-c.sign) * (7 + Math.random() * 24);
		const tz = (Math.random() - 0.5) * ARENA_Z * 1.6;
		const ty = groundY(tx, tz) + 0.5;
		const T = 1.75, G = 24;
		b.active = true; b.team = c.team; b.t = 0; b.spin = Math.random() * 6;
		b.x = p.x; b.y = p.y; b.z = p.z;
		b.vx = (tx - b.x) / T; b.vz = (tz - b.z) / T; b.vy = (ty - b.y) / T + 0.5 * G * T;
		b.mesh.visible = true; b.mesh.position.copy(p);
		this.spawnSmoke(p.x, p.y, p.z, 4);
		this.spawnBurst(p.x, p.y, p.z, this.tmpColor.set(0xffb14a), 7);
	}

	private boulderImpact(b: Battle['boulders'][number]) {
		const gy = groundY(b.x, b.z);
		this.spawnBurst(b.x, gy + 0.6, b.z, this.tmpColor.set(0xff6a2a), 28);
		this.spawnBurst(b.x, gy + 0.4, b.z, this.tmpColor.set(0xffe0a0), 12);
		this.spawnSmoke(b.x, gy + 0.9, b.z, 9);
		this.addDecal(b.x, b.z, 2.3);
		this.shake = Math.min(1.3, this.shake + 0.3);
		// crush a few enemy soldiers caught under it — spectacle, not the deciding force
		const foe = b.team === 'bull' ? 'bear' : 'bull';
		let hits = 0;
		for (const u of this.units) {
			if (u.team !== foe || u.dying > 0 || u.legend) continue;
			const dx = u.x - b.x, dz = u.z - b.z;
			if (dx * dx + dz * dz < 9 && ++hits <= 4) this.kill(u, []);
			if (hits >= 4) break;
		}
	}

	private updateSiege(dt: number) {
		const firing = this.phase === 'battle';
		const SWING = 0.26, DUR = 1.5, G = 24;
		for (const c of this.catapults) {
			if (c.anim > 0) {
				c.anim += dt;
				if (c.anim < SWING) { const k = c.anim / SWING; c.arm.rotation.z = this.COCK + (this.ARMTOP - this.COCK) * (k * k); }
				else { const k = Math.min(1, (c.anim - SWING) / (DUR - SWING)); c.arm.rotation.z = this.ARMTOP + (this.COCK - this.ARMTOP) * k; }
				if (c.anim >= SWING * 0.82 && !c.fired) { this.launchBoulder(c); c.fired = true; }
				if (c.anim >= DUR) { c.anim = 0; c.fired = false; c.cd = 3.5 + Math.random() * 6; }
			} else {
				c.arm.rotation.z = this.COCK;
				if (firing) { c.cd -= dt; if (c.cd <= 0) c.anim = 0.0001; }
			}
		}
		for (const b of this.boulders) {
			if (!b.active) continue;
			b.t += dt; b.vy -= G * dt;
			b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
			b.spin += dt * 7; b.mesh.position.set(b.x, b.y, b.z); b.mesh.rotation.set(b.spin, b.spin * 0.7, 0);
			if (Math.random() < dt * 26) this.spawnBurst(b.x, b.y, b.z, this.tmpColor.set(0xff7a2a), 1); // ember trail
			if (b.y <= groundY(b.x, b.z) + 0.4 || b.t > 4) { this.boulderImpact(b); b.active = false; b.mesh.visible = false; }
		}
	}

	// scatter real trees/rocks and raise the castles once the models arrive
	private dressScenery() {
		const rng = (a: number, b: number) => a + Math.random() * (b - a);
		const onRoad = (z: number) => Math.abs(z - ROAD_Z) < 4;
		type P = { x: number; z: number; y?: number; s: number; r: number };
		const trees: P[] = [], rocksA: P[] = [], rocksB: P[] = [];
		for (let i = 0; i < 260; i++) {
			const x = rng(-BOARD_W / 2 + 12, BOARD_W / 2 - 12);
			const z = rng(-BOARD_D / 2 + 10, BOARD_D / 2 - 10);
			if (onRoad(z)) continue;
			// keep the fighting band and the ground right in front of the castles clear
			if (Math.abs(x) < CAP - 4 && Math.abs(z) < ARENA_Z - 2) continue;
			(Math.random() < 0.7 ? trees : rocksA).push({ x, z, y: this.terrainH(x, z), s: rng(2.6, 4.4), r: rng(0, Math.PI * 2) });
		}
		// a scattering of small stones across the arena floor for lived-in texture
		for (let i = 0; i < 66; i++) {
			const x = rng(-72, 72), z = rng(-ARENA_Z + 3, ARENA_Z - 3);
			if (onRoad(z)) continue;
			rocksB.push({ x, z, y: this.terrainH(x, z), s: rng(1.4, 2.6), r: rng(0, Math.PI * 2) });
		}
		this.scenery.scatter('tree_single_A', trees.filter((_, i) => i % 2 === 0));
		this.scenery.scatter('tree_single_B', trees.filter((_, i) => i % 2 === 1));
		this.scenery.scatter('rock_single_C', rocksA);
		this.scenery.scatter('rock_single_A', rocksB.filter((_, i) => i % 2 === 0));
		this.scenery.scatter('rock_single_E', rocksB.filter((_, i) => i % 2 === 1));
		// crates and barrels stacked around each castle's muster yard
		const supplies: P[] = [];
		for (const cx of [-CAP, CAP]) for (let k = 0; k < 5; k++) supplies.push({ x: cx + rng(-6, 6), z: rng(-10, 10), y: this.terrainH(cx, 0), s: rng(2.2, 3), r: rng(0, Math.PI * 2) });
		this.scenery.scatter('crate_A_big', supplies.filter((_, i) => i % 2 === 0));
		this.scenery.scatter('barrel', supplies.filter((_, i) => i % 2 === 1));
		// raise each host's castle where the old ziggurat stood
		this.scenery.place('building_castle_green', -CAP, 0, 0, 5.5, Math.PI / 2);
		this.scenery.place('building_castle_red', CAP, 0, 0, 5.5, -Math.PI / 2);
	}

	private buildCapital(team: Team, x: number): THREE.Group {
		const p = PAL[team];
		const grp = new THREE.Group();
		// the castle itself is a real model placed by Scenery once loaded; here we only
		// raise the animated team banner above it and a glowing beacon so the base reads
		// from across the field. The group is the logic anchor (strikes/wins/camera).
		const beacon = new THREE.Mesh(new THREE.ConeGeometry(1.4, 2.2, 4), new THREE.MeshBasicMaterial({ color: team === 'bull' ? 0x7dffb0 : 0xff8a95 }));
		beacon.position.y = 20; beacon.rotation.y = Math.PI / 4; grp.add(beacon);
		const pole = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.12, 0.12, 8, 6), '#4a3220'), toonMaterial());
		pole.position.set(0, 18, 0); grp.add(pole);
		const flag = new THREE.Mesh(paint(new THREE.PlaneGeometry(4, 2.3), p.cloth), new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide, gradientMap: toonMaterial().gradientMap }));
		flag.position.set(2.1, 20.5, 0); grp.add(flag);
		this.flags.push(flag);
		grp.position.set(x, 0, 0);
		this.scene.add(grp);
		return grp;
	}

	// liquidity buffer: tinted glow flanking the front, wider on the side with more
	// live tape flow behind it (NewHedge's bid/ask buffer shading)
	private bufBull!: THREE.Mesh; private bufBear!: THREE.Mesh;
	private presB = 0; private presS = 0; private bufWB = 8; private bufWS = 8;
	private gates: THREE.Mesh[] = [];

	private buildFrontLine(): THREE.Mesh {
		const span = ARENA_Z * 2 + 12;
		const mkBuf = (r: number, g: number, b: number) => {
			const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, span), new THREE.MeshBasicMaterial({ map: edgeGradTexture(r, g, b), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
			mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.05; this.scene.add(mesh); return mesh;
		};
		this.bufBull = mkBuf(30, 210, 120);
		this.bufBear = mkBuf(235, 70, 86);
		this.bufBear.scale.x = -1; // mirror: gradient builds toward the front from the bear side
		// victory gates — breach the enemy's gate and the theater falls
		const GATE = FRONT_MAX * 0.9;
		const mkGate = (x: number, hex: number, label: string, css: string) => {
			const gm = new THREE.Mesh(new THREE.PlaneGeometry(1.5, span), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,255,255,0.9)'), color: hex, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false }));
			gm.rotation.x = -Math.PI / 2; gm.position.set(x, hillY(x) + 0.18, 0); this.scene.add(gm); this.gates.push(gm);
			const c = document.createElement('canvas'); c.width = 320; c.height = 64;
			const g2 = c.getContext('2d')!;
			g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.font = '700 30px "JetBrains Mono", monospace';
			g2.shadowColor = css; g2.shadowBlur = 14; g2.fillStyle = css; g2.fillText(label, 160, 32);
			const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
			const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false }));
			sp.scale.set(15, 3, 1); sp.position.set(x, 3.4, -ARENA_Z - 4); this.scene.add(sp);
			const sp2 = sp.clone(); sp2.position.set(x, 3.4, ARENA_Z + 6); this.scene.add(sp2);
		};
		mkGate(-GATE, 0x2fd66b, 'GATE OF HORUS', '#7dffb0');
		mkGate(GATE, 0xff5560, 'GATE OF SET', '#ff8a95');
		// crisp glowing seam instead of a wide haze column
		const m = new THREE.Mesh(new THREE.PlaneGeometry(2.2, span), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,244,200,0.9)'), color: 0xfff2c0, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
		m.rotation.x = -Math.PI / 2; m.position.y = 0.06; this.scene.add(m); return m;
	}

	// live tape pressure from the page — drives the buffer widths
	setPressure(buyUsd: number, sellUsd: number) { this.presB = buyUsd; this.presS = sellUsd; }

	// army standards: winged-disc battle standards that march with the front line,
	// one per host, banner cloth streaming — the war's position made physical
	private standards: { grp: THREE.Group; cloth: THREE.Mesh; side: number }[] = [];
	private buildStandards() {
		for (const team of ['bull', 'bear'] as Team[]) {
			const p = PAL[team];
			const side = team === 'bull' ? -1 : 1;
			const grp = new THREE.Group();
			// a plain war-banner that marches with the host's edge of the front
			const pole = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.08, 0.1, 6.4, 6), '#4a3220'), toonMaterial());
			pole.position.y = 3.2; grp.add(pole);
			const finial = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 6), new THREE.MeshBasicMaterial({ color: team === 'bull' ? 0x7dffb0 : 0xff8a95 }));
			finial.position.y = 6.6; grp.add(finial);
			const cloth = new THREE.Mesh(paint(new THREE.PlaneGeometry(1.9, 2.8), p.cloth), new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide, gradientMap: toonMaterial().gradientMap }));
			cloth.position.set(1.0, 5.0, 0); grp.add(cloth);
			grp.position.set(side * 8, 0, ARENA_Z - 2);
			this.scene.add(grp);
			this.standards.push({ grp, cloth, side });
		}
	}

	private priceTex!: THREE.CanvasTexture;
	private priceCanvas!: HTMLCanvasElement;
	private buildGroundText() {
		const c = document.createElement('canvas'); c.width = 1024; c.height = 256; this.priceCanvas = c;
		this.priceTex = new THREE.CanvasTexture(c); this.priceTex.colorSpace = THREE.SRGBColorSpace;
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 15), new THREE.MeshBasicMaterial({ map: this.priceTex, transparent: true, opacity: 0.55, depthWrite: false }));
		mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, 0.25, 40);
		this.scene.add(mesh);
		this.setPriceLabel('$OSIRIS', '');
	}
	// dollar tick labels along the field edges — the terrain is a live market-cap price
	// ladder (NewHedge-style): every gold gridline is a real $ level around the current cap
	private mcapTicks: { gx: number; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture }[] = [];
	private lastLadderMcap = 0;
	private buildMcapTicks() {
		// ticks fill the field between the centre and the gates, adapting to its width
		const step = Math.round(FRONT_MAX / 4);
		for (let gx = -step * 3; gx <= step * 3; gx += step) {
			if (gx === 0) continue;
			const c = document.createElement('canvas'); c.width = 192; c.height = 56;
			const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
			this.mcapTicks.push({ gx, canvas: c, tex });
			this.drawTick(gx, null);
			const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.5, depthWrite: false }));
			sp.scale.set(8.4, 2.4, 1);
			sp.position.set(gx, 1.3, -ARENA_Z - 7);
			this.scene.add(sp);
			// mirrored on the near edge for reads from every camera angle
			const sp2 = sp.clone();
			sp2.position.set(gx, 1.6, ARENA_Z + 9);
			this.scene.add(sp2);
		}
	}
	private drawTick(gx: number, mcap: number | null) {
		const t = this.mcapTicks.find((k) => k.gx === gx); if (!t) return;
		const x = t.canvas.getContext('2d')!;
		x.clearRect(0, 0, 192, 56);
		x.textAlign = 'center'; x.textBaseline = 'middle';
		const col = gx > 0 ? 'rgba(122,255,176,0.95)' : 'rgba(255,138,149,0.95)';
		const pct = Math.round(gx * PCT_PER_UNIT); // ladder is scaled: world x -> % move
		x.font = '700 15px "JetBrains Mono", monospace';
		x.fillStyle = 'rgba(255,255,255,0.4)';
		x.fillText(`${pct > 0 ? '+' : ''}${pct}%`, 96, 10);
		x.font = '800 27px "JetBrains Mono", monospace';
		x.fillStyle = col;
		x.shadowColor = 'rgba(0,0,0,0.9)'; x.shadowBlur = 6;
		x.fillText(mcap ? fmtUsdShort(mcap * (1 + gx * PCT_PER_UNIT / 100)) : '····', 96, 34);
		x.shadowBlur = 0;
		t.tex.needsUpdate = true;
	}
	// the ladder is FIXED for the duration of a campaign (NewHedge's fixed price
	// increments): it anchors at the cap when the round opens, and the live mcap
	// marker rides across it. A new campaign re-bases the ladder at the latest cap.
	private liveMcap = 0;
	setMcapLadder(mcap: number) {
		if (!mcap) return;
		const first = !this.liveMcap;
		this.liveMcap = mcap;
		if (first) this.rebaseLadder();
	}
	private rebaseLadder() {
		if (!this.liveMcap) return;
		this.lastLadderMcap = this.liveMcap;
		for (const t of this.mcapTicks) this.drawTick(t.gx, this.liveMcap);
	}

	private mcapSprite!: THREE.Sprite;
	private mcapCanvas!: HTMLCanvasElement;
	private mcapTex!: THREE.CanvasTexture;
	private buildMcapSign() {
		const c = document.createElement('canvas'); c.width = 512; c.height = 200; this.mcapCanvas = c;
		this.mcapTex = new THREE.CanvasTexture(c); this.mcapTex.colorSpace = THREE.SRGBColorSpace;
		this.mcapSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.mcapTex, transparent: true, depthTest: false }));
		this.mcapSprite.scale.set(12, 4.6, 1);
		this.mcapSprite.renderOrder = 999;
		this.scene.add(this.mcapSprite);
		this.setMarketCap('—', 0);
	}
	setMarketCap(value: string, dir: number) {
		if (!this.mcapCanvas) return;
		const x = this.mcapCanvas.getContext('2d')!;
		x.clearRect(0, 0, 512, 200);
		const up = dir >= 0;
		const col = up ? '#2fe07a' : '#ff5560';
		// pill background
		x.fillStyle = 'rgba(10,14,12,0.82)';
		const rr = (px: number, py: number, w: number, h: number, r: number) => { x.beginPath(); x.moveTo(px + r, py); x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r); x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath(); };
		rr(16, 40, 480, 120, 26); x.fill(); x.lineWidth = 5; x.strokeStyle = col; x.stroke();
		x.textAlign = 'center'; x.textBaseline = 'middle';
		x.font = '700 26px "JetBrains Mono", monospace'; x.fillStyle = 'rgba(255,255,255,0.55)';
		x.fillText('MARKET CAP', 256, 68);
		x.font = '800 62px "JetBrains Mono", monospace'; x.fillStyle = '#fff';
		x.fillText(value, 236, 122);
		// direction arrow
		x.fillStyle = col; x.font = '800 60px system-ui, sans-serif';
		x.fillText(up ? '▲' : '▼', 236 + x.measureText(value).width / 2 + 44, 122);
		this.mcapTex.needsUpdate = true;
	}
	setPriceLabel(price: string, sub: string) {
		if (!this.priceCanvas) return;
		const x = this.priceCanvas.getContext('2d')!;
		x.clearRect(0, 0, 1024, 256);
		x.textAlign = 'center'; x.textBaseline = 'middle';
		x.font = '700 34px "JetBrains Mono", monospace'; x.fillStyle = 'rgba(30,30,20,0.6)';
		x.fillText(sub || 'CURRENT PRICE', 512, 40);
		x.font = '800 120px "JetBrains Mono", monospace';
		x.lineWidth = 10; x.strokeStyle = 'rgba(255,255,255,0.55)'; x.strokeText(price, 512, 150);
		x.fillStyle = 'rgba(35,32,20,0.85)'; x.fillText(price, 512, 150);
		this.priceTex.needsUpdate = true;
	}

	private buildArrows() {
		this.arrowMesh = new THREE.InstancedMesh(buildArrowGeo(), new THREE.MeshBasicMaterial({ vertexColors: true }), this.PROJ);
		this.arrowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.arrowMesh.count = this.PROJ; this.arrowMesh.frustumCulled = false;
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (let i = 0; i < this.PROJ; i++) { this.arrowMesh.setMatrixAt(i, this.dummy.matrix); this.arrowMesh.setColorAt(i, this.tmpColor.set(0xffffff)); }
		this.scene.add(this.arrowMesh);
		this.proj = Array.from({ length: this.PROJ }, () => ({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dmg: 0, team: 'bull' as Team, life: 0 }));
	}

	private buildSparks() {
		const N = this.SPARK_N; this.sparkPos = new Float32Array(N * 3); this.sparkColor = new Float32Array(N * 3); this.sparkVel = new Float32Array(N * 3); this.sparkLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.sparkPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.sparkColor, 3));
		this.sparks = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.95)'), size: 0.55, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.35 }));
		this.sparks.frustumCulled = false; this.scene.add(this.sparks);
	}
	// ambient war-embers: faint gold motes drifting up off the field all night long
	private embers!: THREE.Points; private emberPos!: Float32Array; private emberVel!: Float32Array; private emberLife!: Float32Array; private EMBER_N = 150;
	private buildEmbers() {
		const N = this.EMBER_N;
		this.emberPos = new Float32Array(N * 3); this.emberVel = new Float32Array(N * 3); this.emberLife = new Float32Array(N);
		const colors = new Float32Array(N * 3);
		for (let i = 0; i < N; i++) {
			this.respawnEmber(i, true);
			const warm = 0.5 + Math.random() * 0.5;
			colors[i * 3] = 0.42 * warm; colors[i * 3 + 1] = 0.3 * warm; colors[i * 3 + 2] = 0.1 * warm;
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(this.emberPos, 3));
		g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		this.embers = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,220,160,0.9)'), size: 0.5, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
		this.embers.frustumCulled = false; this.scene.add(this.embers);
	}
	private respawnEmber(i: number, seed = false) {
		this.emberPos[i * 3] = (Math.random() - 0.5) * 150;
		this.emberPos[i * 3 + 1] = seed ? Math.random() * 9 : 0.3;
		this.emberPos[i * 3 + 2] = (Math.random() - 0.5) * 110;
		this.emberVel[i * 3] = (Math.random() - 0.5) * 0.5;
		this.emberVel[i * 3 + 1] = 0.35 + Math.random() * 0.65;
		this.emberVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
		this.emberLife[i] = 5 + Math.random() * 9;
	}
	private updateEmbers(dt: number) {
		const p = this.emberPos, v = this.emberVel;
		for (let i = 0; i < this.EMBER_N; i++) {
			this.emberLife[i] -= dt;
			if (this.emberLife[i] <= 0) { this.respawnEmber(i); continue; }
			p[i * 3] += (v[i * 3] + Math.sin(this.time * 0.7 + i) * 0.25) * dt;
			p[i * 3 + 1] += v[i * 3 + 1] * dt;
			p[i * 3 + 2] += v[i * 3 + 2] * dt;
		}
		(this.embers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
	}

	private smoke!: THREE.Points; private smokePos!: Float32Array; private smokeVel!: Float32Array; private smokeLife!: Float32Array; private smokeMax!: Float32Array; private smokeColor!: Float32Array; private smokeHead = 0; private SMOKE_N = 240;
	private buildSmoke() {
		const N = this.SMOKE_N; this.smokePos = new Float32Array(N * 3); this.smokeColor = new Float32Array(N * 3); this.smokeVel = new Float32Array(N * 3); this.smokeLife = new Float32Array(N); this.smokeMax = new Float32Array(N);
		for (let i = 0; i < N; i++) this.smokePos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.smokePos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.smokeColor, 3));
		// normal-blended dark puffs — battle smoke drifting off the impacts
		this.smoke = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(190,180,170,0.55)'), size: 3.4, vertexColors: true, transparent: true, opacity: 0.42, depthWrite: false, alphaTest: 0.02 }));
		this.smoke.frustumCulled = false; this.scene.add(this.smoke);
	}
	private spawnSmoke(x: number, y: number, z: number, n: number) {
		for (let k = 0; k < n; k++) {
			const i = this.smokeHead; this.smokeHead = (this.smokeHead + 1) % this.SMOKE_N;
			this.smokePos[i * 3] = x + (Math.random() - 0.5) * 2.4; this.smokePos[i * 3 + 1] = y + Math.random() * 0.8; this.smokePos[i * 3 + 2] = z + (Math.random() - 0.5) * 2.4;
			this.smokeVel[i * 3] = (Math.random() - 0.5) * 1.1; this.smokeVel[i * 3 + 1] = 1.1 + Math.random() * 1.3; this.smokeVel[i * 3 + 2] = (Math.random() - 0.5) * 1.1;
			const l = 1.6 + Math.random() * 1.6; this.smokeLife[i] = l; this.smokeMax[i] = l;
			const v = 0.16 + Math.random() * 0.1;
			this.smokeColor[i * 3] = v; this.smokeColor[i * 3 + 1] = v * 0.92; this.smokeColor[i * 3 + 2] = v * 0.82;
		}
	}

	private buildSouls() {
		const N = this.SOUL_N; this.soulPos = new Float32Array(N * 3); this.soulColor = new Float32Array(N * 3); this.soulVel = new Float32Array(N * 3); this.soulLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.soulPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.soulPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.soulColor, 3));
		this.souls = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.9)'), size: 1.5, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.25 }));
		this.souls.frustumCulled = false; this.scene.add(this.souls);
	}

	// Blob shadows. A KayKit character is ~20 separate skinned meshes, so real
	// shadow-casting meant 1000+ extra draws per frame (8ms — half the budget) for
	// an army. One instanced soft circle per fighter grounds them for almost nothing.
	private unitShadows!: THREE.InstancedMesh;
	private buildUnitShadows() {
		const geo = new THREE.CircleGeometry(1, 14); geo.rotateX(-Math.PI / 2);
		const mat = new THREE.MeshBasicMaterial({ map: radialTexture('rgba(0,0,0,0.5)'), transparent: true, opacity: 0.5, depthWrite: false });
		this.unitShadows = new THREE.InstancedMesh(geo, mat, 240);
		this.unitShadows.frustumCulled = false;
		this.unitShadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.unitShadows.count = 0;
		this.scene.add(this.unitShadows);
	}

	private buildDecals() {
		// battle scars where warriors fall — fade out by shrinking
		const geo = new THREE.CircleGeometry(0.85, 10); geo.rotateX(-Math.PI / 2);
		this.decals = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0x2b1d10, transparent: true, opacity: 0.34, depthWrite: false }), this.DECAL_N);
		this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.decals.count = this.DECAL_N; this.decals.frustumCulled = false;
		this.decalLife = new Float32Array(this.DECAL_N); this.decalBase = new Float32Array(this.DECAL_N);
		this.decalX = new Float32Array(this.DECAL_N); this.decalZ = new Float32Array(this.DECAL_N);
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (let i = 0; i < this.DECAL_N; i++) this.decals.setMatrixAt(i, this.dummy.matrix);
		this.scene.add(this.decals);
	}
	private addDecal(x: number, z: number, s: number) {
		const i = this.decalHead; this.decalHead = (this.decalHead + 1) % this.DECAL_N;
		this.decalLife[i] = 26; this.decalBase[i] = s * (0.9 + Math.random() * 0.7);
		this.decalX[i] = x; this.decalZ[i] = z;
	}
	private updateDecals(dt: number) {
		let dirty = false;
		for (let i = 0; i < this.DECAL_N; i++) {
			if (this.decalLife[i] <= 0) continue;
			this.decalLife[i] -= dt;
			const k = THREE.MathUtils.clamp(this.decalLife[i] / 26, 0, 1);
			this.dummy.position.set(this.decalX[i], groundY(this.decalX[i], this.decalZ[i]) + 0.03 + (i % 9) * 0.0022, this.decalZ[i]);
			this.dummy.rotation.set(0, (i * 0.7) % Math.PI, 0);
			this.dummy.scale.setScalar(this.decalBase[i] * Math.sqrt(k));
			this.dummy.updateMatrix();
			this.decals.setMatrixAt(i, this.dummy.matrix);
			dirty = true;
		}
		if (dirty) this.decals.instanceMatrix.needsUpdate = true;
	}

	private buildAuras() {
		const runeGeo = new THREE.RingGeometry(1.05, 1.3, 40), rune2Geo = new THREE.RingGeometry(1.55, 1.68, 40), crownGeo = new THREE.OctahedronGeometry(0.22, 0);
		for (let i = 0; i < 12; i++) {
			const grp = new THREE.Group();
			const r1 = new THREE.Mesh(runeGeo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); r1.rotation.x = -Math.PI / 2; r1.position.y = 0.08; r1.name = 'r1';
			const r2 = new THREE.Mesh(rune2Geo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); r2.rotation.x = -Math.PI / 2; r2.position.y = 0.08; r2.name = 'r2';
			const crown = new THREE.Mesh(crownGeo, new THREE.MeshBasicMaterial({ color: 0xffd34d })); crown.name = 'crown';
			grp.add(r1, r2, crown); grp.visible = false; this.scene.add(grp); this.auras.push(grp);
		}
	}

	// ---------- camera ----------

	private bindCamera(canvas: HTMLCanvasElement) {
		this.on(canvas, 'pointerdown', (e) => { const p = e as PointerEvent; this.dragging = true; this.lastPtr = { x: p.clientX, y: p.clientY }; this.manualUntil = performance.now() + 7000; });
		this.on(window, 'pointerup', () => (this.dragging = false));
		this.on(window, 'pointermove', (e) => {
			if (!this.dragging) return;
			const p = e as PointerEvent;
			const dx = p.clientX - this.lastPtr.x, dy = p.clientY - this.lastPtr.y; this.lastPtr = { x: p.clientX, y: p.clientY };
			this.camYaw -= dx * 0.005; this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.0035, 0.05, 0.95); this.manualUntil = performance.now() + 7000;
		});
		this.on(canvas, 'wheel', (e) => { e.preventDefault(); this.camZoom = THREE.MathUtils.clamp(this.camZoom * (1 + Math.sign((e as WheelEvent).deltaY) * 0.08), 0.45, 2.0); }, { passive: false });
		this.on(window, 'keydown', (e) => {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA') return; // never hijack typing
			const k = (e as KeyboardEvent).key.toLowerCase(); if ('wasd'.includes(k)) this.keys.add(k);
		});
		this.on(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).key.toLowerCase()));
		this.on(window, 'blur', () => this.keys.clear()); // no stuck pan on alt-tab
	}

	// ---------- public API ----------

	setSupply(_s: number) {}
	// each campaign is a price-range battle anchored at its opening move: the front reads
	// (momentum − anchor), so a won theater resets to a fresh fight instead of instantly
	// re-storming the gate while the timeframe change stays pumped. Timeframe switches
	// shift the anchor by the jump so the front never teleports.
	private momentumAnchor = 0; private anchorReady = false;
	setMomentum(m: number) {
		if (!this.anchorReady) { this.momentumAnchor = m; this.anchorReady = true; }
		else if (Math.abs(m - this.momentum) > 20) this.momentumAnchor += m - this.momentum;
		this.momentum = m;
	}
	// continuous garrison reinforcements/sec per side — scales with the selected timeframe's txn rate
	setReinforceRates(b: number, s: number) { this.reinB = b; this.reinS = s; }
	setTrackWallet(w: string | null) { this.trackWallet = w ? w.trim() : null; for (const u of this.units) u.tracked = !!this.trackWallet && u.wallet === this.trackWallet; }
	setFocus(f: boolean) { this.focus = f; }
	resetCamera() { this.manualUntil = 0; this.camYaw = 0.06; this.camPitch = 0.4; this.camZoom = 0.6; this.panX = 0; this.panZ = 0; }

	spawnGarrison(bulls: number, bears: number) {
		this.lastGarrison = { bulls, bears };
		for (let i = 0; i < bulls; i++) this.addUnit('bull', pickClass('SOLDIER', Math.random()), GARRISON, '', false, true, true);
		for (let i = 0; i < bears; i++) this.addUnit('bear', pickClass('SOLDIER', Math.random()), GARRISON, '', false, true, true);
	}

	spawn(input: SpawnInput) {
		const team: Team = input.kind === 'buy' || input.kind === 'bull' ? 'bull' : 'bear';
		let tier = tierForPct(input.pct);
		// RANK MUST BE EARNED IN DOLLARS. On a microcap a $12 trade can move 0.05% of
		// supply — without a full dollar ladder every dust buy fields a chariot and the
		// elites drown out the infantry. Supply share qualifies you; dollars cap you.
		const cap = input.usd >= 1000 ? 'TITAN' : input.usd >= 300 ? 'CHAMPION' : input.usd >= 60 ? 'ELITE' : 'SOLDIER';
		if (rankIdx(tier.name) > rankIdx(cap)) tier = TIERS.find((t) => t.name === cap)!;
		const legend = tier.name === 'TITAN';
		const cls = pickClass(tier.name, hash01(input.wallet + input.usd));
		const u = this.addUnit(team, cls, tier, input.wallet, legend, false);
		// every real trade lands with a visible team-coloured muster flash; a legend's
		// awakening churns the earth — smoke rolls off the grave and souls rise
		if (u) {
			this.spawnBurst(u.x, groundY(u.x, u.z) + 1.2, u.z, team === 'bull' ? GOLD : CRIMSON, legend ? 26 : 6);
			if (legend && !input.quiet) {
				this.spawnSmoke(u.x, 0.6, u.z, 9);
				for (let k = 0; k < 3; k++) this.spawnSoul(u.x + (Math.random() - 0.5) * 2, 1 + Math.random(), u.z + (Math.random() - 0.5) * 2, team === 'bull' ? GOLD : CRIMSON);
				this.addDecal(u.x, u.z, 2.2);
			}
		}
		if (input.wallet) {
			// bounded roster — drop the least notable wallet when full
			if (!this.commanders.has(input.wallet) && this.commanders.size >= 160) {
				let worstK: string | null = null, worst = Infinity;
				for (const [w, c] of this.commanders) { const score = c.kills * 1000 + c.usd; if (score < worst) { worst = score; worstK = w; } }
				if (worstK) this.commanders.delete(worstK);
			}
			const c = this.commanders.get(input.wallet) || { kills: 0, tier: tier.name, team, usd: 0 };
			c.team = team; c.usd = Math.max(c.usd, input.usd); if (rankIdx(tier.name) > rankIdx(c.tier)) c.tier = tier.name;
			this.commanders.set(input.wallet, c);
			if (input.usd > this.biggestWhaleUsd) { this.biggestWhaleUsd = input.usd; this.biggestWhaleWallet = input.wallet; }
		}
		// quiet spawns replay history on page load — units muster without the fireworks
		if (input.quiet) return;
		if (legend) { this.shake = Math.min(1.6, this.shake + 0.9); this.zoomPunch = 0.7; }
		this.onEvent?.({ type: legend ? 'legend' : 'spawn', team, tier: tier.name, cls, wallet: input.wallet, usd: input.usd, pct: input.pct });
		// a champion entering the field calls down a falcon dive on the enemy host
		if (legend) {
			this.skyStrike(team);
			this.onEvent?.({ type: 'strike', team, tier: 'TITAN', cls, wallet: input.wallet, usd: input.usd, pct: input.pct });
		}
	}

	private aliveCount(team: Team): number {
		let n = 0; for (const u of this.units) if (u.team === team && u.dying <= 0) n++; return n;
	}

	private addUnit(team: Team, cls: Cls, tier: Tier, wallet: string, legend: boolean, atFront: boolean, gated = false): Unit | null {
		// Hold each side at the cap. Reinforcements simply stop; a real trade always
		// deploys, standing down the rear-most garrison soldier to make room — so the
		// field can never outgrow the character pool (past it, units render as nothing).
		if (this.aliveCount(team) >= this.SIDE_CAP) {
			if (gated) return null;
			// stand down the rear-most soldier to make room. Prefer a nameless garrison
			// grunt; but if the whole roster is wallet-tagged traders, retire the rear-most
			// of those too — the cap MUST hold or the field outgrows the character pool.
			let oi = -1, bestD = -1, fallback = -1, fbD = -1;
			for (let i = 0; i < this.units.length; i++) {
				const c = this.units[i];
				if (c.team !== team || c.dying > 0 || c.legend) continue;
				const d = Math.abs(c.x - this.frontX);
				if (!c.wallet) { if (d > bestD) { bestD = d; oi = i; } }
				else if (d > fbD) { fbD = d; fallback = i; }
			}
			if (oi < 0) oi = fallback;
			if (oi >= 0) { const old = this.units[oi]; if (old.char >= 0) this.chars.release(old.char); this.units.splice(oi, 1); }
			else return null; // nothing removable (all legends) — refuse rather than overflow
		}
		const sign = team === 'bull' ? -1 : 1;
		const st = CLASS_STATS[cls];
		this.units.push({
			team, sign, cls, ranged: st.ranged, tier: tier.name,
			scale: tier.scale * st.scaleMul, hp: tier.hp * st.hpMul, maxHp: tier.hp * st.hpMul, dmg: tier.dmg * st.dmgMul,
			standoff: st.standoff, speed: SPEED * st.speedMul,
			wallet,
			x: atFront ? sign * (3 + Math.random() * 13) : sign * (CAP - 2 - Math.random() * 4),
			// rear spawns muster on the road and march to the front in columns
			z: atFront ? (Math.random() - 0.5) * ARENA_Z * 2 : ROAD_Z + (Math.random() - 0.5) * 7,
			rank: atFront ? Math.random() * 3 : Math.random() * 6,
			bob: Math.random() * Math.PI * 2, age: 0, cd: Math.random() * 1.5, kills: 0, idx: this.nextId++, dying: 0,
			tracked: !!this.trackWallet && wallet === this.trackWallet, legend, melee: false,
			target: null, retarget: Math.random() * 0.4, atkCd: Math.random() * 0.8, strike: 0,
			face: sign < 0 ? 0 : Math.PI, // rotY that points local +x (weapon) at the enemy side
			tint: 0.92 + Math.random() * 0.16, struck: 0, swingSide: Math.random() < 0.5 ? 1 : -1,
			lane: (Math.random() - 0.5) * ARENA_Z * 2,
			// formation post: quantized file across the field, class decides the rank depth
			slot: Math.round(((Math.random() - 0.5) * (ARENA_Z * 2 - 6)) / 2.6) * 2.6,
			row: cls === 'guardian' ? 0 : cls === 'spear' ? (Math.random() < 0.55 ? 0 : 1) : 2 + ((Math.random() * 2) | 0),
			frontJitter: -3 + Math.random() * 14, // ranged skirmish depth
			flank: !st.ranged && (cls === 'duelist' ? Math.random() < 0.3 : Math.random() < 0.08),
			spin: Math.random() * Math.PI * 2, px: 0, pz: 0, char: -1
		});
		const u = this.units[this.units.length - 1];
		u.px = u.x; u.pz = u.z;
		// every fighter takes the field as a real animated character
		u.char = this.chars.claim(team, cls as Role);
		return u;
	}

	start() { this.last = performance.now(); this.loop(); }
	dispose() {
		cancelAnimationFrame(this.raf);
		for (const off of this.unbind) off();
		this.unbind = [];
		this.scene.traverse((o) => {
			const m = o as THREE.Mesh;
			if (m.geometry) m.geometry.dispose();
			const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
			for (const mat of mats) { (mat as THREE.MeshBasicMaterial).map?.dispose(); mat.dispose(); }
		});
		this.chars.dispose();
		this.composer.dispose(); this.renderer.dispose();
	}
	private resize() {
		// a minimized/hidden window reports 0×0 — applying it would NaN the camera
		// aspect and leave a dead canvas. Keep the last good size instead.
		if (!innerWidth || !innerHeight) return;
		this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
		this.renderer.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight);
	}

	// ---------- particles ----------

	private spawnBurst(x: number, y: number, z: number, color: THREE.Color, n: number) {
		for (let k = 0; k < n; k++) { const i = this.sparkHead; this.sparkHead = (this.sparkHead + 1) % this.SPARK_N; this.sparkPos[i * 3] = x; this.sparkPos[i * 3 + 1] = y; this.sparkPos[i * 3 + 2] = z; this.sparkVel[i * 3] = (Math.random() - 0.5) * 9; this.sparkVel[i * 3 + 1] = 2 + Math.random() * 8; this.sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 9; this.sparkLife[i] = 0.5 + Math.random() * 0.5; this.sparkColor[i * 3] = color.r; this.sparkColor[i * 3 + 1] = color.g; this.sparkColor[i * 3 + 2] = color.b; }
	}
	private spawnSoul(x: number, y: number, z: number, color: THREE.Color) {
		const i = this.soulHead; this.soulHead = (this.soulHead + 1) % this.SOUL_N; this.soulPos[i * 3] = x; this.soulPos[i * 3 + 1] = y; this.soulPos[i * 3 + 2] = z; this.soulVel[i * 3] = (Math.random() - 0.5) * 0.6; this.soulVel[i * 3 + 1] = 2.4 + Math.random() * 1.4; this.soulVel[i * 3 + 2] = (Math.random() - 0.5) * 0.6; this.soulLife[i] = 2.2 + Math.random() * 1.2; const c = color.clone().lerp(new THREE.Color(0xffffff), 0.5); this.soulColor[i * 3] = c.r; this.soulColor[i * 3 + 1] = c.g; this.soulColor[i * 3 + 2] = c.b;
	}
	private updateParticles(dt: number) {
		const p = this.sparkPos, v = this.sparkVel, l = this.sparkLife;
		for (let i = 0; i < this.SPARK_N; i++) { if (l[i] <= 0) continue; l[i] -= dt; v[i * 3 + 1] -= 14 * dt; p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt; if (l[i] <= 0) p[i * 3 + 1] = -999; }
		(this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true; (this.sparks.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
		const sp = this.soulPos, sv = this.soulVel, sl = this.soulLife;
		for (let i = 0; i < this.SOUL_N; i++) { if (sl[i] <= 0) continue; sl[i] -= dt; sp[i * 3] += sv[i * 3] * dt + Math.sin(this.time * 2 + i) * 0.01; sp[i * 3 + 1] += sv[i * 3 + 1] * dt; sp[i * 3 + 2] += sv[i * 3 + 2] * dt; if (sl[i] <= 0) sp[i * 3 + 1] = -999; }
		(this.souls.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true; (this.souls.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
		// smoke: drift up and sideways, darken into the night as it dies
		const mp = this.smokePos, mv = this.smokeVel, ml = this.smokeLife, mm = this.smokeMax, mc = this.smokeColor;
		for (let i = 0; i < this.SMOKE_N; i++) {
			if (ml[i] <= 0) continue;
			ml[i] -= dt;
			mp[i * 3] += mv[i * 3] * dt; mp[i * 3 + 1] += mv[i * 3 + 1] * dt; mp[i * 3 + 2] += mv[i * 3 + 2] * dt;
			mv[i * 3 + 1] = Math.max(0.25, mv[i * 3 + 1] - dt * 0.5);
			const k = Math.max(0, ml[i] / mm[i]);
			const v = (0.16 + 0.1) * k * k; // quadratic fade toward black = smoke thinning out
			mc[i * 3] = v; mc[i * 3 + 1] = v * 0.92; mc[i * 3 + 2] = v * 0.82;
			if (ml[i] <= 0) mp[i * 3 + 1] = -999;
		}
		(this.smoke.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true; (this.smoke.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
	}

	// ---------- sky strikes (whale events) ----------

	// A TITAN buy/sell sends a falcon of war diving out of the night onto the enemy
	// host — the market's biggest orders land as unmissable battlefield events,
	// scaled like NewHedge's liquidation strikes.
	private strikesFx: { t: number; dur: number; sx: number; sy: number; sz: number; tx: number; ty: number; tz: number; team: Team; mesh: THREE.Mesh; hit: boolean }[] = [];

	private skyStrike(team: Team) {
		if (this.strikesFx.length >= 4) return;
		const foes: Unit[] = [];
		for (const u of this.units) if (u.team !== team && u.dying <= 0) foes.push(u);
		if (!foes.length) return;
		// aim at an enemy just behind the front, biased toward the thick of the host
		const sign = team === 'bull' ? 1 : -1;
		let best = foes[0], bd = Infinity;
		for (const e of foes) {
			const d = Math.abs(e.x - (this.frontX + sign * 7)) + Math.abs(e.z) * 0.25 + Math.random() * 9;
			if (d < bd) { bd = d; best = e; }
		}
		const tx = best.x, tz = best.z, ty = groundY(tx, tz);
		const col = team === 'bull' ? 0xffe08a : 0xff8a95;
		const geo = new THREE.OctahedronGeometry(1.0, 0); geo.scale(1, 2.8, 1);
		const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
		const mesh = new THREE.Mesh(geo, mat);
		const sx = tx - sign * 44, sy = ty + 36, sz = tz + (Math.random() - 0.5) * 24;
		mesh.position.set(sx, sy, sz);
		this.scene.add(mesh);
		this.strikesFx.push({ t: 0, dur: 0.55, sx, sy, sz, tx, ty, tz, team, mesh, hit: false });
	}

	private updateStrikes(dt: number) {
		for (let i = this.strikesFx.length - 1; i >= 0; i--) {
			const s = this.strikesFx[i];
			s.t += dt;
			const k = Math.min(1, s.t / s.dur);
			// dive along a shallow arc, trailing embers
			const x = THREE.MathUtils.lerp(s.sx, s.tx, k);
			const y = THREE.MathUtils.lerp(s.sy, s.ty + 0.5, k * k);
			const z = THREE.MathUtils.lerp(s.sz, s.tz, k);
			s.mesh.position.set(x, y, z);
			this.vTmp.set(s.tx - s.sx, (s.ty - s.sy) * 2 * k, s.tz - s.sz).normalize();
			this.q.setFromUnitVectors(this.upV, this.vTmp);
			s.mesh.quaternion.copy(this.q);
			const c = s.team === 'bull' ? GOLD : CRIMSON;
			for (let n = 0; n < 3; n++) {
				const ti = this.sparkHead; this.sparkHead = (this.sparkHead + 1) % this.SPARK_N;
				this.sparkPos[ti * 3] = x + (Math.random() - 0.5); this.sparkPos[ti * 3 + 1] = y + (Math.random() - 0.5); this.sparkPos[ti * 3 + 2] = z + (Math.random() - 0.5);
				this.sparkVel[ti * 3] = 0; this.sparkVel[ti * 3 + 1] = 1; this.sparkVel[ti * 3 + 2] = 0;
				this.sparkLife[ti] = 0.25 + Math.random() * 0.2;
				this.sparkColor[ti * 3] = c.r * 2; this.sparkColor[ti * 3 + 1] = c.g * 2; this.sparkColor[ti * 3 + 2] = c.b * 2;
			}
			if (k >= 1 && !s.hit) { s.hit = true; this.strikeImpact(s.team, s.tx, s.tz); }
			if (k >= 1) {
				this.scene.remove(s.mesh);
				s.mesh.geometry.dispose();
				(s.mesh.material as THREE.Material).dispose();
				this.strikesFx.splice(i, 1);
			}
		}
	}

	private strikeImpact(team: Team, x: number, z: number) {
		const col = team === 'bull' ? GOLD : CRIMSON;
		this.spawnBurst(x, groundY(x, z) + 1, z, col, 90);
		this.spawnSmoke(x, groundY(x, z) + 1.2, z, 13);
		this.addDecal(x, z, 2.4);
		this.shake = Math.min(2, this.shake + 1.1);
		// the explosion throws real light across the field
		this.flareLight(x, groundY(x, z) + 2.5, z, team === 'bull' ? 0xffe08a : 0xff8a95, 8, 32, 0.65);
		let hits = 0;
		const maxHits = 6, r2 = 7.5 ** 2, dmg = 460;
		for (const e of this.units) {
			if (e.team === team || e.dying > 0) continue;
			const dx = e.x - x, dz = e.z - z;
			if (dx * dx + dz * dz < r2) {
				e.hp -= dmg; e.struck = 0.2;
				if (e.hp <= 0) this.kill(e, []);
				if (++hits >= maxHits) break;
			}
		}
	}

	// ---------- projectiles ----------

	private fireArrowAt(u: Unit, t: Unit) {
		const p = this.proj[this.projHead]; this.projHead = (this.projHead + 1) % this.PROJ;
		const sx = u.x, sy = hillY(u.x) + 1.4 * u.scale * UNIT_SCALE, sz = u.z;
		// aim at the target with slight scatter
		const tx = t.x + (Math.random() - 0.5) * 1.6, tz = t.z + (Math.random() - 0.5) * 1.6, ty = hillY(tx) + 0.9;
		const dist = Math.hypot(tx - sx, tz - sz);
		const T = THREE.MathUtils.clamp(dist / 30, 0.45, 0.95), g = 18; // high, slow arcs — volleys hang in the air
		p.active = true; p.x = sx; p.y = sy; p.z = sz;
		p.dmg = u.dmg * ATK_CD.archer * KILL_TEMPO * 0.6 * this.teamMul(u.team); p.team = u.team; p.life = T + 0.25;
		p.vx = (tx - sx) / T; p.vz = (tz - sz) / T; p.vy = (ty - sy + 0.5 * g * T * T) / T;
		// muzzle flash toward the target
		this.spawnBurst(sx + ((tx - sx) / dist) * 1.1, sy, sz + ((tz - sz) / dist) * 1.1, new THREE.Color(0xffe9a0), 3);
		// first shaft of each volley signal announces the massed release — arrows really flew
		if (!this.volleyAnnounced && this.volleyWindow > 0) {
			this.volleyAnnounced = true;
			const archers = this._bullComp.archer + this._bearComp.archer;
			this.onEvent?.({ type: 'volley', team: u.team, tier: '', cls: 'archer', wallet: '', usd: archers, pct: 0 });
		}
	}

	private updateArrows(dt: number) {
		const g = 18; let dirty = false;
		for (let i = 0; i < this.PROJ; i++) {
			const p = this.proj[i];
			if (!p.active) continue;
			p.vy -= g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.life -= dt;
			if (p.y <= hillY(p.x) + 0.4 || p.life <= 0) {
				p.active = false;
				this.spawnBurst(p.x, hillY(p.x) + 0.6, p.z, p.team === 'bull' ? GOLD : CRIMSON, 4);
				let best: Unit | null = null, bd = 9;
				for (const e of this.units) { if (e.team === p.team || e.dying > 0) continue; const dx = e.x - p.x, dz = e.z - p.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = e; } }
				if (best) { best.hp -= p.dmg * this.guardMul(best); best.struck = 0.16; if (best.hp <= 0) this.kill(best, []); }
				this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); this.arrowMesh.setMatrixAt(i, this.dummy.matrix); dirty = true;
				continue;
			}
			this.vTmp.set(p.vx, p.vy, p.vz).normalize();
			this.q.setFromUnitVectors(this.upV, this.vTmp);
			this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.q); this.dummy.scale.setScalar(1.55); this.dummy.updateMatrix();
			this.arrowMesh.setMatrixAt(i, this.dummy.matrix);
			// HDR tracer colour — pushes past 1.0 so the bloom pass streaks it across the night
			this.arrowMesh.setColorAt(i, this.tmpColor.copy(p.team === 'bull' ? GOLD : CRIMSON).lerp(new THREE.Color(0xffffff), 0.4).multiplyScalar(2.4));
			// short-lived ember trail behind each shaft
			if (Math.random() < 0.45) {
				const ti = this.sparkHead; this.sparkHead = (this.sparkHead + 1) % this.SPARK_N;
				this.sparkPos[ti * 3] = p.x; this.sparkPos[ti * 3 + 1] = p.y; this.sparkPos[ti * 3 + 2] = p.z;
				this.sparkVel[ti * 3] = 0; this.sparkVel[ti * 3 + 1] = 0.4; this.sparkVel[ti * 3 + 2] = 0;
				this.sparkLife[ti] = 0.14 + Math.random() * 0.1;
				const tc = p.team === 'bull' ? GOLD : CRIMSON;
				this.sparkColor[ti * 3] = tc.r * 1.6; this.sparkColor[ti * 3 + 1] = tc.g * 1.6; this.sparkColor[ti * 3 + 2] = tc.b * 1.6;
			}
			dirty = true;
		}
		if (dirty) { this.arrowMesh.instanceMatrix.needsUpdate = true; if (this.arrowMesh.instanceColor) this.arrowMesh.instanceColor.needsUpdate = true; }
	}

	// ---------- loop ----------

	private loop = () => {
		this.raf = requestAnimationFrame(this.loop);
		this.frame++;
		const now = performance.now();
		const rawDt = Math.min((now - this.last) / 1000, 0.25); this.last = now;
		const dt = Math.min(rawDt, 0.05); this.time += rawDt;
		this.fpsAvg = this.fpsAvg * 0.92 + (1 / Math.max(rawDt, 0.001)) * 0.08;
		// adaptive resolution: shed pixels before shedding frames, climb back when headroom returns
		this.qualTick += rawDt;
		if (this.qualTick > 2.5) {
			this.qualTick = 0;
			if (this.fpsAvg < 45 && this.quality > 0) this.applyQuality(this.quality - 1);
			else if (this.fpsAvg > 58 && this.quality < 2) this.applyQuality(this.quality + 1);
		}
		// self-heal a canvas that got sized while the window reported 0×0
		if (this.frame % 60 === 0 && this.renderer.domElement.width === 0 && innerWidth > 0 && innerHeight > 0) this.resize();
		this.slowmo = Math.max(0, this.slowmo - rawDt);
		this.timeScale += ((this.slowmo > 0 ? 0.32 : 1) - this.timeScale) * Math.min(1, rawDt * 6);
		const simDt = dt * this.timeScale;

		this.step(simDt);
		this.chars.update(simDt);
		this.updateArrows(simDt);
		this.updateSiege(simDt);
		this.updateStrikes(simDt);
		this.updateLights(simDt);
		this.updateParticles(simDt);
		this.updateEmbers(simDt);
		this.updateDecals(simDt);
		this.render(dt);

		this.statTick += dt; if (this.statTick > 0.2) { this.statTick = 0; this.emitStats(); }
		if (this.frame % 2 === 0) this.emitOverlay(); // 30Hz is plenty for DOM labels
	};

	private applyQuality(q: number) {
		this.quality = q;
		const ratio = q === 2 ? Math.min(devicePixelRatio, 1.5) : q === 1 ? 1 : 0.75;
		this.renderer.setPixelRatio(ratio);
		this.resize();
	}

	private emptyComp(): Comp { return { spear: 0, duelist: 0, archer: 0, guardian: 0, chariot: 0 }; }
	private _bullPower = 0; private _bearPower = 0; private _bullCount = 0; private _bearCount = 0;
	private _bullComp = this.emptyComp(); private _bearComp = this.emptyComp();

	private step(dt: number) {
		this.warClock += dt;
		const np = phaseAt(this.warClock);
		if (np !== this.battlePhase) {
			this.battlePhase = np;
			if (np === 'form') this.beginDuel();
			else if (np === 'advance') { this.duelA = null; this.duelB = null; } // champions rejoin the line
			else if (np === 'charge') this.awaitClash = true;
		}
		// volley signal: during standoffs the archers loose together, every few breaths
		this.volleyT -= dt;
		if (this.volleyT <= 0) { this.volleyT = 4.5; this.volleyWindow = 0.5; this.volleyAnnounced = false; }
		else this.volleyWindow -= dt;
		// a fallen (or removed) champion ends the single combat
		if (this.duelA && (this.duelA.dying > 0 || this.duelA.hp <= 0)) this.duelA = null;
		if (this.duelB && (this.duelB.dying > 0 || this.duelB.hp <= 0)) this.duelB = null;
		if (!this.duelA || !this.duelB) { this.duelA = null; this.duelB = null; }
		let bullPower = 0, bearPower = 0, bullCount = 0, bearCount = 0;
		const bc = this.emptyComp(), rc = this.emptyComp();
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.team === 'bull') { bullCount++; bc[u.cls]++; bullPower += u.dmg * (u.ranged ? 0.6 : 1); }
			else { bearCount++; rc[u.cls]++; bearPower += u.dmg * (u.ranged ? 0.6 : 1); }
		}

		if (this.phase === 'battle') {
			// THE LINE IS THE MARKET CAP — SPOT ON, ALWAYS. The front sits EXACTLY at the
			// live cap's position on the price ladder: world x == pricePct / PCT_PER_UNIT,
			// so the marker and every ladder tick read the same true $ level. Combat does
			// NOT move the line at all — the armies clash wherever price puts the seam, and
			// price, and price alone, decides where the line stands and when a gate falls.
			const tot = bullPower + bearPower;
			const delta = tot > 0 ? (bullPower - bearPower) / tot : 0;
			const pricePct = this.lastLadderMcap > 0 ? (this.liveMcap / this.lastLadderMcap - 1) * 100 : 0;
			const priceTarget = THREE.MathUtils.clamp(pricePct / PCT_PER_UNIT, -FRONT_MAX, FRONT_MAX);
			// war intensity climbs the longer a campaign runs — it musters bloodier
			// reinforcements (below); it does NOT touch the line.
			this.sudden = THREE.MathUtils.clamp((this.warClock - 300) / 240, 0, 1);
			if (this.sudden > 0 && !this.suddenAnnounced) {
				this.suddenAnnounced = true;
				this.onEvent?.({ type: 'sudden', team: delta >= 0 ? 'bull' : 'bear', tier: '', cls: 'spear', wallet: '', usd: 0, pct: 0 });
			}
			// glide the line onto the exact cap position (smoothing only — it settles
			// precisely on price, never beside it)
			this.frontX += (priceTarget - this.frontX) * Math.min(1, dt * 1.4);
			if (Math.abs(priceTarget - this.frontX) < 0.05) this.frontX = priceTarget;
			// price pushes the cap to the enemy end-zone → the theater falls
			if (this.frontX > FRONT_MAX * 0.9) this.winCampaign('bull');
			else if (this.frontX < -FRONT_MAX * 0.9) this.winCampaign('bear');
		} else if (performance.now() >= this.wonUntil) {
			this.resetCampaign();
		}

		// timeframe-driven reinforcements keep the war supplied (paused while a theater
		// falls). The pumping side musters faster — price is the recruiting sergeant.
		// THE WAR NEVER STARVES: a hard reinforcement floor holds even if every data
		// API dies, and a broken host below fighting strength rallies fresh war bands.
		if (this.phase === 'battle') {
			const tilt = THREE.MathUtils.clamp((this.momentum - this.momentumAnchor) / 50, -0.6, 0.6);
			const heat = 1 + this.sudden * 0.6; // long campaigns grow bloodier
			const FLOOR = 0.32;
			this.accB += Math.max(this.reinB, FLOOR) * (1 + tilt) * heat * dt;
			this.accS += Math.max(this.reinS, FLOOR) * (1 - tilt) * heat * dt;
			// hard rubber-band: hold each host near a big fighting strength so the clash
			// at the line stays a massed war, and a broken side rallies fresh bands fast
			if (bullCount < 80) this.accB += dt * (80 - bullCount) * 0.22;
			if (bearCount < 80) this.accS += dt * (80 - bearCount) * 0.22;
			while (this.accB >= 1) { this.accB -= 1; this.addUnit('bull', pickClass('SOLDIER', Math.random()), GARRISON, '', false, false, true); }
			while (this.accS >= 1) { this.accS -= 1; this.addUnit('bear', pickClass('SOLDIER', Math.random()), GARRISON, '', false, false, true); }
		}

		// live rosters for target acquisition
		const bullsAlive: Unit[] = [], bearsAlive: Unit[] = [];
		for (const u of this.units) if (u.dying <= 0) (u.team === 'bull' ? bullsAlive : bearsAlive).push(u);

		const acquire = (u: Unit, range: number, rangedOnly = false): Unit | null => {
			const foes = u.team === 'bull' ? bearsAlive : bullsAlive;
			let best: Unit | null = null, bd = range * range;
			for (const e of foes) {
				if (e.dying > 0 || e.hp <= 0 || (rangedOnly && !e.ranged)) continue;
				const dx = e.x - u.x, dz = e.z - u.z, d = dx * dx + dz * dz;
				if (d < bd) { bd = d; best = e; }
			}
			return best;
		};

		for (const u of this.units) {
			if (u.dying > 0) { u.dying -= dt; continue; }
			u.age += dt;
			u.rank = Math.max(0, u.rank - dt * 1.5); u.bob += dt * 9;
			u.strike = Math.max(0, u.strike - dt);
			u.struck = Math.max(0, u.struck - dt);
			u.atkCd -= dt;
			u.retarget -= dt;

			// theater fell: winners celebrate where they stand, losers rout to their capital
			if (this.phase === 'victory' && this.winner) {
				u.melee = false; u.target = null; u.strike = 0;
				if (u.team === this.winner) {
					u.bob += dt * 9; // double-time victory bounce
				} else {
					u.x += u.sign * u.speed * 1.6 * dt;
					const flee = u.sign < 0 ? Math.PI : 0; // run home, backs to the enemy
					let dA = flee - u.face;
					while (dA > Math.PI) dA -= Math.PI * 2;
					while (dA < -Math.PI) dA += Math.PI * 2;
					u.face += dA * Math.min(1, dt * 6);
				}
				continue;
			}

			// (re)acquire a real enemy to fight — how far we lock on breathes with the war rhythm
			const wp = this.battlePhase;
			const holding = wp === 'form' || wp === 'advance' || wp === 'regroup';
			const dueling = this.isDueling(u);
			const shaken = u.hp < u.maxHp * 0.3; // badly wounded — falls back, fights only if pressed
			if (dueling) {
				u.target = u === this.duelA ? this.duelB : this.duelA;
			} else if (u.retarget <= 0 || !u.target || u.target.hp <= 0 || u.target.dying > 0) {
				// melee units ALWAYS hunt for a foe across a wide range — the two hosts
				// press together and fight, they never just stand in formation
				const range = u.ranged ? 34 : shaken ? 7 : 30;
				u.target = (u.flank ? acquire(u, 40, true) : null) || acquire(u, range);
				u.retarget = 0.4 + Math.random() * 0.5; // re-scan foes less often — cheaper at big army sizes
			}

			let desiredFace: number | null = null;

			if (u.ranged) {
				// archers hold staggered firing lines — depth varies per unit
				u.melee = false;
				const tx = this.frontX + u.sign * (u.standoff + u.rank * 0.9 + Math.max(0, u.frontJitter) * 0.55);
				u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), u.speed * dt);
				// drift toward their lane so the line fills the whole arena depth
				u.z += Math.sign(u.lane - u.z) * Math.min(Math.abs(u.lane - u.z), u.speed * 0.3 * dt);
				if (u.target && (u.target.dying > 0 || u.target.hp <= 0)) u.target = null;
				if (u.target) {
					desiredFace = Math.atan2(-(u.target.z - u.z), u.target.x - u.x);
					// fire-control: loose at will in the fray, but volley together during the standoff
					const freeFire = wp === 'charge' || wp === 'melee';
					if (u.atkCd <= 0 && (freeFire || this.volleyWindow > 0)) {
						this.fireArrowAt(u, u.target); u.atkCd = ATK_CD.archer + Math.random() * 0.7;
						u.strike = 0.3;
					}
				}
			} else if (u.target && u.target.dying <= 0 && u.target.hp > 0) {
				const t = u.target;
				const dx = t.x - u.x, dz = t.z - u.z;
				const dist = Math.hypot(dx, dz);
				const reach = (u.scale + t.scale) * 0.5 * UNIT_SCALE * 1.1 + (u.cls === 'guardian' ? 1.1 : 0.45);
				desiredFace = Math.atan2(-dz, dx);
				if (dist > reach) {
					// close with the enemy — always advancing into the fight
					const step = Math.min(dist - reach * 0.9, u.speed * (wp === 'charge' ? 1.7 : 1.15) * dt);
					u.x += (dx / dist) * step; u.z += (dz / dist) * step;
					u.melee = dist < reach * 3;
					// dust kicked up under the charge
					if (wp === 'charge' && Math.random() < dt * 1.4) this.spawnBurst(u.x, groundY(u.x, u.z) + 0.25, u.z, this.tmpColor.set(0x6b5c44) as THREE.Color, 2);
				} else {
					// in reach — strike on cooldown
					u.melee = true;
					if (u.atkCd <= 0) {
						u.atkCd = ATK_CD[u.cls] * (0.9 + Math.random() * 0.2);
						u.strike = 0.32;
						u.swingSide = -u.swingSide; // duelists alternate blades, others shift their stance
						// the first blow after the horns lands in slow motion — the lines have met
						if (this.awaitClash) { this.awaitClash = false; this.slowmo = Math.max(this.slowmo, 0.8); this.shake = Math.min(1.4, this.shake + 0.5); }
						const per = u.dmg * ATK_CD[u.cls] * KILL_TEMPO * this.teamMul(u.team);
						const col = u.team === 'bull' ? GOLD : CRIMSON;
						this.spawnBurst(t.x, hillY(t.x) + 1.1, t.z, col, u.cls === 'guardian' ? 12 : 5);
						// knockback
						const kb = u.cls === 'guardian' ? 0.9 : 0.3;
						t.x += (dx / Math.max(0.01, dist)) * kb; t.z += (dz / Math.max(0.01, dist)) * kb * 0.4;
						t.hp -= per * this.guardMul(t); t.struck = 0.16;
						if (t.hp <= 0) this.kill(t, [u]);
						// a guardian's great khopesh cleaves through nearby enemies;
						// a chariot's horses trample whoever presses around its target
						const cleave = u.cls === 'guardian' ? { r: 2.4, mul: 0.55, max: 3 } : u.cls === 'chariot' ? { r: 2.0, mul: 0.45, max: 2 } : null;
						if (cleave) {
							const foes = u.team === 'bull' ? bearsAlive : bullsAlive;
							let hits = 0;
							for (const e of foes) {
								if (e === t || e.dying > 0 || e.hp <= 0) continue;
								const ex = e.x - t.x, ez = e.z - t.z;
								if (ex * ex + ez * ez < cleave.r * cleave.r) { e.hp -= per * cleave.mul * this.guardMul(e); e.struck = 0.16; if (e.hp <= 0) this.kill(e, [u]); if (++hits >= cleave.max) break; }
							}
							if (u.cls === 'guardian') this.shake = Math.min(1.2, this.shake + 0.12);
						}
					}
				}
			} else if (u.flank && !holding) {
				// FLANKERS sweep the arena edge, cross behind the line, and strike from the side
				u.melee = false;
				const wx = this.frontX - u.sign * (5 + Math.max(0, u.frontJitter));
				const wz = (u.lane >= 0 ? 1 : -1) * (ARENA_Z - 3);
				const dx = wx - u.x, dz = wz - u.z, d = Math.hypot(dx, dz);
				if (d > 1) { const st2 = Math.min(d, u.speed * 1.1 * dt); u.x += (dx / d) * st2; u.z += (dz / d) * st2; }
				desiredFace = Math.atan2(-dz, dx);
			} else {
				// no foe in reach (only at a campaign's first breath, or after a rout):
				// march straight to the front line and press across into the enemy so a
				// fresh fight starts immediately — never hold back in formation.
				u.melee = false;
				const shakenBack = shaken ? 3 : 0; // the badly wounded ease back a step
				const fx2 = this.frontX + u.sign * (0.5 + (u.row * 0.7) + shakenBack);
				const fz2 = THREE.MathUtils.clamp(u.slot * 0.5, -ARENA_Z + 2, ARENA_Z - 2);
				const ddx = fx2 - u.x, ddz = fz2 - u.z, dd = Math.hypot(ddx, ddz);
				if (dd > 0.15) {
					const st2 = Math.min(dd, u.speed * 1.2 * dt);
					u.x += (ddx / dd) * st2; u.z += (ddz / dd) * st2;
				}
				desiredFace = u.sign < 0 ? 0 : Math.PI; // eyes on the enemy line
			}

			// smooth facing
			if (desiredFace !== null) {
				let dAng = desiredFace - u.face;
				while (dAng > Math.PI) dAng -= Math.PI * 2;
				while (dAng < -Math.PI) dAng += Math.PI * 2;
				u.face += dAng * Math.min(1, dt * 9);
			} else {
				const home = u.sign < 0 ? 0 : Math.PI;
				let dAng = home - u.face;
				while (dAng > Math.PI) dAng -= Math.PI * 2;
				while (dAng < -Math.PI) dAng += Math.PI * 2;
				u.face += dAng * Math.min(1, dt * 5);
			}
		}

		// separation — spatial hash keeps fighters from stacking into a single blob
		const grid = new Map<number, Unit[]>();
		for (const u of this.units) {
			if (u.dying > 0) continue;
			const key = Math.floor((u.x + 80) / 1.9) * 512 + Math.floor((u.z + 60) / 1.9);
			let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); }
			arr.push(u);
		}
		for (const arr of grid.values()) {
			const n = Math.min(arr.length, 7);
			for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
				const a = arr[i], b = arr[j];
				const dx = b.x - a.x, dz = b.z - a.z;
				const d2 = dx * dx + dz * dz;
				const min = (a.scale + b.scale) * 0.42 * UNIT_SCALE;
				if (d2 < min * min && d2 > 0.0001) {
					const d = Math.sqrt(d2), push = (min - d) * 0.4;
					const px = (dx / d) * push, pz = (dz / d) * push;
					a.x -= px; a.z -= pz; b.x += px; b.z += pz;
				}
			}
		}
		// keep everyone inside the arena and off the capitals — and leash the melee to
		// the line: neither host may drive more than a short push PAST the front into
		// enemy ground, so the two armies always clash ON the price line instead of
		// scattering across the field or chasing routers back to the enemy's spawn.
		const PUSH = 9;
		for (const u of this.units) {
			if (u.dying > 0) continue;
			u.z = THREE.MathUtils.clamp(u.z, -ARENA_Z - 2, ARENA_Z + 2);
			u.x = THREE.MathUtils.clamp(u.x, -CAP + 3, CAP - 3);
			if (u.team === 'bull') u.x = Math.min(u.x, this.frontX + PUSH);
			else u.x = Math.max(u.x, this.frontX - PUSH);
		}

		this.updateUnits();

		this.frontLine.position.x = this.frontX; this.frontLine.position.y = hillY(this.frontX) + 0.12;
		(this.frontLine.material as THREE.MeshBasicMaterial).opacity = 0.2 + Math.sin(this.time * 5) * 0.07;
		// liquidity buffers hug the front — each side's width breathes with its tape share
		{
			const tot = this.presB + this.presS;
			const share = tot > 0 ? this.presB / tot : 0.5;
			const wb = 2.5 + share * 8, ws = 2.5 + (1 - share) * 8;
			this.bufWB += (wb - this.bufWB) * Math.min(1, dt * 1.5);
			this.bufWS += (ws - this.bufWS) * Math.min(1, dt * 1.5);
			this.bufBull.scale.x = this.bufWB; this.bufBull.position.x = this.frontX - this.bufWB / 2 - 1;
			this.bufBear.scale.x = -this.bufWS; this.bufBear.position.x = this.frontX + this.bufWS / 2 + 1;
			// ride the hill — a flat y would sink these under the terrain at mid-field
			this.bufBull.position.y = this.bufBear.position.y = hillY(this.frontX) + 0.1;
		}
		// the gates breathe — brighter as the front closes in on them
		for (let gi = 0; gi < this.gates.length; gi++) {
			const g = this.gates[gi];
			const near = 1 - Math.min(1, Math.abs(this.frontX - g.position.x) / FRONT_MAX);
			(g.material as THREE.MeshBasicMaterial).opacity = 0.1 + Math.sin(this.time * 2 + gi * 2) * 0.03 + near * 0.3;
		}
		// the standards march with their host's edge of the front
		for (const st of this.standards) {
			const sx = this.frontX + st.side * 7;
			st.grp.position.x += (sx - st.grp.position.x) * Math.min(1, dt * 1.2);
			st.grp.position.y = groundY(st.grp.position.x, st.grp.position.z);
		}
		// the market-cap marker rides the front line (its altitude on the hill)
		this.mcapSprite.position.set(this.frontX, hillY(this.frontX) + 15 + Math.sin(this.time * 1.5) * 0.4, 0);

		this._bullPower = bullPower; this._bearPower = bearPower; this._bullCount = bullCount; this._bearCount = bearCount; this._bullComp = bc; this._bearComp = rc;
	}

	// choose each side's champion for single combat: highest tier, closest to the front
	private pickChampion(team: Team): Unit | null {
		let best: Unit | null = null, bs = -Infinity;
		for (const u of this.units) {
			if (u.team !== team || u.dying > 0 || u.hp <= 0 || u.ranged) continue;
			const s = rankIdx(u.tier) * 10 - Math.abs(u.x - this.frontX) * 0.05 - Math.abs(u.z) * 0.02;
			if (s > bs) { bs = s; best = u; }
		}
		return best;
	}

	private beginDuel() {
		const a = this.pickChampion('bull'), b = this.pickChampion('bear');
		if (!a || !b) return;
		this.duelA = a; this.duelB = b;
		this.onEvent?.({ type: 'duel', team: 'bull', tier: `${a.tier} vs ${b.tier}`, cls: a.cls, wallet: a.wallet, usd: 0, pct: 0 });
	}

	private isDueling(u: Unit): boolean { return u === this.duelA || u === this.duelB; }

	// the pumping side fights with the market's favor — its blades bite harder
	private teamMul(team: Team): number {
		const tilt = THREE.MathUtils.clamp((this.momentum - this.momentumAnchor) / 50, -0.5, 0.5);
		return team === 'bull' ? 1 + tilt * 0.5 : 1 - tilt * 0.5;
	}

	// a dressed spearman keeps his great shield up between clashes — volleys glance off the wall
	private guardMul(t: Unit): number {
		if (t.cls !== 'spear') return 1;
		const wp = this.battlePhase;
		return wp === 'form' || wp === 'advance' || wp === 'regroup' ? 0.6 : 1;
	}

	// already blade-to-blade — you cannot disengage mid-fight to dress ranks
	private inContact(u: Unit, t: Unit): boolean {
		const dx = t.x - u.x, dz = t.z - u.z;
		const r = (u.scale + t.scale) * 0.5 * UNIT_SCALE * 1.1 + 3.4;
		return dx * dx + dz * dz < r * r;
	}

	private winCampaign(team: Team) {
		this.phase = 'victory'; this.winner = team; this.wonUntil = performance.now() + 4000; this.shake = 1.7;
		if (team === 'bull') this.winsBull++; else this.winsBear++;
		const loser = team === 'bull' ? this.capitalBear : this.capitalBull;
		// the fallen base erupts and burns
		this.spawnBurst(loser.position.x, 4, 0, team === 'bull' ? CRIMSON : GOLD, 140);
		this.spawnSmoke(loser.position.x, 5, 0, 34);
		for (let k = 0; k < 6; k++) this.addDecal(loser.position.x + (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, 2.5);
		this.onCampaign?.({ winner: team, campaign: this.campaign });
	}

	private resetCampaign() {
		for (const u of this.units) if (u.char >= 0) this.chars.release(u.char);
		this.units = []; this.frontX = 0; this.winner = null; this.phase = 'battle'; this.campaign++;
		this.warClock = 0; this.battlePhase = 'form'; this.duelA = null; this.duelB = null; this.awaitClash = false;
		this.sudden = 0; this.suddenAnnounced = false;
		// the next price-range battle opens around the latest price
		this.momentumAnchor = this.momentum;
		this.rebaseLadder();
		this.spawnGarrison(this.lastGarrison.bulls, this.lastGarrison.bears);
	}

	private kill(u: Unit, killers: Unit[]) {
		if (u.dying > 0) return; // already down — never double-count a casualty
		u.dying = 3; // play the death animation, sink, then retire the character
		this.spawnBurst(u.x, hillY(u.x) + 1.2, u.z, u.team === 'bull' ? GOLD : CRIMSON, u.legend ? 40 : 9);
		this.spawnSoul(u.x, hillY(u.x) + 1.6, u.z, u.team === 'bull' ? GOLD : CRIMSON);
		this.addDecal(u.x, u.z, u.scale);
		if (u.team === 'bull') this.casualtiesBull++; else this.casualtiesBear++;
		this.totalKills++;
		this.killFx.push({ x: u.x, z: u.z, team: u.team, until: performance.now() + 1200 });
		if (this.killFx.length > 40) this.killFx.shift();
		if (killers.length) { const killer = killers[(Math.random() * killers.length) | 0]; killer.kills++; if (killer.wallet) { const c = this.commanders.get(killer.wallet); if (c) c.kills++; } }
		this.onEvent?.({ type: 'kill', team: u.team, tier: u.tier, cls: u.cls, wallet: u.wallet, usd: 0, pct: 0 });
	}

	private updateUnits() {
		let shadowN = 0;
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i];
			// claim a character the moment the models finish streaming in
			if (u.char < 0) { u.char = this.chars.claim(u.team, u.cls as Role); if (u.char < 0) { u.px = u.x; u.pz = u.z; continue; } }
			const gy = groundY(u.x, u.z);
			const moved = Math.hypot(u.x - u.px, u.z - u.pz);
			u.px = u.x; u.pz = u.z;
			// drive the character's animation state straight off the simulation
			let st: CharState;
			if (u.dying > 0) st = 'death';
			else if (this.phase === 'victory' && this.winner === u.team) st = 'cheer';
			else if (u.age < 1.0) st = 'spawn';
			else if (u.strike > 0) st = 'attack';
			else if (moved > 0.07) st = this.battlePhase === 'charge' ? 'run' : 'walk';
			else st = 'idle';
			// slain characters sink into the earth as the death clip finishes
			const sink = u.dying > 0 && u.dying < 0.7 ? (1 - u.dying / 0.7) * 1.3 : 0;
			const size = u.legend ? 1.32 : u.tier === 'CHAMPION' ? 1.14 : u.tier === 'ELITE' ? 1.06 : 1;
			this.chars.pose(u.char, u.x, gy - sink, u.z, u.face, size, st);
			// ground the fighter with a soft blob shadow, fading out as it sinks away
			if (shadowN < 240) {
				const d = this.dummy;
				d.position.set(u.x, gy + 0.06, u.z);
				d.rotation.set(0, 0, 0);
				d.scale.setScalar(size * 1.05 * (u.dying > 0 ? Math.max(0, u.dying / 3) : 1));
				d.updateMatrix();
				this.unitShadows.setMatrixAt(shadowN++, d.matrix);
			}
		}
		this.unitShadows.count = shadowN;
		this.unitShadows.instanceMatrix.needsUpdate = true;
		// retire fully-fallen units and free their character slots
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i]; if (u.dying > 0 || u.hp > 0) continue;
			if (u.char >= 0) this.chars.release(u.char);
			this.units.splice(i, 1);
		}
	}

	// pick a legend for the camera to feature, holding the pick for ~6s
	private featured(): Unit | null {
		const now = performance.now();
		if (this.featuredWallet) {
			const held = this.units.find((u) => u.wallet === this.featuredWallet && u.dying <= 0 && u.legend);
			if (held && now < this.featuredUntil) return held;
			this.featuredWallet = null;
		}
		// choose the best on-field legend: animated champions first, then closest to the front
		let best: Unit | null = null, bs = -Infinity;
		for (const u of this.units) {
			if (!u.legend || u.dying > 0) continue;
			const score = (u.char >= 0 ? 60 : 0) - Math.abs(u.x - this.frontX) * 0.5;
			if (score > bs) { bs = score; best = u; }
		}
		if (best) { this.featuredWallet = best.wallet || `#${best.idx}`; this.featuredUntil = now + 6000; }
		return best;
	}

	private render(dt: number) {
		if (this.keys.size) {
			const spd = 46 * dt * this.camZoom, sy = Math.sin(this.camYaw), cy = Math.cos(this.camYaw);
			if (this.keys.has('w')) { this.panX -= sy * spd; this.panZ -= cy * spd; }
			if (this.keys.has('s')) { this.panX += sy * spd; this.panZ += cy * spd; }
			if (this.keys.has('a')) { this.panX -= cy * spd; this.panZ += sy * spd; }
			if (this.keys.has('d')) { this.panX += cy * spd; this.panZ -= sy * spd; }
			this.panX = THREE.MathUtils.clamp(this.panX, -88, 88); this.panZ = THREE.MathUtils.clamp(this.panZ, -66, 66);
		}

		// war camera: unless the user is driving, drift to keep the front on screen and,
		// when a legend is fighting, lean toward it so hero moments get framed
		if (performance.now() > this.manualUntil && !this.focus && !this.keys.size) {
			const feat = this.featured();
			let tx = this.frontX * 0.72, tz = 0;
			if (feat) { tx = tx * 0.4 + feat.x * 0.6; tz = feat.z * 0.55; }
			this.panX += (tx - this.panX) * Math.min(1, dt * 0.35);
			this.panZ += (tz - this.panZ) * Math.min(1, dt * 0.3);
		}
		// look slightly above the ground so fighters, not turf, sit in frame
		const target = this._camTarget.set(this.panX, 2.2, this.panZ);
		// hero-moment punch: a champion's arrival pulls the camera in for a beat
		this.zoomPunch = Math.max(0, this.zoomPunch - dt * 0.9);
		const punch = 1 - Math.sin(Math.min(1, this.zoomPunch) * Math.PI) * 0.14;

		// TRUE SPHERICAL ORBIT. Elevation is its own axis, so zooming in moves the
		// camera CLOSER at the same cinematic angle instead of swinging overhead —
		// the old height/radius split made close-ups stare down at the tops of helmets,
		// which is what made these characters read as blobs.
		let elev = THREE.MathUtils.lerp(0.22, 1.15, this.camPitch); // ~13° low and filmic → ~66° tactical
		let dist = 78 * this.camZoom * punch;

		if (this.focus) {
			const tracked = this.units.find((u) => u.tracked && u.dying <= 0);
			if (tracked) { target.set(tracked.x, 2.6, tracked.z); dist = 22 * this.camZoom; elev = Math.min(elev, 0.5); }
		}

		const horiz = Math.cos(elev) * dist, height = Math.sin(elev) * dist;
		const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 2 : 0, shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
		this.shake = Math.max(0, this.shake - dt * 1.4);
		this.camera.position.lerp(this._camPos.set(target.x + Math.sin(this.camYaw) * horiz + shakeX, target.y + height + shakeY, target.z + Math.cos(this.camYaw) * horiz), Math.min(1, dt * 2.6));
		this.camera.lookAt(target);

		// the market-cap pill is a world-space sprite — fade it out as the camera closes
		// in, or it fills the frame right when you want to watch the fighting
		(this.mcapSprite.material as THREE.SpriteMaterial).opacity = THREE.MathUtils.clamp((this.camZoom - 0.42) / 0.28, 0, 0.92);

		// waving banners
		for (let i = 0; i < this.flags.length; i++) {
			const f = this.flags[i];
			f.rotation.y = Math.sin(this.time * 2.2 + i * 2) * 0.28;
			f.position.x = 1.8 + Math.sin(this.time * 2.2 + i * 2) * 0.15;
		}
		// standard cloth streams in the night wind
		for (let i = 0; i < this.standards.length; i++) {
			const c = this.standards[i].cloth;
			c.rotation.y = Math.sin(this.time * 2.6 + i * 2.4) * 0.3;
			c.rotation.z = Math.sin(this.time * 1.8 + i) * 0.06;
		}

		this.updateAuras(dt);
		if (!this.fxOk || location.search.includes('nofx')) {
			this.renderer.render(this.scene, this.camera);
			return;
		}
		try {
			this.composer.render(dt);
		} catch {
			this.disableFx();
			this.renderer.render(this.scene, this.camera);
			return;
		}
		// continuous watchdog (first check a few frames in, then every ~2s): an
		// all-white buffer at ANY point — even late-onset driver NaN creep — drops
		// post-processing for good instead of leaving the player a white screen
		if ((!this.fxChecked && this.frame > 12) || (this.fxChecked && this.frame % 120 === 0)) {
			this.fxChecked = true;
			if (this.frameIsBlownOut()) {
				console.warn('[battle] post-processing produced a blown-out frame — falling back to direct rendering');
				this.disableFx();
			}
		}
	}

	private frameIsBlownOut(): boolean {
		// The real failure is an ENTIRELY white buffer (broken float target / NaN pass).
		// Sample a dense grid and only trip if almost everything is white — a dark night
		// scene with a bright HUD pill and bloomed highlights must never be mistaken for it.
		const gl = this.renderer.getContext();
		const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
		if (!w || !h) return false;
		const px = new Uint8Array(4);
		let white = 0, n = 0;
		for (let gy = 1; gy <= 4; gy++) for (let gx = 1; gx <= 5; gx++) {
			n++;
			gl.readPixels(((w * gx) / 6) | 0, ((h * gy) / 5) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
			if (px[0] >= 250 && px[1] >= 250 && px[2] >= 250) white++;
		}
		return white >= n - 1; // essentially the whole frame is white
	}

	private disableFx() {
		if (!this.fxOk) return;
		this.fxOk = false;
		// direct rendering still gets filmic grading via the renderer itself
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.scene.traverse((o) => {
			const mats = (o as THREE.Mesh).material;
			for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) m.needsUpdate = true;
		});
	}

	private updateAuras(dt: number) {
		let ai = 0;
		for (const u of this.units) {
			if (ai >= this.auras.length) break;
			if ((u.tracked || u.legend) && u.dying <= 0) {
				const g = this.auras[ai++]; g.visible = true; g.position.set(u.x, groundY(u.x, u.z) + 0.02, u.z);
				const col = u.tracked ? 0xffffff : u.team === 'bull' ? 0x5effa0 : 0xff7a86; const s = u.scale * UNIT_SCALE;
				g.scale.setScalar(THREE.MathUtils.clamp(s, 0.8, 3.4));
				const r1 = g.getObjectByName('r1'), r2 = g.getObjectByName('r2'), crown = g.getObjectByName('crown');
				if (r1) { r1.rotation.z += dt * 0.6; (((r1 as THREE.Mesh).material) as THREE.MeshBasicMaterial).color.setHex(col); }
				if (r2) { r2.rotation.z -= dt * 0.4; (((r2 as THREE.Mesh).material) as THREE.MeshBasicMaterial).color.setHex(col); }
				if (crown) { crown.position.y = s * 2.9 + Math.sin(this.time * 2 + u.bob) * 0.12; crown.rotation.y += dt * 1.6; ((crown as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(col); }
			}
		}
		for (; ai < this.auras.length; ai++) this.auras[ai].visible = false;
	}

	private emitStats() {
		if (!this.onStats) return;
		const commanders = [...this.commanders.entries()].filter(([w]) => w).map(([wallet, c]) => ({ wallet, kills: c.kills, tier: c.tier, team: c.team })).sort((a, b) => b.kills - a.kills || rankIdx(b.tier) - rankIdx(a.tier)).slice(0, 5);
		this.onStats({
			bulls: this._bullCount, bears: this._bearCount, bullPower: this._bullPower, bearPower: this._bearPower,
			frontPct: THREE.MathUtils.clamp(((this.frontX + FRONT_MAX) / (FRONT_MAX * 2)) * 100, 0, 100),
			casualtiesBull: this.casualtiesBull, casualtiesBear: this.casualtiesBear, fps: Math.round(this.fpsAvg),
			round: this.campaign, winBull: this.winsBull, winBear: this.winsBear, phase: this.phase, winner: this.winner, warPhase: this.battlePhase,
			totalKills: this.totalKills, biggestWhaleUsd: this.biggestWhaleUsd, biggestWhaleWallet: this.biggestWhaleWallet,
			commanders, bullComp: this._bullComp, bearComp: this._bearComp
		});
	}

	private emitOverlay() {
		if (!this.onOverlay) return;
		const v = new THREE.Vector3();
		const project = (x: number, y: number, z: number) => { v.set(x, y, z).project(this.camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, on: v.z < 1 }; };
		const tracked: Overlay['tracked'] = [], titans: Overlay['titans'] = [];
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.tracked) { const p = project(u.x, hillY(u.x) + u.scale * 2.3, u.z); tracked.push({ x: p.x, y: p.y, on: p.on, tier: u.tier, team: u.team, hp: Math.max(0, u.hp), maxHp: u.maxHp, kills: u.kills, wallet: u.wallet }); }
			else if (u.legend) { const p = project(u.x, hillY(u.x) + u.scale * 3.3, u.z); titans.push({ x: p.x, y: p.y, on: p.on, label: u.tier, team: u.team, hp: Math.max(0, u.hp), maxHp: u.maxHp }); }
		}
		// floating casualty markers, rising as they fade
		const now = performance.now();
		this.killFx = this.killFx.filter((k) => k.until > now);
		const kills: Overlay['kills'] = [];
		for (const k of this.killFx) {
			const age = 1 - (k.until - now) / 1200;
			const p = project(k.x, groundY(k.x, k.z) + 2.2 + age * 2.4, k.z);
			kills.push({ x: p.x, y: p.y, on: p.on, team: k.team, age });
		}
		this.onOverlay({ tracked, titans, kills });
	}
}

function rankIdx(t: string): number { return ['GARRISON', 'SOLDIER', 'ELITE', 'CHAMPION', 'TITAN'].indexOf(t); }

function fmtUsdShort(n: number): string {
	if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
	if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
	return '$' + n.toFixed(0);
}
