import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
};

export type Stats = {
	bulls: number;
	bears: number;
	bullPower: number;
	bearPower: number;
	frontPct: number; // 0 = bull capital, 100 = bear capital
	casualtiesBull: number;
	casualtiesBear: number;
	fps: number;
};

export type Overlay = {
	tracked: {
		x: number; y: number; on: boolean; tier: string; team: Team;
		hp: number; maxHp: number; kills: number; wallet: string;
	}[];
	titans: { x: number; y: number; on: boolean; label: string; team: Team }[];
};

type Unit = {
	team: Team;
	sign: number; // bull -1 (left, advances +x), bear +1 (right, advances -x)
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
	idx: number; // instance index
	dying: number; // >0 when dying (seconds remaining)
	tracked: boolean;
	legend: boolean; // titan/god — gets a label
};

const MAX = 900;
const FRONT_MAX = 27;
const CAP = FRONT_MAX + 16; // capital x
const ARENA_Z = 26;
const MELEE = 4.2;
const SPEED = 11;
const UNIT_SCALE = 1.3;

const GOLD = new THREE.Color('#E8B84B');
const CRIMSON = new THREE.Color('#FF3B4E');

function buildWarrior(): THREE.BufferGeometry {
	const parts: THREE.BufferGeometry[] = [];
	const leg = new THREE.BoxGeometry(0.16, 0.72, 0.18);
	const l1 = leg.clone(); l1.translate(-0.13, 0.36, 0);
	const l2 = leg.clone(); l2.translate(0.13, 0.36, 0);
	const torso = new THREE.BoxGeometry(0.52, 0.78, 0.3); torso.translate(0, 1.08, 0);
	const head = new THREE.SphereGeometry(0.2, 8, 6); head.translate(0, 1.62, 0);
	const helm = new THREE.ConeGeometry(0.22, 0.28, 6); helm.translate(0, 1.82, 0);
	// spear on +x side
	const spear = new THREE.CylinderGeometry(0.03, 0.03, 1.9, 5); spear.rotateZ(0.18); spear.translate(0.34, 1.15, 0.08);
	const tip = new THREE.ConeGeometry(0.07, 0.22, 6); tip.rotateZ(0.18); tip.translate(0.52, 2.05, 0.08);
	// shield on -x side
	const shield = new THREE.BoxGeometry(0.06, 0.52, 0.42); shield.translate(-0.32, 1.05, 0);
	parts.push(l1, l2, torso, head, helm, spear, tip, shield);
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
	// sandy noise
	for (let i = 0; i < 26000; i++) {
		const v = 20 + Math.random() * 60;
		x.fillStyle = `rgba(${v + 40},${v + 26},${v},${Math.random() * 0.5})`;
		x.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
	}
	// central battle scar
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
	const t = new THREE.CanvasTexture(c);
	return t;
}

export class Battle {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private composer: EffectComposer;
	private bull: THREE.InstancedMesh;
	private bear: THREE.InstancedMesh;
	private units: Unit[] = [];
	private freeBull: number[] = [];
	private freeBear: number[] = [];
	private frontX = 0;
	private raf = 0;
	private last = 0;
	private orbit = 0;
	private focus = false;
	private trackWallet: string | null = null;
	private shake = 0;
	private statTick = 0;
	private fpsAvg = 60;

	// particles (sparks)
	private sparks: THREE.Points;
	private sparkPos: Float32Array;
	private sparkVel: Float32Array;
	private sparkLife: Float32Array;
	private sparkColor: Float32Array;
	private sparkHead = 0;
	private SPARK_N = 1400;

	private beams: THREE.Mesh[] = [];
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

	constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.setSize(innerWidth, innerHeight);
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.1;

		this.scene.background = skyTexture();
		this.scene.fog = new THREE.FogExp2(0x1a1018, 0.011);

		this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 400);
		this.camera.position.set(0, 34, 66);
		this.camera.lookAt(0, 4, 0);

		this.buildLights();
		this.buildGround();
		this.capitalBull = this.buildCapital(GOLD, -CAP);
		this.capitalBear = this.buildCapital(CRIMSON, CAP);
		this.frontLine = this.buildFrontLine();

		// armies
		const geo = buildWarrior();
		this.bull = this.buildArmy(geo, GOLD, 0x6b5010);
		this.bear = this.buildArmy(geo.clone(), CRIMSON, 0x5a0f16);
		this.scene.add(this.bull, this.bear);
		for (let i = 0; i < MAX; i++) { this.freeBull.push(MAX - 1 - i); this.freeBear.push(MAX - 1 - i); }

		this.buildDust();
		[this.sparks, this.sparkPos, this.sparkVel, this.sparkLife, this.sparkColor] = this.buildSparks();
		this.buildBeams();

		// post
		this.composer = new EffectComposer(this.renderer);
		this.composer.addPass(new RenderPass(this.scene, this.camera));
		const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.85, 0.55, 0.18);
		this.composer.addPass(bloom);
		this.composer.addPass(new OutputPass());

		this._resize = this.resize.bind(this);
		addEventListener('resize', this._resize);
	}
	private _resize: () => void;

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
		const gl = new THREE.PointLight(GOLD, 1.6, 120, 1.6); gl.position.set(-CAP, 16, 0); this.scene.add(gl);
		const rl = new THREE.PointLight(CRIMSON, 1.6, 120, 1.6); rl.position.set(CAP, 16, 0); this.scene.add(rl);
	}

	private buildGround() {
		const mat = new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.96, metalness: 0 });
		const g = new THREE.Mesh(new THREE.PlaneGeometry(300, 160), mat);
		g.rotation.x = -Math.PI / 2;
		g.receiveShadow = true;
		this.scene.add(g);
	}

	private buildCapital(color: THREE.Color, x: number): THREE.Mesh {
		const m = new THREE.Mesh(
			new THREE.ConeGeometry(11, 20, 4),
			new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.5), emissive: color, emissiveIntensity: 0.35, metalness: 0.4, roughness: 0.5, flatShading: true })
		);
		m.position.set(x, 10, 0);
		m.rotation.y = Math.PI / 4;
		m.castShadow = true;
		this.scene.add(m);
		return m;
	}

	private buildFrontLine(): THREE.Mesh {
		const m = new THREE.Mesh(
			new THREE.PlaneGeometry(1.6, ARENA_Z * 2 + 8),
			new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false })
		);
		m.rotation.x = -Math.PI / 2;
		m.position.y = 0.05;
		this.scene.add(m);
		return m;
	}

	private buildArmy(geo: THREE.BufferGeometry, base: THREE.Color, emissive: number): THREE.InstancedMesh {
		const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive, emissiveIntensity: 0.5, metalness: 0.35, roughness: 0.55 });
		const mesh = new THREE.InstancedMesh(geo, mat, MAX);
		mesh.castShadow = true;
		mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		mesh.count = MAX;
		const col = new THREE.Color();
		this.dummy.scale.setScalar(0);
		this.dummy.updateMatrix();
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
			pos[i * 3] = (Math.random() - 0.5) * 140;
			pos[i * 3 + 1] = Math.random() * 30;
			pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		const m = new THREE.PointsMaterial({ color: 0xd8b070, size: 0.18, transparent: true, opacity: 0.35, depthWrite: false });
		this.scene.add(new THREE.Points(g, m));
	}

	private buildSparks(): [THREE.Points, Float32Array, Float32Array, Float32Array, Float32Array] {
		const N = this.SPARK_N;
		const pos = new Float32Array(N * 3);
		const col = new Float32Array(N * 3);
		const vel = new Float32Array(N * 3);
		const life = new Float32Array(N);
		for (let i = 0; i < N; i++) pos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		g.setAttribute('color', new THREE.BufferAttribute(col, 3));
		const m = new THREE.PointsMaterial({ size: 0.4, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
		const pts = new THREE.Points(g, m);
		pts.frustumCulled = false;
		this.scene.add(pts);
		return [pts, pos, vel, life, col];
	}

	private buildBeams() {
		const geo = new THREE.CylinderGeometry(0.14, 0.14, 8, 6, 1, true);
		geo.translate(0, 4, 0);
		for (let i = 0; i < 10; i++) {
			const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
			m.visible = false;
			this.scene.add(m);
			this.beams.push(m);
		}
	}

	// ---- public API ----

	setSupply(_s: number) { /* supply used caller-side to compute pct */ }
	setTrackWallet(w: string | null) {
		this.trackWallet = w ? w.trim() : null;
		for (const u of this.units) u.tracked = !!this.trackWallet && u.wallet === this.trackWallet;
	}
	setFocus(f: boolean) { this.focus = f; }

	spawnGarrison(bulls: number, bears: number) {
		// Standing armies already massed at the front line.
		for (let i = 0; i < bulls; i++) this.addUnit('bull', GARRISON, '', false, true);
		for (let i = 0; i < bears; i++) this.addUnit('bear', GARRISON, '', false, true);
	}

	spawn(input: SpawnInput) {
		const team: Team = input.kind === 'buy' || input.kind === 'bull' ? 'bull' : 'bear';
		const tier = tierForPct(input.pct);
		const legend = tier.name === 'GOD' || tier.name === 'TITAN';
		// Real trades charge in as reinforcements from the capital.
		this.addUnit(team, tier, input.wallet, legend, false);
		if (legend) this.shake = Math.min(1.4, this.shake + (tier.name === 'GOD' ? 1.3 : 0.7));
		this.onEvent?.({ type: legend ? 'legend' : 'spawn', team, tier: tier.name, wallet: input.wallet, usd: input.usd, pct: input.pct });
	}

	private addUnit(team: Team, tier: Tier, wallet: string, legend: boolean, atFront: boolean) {
		const free = team === 'bull' ? this.freeBull : this.freeBear;
		if (!free.length) return;
		const idx = free.pop()!;
		const sign = team === 'bull' ? -1 : 1;
		const u: Unit = {
			team, sign, tier: tier.name, scale: tier.scale, hp: tier.hp, maxHp: tier.hp, dmg: tier.dmg,
			wallet,
			x: atFront ? sign * (3 + Math.random() * 13) : sign * (CAP - 2 - Math.random() * 4),
			z: (Math.random() - 0.5) * ARENA_Z * 2,
			rank: atFront ? Math.random() * 3 : Math.random() * 6,
			bob: Math.random() * Math.PI * 2, kills: 0, idx, dying: 0,
			tracked: !!this.trackWallet && wallet === this.trackWallet, legend
		};
		this.units.push(u);
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

	private spawnBurst(x: number, y: number, z: number, color: THREE.Color, n: number) {
		for (let k = 0; k < n; k++) {
			const i = this.sparkHead;
			this.sparkHead = (this.sparkHead + 1) % this.SPARK_N;
			this.sparkPos[i * 3] = x; this.sparkPos[i * 3 + 1] = y; this.sparkPos[i * 3 + 2] = z;
			this.sparkVel[i * 3] = (Math.random() - 0.5) * 9;
			this.sparkVel[i * 3 + 1] = 2 + Math.random() * 8;
			this.sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 9;
			this.sparkLife[i] = 0.5 + Math.random() * 0.5;
			this.sparkColor[i * 3] = color.r; this.sparkColor[i * 3 + 1] = color.g; this.sparkColor[i * 3 + 2] = color.b;
		}
	}

	private updateSparks(dt: number) {
		const p = this.sparkPos, v = this.sparkVel, l = this.sparkLife;
		for (let i = 0; i < this.SPARK_N; i++) {
			if (l[i] <= 0) { if (p[i * 3 + 1] > -900) { p[i * 3 + 1] = -999; } continue; }
			l[i] -= dt;
			v[i * 3 + 1] -= 14 * dt;
			p[i * 3] += v[i * 3] * dt;
			p[i * 3 + 1] += v[i * 3 + 1] * dt;
			p[i * 3 + 2] += v[i * 3 + 2] * dt;
			if (l[i] <= 0) p[i * 3 + 1] = -999;
		}
		(this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
		(this.sparks.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
	}

	private loop = () => {
		this.raf = requestAnimationFrame(this.loop);
		const now = performance.now();
		let dt = (now - this.last) / 1000;
		this.last = now;
		if (dt > 0.05) dt = 0.05;
		this.fpsAvg = this.fpsAvg * 0.92 + (1 / Math.max(dt, 0.001)) * 0.08;

		this.step(dt);
		this.render(dt);

		this.statTick += dt;
		if (this.statTick > 0.2) { this.statTick = 0; this.emitStats(); }
		this.emitOverlay();
	};

	private step(dt: number) {
		const bulls: Unit[] = [], bears: Unit[] = [];
		let bullPower = 0, bearPower = 0;
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.team === 'bull') { bulls.push(u); bullPower += u.dmg; }
			else { bears.push(u); bearPower += u.dmg; }
		}

		// front line tug of war
		const tot = bullPower + bearPower;
		const delta = tot > 0 ? (bullPower - bearPower) / tot : 0;
		const target = delta * FRONT_MAX;
		this.frontX += (target - this.frontX) * Math.min(1, dt * 0.6);

		// movement + melee gather
		const meleeBulls: Unit[] = [], meleeBears: Unit[] = [];
		for (const u of this.units) {
			if (u.dying > 0) { u.dying -= dt; continue; }
			u.rank = Math.max(0, u.rank - dt * 1.5);
			u.bob += dt * 9;
			const tx = this.frontX + u.sign * (0.7 + u.rank * 0.9);
			u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), SPEED * dt);
			const distToFront = u.team === 'bull' ? this.frontX - u.x : u.x - this.frontX;
			if (distToFront < MELEE) (u.team === 'bull' ? meleeBulls : meleeBears).push(u);
		}

		// combat resolution
		if (meleeBulls.length && meleeBears.length) {
			let bd = 0, rd = 0;
			for (const u of meleeBulls) bd += u.dmg;
			for (const u of meleeBears) rd += u.dmg;
			const K = 0.9;
			const toBears = (bd * dt * K) / meleeBears.length;
			const toBulls = (rd * dt * K) / meleeBulls.length;
			for (const u of meleeBears) { u.hp -= toBears; if (u.hp <= 0) this.kill(u, meleeBulls); }
			for (const u of meleeBulls) { u.hp -= toBulls; if (u.hp <= 0) this.kill(u, meleeBears); }
		}

		// clash sparks along the front
		if (meleeBulls.length && meleeBears.length && Math.random() < 0.9) {
			const z = (Math.random() - 0.5) * ARENA_Z * 2;
			this.spawnBurst(this.frontX + (Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, z, Math.random() < 0.5 ? GOLD : CRIMSON, 3);
		}

		this.updateSparks(dt);

		// write instance matrices
		this.writeArmy(this.bull, 'bull');
		this.writeArmy(this.bear, 'bear');

		// front line + capitals react
		this.frontLine.position.x = this.frontX;
		const bullThreat = THREE.MathUtils.clamp((this.frontX + FRONT_MAX) / (FRONT_MAX * 2), 0, 1);
		(this.capitalBull.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.35 + (1 - bullThreat) * 0.9;
		(this.capitalBear.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.35 + bullThreat * 0.9;

		this._bullPower = bullPower; this._bearPower = bearPower;
		this._bullCount = bulls.length; this._bearCount = bears.length;
	}
	private _bullPower = 0; private _bearPower = 0; private _bullCount = 0; private _bearCount = 0;

	private kill(u: Unit, killers: Unit[]) {
		u.dying = 0.6;
		this.spawnBurst(u.x, 1.2, u.z, u.team === 'bull' ? GOLD : CRIMSON, 10);
		if (u.team === 'bull') this.casualtiesBull++; else this.casualtiesBear++;
		if (killers.length) killers[(Math.random() * killers.length) | 0].kills++;
		this.onEvent?.({ type: 'kill', team: u.team, tier: u.tier, wallet: u.wallet, usd: 0, pct: 0 });
	}

	private writeArmy(mesh: THREE.InstancedMesh, team: Team) {
		let colorDirty = false;
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i];
			if (u.team !== team) continue;
			if (u.dying <= 0 && u.hp <= 0) continue;
			const d = this.dummy;
			if (u.dying > 0) {
				const t = u.dying / 0.6;
				d.position.set(u.x, -(1 - t) * 1.2, u.z);
				d.scale.setScalar(u.scale * UNIT_SCALE * t);
				d.rotation.set((1 - t) * 1.4, u.sign < 0 ? 0 : Math.PI, 0);
			} else {
				const bobY = Math.abs(Math.sin(u.bob)) * 0.12 * u.scale;
				d.position.set(u.x, bobY, u.z);
				d.scale.setScalar(u.scale * UNIT_SCALE);
				d.rotation.set(0, u.sign < 0 ? 0 : Math.PI, Math.sin(u.bob) * 0.05);
			}
			d.updateMatrix();
			mesh.setMatrixAt(u.idx, d.matrix);
			// tracked highlight color
			if (u.tracked) { mesh.setColorAt(u.idx, this.tmpColor.set(0xffffff)); colorDirty = true; }
		}
		// recycle fully-dead
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i];
			if (u.dying > 0 || u.hp > 0) continue;
			// dead & finished dying
			if (u.dying <= 0 && u.hp <= 0) {
				this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
				(u.team === 'bull' ? this.bull : this.bear).setMatrixAt(u.idx, this.dummy.matrix);
				(u.team === 'bull' ? this.freeBull : this.freeBear).push(u.idx);
				this.units.splice(i, 1);
			}
		}
		mesh.instanceMatrix.needsUpdate = true;
		if (colorDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
	}

	private render(dt: number) {
		// camera
		this.orbit += dt * 0.06;
		let camTarget = new THREE.Vector3(0, 4, 0);
		let radius = 66, height = 34;
		const tracked = this.focus ? this.units.find((u) => u.tracked && u.dying <= 0) : null;
		if (tracked) {
			camTarget.set(tracked.x, 3, tracked.z);
			radius = 26; height = 16;
		}
		const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 2 : 0;
		const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
		this.shake = Math.max(0, this.shake - dt * 1.4);
		const cx = Math.sin(this.orbit) * radius + shakeX;
		const cz = Math.cos(this.orbit) * radius;
		this.camera.position.lerp(new THREE.Vector3(cx, height + shakeY, cz), Math.min(1, dt * (tracked ? 2.2 : 1)));
		this.camera.lookAt(camTarget);

		// beacons over tracked + legends
		this.updateBeams();

		this.composer.render();
	}

	private updateBeams() {
		let bi = 0;
		for (const u of this.units) {
			if (bi >= this.beams.length) break;
			if ((u.tracked || u.legend) && u.dying <= 0) {
				const b = this.beams[bi++];
				b.visible = true;
				b.position.set(u.x, u.scale * 1.9, u.z);
				(b.material as THREE.MeshBasicMaterial).color.set(u.tracked ? 0xfff2c0 : u.team === 'bull' ? 0xffdb7a : 0xff8090);
			}
		}
		for (; bi < this.beams.length; bi++) this.beams[bi].visible = false;
	}

	private emitStats() {
		if (!this.onStats) return;
		const total = this._bullPower + this._bearPower || 1;
		this.onStats({
			bulls: this._bullCount, bears: this._bearCount,
			bullPower: this._bullPower, bearPower: this._bearPower,
			frontPct: THREE.MathUtils.clamp(((this.frontX + FRONT_MAX) / (FRONT_MAX * 2)) * 100, 0, 100),
			casualtiesBull: this.casualtiesBull, casualtiesBear: this.casualtiesBear,
			fps: Math.round(this.fpsAvg)
		});
		void total;
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
