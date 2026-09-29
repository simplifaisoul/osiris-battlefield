// Air strikes, the battlefield's big events, from the attacker's side onto the
// densest stretch of the enemy's front:
//   heli    — chin-gun burst, then a rocket ripple from a hover
//   jet     — afterburning pair (or trio) strafes the line with cannon, then missiles
//   bomber  — a bomber formation carpet-bombs along the line, fighters escorting
//   nuke    — a warhead comes down white-hot from high altitude: mushroom cloud

import * as THREE from 'three';
import * as M from './models';
import type { Fx } from './fx';
import { type Army, DIR } from './army';
import { heightAt, isWater, BASE_X, HQ, MINZ, MAXZ, MINX, MAXX, clampZ } from './world';

type AASite = {
	side: number;
	x: number; y: number; z: number;
	gun: THREE.Object3D;
	yaw: number; pitch: number;
	fire: number; // seconds left in the current burst
	cool: number; // seconds until it may open up again
	shotT: number;
};

export type StrikeKind = 'heli' | 'jet' | 'bomber' | 'nuke';
type CraftKind = 'heli' | 'jet' | 'bomber';

type Craft = {
	kind: CraftKind;
	side: number;
	obj: THREE.Object3D;
	rotor?: THREE.Object3D;
	t: number;
	delay: number; // seconds before it enters (escorts time their arrival)
	phase: number;
	x: number; y: number; z: number;
	vx: number; vy: number; vz: number;
	yaw: number; bank: number; pitch: number;
	tx: number; tz: number;
	hx: number; hz: number; hy: number;
	shots: number; gun: number; shotT: number; gunT: number; fired: boolean; strafing: boolean; scale: number;
};

export type AirHooks = {
	sound(kind: CraftKind | 'gun' | 'siren' | 'flak', x: number, z: number): void;
	/** A warhead reached the ground. */
	nuke(x: number, z: number, scale: number, victims: number): void;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const JET_SPEED = 125;

export class Air {
	readonly group = new THREE.Group();
	private crafts: Craft[] = [];
	private heliGeo = M.heliBody();
	private rotorGeo = M.heliRotor();
	private jetGeo = M.jet();
	private bomberGeo = M.bomber();
	private heliMat = [
		new THREE.MeshStandardMaterial({ vertexColors: true, color: '#4c9e62', roughness: 0.5, flatShading: true }),
		new THREE.MeshStandardMaterial({ vertexColors: true, color: '#c24d46', roughness: 0.5, flatShading: true })
	];
	private jetMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: '#cfd5da', roughness: 0.4, metalness: 0.2, flatShading: true });
	private bomberMat = [
		new THREE.MeshStandardMaterial({ vertexColors: true, color: '#7f9a82', roughness: 0.55, flatShading: true }),
		new THREE.MeshStandardMaterial({ vertexColors: true, color: '#9a7f7c', roughness: 0.55, flatShading: true })
	];
	private rotorMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: '#2a2a2a', roughness: 0.6 });
	private warheads = 0;
	private aa: AASite[] = [];

	constructor(
		private fx: Fx,
		private army: Army,
		private hooks: AirHooks
	) {
		// anti-aircraft batteries: two guarding each HQ, two on each side's rear line
		const mountGeo = M.aaMount();
		const gunGeo = M.aaGuns();
		const mountMat = [
			new THREE.MeshStandardMaterial({ vertexColors: true, color: '#8fcf9e', roughness: 0.8, flatShading: true }),
			new THREE.MeshStandardMaterial({ vertexColors: true, color: '#d99a92', roughness: 0.8, flatShading: true })
		];
		const gunMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: '#5d6660', roughness: 0.5, metalness: 0.3, flatShading: true });
		for (const side of [0, 1]) {
			const dir = DIR[side];
			const hq = side === 0 ? HQ.bull : HQ.bear;
			const spots: [number, number][] = [
				[hq.x - dir * 16, hq.z + 24],
				[hq.x - dir * 16, hq.z - 22],
				[dir * 150, 96],
				[dir * 150, -92]
			];
			for (const [x0, z0] of spots) {
				let z = z0;
				for (let k = 0; k < 10 && isWater(x0, z); k++) z += z > 0 ? -5 : 5;
				const y = heightAt(x0, z);
				const mount = new THREE.Mesh(mountGeo, mountMat[side]);
				mount.position.set(x0, y, z);
				const gun = new THREE.Mesh(gunGeo, gunMat);
				gun.position.set(x0, y + 1.7, z);
				gun.rotation.order = 'YXZ';
				gun.rotation.y = side === 0 ? Math.PI : 0;
				gun.rotation.z = 0.5;
				mount.castShadow = mount.receiveShadow = gun.castShadow = true;
				this.group.add(mount, gun);
				this.aa.push({ side, x: x0, y: y + 1.7, z, gun, yaw: gun.rotation.y, pitch: 0.5, fire: 0, cool: Math.random(), shotT: 0 });
			}
		}
	}

	get active() {
		return this.crafts.length + this.warheads;
	}

	clear() {
		for (const c of this.crafts) this.group.remove(c.obj);
		this.crafts.length = 0;
	}

	/** `side` is the attacker. `scale` grows the ordnance with the event size. */
	strike(kind: StrikeKind, side: number, scale = 1, at?: { x: number; z: number }) {
		const target = at ?? this.army.strikePoint(1 - side);
		if (kind === 'heli') this.heli(side, target, scale);
		else if (kind === 'jet') this.jets(side, target, scale);
		else if (kind === 'bomber') this.bombers(side, target, scale);
		else this.nuke(side, target, scale);
	}

	private make(kind: CraftKind, side: number): { obj: THREE.Object3D; rotor?: THREE.Object3D } {
		if (kind === 'heli') {
			const obj = new THREE.Group();
			const body = new THREE.Mesh(this.heliGeo, this.heliMat[side]);
			const rotor = new THREE.Mesh(this.rotorGeo, this.rotorMat);
			rotor.position.y = 1.25;
			body.castShadow = rotor.castShadow = true;
			obj.add(body, rotor);
			obj.scale.setScalar(1.25);
			return { obj, rotor };
		}
		const m = new THREE.Mesh(kind === 'jet' ? this.jetGeo : this.bomberGeo, kind === 'jet' ? this.jetMat : this.bomberMat[side]);
		m.castShadow = true;
		m.scale.setScalar(kind === 'jet' ? 1.3 : 1.35);
		return { obj: m };
	}

	private add(c: Omit<Craft, 'obj' | 'rotor'>) {
		const { obj, rotor } = this.make(c.kind, c.side);
		const craft: Craft = { ...c, obj, rotor };
		obj.position.set(c.x, c.y, c.z);
		obj.visible = c.delay <= 0;
		this.group.add(obj);
		this.crafts.push(craft);
		return craft;
	}

	private base(): Omit<Craft, 'obj' | 'rotor' | 'kind' | 'side'> {
		return {
			t: 0, delay: 0, phase: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, bank: 0, pitch: 0,
			tx: 0, tz: 0, hx: 0, hz: 0, hy: 0, shots: 0, gun: 0, shotT: 0, gunT: 0, fired: false, strafing: false, scale: 1
		};
	}

	private heli(side: number, T: { x: number; z: number }, scale: number) {
		const dir = DIR[side];
		const hx = T.x + dir * 30;
		const hz = clampZ(T.z + rand(-10, 10));
		const x = dir * (BASE_X - 8);
		const z = clampZ(T.z + rand(-50, 50));
		this.add({
			...this.base(), kind: 'heli', side, x, y: 26, z, tx: T.x, tz: T.z, hx, hz,
			hy: heightAt(hx, hz) + 15, yaw: Math.atan2(-(hz - z), hx - x), shots: Math.round(6 + 4 * scale), gun: 18, scale
		});
		this.hooks.sound('heli', x, z);
	}

	private jets(side: number, T: { x: number; z: number }, scale: number, delay = 0) {
		const dir = DIR[side];
		const n = scale > 1.6 ? 3 : 2;
		const angle = rand(-0.35, 0.35);
		const vx = -dir * Math.cos(angle) * JET_SPEED;
		const vz = Math.sin(angle) * JET_SPEED;
		for (let k = 0; k < n; k++) {
			const off = (k - (n - 1) / 2) * 9;
			const lag = Math.abs(k - (n - 1) / 2) * 14;
			const sx = T.x - (vx / JET_SPEED) * (360 + lag);
			const sz = T.z - (vz / JET_SPEED) * (360 + lag) + off;
			this.add({
				...this.base(), kind: 'jet', side, delay, x: sx, y: 38 + k * 2, z: sz, vx, vy: 0, vz,
				tx: T.x + rand(-6, 6), tz: T.z + off * 0.6, yaw: Math.atan2(-vz, vx), scale
			});
		}
		if (delay <= 0) this.hooks.sound('jet', T.x, T.z);
	}

	private bombers(side: number, T: { x: number; z: number }, scale: number) {
		const dir = DIR[side];
		const sgn = Math.random() < 0.5 ? 1 : -1;
		const lane = this.army.front - dir * rand(12, 26);
		const n = scale > 1.6 ? 4 : 3;
		for (let k = 0; k < n; k++) {
			const x = Math.min(MAXX - 6, Math.max(MINX + 6, lane + (k - (n - 1) / 2) * 11));
			const z = -sgn * (MAXZ + 140 + k * 16);
			this.add({
				...this.base(), kind: 'bomber', side, x, y: 48 + k * 1.5, z, vx: 0, vz: sgn * 58,
				yaw: Math.atan2(-sgn, 0), tx: T.x, tz: T.z, scale
			});
		}
		this.hooks.sound('bomber', lane, 0);
		// fighter escort sweeps the line as the bombers arrive
		this.jets(side, this.army.strikePoint(1 - side), 1, 3.2);
	}

	private nuke(side: number, T: { x: number; z: number }, scale: number) {
		const dir = DIR[side];
		// aim a little deeper into enemy ground so the blast is theirs
		const tx = Math.min(MAXX - 20, Math.max(MINX + 20, T.x - dir * 16));
		const tz = clampZ(T.z);
		const sx = tx + dir * 250;
		const sz = tz + rand(-90, 90);
		this.warheads++;
		this.hooks.sound('siren', tx, tz);
		this.fx.warhead(sx, 340, sz, tx, heightAt(tx, tz), tz, 150, (x, z) => {
			this.warheads--;
			this.hooks.nuke(x, z, scale, 1 - side);
		});
	}

	update(dt: number) {
		for (let i = this.crafts.length - 1; i >= 0; i--) {
			const c = this.crafts[i];
			if (c.delay > 0) {
				c.delay -= dt;
				if (c.delay > 0) continue;
				c.obj.visible = true;
				if (c.kind === 'jet') this.hooks.sound('jet', c.tx, c.tz);
			}
			c.t += dt;
			let gone = false;
			if (c.kind === 'heli') gone = this.flyHeli(c, dt);
			else if (c.kind === 'jet') gone = this.flyJet(c, dt);
			else gone = this.flyBomber(c, dt);
			c.obj.position.set(c.x, c.y, c.z);
			c.obj.rotation.set(c.bank, c.yaw, c.pitch, 'YXZ');
			if (gone || c.t > 40) {
				this.group.remove(c.obj);
				this.crafts.splice(i, 1);
			}
		}
		this.updateAA(dt);
	}

	/** Each battery tracks the nearest enemy aircraft in range and hoses it with leading bursts. */
	private updateAA(dt: number) {
		for (const s of this.aa) {
			// a battery the front has rolled over falls silent
			const manned = DIR[s.side] * (s.x - this.army.front) > 12;
			let target: Craft | null = null;
			let best = 240;
			if (manned) {
				for (const c of this.crafts) {
					if (c.side === s.side || c.delay > 0 || c.y < 8) continue;
					const d = Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z);
					if (d < best) {
						best = d;
						target = c;
					}
				}
			}
			s.cool -= dt;
			if (target) {
				// lead the target by roughly the shell's flight time
				const lead = best / 300;
				const ax = target.x + target.vx * lead;
				const ay = target.y + target.vy * lead;
				const az = target.z + target.vz * lead;
				const wantYaw = Math.atan2(-(az - s.z), ax - s.x);
				const wantPitch = Math.atan2(ay - s.y, Math.hypot(ax - s.x, az - s.z));
				s.yaw += wrap(wantYaw - s.yaw) * Math.min(1, dt * 4);
				s.pitch += (wantPitch - s.pitch) * Math.min(1, dt * 4);
				if (s.fire <= 0 && s.cool <= 0) {
					s.fire = rand(1, 1.6);
					this.hooks.sound('flak', s.x, s.z);
				}
				if (s.fire > 0) {
					s.fire -= dt;
					if (s.fire <= 0) s.cool = rand(0.7, 1.4);
					s.shotT -= dt;
					while (s.shotT <= 0) {
						s.shotT += 0.08;
						const cy = Math.cos(s.yaw);
						const sy = Math.sin(s.yaw);
						const cp = Math.cos(s.pitch);
						const mx = s.x + cy * cp * M.AA_MUZZLE;
						const my = s.y + Math.sin(s.pitch) * M.AA_MUZZLE;
						const mz = s.z - sy * cp * M.AA_MUZZLE;
						const bx = ax + rand(-6, 6);
						const by = ay + rand(-4, 4);
						const bz = az + rand(-6, 6);
						this.fx.muzzle(mx, my, mz, 1.2);
						this.fx.tracer(mx, my, mz, bx, by, bz, 3.2, 2.3, 1.1, 320, 5, 0.13, () => {
							if (Math.random() < 0.45) this.fx.flak(bx, by, bz);
						});
					}
				}
			} else {
				s.fire = 0;
				s.pitch += (0.5 - s.pitch) * Math.min(1, dt); // stand-to, barrels up
			}
			s.gun.rotation.set(0, s.yaw, s.pitch, 'YXZ');
		}
	}

	/** A cannon round from (sx, sy, sz) raking a spot on the ground. */
	private round(sx: number, sy: number, sz: number, ax: number, az: number, victims: number, speed = 520) {
		const ay = heightAt(ax, az);
		this.fx.tracer(sx, sy, sz, ax, ay + 0.2, az, 3.4, 2.9, 1.5, speed, 7, 0.15, () => {
			this.fx.bulletImpact(ax, ay, az);
			this.army.blast(ax, az, 1.9, 0.55, victims);
		});
	}

	private flyHeli(c: Craft, dt: number): boolean {
		if (c.rotor) c.rotor.rotation.y += dt * 38;
		const dir = DIR[c.side];
		if (c.phase === 0) {
			const dx = c.hx - c.x;
			const dz = c.hz - c.z;
			const dy = c.hy - c.y;
			const d = Math.hypot(dx, dz);
			const sp = Math.min(38, 6 + d * 0.9);
			if (d > 1.5) {
				c.x += (dx / d) * sp * dt;
				c.z += (dz / d) * sp * dt;
			}
			c.y += dy * Math.min(1, dt * 1.2);
			c.yaw += wrap(Math.atan2(-dz, dx) - c.yaw) * Math.min(1, dt * 2.5);
			c.pitch += (-0.22 * Math.min(1, sp / 38) - c.pitch) * Math.min(1, dt * 3);
			if (d < 3) {
				c.phase = 1;
				c.shotT = 1.1; // chin gun opens up first
			}
		} else if (c.phase === 1) {
			const want = Math.atan2(-(c.tz - c.z), c.tx - c.x);
			c.yaw += wrap(want - c.yaw) * Math.min(1, dt * 3);
			c.pitch += (0.06 - c.pitch) * Math.min(1, dt * 3);
			c.y += Math.sin(c.t * 2) * 0.02;
			const cy = Math.cos(c.yaw);
			const sy = Math.sin(c.yaw);
			const victims = 1 - c.side;
			c.gunT -= dt;
			if (c.gun > 0 && c.gunT <= 0) {
				c.gun--;
				c.gunT = 0.06;
				this.round(c.x + cy * 2.6, c.y - 1, c.z - sy * 2.6, c.tx + rand(-6, 6), c.tz + rand(-6, 6), victims, 300);
			}
			c.shotT -= dt;
			if (c.shotT <= 0 && c.shots > 0) {
				c.shots--;
				c.shotT = 0.28;
				const side = c.shots % 2 ? 1.7 : -1.7;
				// pod positions in the heli frame, rotated into the world
				const px = c.x + cy * 1.2 + sy * side;
				const pz = c.z - sy * 1.2 + cy * side;
				const tx = c.tx + rand(-8, 8);
				const tz = c.tz + rand(-8, 8);
				const s = 0.95 * c.scale;
				this.fx.missile(px, c.y - 0.6, pz, tx, heightAt(tx, tz) + 0.3, tz, 85, () => this.army.impact(tx, tz, s, victims));
			}
			if (c.shots <= 0 && c.shotT < -0.8) c.phase = 2;
		} else {
			// egress: turn for home and climb away
			const hx = dir * (BASE_X + 60);
			const dx = hx - c.x;
			const dz = -c.z * 0.2;
			c.yaw += wrap(Math.atan2(-dz, dx) - c.yaw) * Math.min(1, dt * 2);
			c.x += Math.cos(c.yaw) * 36 * dt;
			c.z -= Math.sin(c.yaw) * 36 * dt;
			c.y += 5 * dt;
			c.pitch += (-0.25 - c.pitch) * Math.min(1, dt * 2);
			return Math.abs(c.x) > MAXX + 50;
		}
		c.bank = Math.sin(c.t * 1.3) * 0.04;
		return false;
	}

	private flyJet(c: Craft, dt: number): boolean {
		c.x += c.vx * dt;
		c.y += c.vy * dt;
		c.z += c.vz * dt;
		const fx = c.vx / JET_SPEED;
		const fz = c.vz / JET_SPEED;
		const victims = 1 - c.side;
		// distance still to run to the target, along the flight path
		const ahead = (c.tx - c.x) * fx + (c.tz - c.z) * fz;

		// strafing run: cannon walks its impacts up the enemy line toward the target
		if (ahead < 185 && ahead > 88) {
			if (!c.strafing) {
				c.strafing = true;
				this.hooks.sound('gun', c.x, c.z);
			}
			c.gunT -= dt;
			while (c.gunT <= 0) {
				c.gunT += 0.035;
				const p = (185 - ahead) / 97;
				const along = -40 + 46 * p;
				const lat = rand(-2.8, 2.8);
				this.round(c.x + fx * 5, c.y - 0.8, c.z + fz * 5, c.tx + fx * along - fz * lat, c.tz + fz * along + fx * lat, victims);
			}
			c.pitch += (-0.1 - c.pitch) * Math.min(1, dt * 3); // nose down on the gun run
		}
		if (!c.fired && ahead < 85) {
			c.fired = true;
			const s = 1.6 * c.scale;
			for (let k = 0; k < 2; k++) {
				const tx = c.tx + rand(-9, 9);
				const tz = c.tz + rand(-9, 9);
				const off = k ? 2.6 : -2.6;
				this.fx.missile(c.x, c.y - 1, c.z + off, tx, heightAt(tx, tz) + 0.3, tz, 150, () => {
					this.army.impact(tx, tz, s, victims);
					this.army.blast(tx, tz, 9 * c.scale, 0.8, victims);
				});
			}
		}
		if (c.fired && ahead < 0) {
			// pull up hard and roll away, pulling vapour off the wings
			c.vy = Math.min(46, c.vy + 34 * dt);
			c.pitch += (0.42 - c.pitch) * Math.min(1, dt * 2.2);
			c.bank += (DIR[c.side] * 0.9 - c.bank) * Math.min(1, dt * 1.5);
		} else if (!c.strafing) {
			c.bank = Math.sin(c.t * 0.9 + DIR[c.side]) * 0.08;
		}
		const cy = Math.cos(c.yaw);
		const sy = Math.sin(c.yaw);
		// afterburner at the nozzle
		this.fx.afterburner(c.x - cy * 5.1, c.y, c.z + sy * 5.1, fx, fz);
		// contrails off the wingtips, thicker while pulling
		const pulling = c.fired && ahead < 0;
		// several puffs per frame along the path this frame covered, so the trail is continuous
		const stepX = c.vx * dt;
		const stepY = c.vy * dt;
		const stepZ = c.vz * dt;
		for (let k = 0; k < 3; k++) {
			const back = k / 3;
			for (const w of [-6.2, 6.2])
				this.fx.puff(c.x - stepX * back - cy * 2.5 + sy * w, c.y - stepY * back, c.z - stepZ * back + sy * 2.5 + cy * w, pulling ? 0.8 : 0.55, 0.94, pulling ? 0.45 : 0.3, 2.4);
		}
		return c.x > MAXX + 380 || c.x < MINX - 380 || c.z > MAXZ + 380 || c.z < MINZ - 380 || c.y > 200;
	}

	private flyBomber(c: Craft, dt: number): boolean {
		c.x += c.vx * dt;
		c.z += c.vz * dt;
		c.bank = 0;
		if (c.z > MINZ + 6 && c.z < MAXZ - 6) {
			c.shotT -= dt;
			if (c.shotT <= 0) {
				c.shotT = 0.24;
				const victims = 1 - c.side;
				const s = 1.8 * c.scale;
				// the bomb lands where it falls, not where it was aimed
				this.fx.bomb(c.x, c.y - 1.5, c.z, 0, c.vz * 0.9, (x, z) => this.army.impact(x, z, s, victims));
			}
		}
		return Math.abs(c.z) > MAXZ + 200 && Math.sign(c.z) === Math.sign(c.vz);
	}
}
