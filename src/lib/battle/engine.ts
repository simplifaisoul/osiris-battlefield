import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
	EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, VignetteEffect,
	NoiseEffect, ChromaticAberrationEffect, ToneMappingEffect, ToneMappingMode,
	GodRaysEffect, BrightnessContrastEffect, HueSaturationEffect, KernelSize, BlendFunction
} from 'postprocessing';
import { createNoise2D } from 'simplex-noise';
import { tierForPct, GARRISON, type Tier } from './tiers';

export type Team = 'bull' | 'bear';
export type Cls = 'spear' | 'ronin' | 'archer' | 'colossus';
export type SpawnInput = { wallet: string; kind: Team | 'buy' | 'sell'; usd: number; pct: number };

export type BattleEvent = {
	type: 'spawn' | 'kill' | 'legend';
	team: Team;
	tier: string;
	cls: Cls;
	wallet: string;
	usd: number;
	pct: number;
	god?: boolean;
};

export type Commander = { wallet: string; kills: number; tier: string; team: Team };
export type Comp = { spear: number; ronin: number; archer: number; colossus: number };

export type Stats = {
	bulls: number; bears: number;
	bullPower: number; bearPower: number;
	frontPct: number;
	casualtiesBull: number; casualtiesBear: number;
	fps: number;
	round: number; winBull: number; winBear: number;
	phase: 'battle' | 'victory'; winner: Team | null;
	totalKills: number; biggestWhaleUsd: number; biggestWhaleWallet: string;
	commanders: Commander[];
	bullComp: Comp; bearComp: Comp;
};

export type RoundResult = { round: number; winner: Team; winBull: number; winBear: number };

export type Overlay = {
	tracked: { x: number; y: number; on: boolean; tier: string; team: Team; hp: number; maxHp: number; kills: number; wallet: string }[];
	titans: { x: number; y: number; on: boolean; label: string; team: Team }[];
};

type Unit = {
	team: Team; sign: number; cls: Cls; ranged: boolean;
	tier: string; scale: number; hp: number; maxHp: number; dmg: number;
	standoff: number; speed: number;
	wallet: string; x: number; z: number; rank: number; bob: number;
	cd: number; kills: number; idx: number; dying: number;
	tracked: boolean; legend: boolean; melee: boolean;
};

const MAX = 340; // per class-mesh
const FRONT_MAX = 27;
const CAP = FRONT_MAX + 16;
const ARENA_Z = 26;
const MELEE = 4.2;
const SPEED = 11;
const UNIT_SCALE = 1.3;
const WIN_THRESH = FRONT_MAX * 0.84;
const CLASSES: Cls[] = ['spear', 'ronin', 'archer', 'colossus'];

const CLASS_STATS: Record<Cls, { hpMul: number; dmgMul: number; scaleMul: number; ranged: boolean; standoff: number; speedMul: number }> = {
	spear: { hpMul: 1.0, dmgMul: 1.0, scaleMul: 1.0, ranged: false, standoff: 0.8, speedMul: 1.0 },
	ronin: { hpMul: 0.78, dmgMul: 1.9, scaleMul: 0.95, ranged: false, standoff: 0.6, speedMul: 1.4 },
	archer: { hpMul: 0.55, dmgMul: 1.7, scaleMul: 0.9, ranged: true, standoff: 15, speedMul: 1.05 },
	colossus: { hpMul: 1.5, dmgMul: 1.4, scaleMul: 1.22, ranged: false, standoff: 0.9, speedMul: 0.8 }
};

// Trader colours — buyers/bulls green, sellers/bears red.
const GOLD = new THREE.Color('#25D366'); // bull / buy side
const CRIMSON = new THREE.Color('#FF4D5E'); // bear / sell side

// The battlefield is a hill whose summit is the market cap; both forces fight up and down its slopes.
const HILL_H = 6;
const HILL_SIG = FRONT_MAX * 0.85;
function hillY(x: number): number { return HILL_H * Math.exp(-(x * x) / (2 * HILL_SIG * HILL_SIG)); }

function hash01(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0) / 4294967296;
}
function pickClass(tier: string, seed: number): Cls {
	if (tier === 'TITAN' || tier === 'GOD') return 'colossus';
	if (seed < 0.42) return 'spear';
	if (seed < 0.70) return 'archer';
	return 'ronin';
}

// ---------- geometry ----------

function legPair(): THREE.BufferGeometry[] {
	const leg = new THREE.CylinderGeometry(0.1, 0.07, 0.72, 5);
	const l1 = leg.clone(); l1.translate(-0.13, 0.36, 0);
	const l2 = leg.clone(); l2.translate(0.13, 0.36, 0);
	return [l1, l2];
}
function head(y = 1.58, r = 0.18): THREE.BufferGeometry { const h = new THREE.SphereGeometry(r, 8, 6); h.translate(0, y, 0); return h; }

function buildSpear(): THREE.BufferGeometry {
	const p = [...legPair()];
	const torso = new THREE.BoxGeometry(0.5, 0.7, 0.28); torso.translate(0, 1.05, 0);
	const sh = new THREE.BoxGeometry(0.62, 0.16, 0.34); sh.translate(0, 1.36, 0);
	const helm = new THREE.ConeGeometry(0.2, 0.3, 6); helm.translate(0, 1.78, 0);
	const plume = new THREE.BoxGeometry(0.05, 0.26, 0.18); plume.translate(0, 1.98, -0.05);
	const cape = new THREE.PlaneGeometry(0.5, 0.9); cape.rotateY(Math.PI / 2); cape.rotateX(0.16); cape.translate(-0.17, 0.95, 0);
	const spear = new THREE.CylinderGeometry(0.028, 0.028, 2.0, 5); spear.rotateZ(0.14); spear.translate(0.36, 1.2, 0.08);
	const tip = new THREE.ConeGeometry(0.06, 0.24, 6); tip.rotateZ(0.14); tip.translate(0.52, 2.14, 0.08);
	const shield = new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12); shield.rotateZ(Math.PI / 2); shield.translate(-0.32, 1.02, 0);
	p.push(torso, sh, head(), helm, plume, cape, spear, tip, shield);
	const m = mergeGeometries(p, false)!; m.computeVertexNormals(); return m;
}

function buildRonin(): THREE.BufferGeometry {
	const p = [...legPair()];
	const torso = new THREE.BoxGeometry(0.44, 0.68, 0.24); torso.translate(0, 1.03, 0);
	const sash = new THREE.BoxGeometry(0.48, 0.14, 0.27); sash.rotateZ(0.25); sash.translate(0, 1.05, 0);
	const topknot = new THREE.SphereGeometry(0.09, 6, 5); topknot.translate(0, 1.76, -0.03);
	// katana: long slim blade held out, slight curve implied by angle
	const blade = new THREE.BoxGeometry(0.035, 1.5, 0.11); blade.rotateZ(-0.5); blade.translate(0.5, 1.5, 0.05);
	const guard = new THREE.CylinderGeometry(0.09, 0.09, 0.03, 8); guard.rotateX(Math.PI / 2); guard.translate(0.2, 1.05, 0.05);
	const hilt = new THREE.CylinderGeometry(0.03, 0.03, 0.24, 6); hilt.rotateZ(-0.5); hilt.translate(0.12, 0.93, 0.05);
	p.push(torso, sash, head(1.5, 0.17), topknot, blade, guard, hilt);
	const m = mergeGeometries(p, false)!; m.computeVertexNormals(); return m;
}

function buildArcher(): THREE.BufferGeometry {
	const p = [...legPair()];
	const torso = new THREE.BoxGeometry(0.44, 0.66, 0.24); torso.translate(0, 1.02, 0);
	const hood = new THREE.ConeGeometry(0.22, 0.34, 6); hood.translate(0, 1.62, 0);
	// bow: an arc held forward
	const bow = new THREE.TorusGeometry(0.55, 0.03, 6, 16, Math.PI * 1.15); bow.rotateY(Math.PI / 2); bow.translate(0.3, 1.15, 0);
	const nock = new THREE.CylinderGeometry(0.02, 0.02, 0.7, 5); nock.rotateZ(Math.PI / 2); nock.translate(0.15, 1.15, 0);
	const quiver = new THREE.CylinderGeometry(0.08, 0.08, 0.4, 6); quiver.rotateX(0.4); quiver.translate(-0.2, 1.2, -0.12);
	p.push(torso, head(1.5, 0.16), hood, bow, nock, quiver);
	const m = mergeGeometries(p, false)!; m.computeVertexNormals(); return m;
}

function buildColossus(): THREE.BufferGeometry {
	const leg = new THREE.CylinderGeometry(0.17, 0.12, 0.9, 6);
	const l1 = leg.clone(); l1.translate(-0.2, 0.45, 0);
	const l2 = leg.clone(); l2.translate(0.2, 0.45, 0);
	const torso = new THREE.BoxGeometry(0.78, 1.0, 0.5); torso.translate(0, 1.45, 0);
	const sh = new THREE.BoxGeometry(1.1, 0.3, 0.62); sh.translate(0, 2.0, 0);
	const hd = new THREE.SphereGeometry(0.24, 8, 6); hd.translate(0, 2.3, 0);
	const helm = new THREE.ConeGeometry(0.28, 0.4, 6); helm.translate(0, 2.55, 0);
	const horn1 = new THREE.ConeGeometry(0.06, 0.4, 5); horn1.rotateZ(0.9); horn1.translate(-0.3, 2.45, 0);
	const horn2 = new THREE.ConeGeometry(0.06, 0.4, 5); horn2.rotateZ(-0.9); horn2.translate(0.3, 2.45, 0);
	// warhammer
	const haft = new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6); haft.translate(0.6, 1.6, 0.1);
	const headb = new THREE.BoxGeometry(0.4, 0.4, 0.4); headb.translate(0.6, 2.9, 0.1);
	const m = mergeGeometries([l1, l2, torso, sh, hd, helm, horn1, horn2, haft, headb], false)!;
	m.computeVertexNormals(); return m;
}

function buildArrow(): THREE.BufferGeometry {
	const shaft = new THREE.CylinderGeometry(0.02, 0.02, 1.0, 5);
	const tip = new THREE.ConeGeometry(0.05, 0.16, 6); tip.translate(0, 0.58, 0);
	const fl = new THREE.BoxGeometry(0.12, 0.16, 0.01); fl.translate(0, -0.5, 0);
	const m = mergeGeometries([shaft, tip, fl], false)!; m.computeVertexNormals(); return m;
}

function groundTexture(): THREE.Texture {
	const c = document.createElement('canvas'); c.width = c.height = 512;
	const x = c.getContext('2d')!;
	x.fillStyle = '#3a2f22'; x.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 26000; i++) { const v = 20 + Math.random() * 60; x.fillStyle = `rgba(${v + 40},${v + 26},${v},${Math.random() * 0.5})`; x.fillRect(Math.random() * 512, Math.random() * 512, 2, 2); }
	const g = x.createRadialGradient(256, 256, 20, 256, 256, 240); g.addColorStop(0, 'rgba(10,6,4,0.7)'); g.addColorStop(1, 'rgba(10,6,4,0)');
	x.fillStyle = g; x.fillRect(0, 0, 512, 512);
	const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 3); t.anisotropy = 4; return t;
}
function skyTexture(): THREE.Texture {
	const c = document.createElement('canvas'); c.width = 4; c.height = 256;
	const x = c.getContext('2d')!;
	const g = x.createLinearGradient(0, 0, 0, 256);
	g.addColorStop(0, '#0b0f0c'); g.addColorStop(0.5, '#161a12'); g.addColorStop(0.8, '#2c2c17'); g.addColorStop(1, '#4a3d1c');
	x.fillStyle = g; x.fillRect(0, 0, 4, 256); return new THREE.CanvasTexture(c);
}
function radialTexture(hex: string): THREE.Texture {
	const c = document.createElement('canvas'); c.width = c.height = 128;
	const x = c.getContext('2d')!;
	const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, hex); g.addColorStop(1, 'rgba(0,0,0,0)');
	x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}

export class Battle {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private composer!: EffectComposer;

	private armies: Record<string, { mesh: THREE.InstancedMesh; free: number[] }> = {};
	private units: Unit[] = [];
	private frontX = 0;

	// projectiles (arrows)
	private arrowMesh!: THREE.InstancedMesh;
	private PROJ = 320;
	private proj!: { active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; dmg: number; team: Team; life: number }[];
	private projHead = 0;

	private raf = 0; private last = 0; private time = 0;
	private focus = false; private trackWallet: string | null = null;
	private shake = 0; private statTick = 0; private fpsAvg = 60;
	private timeScale = 1; private slowmo = 0; private momentum = 0;

	private phase: 'battle' | 'victory' = 'battle';
	private winner: Team | null = null;
	private round = 1; private winBull = 0; private winBear = 0;
	private winHold = 0; private winSide: Team | null = null; private victoryEnd = 0;
	private lastGarrison = { bulls: 60, bears: 60 };

	private commanders = new Map<string, { kills: number; tier: string; team: Team; usd: number }>();
	private totalKills = 0; private biggestWhaleUsd = 0; private biggestWhaleWallet = '';

	private camYaw = 0.5; private camPitch = 0.62; private camZoom = 1;
	private panX = 0; private panZ = 0; private keys = new Set<string>();
	private manualUntil = 0; private dragging = false; private lastPtr = { x: 0, y: 0 };

	private sparks!: THREE.Points; private sparkPos!: Float32Array; private sparkVel!: Float32Array; private sparkLife!: Float32Array; private sparkColor!: Float32Array; private sparkHead = 0; private SPARK_N = 1500;
	private souls!: THREE.Points; private soulPos!: Float32Array; private soulVel!: Float32Array; private soulLife!: Float32Array; private soulColor!: Float32Array; private soulHead = 0; private SOUL_N = 400;
	private embers!: THREE.Points; private emberPos!: Float32Array; private emberVel!: Float32Array; private EMBER_N = 180;

	private auras: THREE.Group[] = [];
	private capitalBull!: THREE.Mesh; private capitalBear!: THREE.Mesh; private frontLine!: THREE.Mesh;
	private dummy = new THREE.Object3D(); private tmpColor = new THREE.Color();
	private q = new THREE.Quaternion(); private up = new THREE.Vector3(0, 1, 0); private vTmp = new THREE.Vector3();

	casualtiesBull = 0; casualtiesBear = 0;

	onStats: ((s: Stats) => void) | null = null;
	onOverlay: ((o: Overlay) => void) | null = null;
	onEvent: ((e: BattleEvent) => void) | null = null;
	onRound: ((r: RoundResult) => void) | null = null;

	constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.setSize(innerWidth, innerHeight);
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.toneMapping = THREE.NoToneMapping;

		this.scene.background = skyTexture();
		this.scene.fog = new THREE.FogExp2(0x161810, 0.0105);

		this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 600);
		this.camera.position.set(0, 34, 66);
		this.camera.lookAt(0, 4, 0);

		this.buildComposer();
		this.buildSky();
		this.buildLights();
		this.buildGround();
		this.capitalBull = this.buildCapital(GOLD, -CAP);
		this.capitalBear = this.buildCapital(CRIMSON, CAP);
		this.frontLine = this.buildFrontLine();
		this.buildGroundText();
		this.buildArmies();
		this.buildArrows();
		this.buildDust();
		this.buildSparks();
		this.buildSouls();
		this.buildEmbers();
		this.buildAuras();

		this._resize = this.resize.bind(this);
		addEventListener('resize', this._resize);
		this.bindCamera(canvas);
	}
	private _resize: () => void;

	// ---------- rendering pipeline ----------

	private buildComposer() {
		const sun = new THREE.Mesh(new THREE.SphereGeometry(22, 32, 32), new THREE.MeshBasicMaterial({ color: 0xffcf8a }));
		sun.position.set(46, 56, -205); sun.frustumCulled = false; this.scene.add(sun);

		this.composer = new EffectComposer(this.renderer, { multisampling: 0, frameBufferType: THREE.HalfFloatType });
		this.composer.addPass(new RenderPass(this.scene, this.camera));

		const godRays = new GodRaysEffect(this.camera, sun, { density: 0.93, decay: 0.94, weight: 0.5, exposure: 0.55, samples: 40, clampMax: 1, kernelSize: KernelSize.MEDIUM, blur: true, resolutionScale: 0.5 });
		const bloom = new BloomEffect({ intensity: 0.85, luminanceThreshold: 0.62, luminanceSmoothing: 0.32, mipmapBlur: true, radius: 0.75, kernelSize: KernelSize.HUGE });
		const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
		const bc = new BrightnessContrastEffect({ brightness: 0.08, contrast: 0.1 });
		const hs = new HueSaturationEffect({ saturation: 0.14 });
		const vignette = new VignetteEffect({ offset: 0.34, darkness: 0.42 });
		const ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0006, 0.0006), radialModulation: true, modulationOffset: 0.45 });
		const noise = new NoiseEffect({ blendFunction: BlendFunction.SOFT_LIGHT });
		(noise as unknown as { blendMode: { opacity: { value: number } } }).blendMode.opacity.value = 0.22;
		const smaa = new SMAAEffect();

		this.composer.addPass(new EffectPass(this.camera, godRays));
		this.composer.addPass(new EffectPass(this.camera, bloom));
		this.composer.addPass(new EffectPass(this.camera, tone, bc, hs, vignette, noise));
		this.composer.addPass(new EffectPass(this.camera, ca));
		this.composer.addPass(new EffectPass(this.camera, smaa));
	}

	private buildSky() {
		const N = 1400; const pos = new Float32Array(N * 3);
		for (let i = 0; i < N; i++) { const r = 260 + Math.random() * 60, th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.5; pos[i * 3] = Math.cos(th) * Math.sin(ph) * r; pos[i * 3 + 1] = Math.cos(ph) * r + 20; pos[i * 3 + 2] = Math.sin(th) * Math.sin(ph) * r; }
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff4d6, size: 1.1, sizeAttenuation: false, transparent: true, opacity: 0.9 })));
		const moon = new THREE.Mesh(new THREE.SphereGeometry(16, 32, 32), new THREE.MeshBasicMaterial({ color: 0xf2e2b0 }));
		moon.position.set(-70, 120, -220); this.scene.add(moon);
		const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('rgba(255,240,200,0.4)'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
		halo.scale.set(110, 110, 1); halo.position.copy(moon.position); this.scene.add(halo);
	}

	private buildLights() {
		this.scene.add(new THREE.HemisphereLight(0xdfe6c0, 0x20240f, 0.85));
		const sun = new THREE.DirectionalLight(0xfff0d0, 2.7);
		sun.position.set(-30, 50, 20); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
		const s = 70; sun.shadow.camera.left = -s; sun.shadow.camera.right = s; sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s; sun.shadow.camera.far = 160; sun.shadow.bias = -0.0004;
		this.scene.add(sun);
		const gl = new THREE.PointLight(GOLD, 1.6, 130, 1.6); gl.position.set(-CAP, 16, 0); this.scene.add(gl);
		const rl = new THREE.PointLight(CRIMSON, 1.6, 130, 1.6); rl.position.set(CAP, 16, 0); this.scene.add(rl);
	}

	private buildGround() {
		const mat = new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.96, metalness: 0, vertexColors: true });
		const geo = new THREE.PlaneGeometry(420, 260, 240, 150);
		const noise2D = createNoise2D(() => 0.42);
		const pos = geo.attributes.position as THREE.BufferAttribute;
		const colors = new Float32Array(pos.count * 3);
		// Held territory: bull (buy) side greens; bear (sell) side scorched red; road between.
		const bullSoil = new THREE.Color('#6f9438'), bearSoil = new THREE.Color('#7a3626'), road = new THREE.Color('#c4bda6');
		const c = new THREE.Color();
		for (let i = 0; i < pos.count; i++) {
			const px = pos.getX(i), py = pos.getY(i);
			const outX = Math.max(0, Math.abs(px) - (CAP + 10)), outZ = Math.max(0, Math.abs(py) - (ARENA_Z + 12));
			const falloff = THREE.MathUtils.clamp((outX + outZ) / 46, 0, 1);
			const dune = (noise2D(px * 0.018, py * 0.018) * 5 + noise2D(px * 0.05, py * 0.05) * 1.6) * falloff;
			const zTaper = THREE.MathUtils.clamp(1 - (Math.abs(py) - ARENA_Z) / 14, 0, 1);
			pos.setZ(i, dune + hillY(px) * zTaper);
			// colour by controlled side, blended, with a bright road seam at the front
			const t = THREE.MathUtils.clamp((px + 6) / 12, 0, 1); // 0 bull .. 1 bear
			c.copy(bullSoil).lerp(bearSoil, t);
			const seam = Math.max(0, 1 - Math.abs(px) / 4);
			c.lerp(road, seam * 0.6 * zTaper);
			colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
		}
		geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		geo.computeVertexNormals();
		const g = new THREE.Mesh(geo, mat); g.rotation.x = -Math.PI / 2; g.receiveShadow = true; this.scene.add(g);
	}

	private buildCapital(color: THREE.Color, x: number): THREE.Mesh {
		const m = new THREE.Mesh(new THREE.ConeGeometry(11, 20, 4), new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.32), emissive: color, emissiveIntensity: 0.18, metalness: 0.5, roughness: 0.42, flatShading: true }));
		m.position.set(x, 10, 0); m.rotation.y = Math.PI / 4; m.castShadow = true;
		const cap = new THREE.Mesh(new THREE.ConeGeometry(2.2, 3.4, 4), new THREE.MeshBasicMaterial({ color })); cap.position.set(0, 11, 0); cap.rotation.y = Math.PI / 4; m.add(cap);
		this.scene.add(m); return m;
	}

	private buildFrontLine(): THREE.Mesh {
		const m = new THREE.Mesh(new THREE.PlaneGeometry(6, ARENA_Z * 2 + 12), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(240,240,255,0.8)'), color: 0xffffff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }));
		m.rotation.x = -Math.PI / 2; m.position.y = 0.06; this.scene.add(m); return m;
	}

	private priceTex!: THREE.CanvasTexture;
	private priceCanvas!: HTMLCanvasElement;
	private buildGroundText() {
		const c = document.createElement('canvas'); c.width = 1024; c.height = 256; this.priceCanvas = c;
		this.priceTex = new THREE.CanvasTexture(c);
		const mesh = new THREE.Mesh(
			new THREE.PlaneGeometry(60, 15),
			new THREE.MeshBasicMaterial({ map: this.priceTex, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending })
		);
		mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, 0.25, 40);
		this.scene.add(mesh);
		this.setPriceLabel('$OSIRIS', '');
	}
	setPriceLabel(price: string, sub: string) {
		if (!this.priceCanvas) return;
		const x = this.priceCanvas.getContext('2d')!;
		x.clearRect(0, 0, 1024, 256);
		x.textAlign = 'center'; x.textBaseline = 'middle';
		x.font = '700 34px "JetBrains Mono", monospace'; x.fillStyle = 'rgba(255,255,255,0.5)';
		x.fillText(sub || 'CURRENT PRICE', 512, 40);
		x.font = '800 120px "JetBrains Mono", monospace';
		x.lineWidth = 8; x.strokeStyle = 'rgba(0,0,0,0.6)'; x.strokeText(price, 512, 150);
		x.fillStyle = 'rgba(255,255,255,0.92)'; x.fillText(price, 512, 150);
		this.priceTex.needsUpdate = true;
	}

	private buildArmies() {
		const geos: Record<Cls, THREE.BufferGeometry> = { spear: buildSpear(), ronin: buildRonin(), archer: buildArcher(), colossus: buildColossus() };
		for (const team of ['bull', 'bear'] as Team[]) {
			const base = team === 'bull' ? GOLD : CRIMSON;
			const emissive = team === 'bull' ? 0x0d5a2a : 0x5a0f16;
			const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive, emissiveIntensity: 0.22, metalness: 0.4, roughness: 0.5 });
			for (const cls of CLASSES) {
				const mesh = new THREE.InstancedMesh(geos[cls], mat, MAX);
				mesh.castShadow = true; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = MAX;
				const col = new THREE.Color(); this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
				for (let i = 0; i < MAX; i++) { mesh.setMatrixAt(i, this.dummy.matrix); col.copy(base).multiplyScalar(0.7 + Math.random() * 0.5); mesh.setColorAt(i, col); }
				mesh.instanceMatrix.needsUpdate = true;
				this.scene.add(mesh);
				const free: number[] = []; for (let i = 0; i < MAX; i++) free.push(MAX - 1 - i);
				this.armies[`${team}:${cls}`] = { mesh, free };
			}
		}
	}

	private buildArrows() {
		const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
		this.arrowMesh = new THREE.InstancedMesh(buildArrow(), mat, this.PROJ);
		this.arrowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.arrowMesh.count = this.PROJ; this.arrowMesh.frustumCulled = false;
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (let i = 0; i < this.PROJ; i++) { this.arrowMesh.setMatrixAt(i, this.dummy.matrix); this.arrowMesh.setColorAt(i, this.tmpColor.set(0xffffff)); }
		this.scene.add(this.arrowMesh);
		this.proj = Array.from({ length: this.PROJ }, () => ({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dmg: 0, team: 'bull' as Team, life: 0 }));
	}

	private buildDust() {
		const N = 500; const pos = new Float32Array(N * 3);
		for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 150; pos[i * 3 + 1] = Math.random() * 32; pos[i * 3 + 2] = (Math.random() - 0.5) * 95; }
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(216,176,112,0.9)'), color: 0xd8b070, size: 0.3, transparent: true, opacity: 0.16, depthWrite: false, alphaTest: 0.35 })));
	}

	private buildSparks() {
		const N = this.SPARK_N; this.sparkPos = new Float32Array(N * 3); this.sparkColor = new Float32Array(N * 3); this.sparkVel = new Float32Array(N * 3); this.sparkLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.sparkPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.sparkColor, 3));
		this.sparks = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.95)'), size: 0.5, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.35 }));
		this.sparks.frustumCulled = false; this.scene.add(this.sparks);
	}
	private buildSouls() {
		const N = this.SOUL_N; this.soulPos = new Float32Array(N * 3); this.soulColor = new Float32Array(N * 3); this.soulVel = new Float32Array(N * 3); this.soulLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.soulPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.soulPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.soulColor, 3));
		this.souls = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.9)'), size: 1.5, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.25 }));
		this.souls.frustumCulled = false; this.scene.add(this.souls);
	}
	private buildEmbers() {
		const N = this.EMBER_N; this.emberPos = new Float32Array(N * 3); this.emberVel = new Float32Array(N * 3);
		for (let i = 0; i < N; i++) this.resetEmber(i, true);
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.emberPos, 3));
		this.embers = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,170,80,0.95)'), color: 0xffa94b, size: 0.38, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.3 }));
		this.embers.frustumCulled = false; this.scene.add(this.embers);
	}
	private resetEmber(i: number, spread = false) {
		this.emberPos[i * 3] = this.frontX + (Math.random() - 0.5) * (spread ? 100 : 14);
		this.emberPos[i * 3 + 1] = Math.random() * (spread ? 12 : 0.5);
		this.emberPos[i * 3 + 2] = (Math.random() - 0.5) * ARENA_Z * 2.2;
		this.emberVel[i * 3] = (Math.random() - 0.5) * 0.5; this.emberVel[i * 3 + 1] = 1.1 + Math.random() * 1.8; this.emberVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
	}

	private buildAuras() {
		const runeGeo = new THREE.RingGeometry(1.05, 1.3, 40), rune2Geo = new THREE.RingGeometry(1.55, 1.68, 40), crownGeo = new THREE.OctahedronGeometry(0.2, 0);
		for (let i = 0; i < 12; i++) {
			const grp = new THREE.Group();
			const r1 = new THREE.Mesh(runeGeo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); r1.rotation.x = -Math.PI / 2; r1.position.y = 0.08; r1.name = 'r1';
			const r2 = new THREE.Mesh(rune2Geo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); r2.rotation.x = -Math.PI / 2; r2.position.y = 0.08; r2.name = 'r2';
			const crown = new THREE.Mesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xffcf70, emissiveIntensity: 0.7, metalness: 0.6, roughness: 0.3 })); crown.name = 'crown';
			grp.add(r1, r2, crown); grp.visible = false; this.scene.add(grp); this.auras.push(grp);
		}
	}

	// ---------- camera ----------

	private bindCamera(canvas: HTMLCanvasElement) {
		canvas.addEventListener('pointerdown', (e) => { this.dragging = true; this.lastPtr = { x: e.clientX, y: e.clientY }; this.manualUntil = performance.now() + 7000; });
		addEventListener('pointerup', () => (this.dragging = false));
		addEventListener('pointermove', (e) => {
			if (!this.dragging) return;
			const dx = e.clientX - this.lastPtr.x, dy = e.clientY - this.lastPtr.y; this.lastPtr = { x: e.clientX, y: e.clientY };
			this.camYaw -= dx * 0.005; this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.0035, 0.05, 0.95); this.manualUntil = performance.now() + 7000;
		});
		canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.camZoom = THREE.MathUtils.clamp(this.camZoom * (1 + Math.sign(e.deltaY) * 0.08), 0.45, 2.0); }, { passive: false });
		addEventListener('keydown', (e) => { const k = e.key.toLowerCase(); if ('wasd'.includes(k)) this.keys.add(k); });
		addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
	}

	// ---------- public API ----------

	setSupply(_s: number) {}
	setMomentum(m: number) { this.momentum = m; }
	setTrackWallet(w: string | null) { this.trackWallet = w ? w.trim() : null; for (const u of this.units) u.tracked = !!this.trackWallet && u.wallet === this.trackWallet; }
	setFocus(f: boolean) { this.focus = f; }
	resetCamera() { this.manualUntil = 0; this.camPitch = 0.42; this.camZoom = 1; }

	spawnGarrison(bulls: number, bears: number) {
		this.lastGarrison = { bulls, bears };
		for (let i = 0; i < bulls; i++) this.addUnit('bull', pickClass('SOLDIER', Math.random()), GARRISON, '', false, true);
		for (let i = 0; i < bears; i++) this.addUnit('bear', pickClass('SOLDIER', Math.random()), GARRISON, '', false, true);
	}

	spawn(input: SpawnInput) {
		if (this.phase === 'victory') return;
		const team: Team = input.kind === 'buy' || input.kind === 'bull' ? 'bull' : 'bear';
		const tier = tierForPct(input.pct);
		const god = tier.name === 'GOD';
		const legend = god || tier.name === 'TITAN';
		const cls = pickClass(tier.name, hash01(input.wallet + input.usd));
		this.addUnit(team, cls, tier, input.wallet, legend, false);
		if (input.wallet) {
			const c = this.commanders.get(input.wallet) || { kills: 0, tier: tier.name, team, usd: 0 };
			c.team = team; c.usd = Math.max(c.usd, input.usd); if (rankIdx(tier.name) > rankIdx(c.tier)) c.tier = tier.name;
			this.commanders.set(input.wallet, c);
			if (input.usd > this.biggestWhaleUsd) { this.biggestWhaleUsd = input.usd; this.biggestWhaleWallet = input.wallet; }
		}
		if (legend) { this.shake = Math.min(1.6, this.shake + (god ? 1.4 : 0.7)); if (god) this.slowmo = 1.1; }
		this.onEvent?.({ type: legend ? 'legend' : 'spawn', team, tier: tier.name, cls, wallet: input.wallet, usd: input.usd, pct: input.pct, god });
	}

	private addUnit(team: Team, cls: Cls, tier: Tier, wallet: string, legend: boolean, atFront: boolean) {
		const army = this.armies[`${team}:${cls}`]; if (!army || !army.free.length) return;
		const idx = army.free.pop()!;
		const sign = team === 'bull' ? -1 : 1;
		const st = CLASS_STATS[cls];
		this.units.push({
			team, sign, cls, ranged: st.ranged, tier: tier.name,
			scale: tier.scale * st.scaleMul, hp: tier.hp * st.hpMul, maxHp: tier.hp * st.hpMul, dmg: tier.dmg * st.dmgMul,
			standoff: st.standoff, speed: SPEED * st.speedMul,
			wallet,
			x: atFront ? sign * (3 + Math.random() * 13) : sign * (CAP - 2 - Math.random() * 4),
			z: (Math.random() - 0.5) * ARENA_Z * 2,
			rank: atFront ? Math.random() * 3 : Math.random() * 6,
			bob: Math.random() * Math.PI * 2, cd: Math.random() * 1.5, kills: 0, idx, dying: 0,
			tracked: !!this.trackWallet && wallet === this.trackWallet, legend, melee: false
		});
	}

	start() { this.last = performance.now(); this.loop(); }
	dispose() { cancelAnimationFrame(this.raf); removeEventListener('resize', this._resize); this.composer.dispose(); this.renderer.dispose(); }
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
		const ep = this.emberPos, ev = this.emberVel;
		for (let i = 0; i < this.EMBER_N; i++) { ep[i * 3] += ev[i * 3] * dt; ep[i * 3 + 1] += ev[i * 3 + 1] * dt; ep[i * 3 + 2] += ev[i * 3 + 2] * dt; if (ep[i * 3 + 1] > 15) this.resetEmber(i); }
		(this.embers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
	}

	// ---------- projectiles ----------

	private fireArrow(u: Unit) {
		const p = this.proj[this.projHead]; this.projHead = (this.projHead + 1) % this.PROJ;
		const sx = u.x, sy = hillY(u.x) + 1.4 * u.scale * UNIT_SCALE, sz = u.z;
		const tx = this.frontX - u.sign * (0.5 + Math.random() * 4), tz = u.z + (Math.random() - 0.5) * 12, ty = hillY(tx) + 1;
		const T = 0.72, g = 18;
		p.active = true; p.x = sx; p.y = sy; p.z = sz; p.dmg = u.dmg; p.team = u.team; p.life = T + 0.2;
		p.vx = (tx - sx) / T; p.vz = (tz - sz) / T; p.vy = (ty - sy + 0.5 * g * T * T) / T;
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
				// damage nearest enemy near landing
				let best: Unit | null = null, bd = 9;
				for (const e of this.units) { if (e.team === p.team || e.dying > 0) continue; const dx = e.x - p.x, dz = e.z - p.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = e; } }
				if (best) { best.hp -= p.dmg; if (best.hp <= 0) this.kill(best, []); }
				this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); this.arrowMesh.setMatrixAt(i, this.dummy.matrix); dirty = true;
				continue;
			}
			this.vTmp.set(p.vx, p.vy, p.vz).normalize();
			this.q.setFromUnitVectors(this.up, this.vTmp);
			this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.q); this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
			this.arrowMesh.setMatrixAt(i, this.dummy.matrix);
			this.arrowMesh.setColorAt(i, this.tmpColor.copy(p.team === 'bull' ? GOLD : CRIMSON).multiplyScalar(1.4));
			dirty = true;
		}
		if (dirty) { this.arrowMesh.instanceMatrix.needsUpdate = true; if (this.arrowMesh.instanceColor) this.arrowMesh.instanceColor.needsUpdate = true; }
	}

	// ---------- loop ----------

	private loop = () => {
		this.raf = requestAnimationFrame(this.loop);
		const now = performance.now();
		const rawDt = Math.min((now - this.last) / 1000, 0.25); this.last = now;
		const dt = Math.min(rawDt, 0.05); this.time += rawDt;
		this.fpsAvg = this.fpsAvg * 0.92 + (1 / Math.max(rawDt, 0.001)) * 0.08;
		this.slowmo = Math.max(0, this.slowmo - rawDt);
		this.timeScale += ((this.slowmo > 0 ? 0.32 : 1) - this.timeScale) * Math.min(1, rawDt * 6);
		const simDt = dt * this.timeScale;

		this.step(simDt);
		this.updateArrows(simDt);
		this.updateParticles(simDt);
		this.render(dt);

		this.statTick += dt; if (this.statTick > 0.2) { this.statTick = 0; this.emitStats(); }
		this.emitOverlay();
	};

	private emptyComp(): Comp { return { spear: 0, ronin: 0, archer: 0, colossus: 0 }; }
	private _bullPower = 0; private _bearPower = 0; private _bullCount = 0; private _bearCount = 0;
	private _bullComp = this.emptyComp(); private _bearComp = this.emptyComp();

	private step(dt: number) {
		let bullPower = 0, bearPower = 0, bullCount = 0, bearCount = 0;
		const bc = this.emptyComp(), rc = this.emptyComp();
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.team === 'bull') { bullCount++; bc[u.cls]++; if (!u.ranged) bullPower += u.dmg; }
			else { bearCount++; rc[u.cls]++; if (!u.ranged) bearPower += u.dmg; }
		}

		const tot = bullPower + bearPower;
		const delta = tot > 0 ? (bullPower - bearPower) / tot : 0;
		// front target = live order-flow power (fast) biased by market-cap momentum (the hill tilts with 24h)
		const bias = THREE.MathUtils.clamp(this.momentum / 25, -1, 1) * FRONT_MAX * 0.35;
		const target = THREE.MathUtils.clamp(delta * FRONT_MAX * 0.72 + bias, -FRONT_MAX, FRONT_MAX);
		this.frontX += (target - this.frontX) * Math.min(1, dt * 0.6);

		const meleeBulls: Unit[] = [], meleeBears: Unit[] = [];
		const enemyExists = { bull: bearCount > 0, bear: bullCount > 0 };
		for (const u of this.units) {
			if (u.dying > 0) { u.dying -= dt; continue; }
			u.rank = Math.max(0, u.rank - dt * 1.5); u.bob += dt * 9;
			const tx = this.frontX + u.sign * (u.standoff + u.rank * 0.9);
			u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), u.speed * dt);
			if (u.ranged) {
				u.melee = false;
				u.cd -= dt;
				if (u.cd <= 0 && enemyExists[u.team]) { this.fireArrow(u); u.cd = 1.1 + Math.random() * 0.9; }
			} else {
				const distToFront = u.team === 'bull' ? this.frontX - u.x : u.x - this.frontX;
				u.melee = distToFront < MELEE;
				if (u.melee) (u.team === 'bull' ? meleeBulls : meleeBears).push(u);
			}
		}

		if (meleeBulls.length && meleeBears.length) {
			let bd = 0, rd = 0; for (const u of meleeBulls) bd += u.dmg; for (const u of meleeBears) rd += u.dmg;
			const K = 0.9; const toBears = (bd * dt * K) / meleeBears.length, toBulls = (rd * dt * K) / meleeBulls.length;
			for (const u of meleeBears) { u.hp -= toBears; if (u.hp <= 0) this.kill(u, meleeBulls); }
			for (const u of meleeBulls) { u.hp -= toBulls; if (u.hp <= 0) this.kill(u, meleeBears); }
			if (Math.random() < 0.9) this.spawnBurst(this.frontX + (Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, (Math.random() - 0.5) * ARENA_Z * 2, Math.random() < 0.5 ? GOLD : CRIMSON, 3);
		}

		this.updateInstances(false);

		this.frontLine.position.x = this.frontX; this.frontLine.position.y = hillY(this.frontX) + 0.12;
		(this.frontLine.material as THREE.MeshBasicMaterial).opacity = 0.18 + Math.sin(this.time * 5) * 0.06;
		const threat = THREE.MathUtils.clamp((this.frontX + FRONT_MAX) / (FRONT_MAX * 2), 0, 1);
		(this.capitalBull.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.18 + (1 - threat) * 0.5;
		(this.capitalBear.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.18 + threat * 0.5;

		this._bullPower = bullPower; this._bearPower = bearPower; this._bullCount = bullCount; this._bearCount = bearCount; this._bullComp = bc; this._bearComp = rc;
	}

	private triggerVictory(winner: Team) {
		this.phase = 'victory'; this.winner = winner; this.victoryEnd = performance.now() + 6000; this.shake = 1.6;
		if (winner === 'bull') this.winBull++; else this.winBear++;
		const loser = winner === 'bull' ? this.capitalBear : this.capitalBull;
		this.spawnBurst(loser.position.x, 10, 0, winner === 'bull' ? CRIMSON : GOLD, 120);
		this.onRound?.({ round: this.round, winner, winBull: this.winBull, winBear: this.winBear });
	}

	private stepVictory(dt: number) {
		const remain = this.victoryEnd - performance.now(); const k = THREE.MathUtils.clamp(remain / 6000, 0, 1);
		for (const u of this.units) { if (u.dying > 0) { u.dying -= dt; continue; } u.bob += dt * 4; }
		this.updateInstances(true);
		const loser = this.winner === 'bull' ? this.capitalBear : this.capitalBull;
		const win = this.winner === 'bull' ? this.capitalBull : this.capitalBear;
		loser.scale.setScalar(Math.max(0.02, k)); loser.position.y = 10 * k;
		(loser.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2 + (1 - k) * 1.5;
		(win.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6 + Math.sin(this.time * 8) * 0.3;
		if (Math.random() < 0.5) this.spawnBurst(loser.position.x + (Math.random() - 0.5) * 12, Math.random() * 14 * k + 1, (Math.random() - 0.5) * 12, this.winner === 'bull' ? CRIMSON : GOLD, 3);
		if (remain <= 0) this.resetRound();
	}

	private resetRound() {
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (const u of this.units) this.armies[`${u.team}:${u.cls}`].mesh.setMatrixAt(u.idx, this.dummy.matrix);
		for (const key in this.armies) { const a = this.armies[key]; a.mesh.instanceMatrix.needsUpdate = true; a.free = []; for (let i = 0; i < MAX; i++) a.free.push(MAX - 1 - i); }
		this.units = []; this.frontX = 0; this.winHold = 0; this.winSide = null; this.winner = null; this.phase = 'battle'; this.round++;
		this.capitalBull.scale.setScalar(1); this.capitalBull.position.y = 10; this.capitalBear.scale.setScalar(1); this.capitalBear.position.y = 10;
		this.spawnGarrison(this.lastGarrison.bulls, this.lastGarrison.bears);
	}

	private kill(u: Unit, killers: Unit[]) {
		u.dying = 0.6;
		this.spawnBurst(u.x, 1.2, u.z, u.team === 'bull' ? GOLD : CRIMSON, u.legend ? 40 : 9);
		this.spawnSoul(u.x, 1.6, u.z, u.team === 'bull' ? GOLD : CRIMSON);
		if (u.team === 'bull') this.casualtiesBull++; else this.casualtiesBear++;
		this.totalKills++;
		if (killers.length) { const killer = killers[(Math.random() * killers.length) | 0]; killer.kills++; if (killer.wallet) { const c = this.commanders.get(killer.wallet); if (c) c.kills++; } }
		this.onEvent?.({ type: 'kill', team: u.team, tier: u.tier, cls: u.cls, wallet: u.wallet, usd: 0, pct: 0 });
	}

	private updateInstances(idle: boolean) {
		const dirty = new Set<THREE.InstancedMesh>();
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i];
			if (u.dying <= 0 && u.hp <= 0) continue;
			const mesh = this.armies[`${u.team}:${u.cls}`].mesh;
			const d = this.dummy, faceY = u.sign < 0 ? 0 : Math.PI, s = u.scale * UNIT_SCALE, gy = hillY(u.x);
			if (u.dying > 0) {
				const t = u.dying / 0.6; d.position.set(u.x, gy - (1 - t) * 1.2, u.z); d.scale.setScalar(s * t); d.rotation.set((1 - t) * 1.5, faceY, (1 - t) * 0.6);
			} else if (idle) {
				d.position.set(u.x, gy + Math.abs(Math.sin(u.bob)) * 0.06 * u.scale, u.z); d.scale.setScalar(s); d.rotation.set(0, faceY, 0);
			} else if (u.ranged) {
				const draw = u.cd < 0.35 ? Math.sin(this.time * 20) * 0.06 : 0; // twitch as it looses
				d.position.set(u.x, gy + Math.abs(Math.sin(u.bob * 0.6)) * 0.05 * u.scale, u.z); d.scale.setScalar(s); d.rotation.set(0, faceY, draw);
			} else if (u.melee) {
				const dir = u.team === 'bull' ? 1 : -1, amp = u.cls === 'ronin' ? 0.85 : u.cls === 'colossus' ? 0.6 : 0.5;
				const lunge = Math.max(0, Math.sin(this.time * (u.cls === 'ronin' ? 14 : 11) + u.bob));
				d.position.set(u.x + dir * lunge * amp, gy + Math.abs(Math.sin(u.bob * 2)) * 0.06 * u.scale, u.z); d.scale.setScalar(s); d.rotation.set(dir * lunge * 0.32, faceY, 0);
			} else {
				const gait = Math.sin(u.bob); d.position.set(u.x, gy + Math.abs(gait) * 0.18 * u.scale, u.z); d.scale.setScalar(s); d.rotation.set(gait * 0.12, faceY, Math.sin(u.bob * 0.5) * 0.05);
			}
			d.updateMatrix(); mesh.setMatrixAt(u.idx, d.matrix); dirty.add(mesh);
			if (u.tracked) { mesh.setColorAt(u.idx, this.tmpColor.set(0xffffff)); }
		}
		// recycle dead
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i]; if (u.dying > 0 || u.hp > 0) continue;
			const army = this.armies[`${u.team}:${u.cls}`];
			this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); army.mesh.setMatrixAt(u.idx, this.dummy.matrix); dirty.add(army.mesh); army.free.push(u.idx); this.units.splice(i, 1);
		}
		for (const m of dirty) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
	}

	private render(dt: number) {
		// WASD pan (RTS-style), relative to camera yaw
		if (this.keys.size) {
			const spd = 46 * dt * this.camZoom, sy = Math.sin(this.camYaw), cy = Math.cos(this.camYaw);
			if (this.keys.has('w')) { this.panX -= sy * spd; this.panZ -= cy * spd; }
			if (this.keys.has('s')) { this.panX += sy * spd; this.panZ += cy * spd; }
			if (this.keys.has('a')) { this.panX -= cy * spd; this.panZ += sy * spd; }
			if (this.keys.has('d')) { this.panX += cy * spd; this.panZ -= sy * spd; }
			this.panX = THREE.MathUtils.clamp(this.panX, -46, 46); this.panZ = THREE.MathUtils.clamp(this.panZ, -34, 34);
		}

		let target = new THREE.Vector3(this.panX, 3, this.panZ);
		let radius = 54 * this.camZoom;
		let height = THREE.MathUtils.lerp(24, 100, this.camPitch) * (0.55 + this.camZoom * 0.45);

		if (this.phase === 'victory') {
			const loser = this.winner === 'bull' ? this.capitalBear : this.capitalBull;
			target.set(loser.position.x * 0.55, 6, 0); radius = 48 * this.camZoom; height = 40 * this.camZoom; this.camYaw += dt * 0.1;
		} else if (this.focus) {
			const tracked = this.units.find((u) => u.tracked && u.dying <= 0);
			if (tracked) { target.set(tracked.x, 3, tracked.z); radius = 26 * this.camZoom; height = 22 * this.camZoom; }
		}

		const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 2 : 0, shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
		this.shake = Math.max(0, this.shake - dt * 1.4);
		this.camera.position.lerp(new THREE.Vector3(target.x + Math.sin(this.camYaw) * radius + shakeX, height + shakeY, target.z + Math.cos(this.camYaw) * radius), Math.min(1, dt * 2.6));
		this.camera.lookAt(target);
		this.updateAuras(dt);
		this.composer.render(dt);
	}

	private updateAuras(dt: number) {
		let ai = 0;
		for (const u of this.units) {
			if (ai >= this.auras.length) break;
			if ((u.tracked || u.legend) && u.dying <= 0) {
				const g = this.auras[ai++]; g.visible = true; g.position.set(u.x, hillY(u.x) + 0.02, u.z);
				const col = u.tracked ? 0xffffff : u.team === 'bull' ? 0x5effa0 : 0xff7a86; const s = u.scale * UNIT_SCALE;
				g.scale.setScalar(THREE.MathUtils.clamp(s, 0.8, 3.4));
				const r1 = g.getObjectByName('r1'), r2 = g.getObjectByName('r2'), crown = g.getObjectByName('crown');
				if (r1) { r1.rotation.z += dt * 0.6; (((r1 as THREE.Mesh).material) as THREE.MeshBasicMaterial).color.setHex(col); }
				if (r2) { r2.rotation.z -= dt * 0.4; (((r2 as THREE.Mesh).material) as THREE.MeshBasicMaterial).color.setHex(col); }
				if (crown) { crown.position.y = s * 2.6 + Math.sin(this.time * 2 + u.bob) * 0.12; crown.rotation.y += dt * 1.6; ((crown as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.setHex(col); }
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
			round: this.round, winBull: this.winBull, winBear: this.winBear, phase: this.phase, winner: this.winner,
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
			if (u.tracked) { const p = project(u.x, u.scale * 2.1, u.z); tracked.push({ x: p.x, y: p.y, on: p.on, tier: u.tier, team: u.team, hp: Math.max(0, u.hp), maxHp: u.maxHp, kills: u.kills, wallet: u.wallet }); }
			else if (u.legend) { const p = project(u.x, u.scale * 2.1, u.z); titans.push({ x: p.x, y: p.y, on: p.on, label: u.tier, team: u.team }); }
		}
		this.onOverlay({ tracked, titans });
	}
}

function rankIdx(t: string): number { return ['GARRISON', 'SOLDIER', 'ELITE', 'CHAMPION', 'TITAN', 'GOD'].indexOf(t); }
