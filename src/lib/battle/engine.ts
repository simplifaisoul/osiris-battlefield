import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeCinematicPass } from './cinematic';
import { tierForPct, GARRISON, type Tier } from './tiers';

export type Team = 'bull' | 'bear';
export type SpawnInput = { wallet: string; kind: Team | 'buy' | 'sell'; usd: number; pct: number };

export type BattleEvent = {
	type: 'spawn' | 'kill' | 'legend';
	team: Team;
	tier: string;
	wallet: string;
	usd: number;
	pct: number;
	god?: boolean;
};

export type Commander = { wallet: string; kills: number; tier: string; team: Team };

export type Stats = {
	bulls: number;
	bears: number;
	bullPower: number;
	bearPower: number;
	frontPct: number;
	casualtiesBull: number;
	casualtiesBear: number;
	fps: number;
	round: number;
	winBull: number;
	winBear: number;
	phase: 'battle' | 'victory';
	winner: Team | null;
	totalKills: number;
	biggestWhaleUsd: number;
	biggestWhaleWallet: string;
	commanders: Commander[];
};

export type RoundResult = { round: number; winner: Team; winBull: number; winBear: number };

export type Overlay = {
	tracked: {
		x: number; y: number; on: boolean; tier: string; team: Team;
		hp: number; maxHp: number; kills: number; wallet: string;
	}[];
	titans: { x: number; y: number; on: boolean; label: string; team: Team }[];
};

type Unit = {
	team: Team;
	sign: number;
	tier: string;
	scale: number;
	hp: number;
	maxHp: number;
	dmg: number;
	wallet: string;
	x: number; z: number;
	rank: number;
	bob: number;
	kills: number;
	idx: number;
	dying: number;
	tracked: boolean;
	legend: boolean;
	melee: boolean;
};

const MAX = 900;
const FRONT_MAX = 27;
const CAP = FRONT_MAX + 16;
const ARENA_Z = 26;
const MELEE = 4.2;
const SPEED = 11;
const UNIT_SCALE = 1.3;
const WIN_THRESH = FRONT_MAX * 0.84;

const GOLD = new THREE.Color('#E8B84B');
const CRIMSON = new THREE.Color('#FF3B4E');

function buildWarrior(): THREE.BufferGeometry {
	const parts: THREE.BufferGeometry[] = [];
	// legs (tapered)
	const leg = new THREE.CylinderGeometry(0.1, 0.07, 0.72, 5);
	const l1 = leg.clone(); l1.translate(-0.13, 0.36, 0);
	const l2 = leg.clone(); l2.translate(0.13, 0.36, 0);
	// torso + a shoulder taper for a soldier silhouette
	const torso = new THREE.BoxGeometry(0.5, 0.7, 0.28); torso.translate(0, 1.05, 0);
	const shoulders = new THREE.BoxGeometry(0.62, 0.16, 0.34); shoulders.translate(0, 1.36, 0);
	const head = new THREE.SphereGeometry(0.18, 8, 6); head.translate(0, 1.58, 0);
	// plumed helm
	const helm = new THREE.ConeGeometry(0.2, 0.3, 6); helm.translate(0, 1.78, 0);
	const plume = new THREE.BoxGeometry(0.05, 0.26, 0.18); plume.translate(0, 1.98, -0.05);
	// flowing cape
	const cape = new THREE.PlaneGeometry(0.5, 0.9); cape.rotateY(Math.PI / 2); cape.rotateX(0.16); cape.translate(-0.17, 0.95, 0);
	// spear + blade tip
	const spear = new THREE.CylinderGeometry(0.028, 0.028, 2.0, 5); spear.rotateZ(0.14); spear.translate(0.36, 1.2, 0.08);
	const tip = new THREE.ConeGeometry(0.06, 0.24, 6); tip.rotateZ(0.14); tip.translate(0.52, 2.14, 0.08);
	// round shield
	const shield = new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12); shield.rotateZ(Math.PI / 2); shield.translate(-0.32, 1.02, 0);
	parts.push(l1, l2, torso, shoulders, head, helm, plume, cape, spear, tip, shield);
	const merged = mergeGeometries(parts, false)!;
	merged.computeVertexNormals();
	return merged;
}

function groundTexture(): THREE.Texture {
	const c = document.createElement('canvas');
	c.width = c.height = 512;
	const x = c.getContext('2d')!;
	x.fillStyle = '#3a2f22';
	x.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 26000; i++) {
		const v = 20 + Math.random() * 60;
		x.fillStyle = `rgba(${v + 40},${v + 26},${v},${Math.random() * 0.5})`;
		x.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
	}
	const g = x.createRadialGradient(256, 256, 20, 256, 256, 240);
	g.addColorStop(0, 'rgba(10,6,4,0.75)');
	g.addColorStop(1, 'rgba(10,6,4,0)');
	x.fillStyle = g; x.fillRect(0, 0, 512, 512);
	const t = new THREE.CanvasTexture(c);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.repeat.set(6, 3);
	t.anisotropy = 4;
	return t;
}

function skyTexture(): THREE.Texture {
	const c = document.createElement('canvas');
	c.width = 4; c.height = 256;
	const x = c.getContext('2d')!;
	const g = x.createLinearGradient(0, 0, 0, 256);
	g.addColorStop(0, '#0a0910');
	g.addColorStop(0.5, '#1a1020');
	g.addColorStop(0.78, '#3a1c1c');
	g.addColorStop(1, '#6b3a1e');
	x.fillStyle = g; x.fillRect(0, 0, 4, 256);
	return new THREE.CanvasTexture(c);
}

function radialTexture(hex: string): THREE.Texture {
	const c = document.createElement('canvas');
	c.width = c.height = 128;
	const x = c.getContext('2d')!;
	const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
	g.addColorStop(0, hex);
	g.addColorStop(1, 'rgba(0,0,0,0)');
	x.fillStyle = g; x.fillRect(0, 0, 128, 128);
	return new THREE.CanvasTexture(c);
}

export class Battle {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private composer: EffectComposer;
	private cine: ShaderPass;
	private bull: THREE.InstancedMesh;
	private bear: THREE.InstancedMesh;
	private units: Unit[] = [];
	private freeBull: number[] = [];
	private freeBear: number[] = [];
	private frontX = 0;
	private raf = 0;
	private last = 0;
	private time = 0;
	private focus = false;
	private trackWallet: string | null = null;
	private shake = 0;
	private statTick = 0;
	private fpsAvg = 60;

	// slow-mo + flash
	private timeScale = 1;
	private slowmo = 0;
	private flash = 0;

	// round system
	private phase: 'battle' | 'victory' = 'battle';
	private winner: Team | null = null;
	private round = 1;
	private winBull = 0;
	private winBear = 0;
	private winHold = 0;
	private winSide: Team | null = null;
	private victoryEnd = 0;
	private lastGarrison = { bulls: 60, bears: 60 };
	private capBaseScale = 1;

	// session
	private commanders = new Map<string, { kills: number; tier: string; team: Team; usd: number }>();
	private totalKills = 0;
	private biggestWhaleUsd = 0;
	private biggestWhaleWallet = '';

	// camera control
	private camYaw = 0;
	private camPitch = 0.42;
	private camZoom = 1;
	private manualUntil = 0;
	private dragging = false;
	private lastPtr = { x: 0, y: 0 };

	// particle systems
	private sparks!: THREE.Points; private sparkPos!: Float32Array; private sparkVel!: Float32Array; private sparkLife!: Float32Array; private sparkColor!: Float32Array; private sparkHead = 0;
	private SPARK_N = 1500;
	private souls!: THREE.Points; private soulPos!: Float32Array; private soulVel!: Float32Array; private soulLife!: Float32Array; private soulMax!: Float32Array; private soulColor!: Float32Array; private soulHead = 0;
	private SOUL_N = 400;
	private embers!: THREE.Points; private emberPos!: Float32Array; private emberVel!: Float32Array;
	private EMBER_N = 220;

	private auras: THREE.Group[] = [];
	private capitalBull: THREE.Mesh;
	private capitalBear: THREE.Mesh;
	private frontLine: THREE.Mesh;

	private dummy = new THREE.Object3D();
	private tmpColor = new THREE.Color();

	casualtiesBull = 0;
	casualtiesBear = 0;

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
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 0.95;

		this.scene.background = skyTexture();
		this.scene.fog = new THREE.FogExp2(0x160f18, 0.0105);

		this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 600);
		this.camera.position.set(0, 34, 66);
		this.camera.lookAt(0, 4, 0);

		this.buildSky();
		this.buildLights();
		this.buildGround();
		this.capitalBull = this.buildCapital(GOLD, -CAP);
		this.capitalBear = this.buildCapital(CRIMSON, CAP);
		this.frontLine = this.buildFrontLine();

		const geo = buildWarrior();
		this.bull = this.buildArmy(geo, GOLD, 0x6b5010);
		this.bear = this.buildArmy(geo.clone(), CRIMSON, 0x5a0f16);
		this.scene.add(this.bull, this.bear);
		for (let i = 0; i < MAX; i++) { this.freeBull.push(MAX - 1 - i); this.freeBear.push(MAX - 1 - i); }

		this.buildDust();
		this.buildSparks();
		this.buildSouls();
		this.buildEmbers();
		this.buildAuras();

		this.composer = new EffectComposer(this.renderer);
		this.composer.addPass(new RenderPass(this.scene, this.camera));
		this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.7, 0.5));
		this.cine = makeCinematicPass();
		this.composer.addPass(this.cine);
		this.composer.addPass(new OutputPass());

		this._resize = this.resize.bind(this);
		addEventListener('resize', this._resize);
		this.bindCamera(canvas);
	}
	private _resize: () => void;

	// ---------- scene build ----------

	private buildSky() {
		// stars
		const N = 1400;
		const pos = new Float32Array(N * 3);
		for (let i = 0; i < N; i++) {
			const r = 260 + Math.random() * 60;
			const th = Math.random() * Math.PI * 2;
			const ph = Math.random() * Math.PI * 0.5;
			pos[i * 3] = Math.cos(th) * Math.sin(ph) * r;
			pos[i * 3 + 1] = Math.cos(ph) * r + 20;
			pos[i * 3 + 2] = Math.sin(th) * Math.sin(ph) * r;
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff4d6, size: 1.1, sizeAttenuation: false, transparent: true, opacity: 0.9 })));
		// moon
		const moon = new THREE.Mesh(new THREE.SphereGeometry(16, 32, 32), new THREE.MeshBasicMaterial({ color: 0xf2e2b0 }));
		moon.position.set(60, 120, -220);
		this.scene.add(moon);
		const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('rgba(255,240,200,0.5)'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
		halo.scale.set(120, 120, 1);
		halo.position.copy(moon.position);
		this.scene.add(halo);
	}

	private buildLights() {
		this.scene.add(new THREE.HemisphereLight(0xffe7c2, 0x2a1608, 0.5));
		const sun = new THREE.DirectionalLight(0xffd9a0, 2.1);
		sun.position.set(-30, 50, 20);
		sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		const s = 70;
		sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
		sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
		sun.shadow.camera.far = 160; sun.shadow.bias = -0.0004;
		this.scene.add(sun);
		const gl = new THREE.PointLight(GOLD, 1.6, 130, 1.6); gl.position.set(-CAP, 16, 0); this.scene.add(gl);
		const rl = new THREE.PointLight(CRIMSON, 1.6, 130, 1.6); rl.position.set(CAP, 16, 0); this.scene.add(rl);
	}

	private buildGround() {
		const mat = new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.96, metalness: 0 });
		const g = new THREE.Mesh(new THREE.PlaneGeometry(320, 170), mat);
		g.rotation.x = -Math.PI / 2;
		g.receiveShadow = true;
		this.scene.add(g);
	}

	private buildCapital(color: THREE.Color, x: number): THREE.Mesh {
		const m = new THREE.Mesh(
			new THREE.ConeGeometry(11, 20, 4),
			new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.32), emissive: color, emissiveIntensity: 0.18, metalness: 0.5, roughness: 0.42, flatShading: true })
		);
		m.position.set(x, 10, 0);
		m.rotation.y = Math.PI / 4;
		m.castShadow = true;
		// a thin glowing capstone so it reads without the whole pyramid glowing
		const cap = new THREE.Mesh(new THREE.ConeGeometry(2.2, 3.4, 4), new THREE.MeshBasicMaterial({ color }));
		cap.position.set(0, 11, 0); cap.rotation.y = Math.PI / 4;
		m.add(cap);
		this.scene.add(m);
		return m;
	}

	private buildFrontLine(): THREE.Mesh {
		const m = new THREE.Mesh(
			new THREE.PlaneGeometry(5, ARENA_Z * 2 + 10),
			new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,180,120,0.7)'), color: 0xffaa66, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false })
		);
		m.rotation.x = -Math.PI / 2;
		m.position.y = 0.06;
		this.scene.add(m);
		return m;
	}

	private buildArmy(geo: THREE.BufferGeometry, base: THREE.Color, emissive: number): THREE.InstancedMesh {
		const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive, emissiveIntensity: 0.22, metalness: 0.4, roughness: 0.5 });
		const mesh = new THREE.InstancedMesh(geo, mat, MAX);
		mesh.castShadow = true;
		mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		mesh.count = MAX;
		const col = new THREE.Color();
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (let i = 0; i < MAX; i++) {
			mesh.setMatrixAt(i, this.dummy.matrix);
			col.copy(base).multiplyScalar(0.7 + Math.random() * 0.5);
			mesh.setColorAt(i, col);
		}
		mesh.instanceMatrix.needsUpdate = true;
		return mesh;
	}

	private buildDust() {
		const N = 500;
		const pos = new Float32Array(N * 3);
		for (let i = 0; i < N; i++) {
			pos[i * 3] = (Math.random() - 0.5) * 150;
			pos[i * 3 + 1] = Math.random() * 32;
			pos[i * 3 + 2] = (Math.random() - 0.5) * 95;
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(216,176,112,0.9)'), color: 0xd8b070, size: 0.3, transparent: true, opacity: 0.16, depthWrite: false, alphaTest: 0.35 })));
	}

	private buildSparks() {
		const N = this.SPARK_N;
		this.sparkPos = new Float32Array(N * 3);
		this.sparkColor = new Float32Array(N * 3);
		this.sparkVel = new Float32Array(N * 3);
		this.sparkLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.sparkPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
		g.setAttribute('color', new THREE.BufferAttribute(this.sparkColor, 3));
		this.sparks = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.95)'), size: 0.5, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.35 }));
		this.sparks.frustumCulled = false;
		this.scene.add(this.sparks);
	}

	private buildSouls() {
		const N = this.SOUL_N;
		this.soulPos = new Float32Array(N * 3);
		this.soulColor = new Float32Array(N * 3);
		this.soulVel = new Float32Array(N * 3);
		this.soulLife = new Float32Array(N);
		this.soulMax = new Float32Array(N);
		for (let i = 0; i < N; i++) this.soulPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(this.soulPos, 3));
		g.setAttribute('color', new THREE.BufferAttribute(this.soulColor, 3));
		this.souls = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.9)'), size: 1.5, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.25 }));
		this.souls.frustumCulled = false;
		this.scene.add(this.souls);
	}

	private buildEmbers() {
		const N = this.EMBER_N;
		this.emberPos = new Float32Array(N * 3);
		this.emberVel = new Float32Array(N * 3);
		for (let i = 0; i < N; i++) this.resetEmber(i, true);
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(this.emberPos, 3));
		this.embers = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,170,80,0.95)'), color: 0xffa94b, size: 0.38, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.3 }));
		this.embers.frustumCulled = false;
		this.scene.add(this.embers);
	}
	private resetEmber(i: number, spread = false) {
		this.emberPos[i * 3] = this.frontX + (Math.random() - 0.5) * (spread ? 100 : 14);
		this.emberPos[i * 3 + 1] = Math.random() * (spread ? 12 : 0.5);
		this.emberPos[i * 3 + 2] = (Math.random() - 0.5) * ARENA_Z * 2.2;
		this.emberVel[i * 3] = (Math.random() - 0.5) * 0.5;
		this.emberVel[i * 3 + 1] = 1.1 + Math.random() * 1.8;
		this.emberVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
	}

	private buildAuras() {
		// Subtle ground runes + a floating crown — no blinding vertical beams.
		const runeGeo = new THREE.RingGeometry(1.05, 1.3, 40);
		const rune2Geo = new THREE.RingGeometry(1.55, 1.68, 40);
		const crownGeo = new THREE.OctahedronGeometry(0.2, 0);
		for (let i = 0; i < 12; i++) {
			const grp = new THREE.Group();
			const r1 = new THREE.Mesh(runeGeo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
			r1.rotation.x = -Math.PI / 2; r1.position.y = 0.08; r1.name = 'r1';
			const r2 = new THREE.Mesh(rune2Geo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
			r2.rotation.x = -Math.PI / 2; r2.position.y = 0.08; r2.name = 'r2';
			const crown = new THREE.Mesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xffcf70, emissiveIntensity: 0.7, metalness: 0.6, roughness: 0.3 }));
			crown.name = 'crown';
			grp.add(r1, r2, crown);
			grp.visible = false;
			this.scene.add(grp);
			this.auras.push(grp);
		}
	}

	// ---------- camera ----------

	private bindCamera(canvas: HTMLCanvasElement) {
		canvas.addEventListener('pointerdown', (e) => { this.dragging = true; this.lastPtr = { x: e.clientX, y: e.clientY }; this.manualUntil = performance.now() + 7000; });
		addEventListener('pointerup', () => (this.dragging = false));
		addEventListener('pointermove', (e) => {
			if (!this.dragging) return;
			const dx = e.clientX - this.lastPtr.x, dy = e.clientY - this.lastPtr.y;
			this.lastPtr = { x: e.clientX, y: e.clientY };
			this.camYaw -= dx * 0.005;
			this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.0035, 0.05, 0.95);
			this.manualUntil = performance.now() + 7000;
		});
		canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			this.camZoom = THREE.MathUtils.clamp(this.camZoom * (1 + Math.sign(e.deltaY) * 0.08), 0.5, 1.9);
			this.manualUntil = performance.now() + 7000;
		}, { passive: false });
	}

	// ---------- public API ----------

	setSupply(_s: number) {}
	setTrackWallet(w: string | null) {
		this.trackWallet = w ? w.trim() : null;
		for (const u of this.units) u.tracked = !!this.trackWallet && u.wallet === this.trackWallet;
	}
	setFocus(f: boolean) { this.focus = f; }
	resetCamera() { this.manualUntil = 0; this.camPitch = 0.42; this.camZoom = 1; }

	spawnGarrison(bulls: number, bears: number) {
		this.lastGarrison = { bulls, bears };
		for (let i = 0; i < bulls; i++) this.addUnit('bull', GARRISON, '', false, true);
		for (let i = 0; i < bears; i++) this.addUnit('bear', GARRISON, '', false, true);
	}

	spawn(input: SpawnInput) {
		if (this.phase === 'victory') return;
		const team: Team = input.kind === 'buy' || input.kind === 'bull' ? 'bull' : 'bear';
		const tier = tierForPct(input.pct);
		const god = tier.name === 'GOD';
		const legend = god || tier.name === 'TITAN';
		this.addUnit(team, tier, input.wallet, legend, false);
		if (input.wallet) {
			const c = this.commanders.get(input.wallet) || { kills: 0, tier: tier.name, team, usd: 0 };
			c.team = team; c.usd = Math.max(c.usd, input.usd);
			if (rankIdx(tier.name) > rankIdx(c.tier)) c.tier = tier.name;
			this.commanders.set(input.wallet, c);
			if (input.usd > this.biggestWhaleUsd) { this.biggestWhaleUsd = input.usd; this.biggestWhaleWallet = input.wallet; }
		}
		if (legend) {
			this.shake = Math.min(1.6, this.shake + (god ? 1.4 : 0.7));
			if (god) { this.slowmo = 1.1; this.flash = Math.min(1, this.flash + 0.7); }
		}
		this.onEvent?.({ type: legend ? 'legend' : 'spawn', team, tier: tier.name, wallet: input.wallet, usd: input.usd, pct: input.pct, god });
	}

	private addUnit(team: Team, tier: Tier, wallet: string, legend: boolean, atFront: boolean) {
		const free = team === 'bull' ? this.freeBull : this.freeBear;
		if (!free.length) return;
		const idx = free.pop()!;
		const sign = team === 'bull' ? -1 : 1;
		this.units.push({
			team, sign, tier: tier.name, scale: tier.scale, hp: tier.hp, maxHp: tier.hp, dmg: tier.dmg,
			wallet,
			x: atFront ? sign * (3 + Math.random() * 13) : sign * (CAP - 2 - Math.random() * 4),
			z: (Math.random() - 0.5) * ARENA_Z * 2,
			rank: atFront ? Math.random() * 3 : Math.random() * 6,
			bob: Math.random() * Math.PI * 2, kills: 0, idx, dying: 0,
			tracked: !!this.trackWallet && wallet === this.trackWallet, legend, melee: false
		});
	}

	start() { this.last = performance.now(); this.loop(); }

	dispose() {
		cancelAnimationFrame(this.raf);
		removeEventListener('resize', this._resize);
		this.renderer.dispose();
	}

	private resize() {
		this.camera.aspect = innerWidth / innerHeight;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(innerWidth, innerHeight);
		this.composer.setSize(innerWidth, innerHeight);
	}

	// ---------- particles ----------

	private spawnBurst(x: number, y: number, z: number, color: THREE.Color, n: number) {
		for (let k = 0; k < n; k++) {
			const i = this.sparkHead; this.sparkHead = (this.sparkHead + 1) % this.SPARK_N;
			this.sparkPos[i * 3] = x; this.sparkPos[i * 3 + 1] = y; this.sparkPos[i * 3 + 2] = z;
			this.sparkVel[i * 3] = (Math.random() - 0.5) * 9;
			this.sparkVel[i * 3 + 1] = 2 + Math.random() * 8;
			this.sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 9;
			this.sparkLife[i] = 0.5 + Math.random() * 0.5;
			this.sparkColor[i * 3] = color.r; this.sparkColor[i * 3 + 1] = color.g; this.sparkColor[i * 3 + 2] = color.b;
		}
	}

	private spawnSoul(x: number, y: number, z: number, color: THREE.Color) {
		const i = this.soulHead; this.soulHead = (this.soulHead + 1) % this.SOUL_N;
		this.soulPos[i * 3] = x; this.soulPos[i * 3 + 1] = y; this.soulPos[i * 3 + 2] = z;
		this.soulVel[i * 3] = (Math.random() - 0.5) * 0.6;
		this.soulVel[i * 3 + 1] = 2.4 + Math.random() * 1.4;
		this.soulVel[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
		this.soulMax[i] = this.soulLife[i] = 2.2 + Math.random() * 1.2;
		const c = color.clone().lerp(new THREE.Color(0xffffff), 0.5);
		this.soulColor[i * 3] = c.r; this.soulColor[i * 3 + 1] = c.g; this.soulColor[i * 3 + 2] = c.b;
	}

	private updateParticles(dt: number) {
		// sparks
		const p = this.sparkPos, v = this.sparkVel, l = this.sparkLife;
		for (let i = 0; i < this.SPARK_N; i++) {
			if (l[i] <= 0) continue;
			l[i] -= dt; v[i * 3 + 1] -= 14 * dt;
			p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
			if (l[i] <= 0) p[i * 3 + 1] = -999;
		}
		(this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
		(this.sparks.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

		// souls
		const sp = this.soulPos, sv = this.soulVel, sl = this.soulLife;
		for (let i = 0; i < this.SOUL_N; i++) {
			if (sl[i] <= 0) continue;
			sl[i] -= dt;
			sp[i * 3] += sv[i * 3] * dt + Math.sin(this.time * 2 + i) * 0.01;
			sp[i * 3 + 1] += sv[i * 3 + 1] * dt;
			sp[i * 3 + 2] += sv[i * 3 + 2] * dt;
			if (sl[i] <= 0) sp[i * 3 + 1] = -999;
		}
		(this.souls.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
		(this.souls.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

		// embers
		const ep = this.emberPos, ev = this.emberVel;
		for (let i = 0; i < this.EMBER_N; i++) {
			ep[i * 3] += ev[i * 3] * dt; ep[i * 3 + 1] += ev[i * 3 + 1] * dt; ep[i * 3 + 2] += ev[i * 3 + 2] * dt;
			if (ep[i * 3 + 1] > 15) this.resetEmber(i);
		}
		(this.embers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
	}

	// ---------- main loop ----------

	private loop = () => {
		this.raf = requestAnimationFrame(this.loop);
		const now = performance.now();
		const rawDt = Math.min((now - this.last) / 1000, 0.25); // wall-clock (for cinematic timers)
		this.last = now;
		const dt = Math.min(rawDt, 0.05); // capped (for sim stability)
		this.time += rawDt;
		this.fpsAvg = this.fpsAvg * 0.92 + (1 / Math.max(rawDt, 0.001)) * 0.08;

		// slow-mo easing (wall-clock so it lasts ~1s regardless of fps)
		this.slowmo = Math.max(0, this.slowmo - rawDt);
		const targetScale = this.slowmo > 0 ? 0.32 : 1;
		this.timeScale += (targetScale - this.timeScale) * Math.min(1, rawDt * 6);
		const simDt = dt * this.timeScale;
		this.flash = Math.max(0, this.flash - rawDt * 1.6);

		if (this.phase === 'battle') this.step(simDt);
		else this.stepVictory(rawDt);

		this.updateParticles(simDt);
		this.render(dt);

		this.statTick += dt;
		if (this.statTick > 0.2) { this.statTick = 0; this.emitStats(); }
		this.emitOverlay();
	};

	private step(dt: number) {
		let bullPower = 0, bearPower = 0, bullCount = 0, bearCount = 0;
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.team === 'bull') { bullCount++; bullPower += u.dmg; } else { bearCount++; bearPower += u.dmg; }
		}

		const tot = bullPower + bearPower;
		const delta = tot > 0 ? (bullPower - bearPower) / tot : 0;
		this.frontX += (delta * FRONT_MAX - this.frontX) * Math.min(1, dt * 0.6);

		const meleeBulls: Unit[] = [], meleeBears: Unit[] = [];
		for (const u of this.units) {
			if (u.dying > 0) { u.dying -= dt; continue; }
			u.rank = Math.max(0, u.rank - dt * 1.5);
			u.bob += dt * 9;
			const tx = this.frontX + u.sign * (0.7 + u.rank * 0.9);
			u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), SPEED * dt);
			const distToFront = u.team === 'bull' ? this.frontX - u.x : u.x - this.frontX;
			u.melee = distToFront < MELEE;
			if (u.melee) (u.team === 'bull' ? meleeBulls : meleeBears).push(u);
		}

		if (meleeBulls.length && meleeBears.length) {
			let bd = 0, rd = 0;
			for (const u of meleeBulls) bd += u.dmg;
			for (const u of meleeBears) rd += u.dmg;
			const K = 0.9;
			const toBears = (bd * dt * K) / meleeBears.length;
			const toBulls = (rd * dt * K) / meleeBulls.length;
			for (const u of meleeBears) { u.hp -= toBears; if (u.hp <= 0) this.kill(u, meleeBulls); }
			for (const u of meleeBulls) { u.hp -= toBulls; if (u.hp <= 0) this.kill(u, meleeBears); }
			if (Math.random() < 0.9) this.spawnBurst(this.frontX + (Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, (Math.random() - 0.5) * ARENA_Z * 2, Math.random() < 0.5 ? GOLD : CRIMSON, 3);
		}

		this.writeArmy(this.bull, 'bull');
		this.writeArmy(this.bear, 'bear');

		this.frontLine.position.x = this.frontX;
		(this.frontLine.material as THREE.MeshBasicMaterial).opacity = 0.18 + Math.sin(this.time * 5) * 0.06;
		const bullThreat = THREE.MathUtils.clamp((this.frontX + FRONT_MAX) / (FRONT_MAX * 2), 0, 1);
		(this.capitalBull.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.18 + (1 - bullThreat) * 0.5;
		(this.capitalBear.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.18 + bullThreat * 0.5;

		// victory detection
		if (this.frontX > WIN_THRESH) { if (this.winSide !== 'bull') { this.winSide = 'bull'; this.winHold = 0; } this.winHold += dt; }
		else if (this.frontX < -WIN_THRESH) { if (this.winSide !== 'bear') { this.winSide = 'bear'; this.winHold = 0; } this.winHold += dt; }
		else { this.winHold = Math.max(0, this.winHold - dt * 2); if (this.winHold === 0) this.winSide = null; }
		if (this.winHold > 1.8 && this.winSide) this.triggerVictory(this.winSide);

		this._bullPower = bullPower; this._bearPower = bearPower; this._bullCount = bullCount; this._bearCount = bearCount;
	}
	private _bullPower = 0; private _bearPower = 0; private _bullCount = 0; private _bearCount = 0;

	private triggerVictory(winner: Team) {
		this.phase = 'victory';
		this.winner = winner;
		this.victoryEnd = performance.now() + 6000;
		this.flash = 1;
		this.shake = 1.6;
		if (winner === 'bull') this.winBull++; else this.winBear++;
		const loser = winner === 'bull' ? this.capitalBear : this.capitalBull;
		this.spawnBurst(loser.position.x, 10, 0, winner === 'bull' ? CRIMSON : GOLD, 120);
		this.onRound?.({ round: this.round, winner, winBull: this.winBull, winBear: this.winBear });
	}

	private stepVictory(dt: number) {
		const remain = this.victoryEnd - performance.now();
		const k = THREE.MathUtils.clamp(remain / 6000, 0, 1);
		// gentle idle animation of surviving units
		for (const u of this.units) { if (u.dying > 0) { u.dying -= dt; continue; } u.bob += dt * 4; }
		this.writeArmy(this.bull, 'bull');
		this.writeArmy(this.bear, 'bear');

		// loser capital collapses, winner flares
		const loser = this.winner === 'bull' ? this.capitalBear : this.capitalBull;
		const win = this.winner === 'bull' ? this.capitalBull : this.capitalBear;
		loser.scale.setScalar(Math.max(0.02, k));
		loser.position.y = 10 * k;
		(loser.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2 + (1 - k) * 1.5;
		(win.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6 + Math.sin(this.time * 8) * 0.3;
		if (Math.random() < 0.5) this.spawnBurst(loser.position.x + (Math.random() - 0.5) * 12, Math.random() * 14 * k + 1, (Math.random() - 0.5) * 12, this.winner === 'bull' ? CRIMSON : GOLD, 3);

		if (remain <= 0) this.resetRound();
	}

	private resetRound() {
		// recycle everything
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (const u of this.units) (u.team === 'bull' ? this.bull : this.bear).setMatrixAt(u.idx, this.dummy.matrix);
		this.bull.instanceMatrix.needsUpdate = true; this.bear.instanceMatrix.needsUpdate = true;
		this.units = [];
		this.freeBull = []; this.freeBear = [];
		for (let i = 0; i < MAX; i++) { this.freeBull.push(MAX - 1 - i); this.freeBear.push(MAX - 1 - i); }
		this.frontX = 0; this.winHold = 0; this.winSide = null; this.winner = null;
		this.phase = 'battle';
		this.round++;
		this.capitalBull.scale.setScalar(1); this.capitalBull.position.y = 10;
		this.capitalBear.scale.setScalar(1); this.capitalBear.position.y = 10;
		this.spawnGarrison(this.lastGarrison.bulls, this.lastGarrison.bears);
	}

	private kill(u: Unit, killers: Unit[]) {
		u.dying = 0.6;
		this.spawnBurst(u.x, 1.2, u.z, u.team === 'bull' ? GOLD : CRIMSON, u.legend ? 40 : 9);
		this.spawnSoul(u.x, 1.6, u.z, u.team === 'bull' ? GOLD : CRIMSON);
		if (u.team === 'bull') this.casualtiesBull++; else this.casualtiesBear++;
		this.totalKills++;
		if (killers.length) {
			const killer = killers[(Math.random() * killers.length) | 0];
			killer.kills++;
			if (killer.wallet) { const c = this.commanders.get(killer.wallet); if (c) c.kills++; }
		}
		this.onEvent?.({ type: 'kill', team: u.team, tier: u.tier, wallet: u.wallet, usd: 0, pct: 0 });
	}

	private writeArmy(mesh: THREE.InstancedMesh, team: Team) {
		let colorDirty = false;
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i];
			if (u.team !== team) continue;
			if (u.dying <= 0 && u.hp <= 0) continue;
			const d = this.dummy;
			const faceY = u.sign < 0 ? 0 : Math.PI;
			const s = u.scale * UNIT_SCALE;
			if (u.dying > 0) {
				const t = u.dying / 0.6;
				d.position.set(u.x, -(1 - t) * 1.2, u.z);
				d.scale.setScalar(s * t);
				d.rotation.set((1 - t) * 1.5, faceY, (1 - t) * 0.6);
			} else if (u.melee) {
				// stabbing lunge toward the enemy line
				const dir = u.team === 'bull' ? 1 : -1;
				const lunge = Math.max(0, Math.sin(this.time * 11 + u.bob));
				d.position.set(u.x + dir * lunge * 0.5, Math.abs(Math.sin(u.bob * 2)) * 0.06 * u.scale, u.z);
				d.scale.setScalar(s);
				d.rotation.set(dir * lunge * 0.32, faceY, 0);
			} else {
				// marching gait — bob + forward lean rock
				const gait = Math.sin(u.bob);
				d.position.set(u.x, Math.abs(gait) * 0.18 * u.scale, u.z);
				d.scale.setScalar(s);
				d.rotation.set(gait * 0.12, faceY, Math.sin(u.bob * 0.5) * 0.05);
			}
			d.updateMatrix();
			mesh.setMatrixAt(u.idx, d.matrix);
			if (u.tracked) { mesh.setColorAt(u.idx, this.tmpColor.set(0xffffff)); colorDirty = true; }
		}
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i];
			if (u.dying > 0 || u.hp > 0) continue;
			this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
			(u.team === 'bull' ? this.bull : this.bear).setMatrixAt(u.idx, this.dummy.matrix);
			(u.team === 'bull' ? this.freeBull : this.freeBear).push(u.idx);
			this.units.splice(i, 1);
		}
		mesh.instanceMatrix.needsUpdate = true;
		if (colorDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
	}

	private render(dt: number) {
		// camera orbit / manual
		const manual = performance.now() < this.manualUntil;
		if (!manual && this.phase === 'battle') this.camYaw += dt * 0.06;

		let target = new THREE.Vector3(0, 4, 0);
		let radius = 66 * this.camZoom;
		let height = THREE.MathUtils.lerp(8, 84, this.camPitch) * (0.6 + this.camZoom * 0.4);

		if (this.phase === 'victory') {
			const loser = this.winner === 'bull' ? this.capitalBear : this.capitalBull;
			target.set(loser.position.x * 0.6, 6, 0);
			if (!manual) { radius = 46; height = 26; this.camYaw += dt * 0.15; }
		} else if (this.focus) {
			const tracked = this.units.find((u) => u.tracked && u.dying <= 0);
			if (tracked) { target.set(tracked.x, 3, tracked.z); if (!manual) { radius = 24; height = 14; } }
		}

		const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 2 : 0;
		const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
		this.shake = Math.max(0, this.shake - dt * 1.4);
		const goal = new THREE.Vector3(Math.sin(this.camYaw) * radius + shakeX, height + shakeY, Math.cos(this.camYaw) * radius);
		this.camera.position.lerp(goal, Math.min(1, dt * 2.4));
		this.camera.lookAt(target);

		this.updateAuras(dt);

		this.cine.uniforms.time.value = this.time;
		this.cine.uniforms.flash.value = this.flash * 0.6;
		this.composer.render();
	}

	private updateAuras(dt: number) {
		let ai = 0;
		for (const u of this.units) {
			if (ai >= this.auras.length) break;
			if ((u.tracked || u.legend) && u.dying <= 0) {
				const g = this.auras[ai++];
				g.visible = true;
				g.position.set(u.x, 0, u.z);
				const col = u.tracked ? 0xffe9b0 : u.team === 'bull' ? 0xffcf70 : 0xff7a86;
				const s = u.scale * UNIT_SCALE;
				g.scale.setScalar(THREE.MathUtils.clamp(s, 0.8, 3.4));
				const r1 = g.getObjectByName('r1'); const r2 = g.getObjectByName('r2'); const crown = g.getObjectByName('crown');
				if (r1) { r1.rotation.z += dt * 0.6; (((r1 as THREE.Mesh).material) as THREE.MeshBasicMaterial).color.setHex(col); }
				if (r2) { r2.rotation.z -= dt * 0.4; (((r2 as THREE.Mesh).material) as THREE.MeshBasicMaterial).color.setHex(col); }
				if (crown) {
					crown.position.y = s * 2.4 + Math.sin(this.time * 2 + u.bob) * 0.12;
					crown.rotation.y += dt * 1.6;
					const cm = (crown as THREE.Mesh).material as THREE.MeshStandardMaterial;
					cm.emissive.setHex(col);
				}
			}
		}
		for (; ai < this.auras.length; ai++) this.auras[ai].visible = false;
	}

	private emitStats() {
		if (!this.onStats) return;
		const commanders = [...this.commanders.entries()]
			.filter(([w]) => w)
			.map(([wallet, c]) => ({ wallet, kills: c.kills, tier: c.tier, team: c.team }))
			.sort((a, b) => b.kills - a.kills || rankIdx(b.tier) - rankIdx(a.tier))
			.slice(0, 5);
		this.onStats({
			bulls: this._bullCount, bears: this._bearCount,
			bullPower: this._bullPower, bearPower: this._bearPower,
			frontPct: THREE.MathUtils.clamp(((this.frontX + FRONT_MAX) / (FRONT_MAX * 2)) * 100, 0, 100),
			casualtiesBull: this.casualtiesBull, casualtiesBear: this.casualtiesBear,
			fps: Math.round(this.fpsAvg),
			round: this.round, winBull: this.winBull, winBear: this.winBear,
			phase: this.phase, winner: this.winner,
			totalKills: this.totalKills, biggestWhaleUsd: this.biggestWhaleUsd, biggestWhaleWallet: this.biggestWhaleWallet,
			commanders
		});
	}

	private emitOverlay() {
		if (!this.onOverlay) return;
		const v = new THREE.Vector3();
		const project = (x: number, y: number, z: number) => {
			v.set(x, y, z).project(this.camera);
			return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, on: v.z < 1 };
		};
		const tracked: Overlay['tracked'] = [];
		const titans: Overlay['titans'] = [];
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.tracked) {
				const p = project(u.x, u.scale * 2.1, u.z);
				tracked.push({ x: p.x, y: p.y, on: p.on, tier: u.tier, team: u.team, hp: Math.max(0, u.hp), maxHp: u.maxHp, kills: u.kills, wallet: u.wallet });
			} else if (u.legend) {
				const p = project(u.x, u.scale * 2.1, u.z);
				titans.push({ x: p.x, y: p.y, on: p.on, label: u.tier, team: u.team });
			}
		}
		this.onOverlay({ tracked, titans });
	}
}

function rankIdx(t: string): number {
	return ['GARRISON', 'SOLDIER', 'ELITE', 'CHAMPION', 'TITAN', 'GOD'].indexOf(t);
}
