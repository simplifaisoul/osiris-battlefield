import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
	EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, VignetteEffect,
	ToneMappingEffect, ToneMappingMode
} from 'postprocessing';
import { createNoise2D } from 'simplex-noise';
import { tierForPct, GARRISON, type Tier } from './tiers';

export type Team = 'bull' | 'bear';
export type Cls = 'spear' | 'ronin' | 'archer' | 'colossus';
export type SpawnInput = { wallet: string; kind: Team | 'buy' | 'sell'; usd: number; pct: number };

export type BattleEvent = {
	type: 'spawn' | 'kill' | 'legend';
	team: Team; tier: string; cls: Cls; wallet: string; usd: number; pct: number; god?: boolean;
};

export type Commander = { wallet: string; kills: number; tier: string; team: Team };
export type Comp = { spear: number; ronin: number; archer: number; colossus: number };

export type Stats = {
	bulls: number; bears: number; bullPower: number; bearPower: number;
	frontPct: number; casualtiesBull: number; casualtiesBear: number; fps: number;
	round: number; winBull: number; winBear: number;
	phase: 'battle' | 'victory'; winner: Team | null;
	totalKills: number; biggestWhaleUsd: number; biggestWhaleWallet: string;
	commanders: Commander[]; bullComp: Comp; bearComp: Comp;
};

export type Overlay = {
	tracked: { x: number; y: number; on: boolean; tier: string; team: Team; hp: number; maxHp: number; kills: number; wallet: string }[];
	titans: { x: number; y: number; on: boolean; label: string; team: Team }[];
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
	tint: number; struck: number;
	// battlefield-spread behaviour
	lane: number; frontJitter: number; flank: boolean;
};

// per-class attack pacing (seconds between strikes)
const ATK_CD: Record<Cls, number> = { spear: 1.05, ronin: 0.62, archer: 1.15, colossus: 2.6 };
const KILL_TEMPO = 2.6; // global lethality multiplier (per-hit = dmg * cd * tempo)
const ACQUIRE_R = 18; // how far a melee unit will lock onto an enemy

const MAX = 340;
const FRONT_MAX = 33;
const CAP = FRONT_MAX + 17;
const ARENA_Z = 36;
// the battlefield is a bounded board floating in a dark void
const BOARD_W = 128;
const BOARD_D = 98;
const ROAD_Z = 9; // horizontal road across the map
const MELEE = 4.2;
const SPEED = 11;
const UNIT_SCALE = 2.1;
const CLASSES: Cls[] = ['spear', 'ronin', 'archer', 'colossus'];

const CLASS_STATS: Record<Cls, { hpMul: number; dmgMul: number; scaleMul: number; ranged: boolean; standoff: number; speedMul: number }> = {
	spear: { hpMul: 1.0, dmgMul: 1.0, scaleMul: 1.0, ranged: false, standoff: 0.8, speedMul: 1.0 },
	ronin: { hpMul: 0.78, dmgMul: 1.9, scaleMul: 0.95, ranged: false, standoff: 0.6, speedMul: 1.4 },
	archer: { hpMul: 0.55, dmgMul: 1.7, scaleMul: 0.9, ranged: true, standoff: 13, speedMul: 1.05 },
	colossus: { hpMul: 2.4, dmgMul: 2.4, scaleMul: 0.55, ranged: true, standoff: 12, speedMul: 0.6 }
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
	if (tier === 'TITAN' || tier === 'GOD') return 'colossus';
	// ranged-heavy mix: most of the war is volleys traded across the line
	if (seed < 0.3) return 'spear';
	if (seed < 0.76) return 'archer';
	return 'ronin';
}
function easeOutBack(t: number): number { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

// ---------- toon look ----------

function toonMaterial(): THREE.MeshToonMaterial {
	const steps = new Uint8Array([70, 135, 200, 255]);
	const grad = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
	grad.minFilter = THREE.NearestFilter; grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
	return new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: grad });
}

type Palette = { cloth: string; clothDark: string; skin: string; metal: string; wood: string; leather: string; accent: string };
const PAL: Record<Team, Palette> = {
	bull: { cloth: '#29d465', clothDark: '#189a4b', skin: '#f2c89a', metal: '#d7dde6', wood: '#8a5a2b', leather: '#6b4a2f', accent: '#ffd34d' },
	bear: { cloth: '#ff5560', clothDark: '#c22f3c', skin: '#e8b088', metal: '#d7dde6', wood: '#7a4c22', leather: '#5c3c26', accent: '#ffd34d' }
};

function paint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
	const c = new THREE.Color(hex);
	const n = g.attributes.position.count;
	const arr = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
	g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
	return g;
}

// ---------- chunky character builders (Clash-style proportions) ----------

function chunkyBase(p: Palette): THREE.BufferGeometry[] {
	const parts: THREE.BufferGeometry[] = [];
	// stubby boots
	const b1 = paint(new THREE.BoxGeometry(0.26, 0.22, 0.34), p.leather); b1.translate(-0.18, 0.11, 0.02);
	const b2 = paint(new THREE.BoxGeometry(0.26, 0.22, 0.34), p.leather); b2.translate(0.18, 0.11, 0.02);
	// barrel body
	const body = paint(new THREE.CylinderGeometry(0.34, 0.42, 0.72, 10), p.cloth); body.translate(0, 0.62, 0);
	// belt
	const belt = paint(new THREE.CylinderGeometry(0.43, 0.43, 0.12, 10), p.leather); belt.translate(0, 0.32, 0);
	// stubby legs connecting boots to body
	const g1 = paint(new THREE.CylinderGeometry(0.13, 0.12, 0.32, 6), p.clothDark); g1.translate(-0.14, 0.35, 0.02);
	const g2 = paint(new THREE.CylinderGeometry(0.13, 0.12, 0.32, 6), p.clothDark); g2.translate(0.14, 0.35, 0.02);
	// big head
	const head = paint(new THREE.SphereGeometry(0.4, 12, 10), p.skin); head.translate(0, 1.32, 0.02);
	// simple face — brow + two eyes
	const brow = paint(new THREE.BoxGeometry(0.34, 0.07, 0.06), p.clothDark); brow.translate(0, 1.46, 0.36);
	const e1 = paint(new THREE.SphereGeometry(0.062, 6, 5), '#20160f'); e1.translate(-0.15, 1.37, 0.35);
	const e2 = paint(new THREE.SphereGeometry(0.062, 6, 5), '#20160f'); e2.translate(0.15, 1.37, 0.35);
	parts.push(b1, b2, g1, g2, body, belt, head, brow, e1, e2);
	return parts;
}
function armPair(p: Palette, weaponSide = 1): THREE.BufferGeometry[] {
	// chunky arms with big fists
	const aR = paint(new THREE.CylinderGeometry(0.11, 0.13, 0.5, 8), p.skin); aR.rotateZ(-0.9 * weaponSide); aR.translate(0.45 * weaponSide, 0.85, 0.06);
	const fR = paint(new THREE.SphereGeometry(0.15, 8, 6), p.skin); fR.translate(0.62 * weaponSide, 0.72, 0.1);
	const aL = paint(new THREE.CylinderGeometry(0.11, 0.13, 0.5, 8), p.skin); aL.rotateZ(0.9 * weaponSide); aL.translate(-0.45 * weaponSide, 0.85, 0.06);
	const fL = paint(new THREE.SphereGeometry(0.15, 8, 6), p.skin); fL.translate(-0.62 * weaponSide, 0.72, 0.1);
	return [aR, fR, aL, fL];
}

function buildSpearman(p: Palette): THREE.BufferGeometry {
	const parts = [...chunkyBase(p), ...armPair(p)];
	// horned metal helm
	const helm = paint(new THREE.SphereGeometry(0.42, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), p.metal); helm.translate(0, 1.42, 0.02);
	const h1 = paint(new THREE.ConeGeometry(0.09, 0.34, 6), p.accent); h1.rotateZ(1.0); h1.translate(-0.42, 1.62, 0.02);
	const h2 = paint(new THREE.ConeGeometry(0.09, 0.34, 6), p.accent); h2.rotateZ(-1.0); h2.translate(0.42, 1.62, 0.02);
	// BIG spear in right fist
	const shaft = paint(new THREE.CylinderGeometry(0.045, 0.045, 2.5, 6), p.wood); shaft.translate(0.62, 1.15, 0.1);
	const tip = paint(new THREE.ConeGeometry(0.13, 0.42, 6), p.metal); tip.translate(0.62, 2.55, 0.1);
	// BIG round shield on left
	const shield = paint(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 14), p.clothDark); shield.rotateZ(Math.PI / 2); shield.translate(-0.68, 0.9, 0.08);
	const boss = paint(new THREE.SphereGeometry(0.14, 8, 6), p.accent); boss.translate(-0.74, 0.9, 0.08);
	parts.push(helm, h1, h2, shaft, tip, shield, boss);
	const m = mergeGeometries(parts, false)!; m.computeVertexNormals(); return m;
}

function buildRonin(p: Palette): THREE.BufferGeometry {
	const parts = [...chunkyBase(p), ...armPair(p)];
	// topknot + headband
	const knot = paint(new THREE.SphereGeometry(0.13, 8, 6), '#2b2018'); knot.translate(0, 1.72, -0.04);
	const band = paint(new THREE.CylinderGeometry(0.41, 0.41, 0.1, 12), p.clothDark); band.translate(0, 1.45, 0.02);
	// sash
	const sash = paint(new THREE.BoxGeometry(0.72, 0.16, 0.46), p.clothDark); sash.rotateZ(0.5); sash.translate(0, 0.68, 0);
	// BIG katana raised in right fist
	const blade = paint(new THREE.BoxGeometry(0.06, 1.7, 0.16), p.metal); blade.rotateZ(-0.42); blade.translate(0.98, 1.6, 0.1);
	const guard = paint(new THREE.CylinderGeometry(0.13, 0.13, 0.05, 10), p.accent); guard.rotateX(Math.PI / 2); guard.rotateZ(-0.42); guard.translate(0.66, 0.88, 0.1);
	const hilt = paint(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 6), p.leather); hilt.rotateZ(-0.42); hilt.translate(0.56, 0.72, 0.1);
	parts.push(knot, band, sash, blade, guard, hilt);
	const m = mergeGeometries(parts, false)!; m.computeVertexNormals(); return m;
}

function buildArcher(p: Palette): THREE.BufferGeometry {
	const parts = [...chunkyBase(p), ...armPair(p)];
	// hood
	const hood = paint(new THREE.ConeGeometry(0.44, 0.62, 10), p.clothDark); hood.translate(0, 1.6, 0);
	const brim = paint(new THREE.CylinderGeometry(0.46, 0.46, 0.1, 10), p.clothDark); brim.translate(0, 1.3, 0);
	// BIG bow in right fist (arc)
	const bow = paint(new THREE.TorusGeometry(0.78, 0.05, 8, 20, Math.PI * 1.2), p.wood); bow.rotateY(Math.PI / 2); bow.rotateX(-0.15); bow.translate(0.66, 1.0, 0.1);
	// quiver on back with fletched arrows
	const quiver = paint(new THREE.CylinderGeometry(0.12, 0.12, 0.55, 8), p.leather); quiver.rotateX(0.45); quiver.translate(-0.16, 1.1, -0.34);
	const fl = paint(new THREE.BoxGeometry(0.2, 0.16, 0.06), p.cloth); fl.rotateX(0.45); fl.translate(-0.16, 1.42, -0.5);
	parts.push(hood, brim, bow, quiver, fl);
	const m = mergeGeometries(parts, false)!; m.computeVertexNormals(); return m;
}

function buildColossus(p: Palette): THREE.BufferGeometry {
	// WHALE ARMOR: a chunky toon tank — hull, treads, turret, barrel
	const parts: THREE.BufferGeometry[] = [];
	// treads
	const t1 = paint(new THREE.BoxGeometry(2.5, 0.55, 0.55), '#2c2c28'); t1.translate(0, 0.32, -0.85);
	const t2 = paint(new THREE.BoxGeometry(2.5, 0.55, 0.55), '#2c2c28'); t2.translate(0, 0.32, 0.85);
	// wheels hint
	for (let i = -2; i <= 2; i++) {
		const w1 = paint(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 8), '#4a4a42'); w1.rotateX(Math.PI / 2); w1.translate(i * 0.5, 0.3, -0.85);
		const w2 = paint(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 8), '#4a4a42'); w2.rotateX(Math.PI / 2); w2.translate(i * 0.5, 0.3, 0.85);
		parts.push(w1, w2);
	}
	// hull
	const hull = paint(new THREE.BoxGeometry(2.3, 0.62, 1.5), p.cloth); hull.translate(0, 0.78, 0);
	const glacis = paint(new THREE.BoxGeometry(0.7, 0.4, 1.3), p.clothDark); glacis.rotateZ(0.5); glacis.translate(1.15, 0.85, 0);
	const trim = paint(new THREE.BoxGeometry(2.35, 0.1, 1.55), p.accent); trim.translate(0, 1.06, 0);
	// turret + barrel (points +x)
	const turret = paint(new THREE.CylinderGeometry(0.62, 0.72, 0.55, 10), p.cloth); turret.translate(-0.15, 1.4, 0);
	const hatch = paint(new THREE.CylinderGeometry(0.24, 0.24, 0.14, 8), p.accent); hatch.translate(-0.3, 1.72, 0);
	const barrel = paint(new THREE.CylinderGeometry(0.11, 0.13, 1.9, 8), p.metal); barrel.rotateZ(Math.PI / 2); barrel.translate(1.15, 1.42, 0);
	const muzzle = paint(new THREE.CylinderGeometry(0.17, 0.17, 0.25, 8), '#2c2c28'); muzzle.rotateZ(Math.PI / 2); muzzle.translate(2.05, 1.42, 0);
	parts.push(t1, t2, hull, glacis, trim, turret, hatch, barrel, muzzle);
	const m = mergeGeometries(parts, false)!; m.computeVertexNormals(); return m;
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
	x.fillStyle = '#b8b2a2'; x.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 18000; i++) { const v = 150 + Math.random() * 80; x.fillStyle = `rgba(${v},${v - 6},${v - 20},${Math.random() * 0.4})`; x.fillRect(Math.random() * 512, Math.random() * 512, 2, 2); }
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 3); t.anisotropy = 4; return t;
}
function skyTexture(): THREE.Texture {
	const c = document.createElement('canvas'); c.width = 512; c.height = 512;
	const x = c.getContext('2d')!;
	const g = x.createLinearGradient(0, 0, 0, 512);
	g.addColorStop(0, '#04060a'); g.addColorStop(0.55, '#080d10'); g.addColorStop(0.85, '#0c1512'); g.addColorStop(1, '#0f1a14');
	x.fillStyle = g; x.fillRect(0, 0, 512, 512);
	// faint starfield in the upper sky
	for (let i = 0; i < 240; i++) {
		const sx = Math.random() * 512, sy = Math.pow(Math.random(), 1.6) * 330;
		x.fillStyle = `rgba(200,220,255,${0.08 + Math.random() * 0.4})`;
		x.beginPath(); x.arc(sx, sy, 0.3 + Math.random() * 1.0, 0, Math.PI * 2); x.fill();
	}
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function radialTexture(hex: string): THREE.Texture {
	const c = document.createElement('canvas'); c.width = c.height = 128;
	const x = c.getContext('2d')!;
	const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, hex); g.addColorStop(1, 'rgba(0,0,0,0)');
	x.fillStyle = g; x.fillRect(0, 0, 128, 128);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Battle {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private composer!: EffectComposer;

	private armies: Record<string, { mesh: THREE.InstancedMesh; free: number[]; top: number }> = {};
	private units: Unit[] = [];
	private frontX = 0;
	private terrainH: (x: number, z: number) => number = () => 0;

	private arrowMesh!: THREE.InstancedMesh;
	private PROJ = 320;
	private proj!: { active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; dmg: number; team: Team; life: number }[];
	private projHead = 0;
	private shellMesh!: THREE.InstancedMesh;
	private SHELL_N = 90;
	private shells!: { active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; dmg: number; team: Team; life: number }[];
	private shellHead = 0;

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
	onCampaign: ((r: { winner: Team; campaign: number }) => void) | null = null;
	private reinB = 0; private reinS = 0; private accB = 0; private accS = 0;
	private killFx: { x: number; z: number; team: Team; until: number }[] = [];
	private decals!: THREE.InstancedMesh; private DECAL_N = 200; private decalHead = 0;
	private decalLife!: Float32Array; private decalBase!: Float32Array; private decalX!: Float32Array; private decalZ!: Float32Array;

	private commanders = new Map<string, { kills: number; tier: string; team: Team; usd: number }>();
	private totalKills = 0; private biggestWhaleUsd = 0; private biggestWhaleWallet = '';
	private lastGarrison = { bulls: 60, bears: 60 };

	private camYaw = 0.06; private camPitch = 0.68; private camZoom = 1.02;
	private panX = 0; private panZ = 0; private keys = new Set<string>();
	private manualUntil = 0; private dragging = false; private lastPtr = { x: 0, y: 0 };

	private sparks!: THREE.Points; private sparkPos!: Float32Array; private sparkVel!: Float32Array; private sparkLife!: Float32Array; private sparkColor!: Float32Array; private sparkHead = 0; private SPARK_N = 1500;
	private souls!: THREE.Points; private soulPos!: Float32Array; private soulVel!: Float32Array; private soulLife!: Float32Array; private soulColor!: Float32Array; private soulHead = 0; private SOUL_N = 400;

	private auras: THREE.Group[] = [];
	private capitalBull!: THREE.Group; private capitalBear!: THREE.Group; private frontLine!: THREE.Mesh;
	private flags: THREE.Mesh[] = [];
	private dummy = new THREE.Object3D(); private tmpColor = new THREE.Color();
	private _camTarget = new THREE.Vector3(); private _camPos = new THREE.Vector3();
	private q = new THREE.Quaternion(); private upV = new THREE.Vector3(0, 1, 0); private vTmp = new THREE.Vector3();

	casualtiesBull = 0; casualtiesBear = 0;

	onStats: ((s: Stats) => void) | null = null;
	onOverlay: ((o: Overlay) => void) | null = null;
	onEvent: ((e: BattleEvent) => void) | null = null;

	constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
		this.renderer.setSize(innerWidth, innerHeight);
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.toneMapping = THREE.NoToneMapping;

		this.scene.background = skyTexture();
		this.scene.fog = new THREE.FogExp2(0x06090b, 0.0028);

		this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 700);
		this.camera.position.set(0, 40, 60);
		this.camera.lookAt(0, 3, 0);

		this.buildComposer();
		this.buildLights();
		this.buildGround();
		this.buildProps();
		this.capitalBull = this.buildCapital('bull', -CAP);
		this.capitalBear = this.buildCapital('bear', CAP);
		this.frontLine = this.buildFrontLine();
		this.buildGroundText();
		this.buildMcapSign();
		this.buildArmies();
		this.buildArrows();
		this.buildSparks();
		this.buildSouls();
		this.buildDecals();
		this.buildAuras();

		this.on(window, 'resize', () => this.resize());
		this.bindCamera(canvas);
	}

	private on(t: EventTarget, k: string, fn: EventListener, opt?: AddEventListenerOptions) {
		t.addEventListener(k, fn, opt);
		this.unbind.push(() => t.removeEventListener(k, fn));
	}

	// ---------- pipeline ----------

	private buildComposer() {
		this.composer = new EffectComposer(this.renderer, { multisampling: 0, frameBufferType: THREE.HalfFloatType });
		this.composer.addPass(new RenderPass(this.scene, this.camera));

		// one lean pass: subtle bloom on true highlights, filmic tone map, gentle vignette
		const bloom = new BloomEffect({ intensity: 0.42, luminanceThreshold: 0.82, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.6 });
		const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
		const vignette = new VignetteEffect({ offset: 0.24, darkness: 0.58 });
		this.composer.addPass(new EffectPass(this.camera, bloom, tone, vignette));
		this.composer.addPass(new EffectPass(this.camera, new SMAAEffect()));
	}

	private buildLights() {
		this.scene.add(new THREE.HemisphereLight(0x8fb0d0, 0x1f2a18, 0.65));
		const sun = new THREE.DirectionalLight(0xffe2b0, 2.3);
		sun.position.set(-34, 62, 26); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
		const s = 64; sun.shadow.camera.left = -s; sun.shadow.camera.right = s; sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s; sun.shadow.camera.far = 170; sun.shadow.bias = -0.0004;
		this.scene.add(sun);
		// cool rim from the far side so silhouettes pop against the dark board
		const rim = new THREE.DirectionalLight(0x9fc8ff, 0.85);
		rim.position.set(38, 34, -46);
		this.scene.add(rim);
	}

	private buildGround() {
		const mat = new THREE.MeshToonMaterial({ map: groundTexture(), vertexColors: true, gradientMap: (toonMaterial() as THREE.MeshToonMaterial).gradientMap });
		const geo = new THREE.PlaneGeometry(BOARD_W, BOARD_D, 210, 160);
		const noise2D = createNoise2D(() => 0.42);
		const pos = geo.attributes.position as THREE.BufferAttribute;
		const colors = new Float32Array(pos.count * 3);
		// moody war-map palette: bull grass vs bear dust, asphalt road, price gridlines
		const bullSoil = new THREE.Color('#3e6a21'), bearSoil = new THREE.Color('#5e452a');
		const asphalt = new THREE.Color('#3c3c38'), dash = new THREE.Color('#d8d8d0'), grid = new THREE.Color('#e9e2c2');
		const c = new THREE.Color();
		for (let i = 0; i < pos.count; i++) {
			const px = pos.getX(i), py = pos.getY(i);
			const zTaper = THREE.MathUtils.clamp(1 - (Math.abs(py) - ARENA_Z) / 14, 0, 1);
			const h = hillY(px) * zTaper + noise2D(px * 0.05, py * 0.05) * 0.35;
			pos.setZ(i, h);
			// held territory split with a soft, noisy seam
			const wob = noise2D(0.5, py * 0.06) * 3;
			const t = THREE.MathUtils.clamp((px + wob + 5) / 10, 0, 1);
			c.copy(bullSoil).lerp(bearSoil, t);
			// hand-painted patches + mow stripes
			const patch = noise2D(px * 0.1, py * 0.1) * 0.5 + 0.5;
			c.multiplyScalar(0.85 + patch * 0.3);
			if (Math.floor(px / 6) % 2 === 0) c.multiplyScalar(1.022);
			// PRICE GRIDLINES: vertical ticks every 10 units — the terrain IS the mcap axis
			const nearGrid = Math.abs(px - Math.round(px / 10) * 10);
			if (nearGrid < 0.22 && Math.abs(Math.round(px / 10) * 10) <= 40) c.lerp(grid, 0.18);
			// horizontal ROAD across the whole map
			const roadDist = Math.abs(py - ROAD_Z);
			if (roadDist < 2.1) {
				c.lerp(asphalt, THREE.MathUtils.clamp(1 - (roadDist - 1.4) / 0.7, 0, 1));
				// centre dashes
				if (roadDist < 0.22 && ((px % 7) + 7) % 7 < 3) c.copy(dash);
			}
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
		const skirt = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, 3.4, BOARD_D), new THREE.MeshBasicMaterial({ color: 0x0a0d0a }));
		skirt.position.y = -1.75; this.scene.add(skirt);
		// soft pedestal glow beneath the floating diorama
		const glow = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W * 2.1, BOARD_D * 2.3), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(70,120,95,0.5)'), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
		glow.rotation.x = -Math.PI / 2; glow.position.y = -3.6; this.scene.add(glow);
	}

	private buildProps() {
		const parts: THREE.BufferGeometry[] = [];
		const rng = (a: number, b: number) => a + Math.random() * (b - a);
		const onRoad = (z: number) => Math.abs(z - ROAD_Z) < 3.4;
		const treeAt = (x: number, z: number, s: number, green: string) => {
			const y = this.terrainH(x, z);
			const trunk = paint(new THREE.CylinderGeometry(0.14 * s, 0.2 * s, 0.8 * s, 6), '#5f3d1f'); trunk.translate(x, y + 0.4 * s, z);
			const c1 = paint(new THREE.ConeGeometry(0.95 * s, 1.4 * s, 8), green); c1.translate(x, y + 1.45 * s, z);
			const c2 = paint(new THREE.ConeGeometry(0.72 * s, 1.1 * s, 8), green); c2.translate(x, y + 2.15 * s, z);
			parts.push(trunk, c1, c2);
		};
		// dense forests across BOTH territories — clear of the road and the fighting lane
		for (let i = 0; i < 150; i++) {
			const x = rng(-BOARD_W / 2 + 6, BOARD_W / 2 - 6);
			const z = rng(-BOARD_D / 2 + 6, BOARD_D / 2 - 6);
			if (onRoad(z)) continue;
			if (Math.abs(x) < CAP - 6 && Math.abs(z) < ARENA_Z - 4 && Math.random() < 0.82) continue;
			const bull = x < 0;
			const green = bull ? (Math.random() < 0.5 ? '#2f6e2c' : '#3f8a34') : (Math.random() < 0.5 ? '#5c6e2a' : '#726b2c');
			treeAt(x, z, rng(0.7, 1.5), green);
		}
		const merged = mergeGeometries(parts, false)!; merged.computeVertexNormals();
		const mesh = new THREE.Mesh(merged, toonMaterial()); mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh);

		// lakes — flat translucent pools, one deep in each territory
		const lakeMat = new THREE.MeshBasicMaterial({ color: 0x2f7fb8, transparent: true, opacity: 0.72 });
		for (const [lx, lz, r] of [[-34, -26, 8], [40, 28, 9]] as const) {
			const lake = new THREE.Mesh(new THREE.CircleGeometry(r, 24), lakeMat);
			lake.rotation.x = -Math.PI / 2; lake.scale.y = 0.6; lake.position.set(lx, this.terrainH(lx, lz) + 0.12, lz);
			this.scene.add(lake);
		}

		// villages — clusters of toon houses in the back corners
		const vparts: THREE.BufferGeometry[] = [];
		const houseAt = (x: number, z: number, wall: string) => {
			const y = this.terrainH(x, z);
			const base = paint(new THREE.BoxGeometry(1.6, 1.1, 1.4), wall); base.translate(x, y + 0.55, z);
			const roof = paint(new THREE.ConeGeometry(1.35, 0.9, 4), '#7a3b28'); roof.rotateY(Math.PI / 4); roof.translate(x, y + 1.55, z);
			vparts.push(base, roof);
		};
		for (const [vx, vz] of [[-48, 34], [48, -34], [-54, -28], [52, 30]] as const)
			for (let k = 0; k < 4; k++) houseAt(vx + rng(-4, 4), vz + rng(-4, 4), Math.random() < 0.5 ? '#d8c9a8' : '#c2a888');
		const vm = mergeGeometries(vparts, false)!; vm.computeVertexNormals();
		const vmesh = new THREE.Mesh(vm, toonMaterial()); vmesh.castShadow = true; this.scene.add(vmesh);
	}

	private buildCapital(team: Team, x: number): THREE.Group {
		const p = PAL[team];
		const grp = new THREE.Group();
		const parts: THREE.BufferGeometry[] = [];
		// stepped temple
		const steps = [ [14, 3.4], [10.5, 3.0], [7.4, 2.7], [4.6, 2.4] ] as const;
		let y = 0;
		steps.forEach(([w, h], i) => {
			const b = paint(new THREE.BoxGeometry(w, h, w), i % 2 ? p.clothDark : p.cloth); b.translate(0, y + h / 2, 0); y += h;
			parts.push(b);
			const trim = paint(new THREE.BoxGeometry(w + 0.4, 0.3, w + 0.4), p.accent); trim.translate(0, y, 0); parts.push(trim);
		});
		const geo = mergeGeometries(parts, false)!; geo.computeVertexNormals();
		const body = new THREE.Mesh(geo, toonMaterial()); body.castShadow = true; grp.add(body);
		// glowing capstone
		const cap = new THREE.Mesh(new THREE.ConeGeometry(2, 2.6, 4), new THREE.MeshBasicMaterial({ color: team === 'bull' ? 0x7dffb0 : 0xff8a95 }));
		cap.position.y = y + 1.3; cap.rotation.y = Math.PI / 4; grp.add(cap);
		// banner
		const pole = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.1, 0.1, 5.4, 6), '#7a4c26'), toonMaterial());
		pole.position.set(0, y + 2.6, 0); grp.add(pole);
		const flag = new THREE.Mesh(paint(new THREE.PlaneGeometry(3.4, 1.9), p.cloth), new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide, gradientMap: toonMaterial().gradientMap }));
		flag.position.set(1.8, y + 4.4, 0); grp.add(flag);
		this.flags.push(flag);
		grp.position.set(x, 0, 0);
		this.scene.add(grp);
		return grp;
	}

	private buildFrontLine(): THREE.Mesh {
		// crisp glowing seam instead of a wide haze column
		const m = new THREE.Mesh(new THREE.PlaneGeometry(2.2, ARENA_Z * 2 + 12), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,244,200,0.9)'), color: 0xfff2c0, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
		m.rotation.x = -Math.PI / 2; m.position.y = 0.06; this.scene.add(m); return m;
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
	private mcapSprite!: THREE.Sprite;
	private mcapCanvas!: HTMLCanvasElement;
	private mcapTex!: THREE.CanvasTexture;
	private buildMcapSign() {
		const c = document.createElement('canvas'); c.width = 512; c.height = 200; this.mcapCanvas = c;
		this.mcapTex = new THREE.CanvasTexture(c); this.mcapTex.colorSpace = THREE.SRGBColorSpace;
		this.mcapSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.mcapTex, transparent: true, depthTest: false }));
		this.mcapSprite.scale.set(18, 7, 1);
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

	private buildArmies() {
		const builders: Record<Cls, (p: Palette) => THREE.BufferGeometry> = { spear: buildSpearman, ronin: buildRonin, archer: buildArcher, colossus: buildColossus };
		for (const team of ['bull', 'bear'] as Team[]) {
			for (const cls of CLASSES) {
				const mesh = new THREE.InstancedMesh(builders[cls](PAL[team]), toonMaterial(), MAX);
				mesh.castShadow = true; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = MAX;
				this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
				for (let i = 0; i < MAX; i++) { mesh.setMatrixAt(i, this.dummy.matrix); const v = 0.92 + Math.random() * 0.16; mesh.setColorAt(i, this.tmpColor.setScalar(v)); }
				mesh.instanceMatrix.needsUpdate = true;
				this.scene.add(mesh);
				const free: number[] = []; for (let i = 0; i < MAX; i++) free.push(MAX - 1 - i);
				this.armies[`${team}:${cls}`] = { mesh, free, top: -1 };
			}
		}
	}

	private buildArrows() {
		this.arrowMesh = new THREE.InstancedMesh(buildArrowGeo(), new THREE.MeshBasicMaterial({ vertexColors: true }), this.PROJ);
		this.arrowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.arrowMesh.count = this.PROJ; this.arrowMesh.frustumCulled = false;
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (let i = 0; i < this.PROJ; i++) { this.arrowMesh.setMatrixAt(i, this.dummy.matrix); this.arrowMesh.setColorAt(i, this.tmpColor.set(0xffffff)); }
		this.scene.add(this.arrowMesh);
		this.proj = Array.from({ length: this.PROJ }, () => ({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dmg: 0, team: 'bull' as Team, life: 0 }));

		// tank shells — fat dark rounds with a bright tip
		const shellGeo = paint(new THREE.CapsuleGeometry(0.16, 0.34, 3, 8), '#26221c');
		this.shellMesh = new THREE.InstancedMesh(shellGeo, new THREE.MeshBasicMaterial({ vertexColors: true }), this.SHELL_N);
		this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.shellMesh.count = this.SHELL_N; this.shellMesh.frustumCulled = false;
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (let i = 0; i < this.SHELL_N; i++) { this.shellMesh.setMatrixAt(i, this.dummy.matrix); this.shellMesh.setColorAt(i, this.tmpColor.set(0xffffff)); }
		this.scene.add(this.shellMesh);
		this.shells = Array.from({ length: this.SHELL_N }, () => ({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dmg: 0, team: 'bull' as Team, life: 0 }));
	}

	private buildSparks() {
		const N = this.SPARK_N; this.sparkPos = new Float32Array(N * 3); this.sparkColor = new Float32Array(N * 3); this.sparkVel = new Float32Array(N * 3); this.sparkLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.sparkPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.sparkColor, 3));
		this.sparks = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.95)'), size: 0.55, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.35 }));
		this.sparks.frustumCulled = false; this.scene.add(this.sparks);
	}
	private buildSouls() {
		const N = this.SOUL_N; this.soulPos = new Float32Array(N * 3); this.soulColor = new Float32Array(N * 3); this.soulVel = new Float32Array(N * 3); this.soulLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.soulPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.soulPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.soulColor, 3));
		this.souls = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.9)'), size: 1.5, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.25 }));
		this.souls.frustumCulled = false; this.scene.add(this.souls);
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
	setMomentum(m: number) { this.momentum = m; }
	// continuous garrison reinforcements/sec per side — scales with the selected timeframe's txn rate
	setReinforceRates(b: number, s: number) { this.reinB = b; this.reinS = s; }
	setTrackWallet(w: string | null) { this.trackWallet = w ? w.trim() : null; for (const u of this.units) u.tracked = !!this.trackWallet && u.wallet === this.trackWallet; }
	setFocus(f: boolean) { this.focus = f; }
	resetCamera() { this.manualUntil = 0; this.camYaw = 0.06; this.camPitch = 0.68; this.camZoom = 1.02; this.panX = 0; this.panZ = 0; }

	spawnGarrison(bulls: number, bears: number) {
		this.lastGarrison = { bulls, bears };
		for (let i = 0; i < bulls; i++) this.addUnit('bull', pickClass('SOLDIER', Math.random()), GARRISON, '', false, true);
		for (let i = 0; i < bears; i++) this.addUnit('bear', pickClass('SOLDIER', Math.random()), GARRISON, '', false, true);
	}

	spawn(input: SpawnInput) {
		const team: Team = input.kind === 'buy' || input.kind === 'bull' ? 'bull' : 'bear';
		const tier = tierForPct(input.pct);
		const god = tier.name === 'GOD';
		const legend = god || tier.name === 'TITAN';
		const cls = pickClass(tier.name, hash01(input.wallet + input.usd));
		const u = this.addUnit(team, cls, tier, input.wallet, legend, false);
		// every real trade lands with a visible team-coloured muster flash
		if (u) this.spawnBurst(u.x, groundY(u.x, u.z) + 1.2, u.z, team === 'bull' ? GOLD : CRIMSON, legend ? 26 : 6);
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
		if (legend) { this.shake = Math.min(1.6, this.shake + (god ? 1.4 : 0.7)); if (god) this.slowmo = 1.1; }
		this.onEvent?.({ type: legend ? 'legend' : 'spawn', team, tier: tier.name, cls, wallet: input.wallet, usd: input.usd, pct: input.pct, god });
	}

	private addUnit(team: Team, cls: Cls, tier: Tier, wallet: string, legend: boolean, atFront: boolean): Unit | null {
		const army = this.armies[`${team}:${cls}`]; if (!army || !army.free.length) return null;
		const idx = army.free.pop()!;
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
			bob: Math.random() * Math.PI * 2, age: 0, cd: Math.random() * 1.5, kills: 0, idx, dying: 0,
			tracked: !!this.trackWallet && wallet === this.trackWallet, legend, melee: false,
			target: null, retarget: Math.random() * 0.4, atkCd: Math.random() * 0.8, strike: 0,
			face: sign < 0 ? 0 : Math.PI, // rotY that points local +x (weapon/barrel) at the enemy side
			tint: 0.92 + Math.random() * 0.16, struck: 0,
			lane: (Math.random() - 0.5) * ARENA_Z * 2,
			frontJitter: -3 + Math.random() * 14, // most units press PAST the line — the war spreads deep
			flank: !st.ranged && (cls === 'ronin' ? Math.random() < 0.38 : Math.random() < 0.12)
		});
		return this.units[this.units.length - 1];
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
		this.composer.dispose(); this.renderer.dispose();
	}
	private resize() { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight); }

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
	}

	// ---------- projectiles ----------

	private fireShellAt(u: Unit, t: Unit) {
		const p = this.shells[this.shellHead]; this.shellHead = (this.shellHead + 1) % this.SHELL_N;
		const sx = u.x, sy = hillY(u.x) + 1.42 * u.scale * UNIT_SCALE * 0.5, sz = u.z;
		const tx = t.x + (Math.random() - 0.5) * 2, tz = t.z + (Math.random() - 0.5) * 2, ty = hillY(tx) + 0.5;
		const dist = Math.hypot(tx - sx, tz - sz);
		const T = THREE.MathUtils.clamp(dist / 34, 0.35, 0.8), g = 14;
		p.active = true; p.x = sx; p.y = sy; p.z = sz;
		p.dmg = u.dmg * ATK_CD.colossus * KILL_TEMPO; p.team = u.team; p.life = T + 0.2;
		p.vx = (tx - sx) / T; p.vz = (tz - sz) / T; p.vy = (ty - sy + 0.5 * g * T * T) / T;
		// muzzle flash
		this.spawnBurst(sx + (tx - sx) / dist * 2.2, sy, sz + (tz - sz) / dist * 2.2, new THREE.Color(0xffe9a0), 8);
		this.shake = Math.min(1.2, this.shake + 0.06);
	}

	private updateShells(dt: number) {
		const g = 14; let dirty = false;
		for (let i = 0; i < this.SHELL_N; i++) {
			const p = this.shells[i];
			if (!p.active) continue;
			p.vy -= g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.life -= dt;
			if (p.y <= hillY(p.x) + 0.3 || p.life <= 0) {
				p.active = false;
				// EXPLOSION: big flash + splash damage
				const col = p.team === 'bull' ? GOLD : CRIMSON;
				this.spawnBurst(p.x, hillY(p.x) + 0.8, p.z, new THREE.Color(0xffd080), 16);
				this.spawnBurst(p.x, hillY(p.x) + 0.8, p.z, col, 14);
				this.addDecal(p.x, p.z, 1.5);
				this.shake = Math.min(1.4, this.shake + 0.18);
				let hits = 0;
				for (const e of this.units) {
					if (e.team === p.team || e.dying > 0 || e.hp <= 0) continue;
					const dx = e.x - p.x, dz = e.z - p.z, d2 = dx * dx + dz * dz;
					if (d2 < 3.2 * 3.2) { e.hp -= p.dmg * (d2 < 1.6 ? 1 : 0.55); e.struck = 0.16; if (e.hp <= 0) this.kill(e, []); if (++hits >= 5) break; }
				}
				this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); this.shellMesh.setMatrixAt(i, this.dummy.matrix); dirty = true;
				continue;
			}
			this.vTmp.set(p.vx, p.vy, p.vz).normalize();
			this.q.setFromUnitVectors(this.upV, this.vTmp);
			this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.q); this.dummy.scale.setScalar(1.4); this.dummy.updateMatrix();
			this.shellMesh.setMatrixAt(i, this.dummy.matrix);
			this.shellMesh.setColorAt(i, this.tmpColor.copy(p.team === 'bull' ? GOLD : CRIMSON).lerp(new THREE.Color(0xffffff), 0.2));
			dirty = true;
		}
		if (dirty) { this.shellMesh.instanceMatrix.needsUpdate = true; if (this.shellMesh.instanceColor) this.shellMesh.instanceColor.needsUpdate = true; }
	}

	private fireArrowAt(u: Unit, t: Unit) {
		const p = this.proj[this.projHead]; this.projHead = (this.projHead + 1) % this.PROJ;
		const sx = u.x, sy = hillY(u.x) + 1.4 * u.scale * UNIT_SCALE, sz = u.z;
		// aim at the target with slight scatter
		const tx = t.x + (Math.random() - 0.5) * 1.6, tz = t.z + (Math.random() - 0.5) * 1.6, ty = hillY(tx) + 0.9;
		const dist = Math.hypot(tx - sx, tz - sz);
		const T = THREE.MathUtils.clamp(dist / 34, 0.35, 0.72), g = 18;
		p.active = true; p.x = sx; p.y = sy; p.z = sz;
		p.dmg = u.dmg * ATK_CD.archer * KILL_TEMPO * 0.6; p.team = u.team; p.life = T + 0.25;
		p.vx = (tx - sx) / T; p.vz = (tz - sz) / T; p.vy = (ty - sy + 0.5 * g * T * T) / T;
		// muzzle flash toward the target
		this.spawnBurst(sx + ((tx - sx) / dist) * 1.1, sy, sz + ((tz - sz) / dist) * 1.1, new THREE.Color(0xffe9a0), 3);
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
				if (best) { best.hp -= p.dmg; best.struck = 0.16; if (best.hp <= 0) this.kill(best, []); }
				this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); this.arrowMesh.setMatrixAt(i, this.dummy.matrix); dirty = true;
				continue;
			}
			this.vTmp.set(p.vx, p.vy, p.vz).normalize();
			this.q.setFromUnitVectors(this.upV, this.vTmp);
			this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.q); this.dummy.scale.setScalar(1.35); this.dummy.updateMatrix();
			this.arrowMesh.setMatrixAt(i, this.dummy.matrix);
			this.arrowMesh.setColorAt(i, this.tmpColor.copy(p.team === 'bull' ? GOLD : CRIMSON).lerp(new THREE.Color(0xffffff), 0.55));
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
		this.slowmo = Math.max(0, this.slowmo - rawDt);
		this.timeScale += ((this.slowmo > 0 ? 0.32 : 1) - this.timeScale) * Math.min(1, rawDt * 6);
		const simDt = dt * this.timeScale;

		this.step(simDt);
		this.updateArrows(simDt);
		this.updateShells(simDt);
		this.updateParticles(simDt);
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

	private emptyComp(): Comp { return { spear: 0, ronin: 0, archer: 0, colossus: 0 }; }
	private _bullPower = 0; private _bearPower = 0; private _bullCount = 0; private _bearCount = 0;
	private _bullComp = this.emptyComp(); private _bearComp = this.emptyComp();

	private step(dt: number) {
		let bullPower = 0, bearPower = 0, bullCount = 0, bearCount = 0;
		const bc = this.emptyComp(), rc = this.emptyComp();
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.team === 'bull') { bullCount++; bc[u.cls]++; bullPower += u.dmg * (u.ranged ? 0.6 : 1); }
			else { bearCount++; rc[u.cls]++; bearPower += u.dmg * (u.ranged ? 0.6 : 1); }
		}

		if (this.phase === 'battle') {
			const tot = bullPower + bearPower;
			const delta = tot > 0 ? (bullPower - bearPower) / tot : 0;
			const bias = THREE.MathUtils.clamp(this.momentum / 25, -1, 1) * FRONT_MAX * 0.35;
			// 0.95 ≥ the 0.9 win threshold — total battlefield dominance can actually storm the base
			const target = THREE.MathUtils.clamp(delta * FRONT_MAX * 0.95 + bias, -FRONT_MAX, FRONT_MAX);
			this.frontX += (target - this.frontX) * Math.min(1, dt * 0.6);
			// a side reaches the enemy base → the theater falls
			if (this.frontX > FRONT_MAX * 0.9) this.winCampaign('bull');
			else if (this.frontX < -FRONT_MAX * 0.9) this.winCampaign('bear');
		} else if (performance.now() >= this.wonUntil) {
			this.resetCampaign();
		}

		// timeframe-driven reinforcements keep the war supplied (paused while a theater falls)
		if (this.phase === 'battle') {
			this.accB += this.reinB * dt; this.accS += this.reinS * dt;
			while (this.accB >= 1) { this.accB -= 1; this.addUnit('bull', pickClass('SOLDIER', Math.random()), GARRISON, '', false, false); }
			while (this.accS >= 1) { this.accS -= 1; this.addUnit('bear', pickClass('SOLDIER', Math.random()), GARRISON, '', false, false); }
		}

		// live rosters for target acquisition
		const bullsAlive: Unit[] = [], bearsAlive: Unit[] = [];
		for (const u of this.units) if (u.dying <= 0) (u.team === 'bull' ? bullsAlive : bearsAlive).push(u);

		const acquire = (u: Unit, range: number): Unit | null => {
			const foes = u.team === 'bull' ? bearsAlive : bullsAlive;
			let best: Unit | null = null, bd = range * range;
			for (const e of foes) {
				if (e.dying > 0 || e.hp <= 0) continue;
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

			// (re)acquire a real enemy to fight
			if (u.retarget <= 0 || !u.target || u.target.hp <= 0 || u.target.dying > 0) {
				u.target = acquire(u, u.ranged ? 30 : ACQUIRE_R);
				u.retarget = 0.3 + Math.random() * 0.3;
			}

			let desiredFace: number | null = null;

			if (u.ranged) {
				// archers/tanks hold staggered firing lines — depth varies per unit
				u.melee = false;
				const tx = this.frontX + u.sign * (u.standoff + u.rank * 0.9 + Math.max(0, u.frontJitter) * 0.55);
				u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), u.speed * dt);
				// drift toward their lane so the line fills the whole arena depth
				u.z += Math.sign(u.lane - u.z) * Math.min(Math.abs(u.lane - u.z), u.speed * 0.3 * dt);
				if (u.target && (u.target.dying > 0 || u.target.hp <= 0)) u.target = null;
				if (u.target) {
					desiredFace = Math.atan2(-(u.target.z - u.z), u.target.x - u.x);
					if (u.atkCd <= 0) {
						if (u.cls === 'colossus') { this.fireShellAt(u, u.target); u.atkCd = ATK_CD.colossus + Math.random() * 0.9; }
						else { this.fireArrowAt(u, u.target); u.atkCd = ATK_CD.archer + Math.random() * 0.7; }
						u.strike = 0.3;
					}
				}
			} else if (u.target && u.target.dying <= 0 && u.target.hp > 0) {
				const t = u.target;
				const dx = t.x - u.x, dz = t.z - u.z;
				const dist = Math.hypot(dx, dz);
				const reach = (u.scale + t.scale) * 0.5 * UNIT_SCALE * 1.1 + (u.cls === 'colossus' ? 1.1 : 0.45);
				desiredFace = Math.atan2(-dz, dx);
				if (dist > reach) {
					// charge the target
					const step = Math.min(dist - reach * 0.9, u.speed * dt);
					u.x += (dx / dist) * step; u.z += (dz / dist) * step;
					u.melee = dist < reach * 3;
				} else {
					// in reach — strike on cooldown
					u.melee = true;
					if (u.atkCd <= 0) {
						u.atkCd = ATK_CD[u.cls] * (0.9 + Math.random() * 0.2);
						u.strike = 0.32;
						const per = u.dmg * ATK_CD[u.cls] * KILL_TEMPO;
						const col = u.team === 'bull' ? GOLD : CRIMSON;
						this.spawnBurst(t.x, hillY(t.x) + 1.1, t.z, col, u.cls === 'colossus' ? 12 : 5);
						// knockback
						const kb = u.cls === 'colossus' ? 0.9 : 0.3;
						t.x += (dx / Math.max(0.01, dist)) * kb; t.z += (dz / Math.max(0.01, dist)) * kb * 0.4;
						t.hp -= per; t.struck = 0.16;
						if (t.hp <= 0) this.kill(t, [u]);
						// colossus slam splashes nearby enemies
						if (u.cls === 'colossus') {
							const foes = u.team === 'bull' ? bearsAlive : bullsAlive;
							let hits = 0;
							for (const e of foes) {
								if (e === t || e.dying > 0 || e.hp <= 0) continue;
								const ex = e.x - t.x, ez = e.z - t.z;
								if (ex * ex + ez * ez < 2.4 * 2.4) { e.hp -= per * 0.55; e.struck = 0.16; if (e.hp <= 0) this.kill(e, [u]); if (++hits >= 3) break; }
							}
							this.shake = Math.min(1.2, this.shake + 0.12);
						}
					}
				}
			} else if (u.flank) {
				// FLANKERS sweep the arena edge, cross behind the line, and strike from the side
				u.melee = false;
				const wx = this.frontX - u.sign * (5 + Math.max(0, u.frontJitter));
				const wz = (u.lane >= 0 ? 1 : -1) * (ARENA_Z - 3);
				const dx = wx - u.x, dz = wz - u.z, d = Math.hypot(dx, dz);
				if (d > 1) { const st2 = Math.min(d, u.speed * 1.1 * dt); u.x += (dx / d) * st2; u.z += (dz / d) * st2; }
				desiredFace = Math.atan2(-dz, dx);
			} else {
				// no enemy in range — press to a personal depth PAST the line, then hold ground
				u.melee = false;
				const tx = this.frontX + u.sign * (u.standoff + u.rank * 0.9) - u.sign * Math.max(0, u.frontJitter);
				const ahead = u.sign < 0 ? u.x >= tx : u.x <= tx; // already at/beyond their push depth
				if (!ahead) u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), u.speed * dt);
				// spread across the arena depth toward their lane
				u.z += Math.sign(u.lane - u.z) * Math.min(Math.abs(u.lane - u.z), u.speed * 0.35 * dt);
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
		// keep everyone inside the arena and off the capitals
		for (const u of this.units) {
			if (u.dying > 0) continue;
			u.z = THREE.MathUtils.clamp(u.z, -ARENA_Z - 2, ARENA_Z + 2);
			u.x = THREE.MathUtils.clamp(u.x, -CAP + 3, CAP - 3);
		}

		this.updateInstances();

		this.frontLine.position.x = this.frontX; this.frontLine.position.y = hillY(this.frontX) + 0.12;
		(this.frontLine.material as THREE.MeshBasicMaterial).opacity = 0.2 + Math.sin(this.time * 5) * 0.07;
		// the market-cap marker rides the front line (its altitude on the hill)
		this.mcapSprite.position.set(this.frontX, hillY(this.frontX) + 11 + Math.sin(this.time * 1.5) * 0.4, 0);

		this._bullPower = bullPower; this._bearPower = bearPower; this._bullCount = bullCount; this._bearCount = bearCount; this._bullComp = bc; this._bearComp = rc;
	}

	private winCampaign(team: Team) {
		this.phase = 'victory'; this.winner = team; this.wonUntil = performance.now() + 4000; this.shake = 1.7;
		if (team === 'bull') this.winsBull++; else this.winsBear++;
		const loser = team === 'bull' ? this.capitalBear : this.capitalBull;
		// the fallen base erupts
		this.spawnBurst(loser.position.x, 4, 0, team === 'bull' ? CRIMSON : GOLD, 140);
		for (let k = 0; k < 6; k++) this.addDecal(loser.position.x + (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, 2.5);
		this.onCampaign?.({ winner: team, campaign: this.campaign });
	}

	private resetCampaign() {
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (const u of this.units) this.armies[`${u.team}:${u.cls}`].mesh.setMatrixAt(u.idx, this.dummy.matrix);
		for (const key in this.armies) { const a = this.armies[key]; a.mesh.instanceMatrix.needsUpdate = true; a.free = []; for (let i = 0; i < MAX; i++) a.free.push(MAX - 1 - i); }
		this.units = []; this.frontX = 0; this.winner = null; this.phase = 'battle'; this.campaign++;
		this.spawnGarrison(this.lastGarrison.bulls, this.lastGarrison.bears);
	}

	private kill(u: Unit, killers: Unit[]) {
		if (u.dying > 0) return; // already down — never double-count a casualty
		u.dying = 8; // fall, lie as a casualty on the field, then fade
		this.spawnBurst(u.x, hillY(u.x) + 1.2, u.z, u.team === 'bull' ? GOLD : CRIMSON, u.legend ? 40 : 9);
		this.spawnSoul(u.x, hillY(u.x) + 1.6, u.z, u.team === 'bull' ? GOLD : CRIMSON);
		this.addDecal(u.x, u.z, u.scale);
		if (u.team === 'bull') this.casualtiesBull++; else this.casualtiesBear++;
		this.totalKills++;
		// each casualty physically shoves the front toward the loser's base
		this.frontX = THREE.MathUtils.clamp(this.frontX + (u.team === 'bear' ? 0.12 : -0.12), -FRONT_MAX, FRONT_MAX);
		this.killFx.push({ x: u.x, z: u.z, team: u.team, until: performance.now() + 1200 });
		if (this.killFx.length > 40) this.killFx.shift();
		if (killers.length) { const killer = killers[(Math.random() * killers.length) | 0]; killer.kills++; if (killer.wallet) { const c = this.commanders.get(killer.wallet); if (c) c.kills++; } }
		this.onEvent?.({ type: 'kill', team: u.team, tier: u.tier, cls: u.cls, wallet: u.wallet, usd: 0, pct: 0 });
	}

	private updateInstances() {
		const dirty = new Set<THREE.InstancedMesh>();
		for (const key in this.armies) this.armies[key].top = -1;
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i];
			if (u.dying <= 0 && u.hp <= 0) continue;
			const army = this.armies[`${u.team}:${u.cls}`];
			if (u.idx > army.top) army.top = u.idx;
			const mesh = army.mesh;
			const d = this.dummy, gy = groundY(u.x, u.z);
			// spawn pop-in (Clash-style overshoot)
			const pop = u.age < 0.45 ? easeOutBack(Math.min(1, u.age / 0.45)) : 1;
			const s = u.scale * UNIT_SCALE * Math.max(0.01, pop);
			if (u.dying > 0) {
				// fall over (0.45s) → lie as a casualty → sink away in the last second
				const elapsed = 8 - u.dying;
				const fall = Math.min(1, elapsed / 0.45);
				const fade = u.dying < 1 ? u.dying : 1;
				// tanks don't flop on their side — they slump and burn out
				const flopAmt = u.cls === 'colossus' ? 0.16 : 0.94;
				const flop = (u.idx % 2 === 0 ? 1 : -1) * fall * (Math.PI / 2) * flopAmt;
				d.position.set(u.x, gy + (1 - fall) * 0.2 - (1 - fade) * 0.55, u.z);
				d.scale.setScalar(s * (0.55 + fade * 0.45));
				d.rotation.set(0, u.face, flop);
			} else if (u.ranged && u.cls === 'colossus') {
				// tank: steady, recoil kick backwards on fire
				const recoil = u.strike > 0 ? Math.sin((0.3 - u.strike) / 0.3 * Math.PI) * 0.4 : 0;
				const fx = Math.cos(u.face), fz = -Math.sin(u.face);
				d.position.set(u.x - fx * recoil, gy + 0.02, u.z - fz * recoil);
				d.scale.setScalar(s);
				d.rotation.set(recoil * 0.06, u.face, 0);
			} else if (u.ranged) {
				const hop = Math.abs(Math.sin(u.bob * 0.6)) * 0.06 * u.scale;
				// draw-and-loose: lean back on strike, snap forward on release
				const loose = u.strike > 0 ? Math.sin((0.3 - u.strike) / 0.3 * Math.PI) * 0.28 : 0;
				d.position.set(u.x, gy + hop, u.z);
				d.scale.setScalar(s);
				d.rotation.set(-loose * 0.6, u.face, Math.sin(u.bob * 0.5) * 0.05);
			} else if (u.strike > 0) {
				// weapon strike: anticipation wind-up then chop into the target
				const t = 1 - u.strike / 0.32; // 0 → 1 over the swing
				const swing = t < 0.35 ? -t / 0.35 * 0.55 : Math.sin((t - 0.35) / 0.65 * Math.PI) * (u.cls === 'colossus' ? 0.95 : 0.7);
				const lungeF = t < 0.35 ? 0 : Math.sin((t - 0.35) / 0.65 * Math.PI) * (u.cls === 'ronin' ? 0.7 : 0.4);
				const fx = Math.cos(u.face), fz = -Math.sin(u.face); // forward (local +x) from face angle
				d.position.set(u.x + fx * lungeF, gy + Math.abs(Math.sin(u.bob * 2)) * 0.06 * u.scale, u.z + fz * lungeF);
				d.scale.setScalar(s);
				d.rotation.set(swing, u.face, 0);
			} else if (u.melee) {
				// guard stance — tense bounce facing the enemy
				d.position.set(u.x, gy + Math.abs(Math.sin(u.bob * 2.4)) * 0.07 * u.scale, u.z);
				d.scale.setScalar(s);
				d.rotation.set(0.06, u.face, Math.sin(u.bob * 3) * 0.05);
			} else {
				// waddle march — bouncy, side-to-side, leaning in
				const gait = Math.sin(u.bob);
				d.position.set(u.x, gy + Math.abs(gait) * 0.22 * u.scale, u.z);
				d.scale.setScalar(s);
				d.rotation.set(0.1, u.face, gait * 0.14);
			}
			d.updateMatrix(); mesh.setMatrixAt(u.idx, d.matrix); dirty.add(mesh);
			// colour: hit-flash > tracked glow > base tint
			if (u.struck > 0) mesh.setColorAt(u.idx, this.tmpColor.set(2.4, 2.2, 2.0));
			else if (u.tracked) mesh.setColorAt(u.idx, this.tmpColor.set(1.6, 1.5, 1.1));
			else mesh.setColorAt(u.idx, this.tmpColor.setScalar(u.tint));
		}
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i]; if (u.dying > 0 || u.hp > 0) continue;
			const army = this.armies[`${u.team}:${u.cls}`];
			this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); army.mesh.setMatrixAt(u.idx, this.dummy.matrix); dirty.add(army.mesh); army.free.push(u.idx); this.units.splice(i, 1);
		}
		for (const m of dirty) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
		// only draw the occupied slice of each army buffer — empty ranks cost nothing
		for (const key in this.armies) { const a = this.armies[key]; a.mesh.count = a.top + 1; }
	}

	private render(dt: number) {
		if (this.keys.size) {
			const spd = 46 * dt * this.camZoom, sy = Math.sin(this.camYaw), cy = Math.cos(this.camYaw);
			if (this.keys.has('w')) { this.panX -= sy * spd; this.panZ -= cy * spd; }
			if (this.keys.has('s')) { this.panX += sy * spd; this.panZ += cy * spd; }
			if (this.keys.has('a')) { this.panX -= cy * spd; this.panZ += sy * spd; }
			if (this.keys.has('d')) { this.panX += cy * spd; this.panZ -= sy * spd; }
			this.panX = THREE.MathUtils.clamp(this.panX, -56, 56); this.panZ = THREE.MathUtils.clamp(this.panZ, -44, 44);
		}

		const target = this._camTarget.set(this.panX, 1, this.panZ);
		let radius = 60 * this.camZoom;
		let height = THREE.MathUtils.lerp(24, 128, this.camPitch) * (0.55 + this.camZoom * 0.45);

		if (this.focus) {
			const tracked = this.units.find((u) => u.tracked && u.dying <= 0);
			if (tracked) { target.set(tracked.x, 3, tracked.z); radius = 26 * this.camZoom; height = 22 * this.camZoom; }
		}

		const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 2 : 0, shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
		this.shake = Math.max(0, this.shake - dt * 1.4);
		this.camera.position.lerp(this._camPos.set(target.x + Math.sin(this.camYaw) * radius + shakeX, height + shakeY, target.z + Math.cos(this.camYaw) * radius), Math.min(1, dt * 2.6));
		this.camera.lookAt(target);

		// waving banners
		for (let i = 0; i < this.flags.length; i++) {
			const f = this.flags[i];
			f.rotation.y = Math.sin(this.time * 2.2 + i * 2) * 0.28;
			f.position.x = 1.8 + Math.sin(this.time * 2.2 + i * 2) * 0.15;
		}

		this.updateAuras(dt);
		if (location.search.includes('nofx')) this.renderer.render(this.scene, this.camera);
		else this.composer.render(dt);
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
			round: this.campaign, winBull: this.winsBull, winBear: this.winsBear, phase: this.phase, winner: this.winner,
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
			else if (u.legend) { const p = project(u.x, hillY(u.x) + u.scale * 2.3, u.z); titans.push({ x: p.x, y: p.y, on: p.on, label: u.tier, team: u.team }); }
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

function rankIdx(t: string): number { return ['GARRISON', 'SOLDIER', 'ELITE', 'CHAMPION', 'TITAN', 'GOD'].indexOf(t); }
