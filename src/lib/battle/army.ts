// The two armies. Infantry is a struct-of-arrays pool rendered through
// instanced meshes (one per pose per side, repacked every frame). Soldiers hold
// slots at a depth behind the front line, march in as reinforcements, trade
// fire across the line (tracers that can actually kill), get overrun when the
// line moves past them, and are blown off their feet by explosions. Tanks and
// rocket trucks are small object lists with their own instanced meshes.

import * as THREE from 'three';
import * as M from './models';
import type { Fx } from './fx';
import { heightAt, isWater, wobble, MINX, MAXX, MINZ, MAXZ, D } from './world';

export const BULL = 0;
export const BEAR = 1;
/** Direction from the front toward that side's own base (+x for Bulls). */
export const DIR = [1, -1] as const;

export const TEAM = [new THREE.Color('#6fe38c'), new THREE.Color('#e5463f')];
const ARMOR = [new THREE.Color('#86e8a2'), new THREE.Color('#ee6f66')];
const TRUCK = [new THREE.Color('#4fae68'), new THREE.Color('#c9544c')];
const GOLD = new THREE.Color('#ffc93c'); // a tracked wallet's units
const TRACER = [
	[1.2, 2.8, 1.3],
	[3.0, 1.4, 0.7]
];

const CAP = 3200;
const FREE = 0;
const MARCH = 1;
const HOLD = 2;
const DYING = 3;
const CORPSE = 4;
const FLUNG = 5;
const STAND = 0;
const KNEEL = 1;
const RUN = 2;
const BIN = 10;
const NBINS = Math.ceil(D / BIN) + 1;
const SKULLS = 700;
const MAX_TANKS = 26;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

type Tank = {
	side: number; x: number; z: number; y: number; rot: number; tur: number;
	slotD: number; slotZ: number; wreck: boolean; fireT: number; t: number; recoil: number;
	aimX: number; aimZ: number; aiming: number; // seconds spent laying the gun, -1 = idle
	trail: number; // distance since the last tread mark
	idn: number; kills: number; bornAt: number; bornFront: number; // its commander and record
};

export type Pick = { kind: 'soldier'; i: number; gen: number } | { kind: 'tank'; tank: Tank };
export type UnitInfo = {
	kind: 'soldier' | 'tank';
	side: number;
	wallet: string | null;
	alive: boolean;
	x: number; y: number; z: number;
	kills: number;
	bornAt: number;
	bornFront: number;
};
/** Who gets the credit for a blast's kills. */
type Credit = { side: number; idn: number; tank?: Tank };
type Launcher = {
	side: number; x: number; z: number; y: number; rot: number; slotD: number; slotZ: number;
	wreck: boolean; fireT: number; t: number; salvo: number; salvoT: number;
};

export type ArmyHooks = {
	shot(x: number, z: number): void;
	cannon(x: number, z: number): void;
	track(x: number, z: number, rot: number): void;
};

export class Army {
	readonly group = new THREE.Group();
	time = 0;
	front = 0;
	volatility = 0;
	targets = { inf: [480, 480], tanks: [6, 6], launchers: [2, 2] };
	alive = [0, 0];
	casualties = [0, 0];

	// infantry pool
	private side = new Uint8Array(CAP);
	private st = new Uint8Array(CAP);
	private kneel = new Uint8Array(CAP);
	private gen = new Uint32Array(CAP);
	private x = new Float32Array(CAP);
	private z = new Float32Array(CAP);
	private y = new Float32Array(CAP);
	private rot = new Float32Array(CAP);
	private slotD = new Float32Array(CAP);
	private slotZ = new Float32Array(CAP);
	private fireT = new Float32Array(CAP);
	private aimT = new Float32Array(CAP);
	private t = new Float32Array(CAP);
	private shade = new Float32Array(CAP);
	private fall = new Float32Array(CAP);
	private vx = new Float32Array(CAP);
	private vy = new Float32Array(CAP);
	private vz = new Float32Array(CAP);
	private pose = new Uint8Array(CAP);
	private free: number[] = [];
	private poses: THREE.InstancedMesh[][] = [[], []];

	// who each unit is: an index into its side's roster of wallets (-1 = anonymous conscript)
	private idn = new Int32Array(CAP).fill(-1);
	private kills = new Uint16Array(CAP);
	private bornAt = new Float64Array(CAP); // wall-clock ms it took the field
	private bornFront = new Float64Array(CAP); // the price / market cap it took the field at
	/** The live battle value, kept current by the engine: stamped on every unit as it deploys. */
	price = 0;
	private roster: [string[], string[]] = [[], []];
	private rosterIdx: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
	private order: [number[], number[]] = [[], []]; // identities in deployment priority (biggest holders first)
	private fielded: [number[], number[]] = [[], []];
	private unitKills: [number[], number[]] = [[], []];
	private unitDeaths: [number[], number[]] = [[], []];
	/** Identity per side drawn in gold (a tracked wallet). */
	tracked: [number, number] = [-1, -1];
	private pv = new THREE.Vector3();

	// targeting bins (front-line soldiers by z)
	private binStart = [new Int32Array(NBINS + 1), new Int32Array(NBINS + 1)];
	private binList = [new Int32Array(CAP), new Int32Array(CAP)];
	private frontShooters = [0, 0];
	private pHit = [0.1, 0.1];
	private spawnAcc = [0, 0];

	// armour
	tanks: Tank[] = [];
	launchers: Launcher[] = [];
	private tankT = [0, 0];
	private launcherT = [0, 0];
	private surplusT = [0, 0];
	private hull: THREE.InstancedMesh[] = [];
	private turret: THREE.InstancedMesh[] = [];
	private truck: THREE.InstancedMesh[] = [];

	// skulls
	private skullMesh: THREE.InstancedMesh;
	private sk = { x: new Float32Array(SKULLS), z: new Float32Array(SKULLS), y: new Float32Array(SKULLS), r: new Float32Array(SKULLS), age: new Float32Array(SKULLS).fill(999), head: 0 };

	private tmpC = new THREE.Color();
	private mtx = new THREE.Matrix4();
	private scl = new THREE.Vector3();
	// the front line sampled every 2 units of z, refreshed once per frame
	private ft = new Float32Array(Math.ceil(D / 2) + 2);
	private ftKey = NaN;

	constructor(
		private fx: Fx,
		private hooks: ArmyHooks
	) {
		for (let i = CAP - 1; i >= 0; i--) this.free.push(i);

		const plastic = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0, flatShading: true });
		const geos = [M.soldierStand(), M.soldierKneel(), M.soldierRun()];
		for (const s of [BULL, BEAR]) {
			for (const g of geos) {
				const m = new THREE.InstancedMesh(g, plastic, CAP);
				m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
				m.setColorAt(0, TEAM[s]);
				m.castShadow = true;
				m.frustumCulled = false;
				m.count = 0;
				this.poses[s].push(m);
				this.group.add(m);
			}
			const armor = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.05, flatShading: true });
			const mk = (g: THREE.BufferGeometry, n: number, c: THREE.Color) => {
				const m = new THREE.InstancedMesh(g, armor, n);
				m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
				m.setColorAt(0, c);
				m.castShadow = true;
				m.receiveShadow = true;
				m.frustumCulled = false;
				m.count = 0;
				this.group.add(m);
				return m;
			};
			this.hull.push(mk(M.tankHull(), MAX_TANKS + 4, ARMOR[s]));
			this.turret.push(mk(M.tankTurret(), MAX_TANKS + 4, ARMOR[s]));
			this.truck.push(mk(M.rocketTruck(), 12, TRUCK[s]));
		}

		this.skullMesh = new THREE.InstancedMesh(
			M.skull(),
			new THREE.MeshStandardMaterial({ color: '#f4f1e8', vertexColors: true, roughness: 0.6, flatShading: true }),
			SKULLS
		);
		this.skullMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.skullMesh.frustumCulled = false;
		this.skullMesh.count = 0;
		this.group.add(this.skullMesh);
	}

	frontAt(z: number) {
		const key = this.front * 1e3 + this.time;
		if (key !== this.ftKey) {
			this.ftKey = key;
			for (let k = 0; k < this.ft.length; k++) this.ft[k] = this.front + wobble(MINZ + k * 2, this.time);
		}
		const f = Math.min(this.ft.length - 1.001, Math.max(0, (z - MINZ) / 2));
		const k = f | 0;
		return this.ft[k] + (this.ft[k + 1] - this.ft[k]) * (f - k);
	}

	// ── identities ─────────────────────────────────────────────────────

	/** The identity index for a wallet on side s, enlisting it if new. */
	idFor(s: number, wallet: string): number {
		let k = this.rosterIdx[s].get(wallet);
		if (k === undefined) {
			k = this.roster[s].length;
			this.roster[s].push(wallet);
			this.rosterIdx[s].set(wallet, k);
			this.fielded[s].push(0);
			this.unitKills[s].push(0);
			this.unitDeaths[s].push(0);
		}
		return k;
	}

	/** Set who deploys first on side s: wallets in priority order (the roster only ever grows). */
	setRoster(s: number, wallets: string[]) {
		this.order[s] = wallets.map((w) => this.idFor(s, w));
		// anonymous soldiers already in the line take up the unclaimed names
		for (let i = 0; i < CAP; i++) {
			if (this.side[i] !== s || this.idn[i] >= 0 || (this.st[i] !== HOLD && this.st[i] !== MARCH)) continue;
			const k = this.nextIdentity(s);
			if (k < 0) break;
			this.idn[i] = k;
			this.fielded[s][k]++;
		}
		for (const t of this.tanks) if (t.side === s && t.idn < 0 && !t.wreck) t.idn = this.tankCommander(s);
	}

	walletOf(s: number, k: number): string | null {
		return k >= 0 ? (this.roster[s][k] ?? null) : null;
	}

	/** The highest-priority identity with nobody on the field. */
	private nextIdentity(s: number): number {
		for (const k of this.order[s]) if (this.fielded[s][k] === 0) return k;
		return -1;
	}

	private enlist(i: number, s: number, k: number) {
		this.idn[i] = k;
		this.kills[i] = 0;
		this.bornAt[i] = Date.now();
		this.bornFront[i] = this.price;
		if (k >= 0) this.fielded[s][k]++;
	}

	/** A wallet's record across both sides this session. */
	record(wallet: string) {
		const out = { soldiers: 0, tanks: 0, kills: 0, deaths: 0 };
		for (const s of [BULL, BEAR]) {
			const k = this.rosterIdx[s].get(wallet);
			if (k === undefined) continue;
			out.soldiers += this.fielded[s][k];
			out.kills += this.unitKills[s][k];
			out.deaths += this.unitDeaths[s][k];
			for (const t of this.tanks) if (t.side === s && t.idn === k && !t.wreck) out.tanks++;
		}
		return out;
	}

	/** One of a wallet's units on the field (its tank if it commands one), or null. */
	unitOf(wallet: string): Pick | null {
		for (const s of [BULL, BEAR]) {
			const k = this.rosterIdx[s].get(wallet);
			if (k === undefined) continue;
			const t = this.tanks.find((t) => t.side === s && t.idn === k && !t.wreck);
			if (t) return { kind: 'tank', tank: t };
			for (let i = 0; i < CAP; i++) {
				if (this.side[i] === s && this.idn[i] === k && (this.st[i] === HOLD || this.st[i] === MARCH)) return { kind: 'soldier', i, gen: this.gen[i] };
			}
		}
		return null;
	}

	/** Gold-highlight every unit of a wallet (null clears). */
	track(wallet: string | null) {
		for (const s of [BULL, BEAR]) this.tracked[s] = wallet ? (this.rosterIdx[s].get(wallet) ?? -1) : -1;
	}

	/** The unit nearest a screen point (px, py) within a few pixels, if any. */
	pick(cam: THREE.Camera, px: number, py: number, w: number, h: number): Pick | null {
		let best: Pick | null = null;
		let bestD = 26 * 26;
		for (const t of this.tanks) {
			const d = this.screenDist(cam, t.x, t.y + 1.4, t.z, px, py, w, h);
			if (d < bestD) {
				bestD = d;
				best = { kind: 'tank', tank: t };
			}
		}
		if (best) return best;
		bestD = 16 * 16;
		for (let i = 0; i < CAP; i++) {
			const st = this.st[i];
			if (st === FREE) continue;
			const d = this.screenDist(cam, this.x[i], this.y[i] + 0.9, this.z[i], px, py, w, h);
			// the living win ties over the fallen
			if (d < bestD || (best?.kind === 'soldier' && d < bestD * 1.5 && st <= HOLD && this.st[best.i] > HOLD)) {
				bestD = d;
				best = { kind: 'soldier', i, gen: this.gen[i] };
			}
		}
		return best;
	}

	private screenDist(cam: THREE.Camera, x: number, y: number, z: number, px: number, py: number, w: number, h: number) {
		const v = this.pv.set(x, y, z).project(cam);
		if (v.z > 1) return Infinity;
		const sx = ((v.x + 1) / 2) * w - px;
		const sy = ((1 - v.y) / 2) * h - py;
		return sx * sx + sy * sy;
	}

	/** Live facts about a picked unit, or null once it's gone from the field. */
	info(p: Pick): UnitInfo | null {
		if (p.kind === 'tank') {
			const t = p.tank;
			if (!this.tanks.includes(t)) return null;
			return {
				kind: 'tank', side: t.side, wallet: this.walletOf(t.side, t.idn), alive: !t.wreck,
				x: t.x, y: t.y, z: t.z, kills: t.kills, bornAt: t.bornAt, bornFront: t.bornFront
			};
		}
		const i = p.i;
		if (this.gen[i] !== p.gen || this.st[i] === FREE) return null;
		const st = this.st[i];
		return {
			kind: 'soldier', side: this.side[i], wallet: this.walletOf(this.side[i], this.idn[i]),
			alive: st === HOLD || st === MARCH, x: this.x[i], y: this.y[i], z: this.z[i],
			kills: this.kills[i], bornAt: this.bornAt[i], bornFront: this.bornFront[i]
		};
	}

	// ── lifecycle ──────────────────────────────────────────────────────

	clear() {
		this.free.length = 0;
		for (let i = CAP - 1; i >= 0; i--) {
			this.st[i] = FREE;
			this.free.push(i);
		}
		for (const s of [BULL, BEAR]) this.fielded[s].fill(0);
		this.tanks.length = 0;
		this.launchers.length = 0;
		this.sk.age.fill(999);
		this.draw(0); // empty the instanced meshes now, not on the next update
	}

	/** Fill both armies straight onto their positions (round start). */
	seed() {
		for (const s of [BULL, BEAR]) {
			for (let k = 0; k < this.targets.inf[s]; k++) {
				const i = this.spawn(s, 0, 0, HOLD);
				if (i < 0) break;
				this.enlist(i, s, this.nextIdentity(s));
				const tz = this.slotZ[i];
				this.x[i] = this.frontAt(tz) + DIR[s] * this.slotD[i];
				this.z[i] = tz;
				this.fixWater(i);
			}
			for (let k = 0; k < this.targets.tanks[s]; k++) this.addTank(s, true);
			for (let k = 0; k < this.targets.launchers[s]; k++) this.addLauncher(s, true);
		}
	}

	private spawn(s: number, x: number, z: number, state: number): number {
		const i = this.free.pop();
		if (i === undefined) return -1;
		this.side[i] = s;
		this.st[i] = state;
		this.gen[i]++;
		const r = Math.random();
		this.slotD[i] = r < 0.62 ? rand(0.9, 6.5) : r < 0.9 ? rand(6.5, 19) : rand(19, 42);
		this.slotZ[i] = rand(MINZ + 8, MAXZ - 8);
		this.x[i] = x;
		this.z[i] = z;
		this.y[i] = heightAt(x, z);
		this.rot[i] = s === BULL ? Math.PI : 0;
		this.kneel[i] = Math.random() < 0.36 ? 1 : 0;
		this.shade[i] = Math.random();
		this.fireT[i] = rand(0.2, 3);
		this.aimT[i] = 0;
		this.t[i] = 0;
		return i;
	}

	private fixWater(i: number) {
		for (let k = 0; k < 14 && isWater(this.x[i], this.z[i]); k++) this.z[i] += this.z[i] > 0 ? -4 : 4;
		this.slotZ[i] = this.z[i];
	}

	/** Reinforcements for a trade: a squad double-times in from behind the line, carrying the trader's colours. */
	squad(s: number, n: number, wallet?: string) {
		const who = wallet ? this.idFor(s, wallet) : -1;
		const cz = rand(MINZ + 30, MAXZ - 30);
		for (let k = 0; k < n; k++) {
			const z = cz + rand(-12, 12);
			const x = Math.min(MAXX - 8, Math.max(MINX + 8, this.frontAt(z) + DIR[s] * rand(40, 56)));
			const i = this.spawn(s, x, z, MARCH);
			if (i < 0) return;
			this.enlist(i, s, who);
			// fan out along the line rather than piling onto one spot
			this.slotZ[i] = Math.min(MAXZ - 8, Math.max(MINZ + 8, cz + rand(-22, 22)));
			this.slotD[i] = rand(0.9, 12);
		}
	}

	deployTank(s: number, wallet?: string) {
		if (this.tanks.filter((t) => t.side === s && !t.wreck).length < MAX_TANKS) this.addTank(s, false, wallet ? this.idFor(s, wallet) : undefined);
	}

	/** An immediate artillery salvo from `s` (smaller liquidations). */
	barrage(s: number, rockets: number) {
		const trucks = this.launchers.filter((l) => l.side === s && !l.wreck);
		if (trucks.length) {
			const l = trucks[(Math.random() * trucks.length) | 0];
			l.salvo = Math.max(l.salvo, rockets);
			return;
		}
		// no trucks on the field: off-map guns
		for (let k = 0; k < rockets; k++) {
			const tz = rand(MINZ + 20, MAXZ - 20);
			const tx = this.frontAt(tz) - DIR[s] * rand(8, 40);
			const sx = this.frontAt(tz) + DIR[s] * 160;
			setTimeout(() => this.fx.rocket(Math.min(MAXX, Math.max(MINX, sx)), 18, tz + rand(-20, 20), tx, tz, () => this.impact(tx, tz, 0.85, 1 - s)), k * 180);
		}
	}

	/** Pick a concentrated patch of `s`'s front line to aim a strike at. */
	strikePoint(s: number): { x: number; z: number } {
		const st = this.binStart[s];
		let best = -1;
		let bestN = -1;
		for (let b = 0; b < NBINS; b++) {
			const n = st[b + 1] - st[b] + Math.random() * 6;
			if (n > bestN) {
				bestN = n;
				best = b;
			}
		}
		const z = Math.min(MAXZ - 12, Math.max(MINZ + 12, MINZ + (best + 0.5) * BIN + rand(-4, 4)));
		return { x: this.frontAt(z) + DIR[s] * rand(3, 12), z };
	}

	impact(x: number, z: number, scale: number, victims: number, credit?: Credit) {
		this.fx.explode(x, heightAt(x, z), z, scale);
		this.blast(x, z, 1.8 + 2.2 * scale, Math.min(0.95, 0.35 + 0.3 * scale), victims, credit);
		// heavy ordnance sets the ground alight
		if (scale >= 1.4 && Math.random() < 0.55) this.fx.burn(x, z, 0.6 + 0.4 * scale, rand(7, 14));
	}

	/** Kill / fling everything of side `victims` (-1 = any) inside radius r. */
	blast(x: number, z: number, r: number, power: number, victims: number, credit?: Credit): number {
		const r2 = r * r;
		let kills = 0;
		for (let i = 0; i < CAP; i++) {
			const s = this.st[i];
			if (s !== HOLD && s !== MARCH) continue;
			if (victims >= 0 && this.side[i] !== victims) continue;
			const dx = this.x[i] - x;
			const dz = this.z[i] - z;
			const d2 = dx * dx + dz * dz;
			if (d2 > r2) continue;
			if (Math.random() < power * (1 - (Math.sqrt(d2) / r) * 0.55)) {
				this.kill(i, x, z, power);
				kills++;
			}
		}
		const rv = r * 0.75;
		for (const t of this.tanks) {
			if (t.wreck || (victims >= 0 && t.side !== victims)) continue;
			if (Math.hypot(t.x - x, t.z - z) < rv && Math.random() < power * 0.6) this.wreckTank(t);
		}
		for (const l of this.launchers) {
			if (l.wreck || (victims >= 0 && l.side !== victims)) continue;
			if (Math.hypot(l.x - x, l.z - z) < rv && Math.random() < power * 0.5) {
				l.wreck = true;
				l.t = 0;
				this.fx.explode(l.x, l.y + 1, l.z, 1.1, false);
			}
		}
		if (credit && kills) {
			if (credit.idn >= 0) this.unitKills[credit.side][credit.idn] += kills;
			if (credit.tank) credit.tank.kills += kills;
		}
		return kills;
	}

	/** Victory: the beaten army breaks. */
	rout(s: number, dt: number) {
		for (let i = 0; i < CAP; i++) {
			if (this.side[i] !== s || (this.st[i] !== HOLD && this.st[i] !== MARCH)) continue;
			if (Math.random() < dt * 0.55) this.kill(i);
		}
	}

	private kill(i: number, fromX?: number, fromZ?: number, power = 1) {
		const s = this.side[i];
		this.casualties[s]++;
		const k = this.idn[i];
		if (k >= 0) {
			// the wallet takes the loss, and is free to redeploy with the next reinforcements
			this.unitDeaths[s][k]++;
			this.fielded[s][k] = Math.max(0, this.fielded[s][k] - 1);
		}
		this.t[i] = 0;
		this.fall[i] = Math.random() < 0.5 ? 1 : -1;
		if (fromX !== undefined && fromZ !== undefined) {
			const dx = this.x[i] - fromX;
			const dz = this.z[i] - fromZ;
			const d = Math.hypot(dx, dz) || 1;
			const sp = rand(3, 8) * power;
			this.vx[i] = (dx / d) * sp;
			this.vz[i] = (dz / d) * sp;
			this.vy[i] = rand(5, 11) * power;
			this.st[i] = FLUNG;
		} else {
			this.st[i] = DYING;
			this.fx.dust(this.x[i], this.y[i] + 0.3, this.z[i], 0.5);
		}
	}

	private release(i: number) {
		this.st[i] = FREE;
		this.free.push(i);
		const k = this.sk.head;
		this.sk.head = (k + 1) % SKULLS;
		this.sk.x[k] = this.x[i];
		this.sk.z[k] = this.z[i];
		this.sk.y[k] = heightAt(this.x[i], this.z[i]);
		this.sk.r[k] = Math.random() * 6.28;
		this.sk.age[k] = 0;
	}

	// ── armour ─────────────────────────────────────────────────────────

	private spreadSlot(list: { side: number; slotZ: number; wreck: boolean }[], s: number): number {
		let best = 0;
		let bestD = -1;
		for (let k = 0; k < 10; k++) {
			const z = rand(MINZ + 16, MAXZ - 16);
			let d = 1e9;
			for (const o of list) if (o.side === s && !o.wreck) d = Math.min(d, Math.abs(o.slotZ - z));
			if (d > bestD) {
				bestD = d;
				best = z;
			}
		}
		return best;
	}

	/** The biggest wallet on side s not already commanding a tank: whales ride in armour. */
	private tankCommander(s: number): number {
		for (const k of this.order[s].slice(0, 24)) if (!this.tanks.some((t) => t.side === s && t.idn === k && !t.wreck)) return k;
		return -1;
	}

	private addTank(s: number, inPlace: boolean, idn?: number) {
		const slotZ = this.spreadSlot(this.tanks, s);
		const slotD = rand(4.5, 15);
		const x = inPlace ? this.frontAt(slotZ) + DIR[s] * slotD : this.frontAt(slotZ) + DIR[s] * rand(85, 120);
		const cx = Math.min(MAXX - 10, Math.max(MINX + 10, x));
		const rot = s === BULL ? Math.PI : 0;
		this.tanks.push({
			side: s, x: cx, z: slotZ, y: heightAt(cx, slotZ), rot, tur: rot, slotD, slotZ,
			wreck: false, fireT: rand(1, 5), t: 0, recoil: 0, aimX: cx - DIR[s] * 20, aimZ: slotZ, aiming: -1, trail: 0,
			idn: idn ?? this.tankCommander(s), kills: 0, bornAt: Date.now(), bornFront: this.price
		});
	}

	private addLauncher(s: number, inPlace: boolean) {
		const slotZ = this.spreadSlot(this.launchers, s);
		const slotD = rand(30, 46);
		const x = inPlace ? this.frontAt(slotZ) + DIR[s] * slotD : this.frontAt(slotZ) + DIR[s] * rand(95, 130);
		const cx = Math.min(MAXX - 10, Math.max(MINX + 10, x));
		this.launchers.push({
			side: s, x: cx, z: slotZ, y: heightAt(cx, slotZ), rot: s === BULL ? Math.PI : 0, slotD, slotZ,
			wreck: false, fireT: rand(3, 12), t: 0, salvo: 0, salvoT: 0
		});
	}

	private wreckTank(t: Tank) {
		t.wreck = true;
		t.t = 0;
		if (t.idn >= 0) this.unitDeaths[t.side][t.idn]++;
		this.fx.explode(t.x, t.y + 1.2, t.z, 1.2, false);
	}

	// ── frame ──────────────────────────────────────────────────────────

	update(dt: number) {
		this.time += dt;
		this.buildBins();
		this.updateHitRates();
		this.updateInfantry(dt);
		this.reinforce(dt);
		this.updateTanks(dt);
		this.updateLaunchers(dt);
		this.draw(dt);
	}

	private buildBins() {
		for (const s of [BULL, BEAR]) {
			const start = this.binStart[s];
			const list = this.binList[s];
			start.fill(0);
			let shooters = 0;
			for (let i = 0; i < CAP; i++) {
				const st = this.st[i];
				if (this.side[i] !== s || (st !== HOLD && st !== MARCH)) continue;
				if (DIR[s] * (this.x[i] - this.frontAt(this.z[i])) > 24) continue;
				const b = Math.min(NBINS - 1, Math.max(0, ((this.z[i] - MINZ) / BIN) | 0));
				start[b + 1]++;
				if (st === HOLD) shooters++;
			}
			for (let b = 0; b < NBINS; b++) start[b + 1] += start[b];
			const fill = start.slice(0, NBINS);
			for (let i = 0; i < CAP; i++) {
				const st = this.st[i];
				if (this.side[i] !== s || (st !== HOLD && st !== MARCH)) continue;
				if (DIR[s] * (this.x[i] - this.frontAt(this.z[i])) > 24) continue;
				const b = Math.min(NBINS - 1, Math.max(0, ((this.z[i] - MINZ) / BIN) | 0));
				list[fill[b]++] = i;
			}
			this.frontShooters[s] = shooters;
		}
	}

	/** Each side's hit chance is set so its kill rate tracks its share of the field. */
	private updateHitRates() {
		const tot = this.targets.inf[0] + this.targets.inf[1] || 1;
		for (const s of [BULL, BEAR]) {
			const share = this.targets.inf[s] / tot;
			const want = 1.25 * Math.pow(share / 0.5, 1.4) * (1 + 0.8 * this.volatility);
			const shotsPerSec = Math.max(1, this.frontShooters[s] / (2.5 * (1 - 0.35 * this.volatility)));
			this.pHit[s] = Math.min(0.6, want / shotsPerSec);
		}
	}

	private pickTarget(s: number, z: number, spread = 1): number {
		const e = 1 - s;
		const st = this.binStart[e];
		const b0 = Math.min(NBINS - 1, Math.max(0, ((z - MINZ) / BIN) | 0));
		for (let k = 0; k < 4; k++) {
			const b = Math.min(NBINS - 1, Math.max(0, b0 + Math.round(rand(-spread, spread))));
			const n = st[b + 1] - st[b];
			if (n > 0) return this.binList[e][st[b] + ((Math.random() * n) | 0)];
		}
		return -1;
	}

	private fire(i: number) {
		const s = this.side[i];
		const j = this.pickTarget(s, this.z[i]);
		if (j < 0) return;
		const dx = this.x[j] - this.x[i];
		const dz = this.z[j] - this.z[i];
		const d = Math.hypot(dx, dz);
		if (d > 75 || d < 0.5) return;
		this.rot[i] = Math.atan2(-dz, dx);
		this.aimT[i] = 1.4;
		const mx = this.x[i] + (dx / d) * 1.05;
		const mz = this.z[i] + (dz / d) * 1.05;
		const my = this.y[i] + (this.kneel[i] ? 1.13 : 1.43);
		this.fx.muzzle(mx, my, mz, 0.9);
		const g = this.gen[j];
		const shooterGen = this.gen[i];
		const shooterId = this.idn[i];
		const hit = Math.random() < this.pHit[s];
		const c = TRACER[s];
		this.fx.tracer(
			mx, my, mz,
			this.x[j] + rand(-0.6, 0.6), this.y[j] + rand(0.7, 1.4), this.z[j] + rand(-0.6, 0.6),
			c[0], c[1], c[2], 170, 2.6, 0.085,
			hit
				? () => {
						if (this.gen[j] !== g || (this.st[j] !== HOLD && this.st[j] !== MARCH)) return;
						this.kill(j);
						// credit the rifleman, and the wallet it fights for
						if (this.gen[i] === shooterGen) this.kills[i]++;
						if (shooterId >= 0) this.unitKills[s][shooterId]++;
					}
				: undefined
		);
		this.hooks.shot(mx, mz);
	}

	private updateInfantry(dt: number) {
		this.alive[0] = this.alive[1] = 0;
		const vol = this.volatility;
		for (let i = 0; i < CAP; i++) {
			const st = this.st[i];
			if (st === FREE) continue;
			const s = this.side[i];
			if (st === HOLD || st === MARCH) {
				this.alive[s]++;
				const dir = DIR[s];
				let tz = this.slotZ[i];
				let tx = Math.min(MAXX - 8, Math.max(MINX + 8, this.frontAt(tz) + dir * this.slotD[i]));
				for (let k = 0; k < 12 && isWater(tx, tz); k++) tz += tz > 0 ? -4 : 4;
				const dx = tx - this.x[i];
				const dz = tz - this.z[i];
				const dist = Math.hypot(dx, dz);
				// caught on the wrong side of a moving line: run for it, or fall
				const wrong = dir * (this.x[i] - this.frontAt(this.z[i])) < -0.4;
				if (wrong && Math.random() < dt * 0.35) {
					this.kill(i);
					continue;
				}
				// sprint to catch a line that has jumped, jog to a nearby slot
				let speed = 0;
				if (st === MARCH) {
					speed = dist > 20 ? 8.5 : 6.4;
					if (dist < 1.2) this.st[i] = HOLD;
				} else if (dist > 0.45) speed = dist > 14 ? 8.5 : dist > 5 || wrong ? 6.4 : 2.4;
				let pose = this.kneel[i] ? KNEEL : STAND;
				if (speed > 0 && dist > 0.01) {
					const step = Math.min(dist, speed * dt);
					this.x[i] += (dx / dist) * step;
					this.z[i] += (dz / dist) * step;
					const want = Math.atan2(-dz, dx);
					this.rot[i] += wrapAngle(want - this.rot[i]) * Math.min(1, dt * 10);
					pose = speed > 4 ? RUN : STAND;
				} else {
					if (this.aimT[i] > 0) this.aimT[i] -= dt;
					else {
						const want = (s === BULL ? Math.PI : 0) + (this.shade[i] - 0.5) * 0.5;
						this.rot[i] += wrapAngle(want - this.rot[i]) * Math.min(1, dt * 4);
					}
					if (this.slotD[i] < 20) {
						this.fireT[i] -= dt;
						if (this.fireT[i] <= 0) {
							this.fireT[i] = rand(1.3, 3.7) * (1 - 0.35 * vol);
							this.fire(i);
						}
					}
				}
				this.pose[i] = pose;
				this.y[i] = heightAt(this.x[i], this.z[i]) + (pose === RUN ? Math.abs(Math.sin(this.time * 13 + this.shade[i] * 20)) * 0.14 : 0);
			} else if (st === DYING) {
				this.t[i] += dt;
				if (this.t[i] > 0.42) {
					this.st[i] = CORPSE;
					this.t[i] = 0;
				}
			} else if (st === FLUNG) {
				this.t[i] += dt;
				this.vy[i] -= 26 * dt;
				this.x[i] += this.vx[i] * dt;
				this.y[i] += this.vy[i] * dt;
				this.z[i] += this.vz[i] * dt;
				const g = heightAt(this.x[i], this.z[i]);
				if (this.y[i] <= g && this.vy[i] < 0) {
					this.y[i] = g;
					this.st[i] = CORPSE;
					this.t[i] = 0;
				}
			} else if (st === CORPSE) {
				this.t[i] += dt;
				if (this.t[i] > 5 + this.shade[i] * 5) this.release(i);
			}
		}
	}

	private reinforce(dt: number) {
		for (const s of [BULL, BEAR]) {
			const deficit = this.targets.inf[s] - this.alive[s];
			if (deficit <= 0) {
				this.spawnAcc[s] = 0;
				continue;
			}
			this.spawnAcc[s] += Math.min(16, 1.5 + deficit * 0.3) * dt;
			while (this.spawnAcc[s] >= 1) {
				this.spawnAcc[s] -= 1;
				const z = rand(MINZ + 10, MAXZ - 10);
				const x = Math.min(MAXX - 8, Math.max(MINX + 8, this.frontAt(z) + DIR[s] * rand(55, 110)));
				const i = this.spawn(s, x, z, MARCH);
				if (i < 0) break;
				this.enlist(i, s, this.nextIdentity(s));
				this.slotZ[i] = Math.min(MAXZ - 8, Math.max(MINZ + 8, z + rand(-25, 25)));
			}
		}
	}

	private updateTanks(dt: number) {
		const vol = this.volatility;
		const aliveBySide = [0, 0];
		for (const t of this.tanks) if (!t.wreck) aliveBySide[t.side]++;
		for (const s of [BULL, BEAR]) {
			if (aliveBySide[s] < this.targets.tanks[s]) {
				this.tankT[s] -= dt;
				if (this.tankT[s] <= 0) {
					this.addTank(s, false);
					this.tankT[s] = 2.5;
				}
			}
			// surplus armour doesn't retire quietly: it gets knocked out in the fighting
			if (aliveBySide[s] > this.targets.tanks[s] + 2) {
				this.surplusT[s] -= dt;
				if (this.surplusT[s] <= 0) {
					const cands = this.tanks.filter((t) => t.side === s && !t.wreck);
					this.wreckTank(cands[(Math.random() * cands.length) | 0]);
					this.surplusT[s] = 8;
				}
			}
		}
		for (let k = this.tanks.length - 1; k >= 0; k--) {
			const t = this.tanks[k];
			if (t.wreck) {
				t.t += dt;
				if (Math.random() < dt * 5) this.fx.puff(t.x + rand(-1, 1), t.y + 2, t.z + rand(-1, 1), 1.5, 0.12, 0.65, 4.5);
				if (t.t < 14 && Math.random() < dt * 14) this.fx.flame(t.x, t.y + 1.6, t.z, 1.6);
				if (t.t > 28) this.tanks.splice(k, 1);
				continue;
			}
			const dir = DIR[t.side];
			let tz = t.slotZ;
			const tx = Math.min(MAXX - 10, Math.max(MINX + 10, this.frontAt(tz) + dir * t.slotD));
			for (let q = 0; q < 12 && isWater(tx, tz); q++) tz += tz > 0 ? -4 : 4;
			const dx = tx - t.x;
			const dz = tz - t.z;
			const dist = Math.hypot(dx, dz);
			if (dist > 0.8) {
				const sp = dist > 30 ? 9 : 5;
				const step = Math.min(dist, sp * dt);
				t.x += (dx / dist) * step;
				t.z += (dz / dist) * step;
				t.rot += wrapAngle(Math.atan2(-dz, dx) - t.rot) * Math.min(1, dt * 3);
				if (Math.random() < dt * 4) this.fx.dust(t.x - Math.cos(t.rot) * 2.4, t.y + 0.3, t.z + Math.sin(t.rot) * 2.4, 0.9);
				// treads print into the dirt every metre or so
				t.trail += step;
				if (t.trail > 0.9) {
					t.trail = 0;
					this.hooks.track(t.x, t.z, t.rot);
				}
			} else {
				t.rot += wrapAngle((t.side === BULL ? Math.PI : 0) - t.rot) * Math.min(1, dt * 1.5);
			}
			t.y = heightAt(t.x, t.z);
			const want = Math.atan2(-(t.aimZ - t.z), t.aimX - t.x);
			const err = wrapAngle(want - t.tur);
			t.tur += err * Math.min(1, dt * 2.5);
			t.recoil = Math.max(0, t.recoil - dt * 3);
			t.fireT -= dt;
			if (t.aiming < 0 && t.fireT <= 0 && dist < 25) {
				// acquire a target: an enemy near the line, else a patch across it
				const j = this.pickTarget(t.side, t.z, 2);
				if (j >= 0 && Math.hypot(this.x[j] - t.x, this.z[j] - t.z) < 80) {
					t.aimX = this.x[j];
					t.aimZ = this.z[j];
				} else {
					t.aimZ = t.z + rand(-14, 14);
					t.aimX = this.frontAt(t.aimZ) - dir * rand(6, 30);
				}
				t.aiming = 0;
			} else if (t.aiming >= 0) {
				t.aiming += dt;
				if (Math.abs(err) < 0.1) {
					const tx2 = t.aimX;
					const tz2 = t.aimZ;
					const c = Math.cos(t.tur);
					const sn = Math.sin(t.tur);
					const mx = t.x + c * M.TANK_MUZZLE.x;
					const mz = t.z - sn * M.TANK_MUZZLE.x;
					const my = t.y + M.TANK_MUZZLE.y;
					this.fx.muzzle(mx, my, mz, 3.4);
					this.fx.puff(mx, my, mz, 1.1, 0.62, 0.5, 1.6);
					t.recoil = 1;
					const side = t.side;
					const credit = { side, idn: t.idn, tank: t };
					this.fx.tracer(mx, my, mz, tx2, heightAt(tx2, tz2) + 0.4, tz2, 3.2, 2.5, 1.3, 260, 5, 0.17, () => this.impact(tx2, tz2, 0.5, 1 - side, credit));
					this.hooks.cannon(mx, mz);
					t.fireT = rand(3.5, 7.5) * (1 - 0.4 * vol);
					t.aiming = -1;
				} else if (t.aiming > 3) {
					t.aiming = -1;
					t.fireT = rand(0.5, 2);
				}
			}
		}
	}

	private updateLaunchers(dt: number) {
		const vol = this.volatility;
		const aliveBySide = [0, 0];
		for (const l of this.launchers) if (!l.wreck) aliveBySide[l.side]++;
		for (const s of [BULL, BEAR]) {
			if (aliveBySide[s] < this.targets.launchers[s]) {
				this.launcherT[s] -= dt;
				if (this.launcherT[s] <= 0) {
					this.addLauncher(s, false);
					this.launcherT[s] = 6;
				}
			}
		}
		for (let k = this.launchers.length - 1; k >= 0; k--) {
			const l = this.launchers[k];
			if (l.wreck) {
				l.t += dt;
				if (Math.random() < dt * 4) this.fx.puff(l.x, l.y + 2, l.z, 1.3, 0.12, 0.6, 4);
				if (l.t > 24) this.launchers.splice(k, 1);
				continue;
			}
			const dir = DIR[l.side];
			let tz = l.slotZ;
			const tx = Math.min(MAXX - 10, Math.max(MINX + 10, this.frontAt(tz) + dir * l.slotD));
			for (let q = 0; q < 12 && isWater(tx, tz); q++) tz += tz > 0 ? -4 : 4;
			const dx = tx - l.x;
			const dz = tz - l.z;
			const dist = Math.hypot(dx, dz);
			if (dist > 1) {
				const step = Math.min(dist, (dist > 30 ? 10 : 5.5) * dt);
				l.x += (dx / dist) * step;
				l.z += (dz / dist) * step;
				l.rot += wrapAngle(Math.atan2(-dz, dx) - l.rot) * Math.min(1, dt * 3);
			} else {
				l.rot += wrapAngle((l.side === BULL ? Math.PI : 0) - l.rot) * Math.min(1, dt * 1.5);
				l.fireT -= dt;
				if (l.fireT <= 0) {
					l.salvo = Math.round(4 + 4 * vol);
					l.fireT = rand(9, 17) * (1 - 0.55 * vol);
				}
			}
			l.y = heightAt(l.x, l.z);
			if (l.salvo > 0) {
				l.salvoT -= dt;
				if (l.salvoT <= 0) {
					l.salvo--;
					l.salvoT = 0.2;
					const c = Math.cos(l.rot);
					const sn = Math.sin(l.rot);
					const sx = l.x + c * M.TRUCK_LAUNCH.x;
					const sz = l.z - sn * M.TRUCK_LAUNCH.x;
					const aimZ = l.z + rand(-30, 30);
					const aimX = this.frontAt(aimZ) - dir * rand(8, 42);
					const side = l.side;
					this.fx.rocket(sx, l.y + M.TRUCK_LAUNCH.y, sz, aimX, aimZ, () => this.impact(aimX, aimZ, 0.85, 1 - side));
				}
			}
		}
	}

	// ── rendering ──────────────────────────────────────────────────────

	private draw(dt: number) {
		const counts = [
			[0, 0, 0],
			[0, 0, 0]
		];
		for (let i = 0; i < CAP; i++) {
			const st = this.st[i];
			if (st === FREE) continue;
			const s = this.side[i];
			const upright = st === HOLD || st === MARCH;
			const p = upright ? this.pose[i] : STAND;
			const mesh = this.poses[s][p];
			const k = counts[s][p]++;
			const te = mesh.instanceMatrix.array as Float32Array;
			const o = k * 16;
			const gold = this.idn[i] >= 0 && this.idn[i] === this.tracked[s];
			const sc = (0.94 + this.shade[i] * 0.12) * (gold ? 1.3 : 1);
			const c = Math.cos(this.rot[i]);
			const sn = Math.sin(this.rot[i]);
			let a = 0;
			if (st === DYING) a = Math.min(1, this.t[i] / 0.42) ** 2 * (Math.PI / 2) * this.fall[i];
			else if (st === CORPSE) a = (Math.PI / 2) * this.fall[i];
			else if (st === FLUNG) a = this.t[i] * 9 * this.fall[i];
			const ca = Math.cos(a);
			const sa = Math.sin(a);
			te[o] = c * ca * sc; te[o + 1] = sa * sc; te[o + 2] = -sn * ca * sc; te[o + 3] = 0;
			te[o + 4] = -c * sa * sc; te[o + 5] = ca * sc; te[o + 6] = sn * sa * sc; te[o + 7] = 0;
			te[o + 8] = sn * sc; te[o + 9] = 0; te[o + 10] = c * sc; te[o + 11] = 0;
			te[o + 12] = this.x[i];
			te[o + 13] = this.y[i] + (st === CORPSE ? 0.22 : st === DYING ? Math.abs(sa) * 0.22 : 0);
			te[o + 14] = this.z[i];
			te[o + 15] = 1;
			const col = mesh.instanceColor!.array as Float32Array;
			const f = (0.86 + this.shade[i] * 0.2) * (upright ? 1 : 0.55);
			const tc = gold ? GOLD : TEAM[s];
			col[k * 3] = tc.r * f;
			col[k * 3 + 1] = tc.g * f;
			col[k * 3 + 2] = tc.b * f;
		}
		for (const s of [BULL, BEAR]) {
			for (let p = 0; p < 3; p++) {
				const m = this.poses[s][p];
				m.count = counts[s][p];
				m.instanceMatrix.needsUpdate = true;
				m.instanceColor!.needsUpdate = true;
			}
		}

		const mtx = this.mtx;
		const tc = [0, 0];
		for (const t of this.tanks) {
			const s = t.side;
			const k = tc[s]++;
			mtx.makeRotationY(t.rot).setPosition(t.x, t.y, t.z);
			this.hull[s].setMatrixAt(k, mtx);
			const back = t.recoil * 0.35;
			mtx.makeRotationY(t.tur).setPosition(t.x - Math.cos(t.tur) * back, t.y, t.z + Math.sin(t.tur) * back);
			this.turret[s].setMatrixAt(k, mtx);
			this.tmpC.copy(t.idn >= 0 && t.idn === this.tracked[s] ? GOLD : ARMOR[s]).multiplyScalar(t.wreck ? 0.18 : 1);
			this.hull[s].setColorAt(k, this.tmpC);
			this.turret[s].setColorAt(k, this.tmpC);
		}
		const lc = [0, 0];
		for (const l of this.launchers) {
			const s = l.side;
			const k = lc[s]++;
			mtx.makeRotationY(l.rot).setPosition(l.x, l.y, l.z);
			this.truck[s].setMatrixAt(k, mtx);
			this.tmpC.copy(TRUCK[s]).multiplyScalar(l.wreck ? 0.18 : 1);
			this.truck[s].setColorAt(k, this.tmpC);
		}
		for (const s of [BULL, BEAR]) {
			for (const [m, n] of [
				[this.hull[s], tc[s]],
				[this.turret[s], tc[s]],
				[this.truck[s], lc[s]]
			] as [THREE.InstancedMesh, number][]) {
				m.count = n;
				m.instanceMatrix.needsUpdate = true;
				if (m.instanceColor) m.instanceColor.needsUpdate = true;
			}
		}

		// skulls pop up, linger, and fade into the grass
		let n = 0;
		const sk = this.sk;
		for (let k = 0; k < SKULLS; k++) {
			if (sk.age[k] > 40) continue;
			sk.age[k] += dt;
			const a = sk.age[k];
			const sc = a < 0.25 ? a / 0.25 : a > 34 ? Math.max(0.001, 1 - (a - 34) / 6) : 1;
			mtx.makeRotationY(sk.r[k]).scale(this.scl.set(sc, sc, sc)).setPosition(sk.x[k], sk.y[k], sk.z[k]);
			this.skullMesh.setMatrixAt(n++, mtx);
		}
		this.skullMesh.count = n;
		this.skullMesh.instanceMatrix.needsUpdate = true;
	}
}
