// Battlefield effects: GPU-billboarded particles (fire, smoke, dust, sparks),
// tracer streaks, shockwave rings, pooled flash lights, and ordnance in flight
// (artillery rockets, missiles, bombs). Everything is pooled — no per-shot
// allocations in the frame loop.

import * as THREE from 'three';
import { bombShape } from './models';
import { heightAt } from './world';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function glowTexture(): THREE.Texture {
	const c = document.createElement('canvas');
	c.width = c.height = 64;
	const x = c.getContext('2d')!;
	const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
	g.addColorStop(0, 'rgba(255,255,255,1)');
	g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
	g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
	g.addColorStop(1, 'rgba(255,255,255,0)');
	x.fillStyle = g;
	x.fillRect(0, 0, 64, 64);
	return new THREE.CanvasTexture(c);
}

function smokeTexture(): THREE.Texture {
	const c = document.createElement('canvas');
	c.width = c.height = 128;
	const x = c.getContext('2d')!;
	let seed = 11;
	const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
	for (let i = 0; i < 18; i++) {
		const px = 64 + (r() - 0.5) * 50;
		const py = 64 + (r() - 0.5) * 50;
		const rad = 22 + r() * 22;
		const g = x.createRadialGradient(px, py, 0, px, py, rad);
		g.addColorStop(0, 'rgba(255,255,255,0.32)');
		g.addColorStop(1, 'rgba(255,255,255,0)');
		x.fillStyle = g;
		x.fillRect(0, 0, 128, 128);
	}
	return new THREE.CanvasTexture(c);
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute float iSize;
attribute vec4 iColor;
attribute float iRot;
varying vec2 vUv;
varying vec4 vColor;
#include <common>
#include <fog_pars_vertex>
void main() {
	vUv = uv;
	vColor = iColor;
	vec4 mvPosition = viewMatrix * vec4(iPos, 1.0);
	float c = cos(iRot), s = sin(iRot);
	vec2 p = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
	mvPosition.xy += p * iSize;
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
#include <common>
#include <fog_pars_fragment>
void main() {
	vec4 t = texture2D(map, vUv);
	gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
	#include <fog_fragment>
}`;

/** One pool of camera-facing particles sharing a texture and blend mode. */
export class Particles {
	readonly mesh: THREE.Mesh;
	private geo: THREE.InstancedBufferGeometry;
	private n = 0;
	private pos: Float32Array;
	private size: Float32Array;
	private col: Float32Array;
	private rot: Float32Array;
	private d: Float32Array; // per-particle sim state, STRIDE floats each
	private static STRIDE = 21;

	constructor(
		private cap: number,
		tex: THREE.Texture,
		additive: boolean
	) {
		const g = new THREE.InstancedBufferGeometry();
		const quad = new THREE.PlaneGeometry(1, 1);
		g.index = quad.index;
		g.setAttribute('position', quad.getAttribute('position'));
		g.setAttribute('uv', quad.getAttribute('uv'));
		this.pos = new Float32Array(cap * 3);
		this.size = new Float32Array(cap);
		this.col = new Float32Array(cap * 4);
		this.rot = new Float32Array(cap);
		this.d = new Float32Array(cap * Particles.STRIDE);
		g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
		g.setAttribute('iSize', new THREE.InstancedBufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
		g.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
		g.setAttribute('iRot', new THREE.InstancedBufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
		g.instanceCount = 0;
		this.geo = g;
		const mat = new THREE.ShaderMaterial({
			uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]),
			vertexShader: VERT,
			fragmentShader: FRAG,
			transparent: true,
			depthWrite: false,
			fog: true,
			blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
		});
		mat.uniforms.map.value = tex;
		this.mesh = new THREE.Mesh(g, mat);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = additive ? 20 : 10;
	}

	/** c0 → c1 over the particle's life (rgba). grav < 0 falls, > 0 rises. */
	spawn(
		x: number, y: number, z: number,
		vx: number, vy: number, vz: number,
		life: number, s0: number, s1: number,
		r0: number, g0: number, b0: number, a0: number,
		r1: number, g1: number, b1: number, a1: number,
		drag = 0, grav = 0, fadeIn = 0
	) {
		if (this.n >= this.cap) return;
		const i = this.n++;
		const o = i * Particles.STRIDE;
		const d = this.d;
		d[o] = x; d[o + 1] = y; d[o + 2] = z;
		d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
		d[o + 6] = 0; d[o + 7] = life;
		d[o + 8] = s0; d[o + 9] = s1;
		d[o + 10] = r0; d[o + 11] = g0; d[o + 12] = b0; d[o + 13] = a0;
		d[o + 14] = r1; d[o + 15] = g1; d[o + 16] = b1; d[o + 17] = a1;
		d[o + 18] = drag; d[o + 19] = grav; d[o + 20] = fadeIn;
		this.rot[i] = Math.random() * 6.28;
	}

	clear() {
		this.n = 0;
		this.geo.instanceCount = 0;
	}

	update(dt: number) {
		const S = Particles.STRIDE;
		const d = this.d;
		let i = 0;
		while (i < this.n) {
			const o = i * S;
			d[o + 6] += dt;
			const age = d[o + 6];
			const life = d[o + 7];
			if (age >= life) {
				// swap-remove with the last live particle
				const last = --this.n;
				if (i !== last) {
					d.copyWithin(o, last * S, last * S + S);
					this.rot[i] = this.rot[last];
				}
				continue;
			}
			const drag = Math.exp(-d[o + 18] * dt);
			d[o + 3] *= drag;
			d[o + 5] *= drag;
			d[o + 4] = d[o + 4] * drag + d[o + 19] * dt;
			d[o] += d[o + 3] * dt;
			d[o + 1] += d[o + 4] * dt;
			d[o + 2] += d[o + 5] * dt;
			const t = age / life;
			const e = 1 - (1 - t) * (1 - t);
			const pre = d[o + 20] > 0 ? Math.min(1, age / d[o + 20]) : 1;
			this.pos[i * 3] = d[o];
			this.pos[i * 3 + 1] = d[o + 1];
			this.pos[i * 3 + 2] = d[o + 2];
			this.size[i] = d[o + 8] + (d[o + 9] - d[o + 8]) * e;
			this.col[i * 4] = d[o + 10] + (d[o + 14] - d[o + 10]) * t;
			this.col[i * 4 + 1] = d[o + 11] + (d[o + 15] - d[o + 11]) * t;
			this.col[i * 4 + 2] = d[o + 12] + (d[o + 16] - d[o + 12]) * t;
			this.col[i * 4 + 3] = (d[o + 13] + (d[o + 17] - d[o + 13]) * t) * pre;
			this.rot[i] += dt * 0.25;
			i++;
		}
		this.geo.instanceCount = this.n;
		for (const k of ['iPos', 'iSize', 'iColor', 'iRot']) (this.geo.getAttribute(k) as THREE.InstancedBufferAttribute).needsUpdate = true;
	}
}

type Tracer = {
	fx: number; fy: number; fz: number;
	dx: number; dy: number; dz: number;
	dist: number; speed: number; len: number; head: number; thick: number;
	r: number; g: number; b: number;
	done?: () => void;
	arrived: boolean;
};

type Ordnance = {
	kind: 'rocket' | 'missile' | 'bomb' | 'warhead';
	x: number; y: number; z: number;
	sx: number; sy: number; sz: number;
	tx: number; ty: number; tz: number;
	vx: number; vy: number; vz: number;
	t: number; T: number; apex: number; trail: number;
	hit: (x: number, z: number) => void; // called with the actual impact point
};

type Ring = { x: number; y: number; z: number; age: number; life: number; r: number; c: THREE.Color };

export type FxHooks = {
	shake(amount: number, x: number, z: number): void;
	sound(kind: 'boom' | 'shot' | 'cannon' | 'rocket' | 'whoosh' | 'gun', x: number, z: number, scale: number): void;
	crater(x: number, z: number, r: number): void;
};

export class Fx {
	readonly group = new THREE.Group();
	readonly add: Particles; // additive: fire, flashes, sparks
	readonly smoke: Particles; // alpha: smoke, dust, debris
	private tracers: Tracer[] = [];
	private tracerMesh: THREE.InstancedMesh;
	private ords: Ordnance[] = [];
	private bombMesh: THREE.InstancedMesh;
	private rings: Ring[] = [];
	private ringMesh: THREE.InstancedMesh;
	private lights: THREE.PointLight[] = [];
	private fires: { x: number; y: number; z: number; t: number; life: number; s: number }[] = [];
	private m = new THREE.Matrix4();
	private q = new THREE.Quaternion();
	private v = new THREE.Vector3();
	private s = new THREE.Vector3();
	private X = new THREE.Vector3(1, 0, 0);

	constructor(private hooks: FxHooks) {
		const glow = glowTexture();
		this.add = new Particles(8000, glow, true);
		this.smoke = new Particles(9000, smokeTexture(), false);
		this.group.add(this.smoke.mesh, this.add.mesh);

		const tm = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
		this.tracerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), tm, 900);
		this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.tracerMesh.setColorAt(0, new THREE.Color());
		this.tracerMesh.frustumCulled = false;
		this.tracerMesh.count = 0;
		this.tracerMesh.renderOrder = 21;
		this.group.add(this.tracerMesh);

		this.bombMesh = new THREE.InstancedMesh(
			bombShape(),
			new THREE.MeshStandardMaterial({ color: '#3a3d38', roughness: 0.5, metalness: 0.3, vertexColors: true }),
			96
		);
		this.bombMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.bombMesh.frustumCulled = false;
		this.bombMesh.count = 0;
		this.group.add(this.bombMesh);

		const ring = new THREE.RingGeometry(0.82, 1, 40);
		ring.rotateX(-Math.PI / 2);
		this.ringMesh = new THREE.InstancedMesh(
			ring,
			new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
			48
		);
		this.ringMesh.setColorAt(0, new THREE.Color());
		this.ringMesh.frustumCulled = false;
		this.ringMesh.count = 0;
		this.group.add(this.ringMesh);

		for (let i = 0; i < 3; i++) {
			const l = new THREE.PointLight('#ffb060', 0, 70, 1.6);
			this.lights.push(l);
			this.group.add(l);
		}
	}

	clear() {
		this.add.clear();
		this.smoke.clear();
		this.tracers.length = 0;
		this.ords.length = 0;
		this.rings.length = 0;
		this.fires.length = 0;
	}

	// ── one-shots ───────────────────────────────────────────────────────

	muzzle(x: number, y: number, z: number, size: number) {
		this.add.spawn(x, y, z, 0, 0, 0, 0.07, size * 0.5, size * 1.2, 3.2, 2.4, 1.1, 1, 2.4, 1, 0.3, 0);
		this.smoke.spawn(x, y, z, rand(-0.3, 0.3), rand(0.4, 0.9), rand(-0.3, 0.3), rand(0.7, 1.1), size * 0.3, size * 1.4, 0.75, 0.74, 0.72, 0.32, 0.8, 0.8, 0.78, 0, 1.2, 0.3);
	}

	puff(x: number, y: number, z: number, size: number, shade = 0.3, alpha = 0.55, life = 3) {
		this.smoke.spawn(x, y, z, rand(-0.5, 0.5), rand(1.2, 2.4), rand(-0.5, 0.5), life * rand(0.8, 1.2), size, size * 2.6, shade, shade * 0.96, shade * 0.92, alpha, shade + 0.18, shade + 0.17, shade + 0.16, 0, 0.8, 0.4, 0.15);
	}

	flame(x: number, y: number, z: number, size: number) {
		this.add.spawn(x + rand(-0.4, 0.4), y, z + rand(-0.4, 0.4), 0, rand(1.5, 3), 0, rand(0.25, 0.45), size, size * 0.3, 2.6, 1.1, 0.25, 0.9, 1.6, 0.3, 0.05, 0);
	}

	dust(x: number, y: number, z: number, size: number) {
		this.smoke.spawn(x, y, z, rand(-1, 1), rand(0.3, 0.8), rand(-1, 1), rand(0.8, 1.4), size, size * 2.2, 0.5, 0.44, 0.34, 0.45, 0.55, 0.5, 0.4, 0, 1.5, 0);
	}

	/** Jet exhaust: a short hot plume behind the nozzle, (dx, dz) = flight direction. */
	afterburner(x: number, y: number, z: number, dx: number, dz: number) {
		this.add.spawn(x, y, z, -dx * 20, 0, -dz * 20, 0.09, 1.5, 0.5, 3.4, 1.9, 0.9, 1, 1.2, 0.35, 1.4, 0, 2);
	}

	/** A cannon round hitting the dirt: spark, kicked-up dust, no crater. */
	bulletImpact(x: number, y: number, z: number) {
		this.add.spawn(x, y + 0.3, z, 0, 0, 0, 0.07, 0.9, 1.6, 3.4, 2.6, 1.3, 1, 2, 1, 0.3, 0);
		for (let k = 0; k < 2; k++)
			this.smoke.spawn(x, y + 0.2, z, rand(-1.5, 1.5), rand(2, 5), rand(-1.5, 1.5), rand(0.7, 1.2), 0.6, 2.2, 0.5, 0.43, 0.32, 0.6, 0.55, 0.5, 0.4, 0, 2, -3);
	}

	/** A patch of ground left burning: flames licking up, a smoke column, dying down at the end. */
	burn(x: number, z: number, size: number, life: number) {
		if (this.fires.length >= 48) this.fires.shift();
		this.fires.push({ x, y: heightAt(x, z), z, t: 0, life, s: size });
	}

	/** An anti-aircraft shell bursting in the air: a flash, sparks, a black puff. */
	flak(x: number, y: number, z: number) {
		this.add.spawn(x, y, z, 0, 0, 0, 0.09, 1.5, 3.5, 3.2, 2.2, 1.1, 1, 1.5, 0.5, 0.1, 0);
		this.smoke.spawn(x, y, z, rand(-0.6, 0.6), rand(-0.2, 0.4), rand(-0.6, 0.6), rand(2.2, 3.2), 1.4, 5.2, 0.06, 0.06, 0.06, 0.85, 0.2, 0.2, 0.2, 0, 1.2, 0);
		for (let k = 0; k < 5; k++)
			this.add.spawn(x, y, z, rand(-9, 9), rand(-9, 9), rand(-9, 9), 0.3, 0.3, 0.1, 3, 2, 0.8, 1, 1.5, 0.4, 0.1, 0, 1, -8);
	}

	/** Low battle smoke drifting across the lines. */
	haze(x: number, y: number, z: number) {
		this.smoke.spawn(x, y, z, rand(0.6, 1.6), rand(0.05, 0.3), rand(-0.4, 0.4), rand(9, 13), rand(7, 10), rand(18, 26), 0.5, 0.49, 0.46, 0.14, 0.58, 0.57, 0.55, 0, 0.05, 0, 2.5);
	}

	/** A bare flash of light: glow sprite + a borrowed point light. */
	flash(x: number, y: number, z: number, size: number, light = 0) {
		this.add.spawn(x, y, z, 0, 0, 0, 0.35, size * 0.6, size, 5, 4.6, 4, 1, 3, 1.6, 0.6, 0);
		if (light > 0) {
			let l = this.lights[0];
			for (const k of this.lights) if (k.intensity < l.intensity) l = k;
			l.position.set(x, y, z);
			l.intensity = light;
			l.distance = size * 4;
		}
	}

	/** Colour is HDR (values > 1 bloom). */
	tracer(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, r: number, g: number, b: number, speed = 150, len = 3.2, thick = 0.09, done?: () => void) {
		if (this.tracers.length >= 900) {
			done?.();
			return;
		}
		const dx = tx - fx;
		const dy = ty - fy;
		const dz = tz - fz;
		const dist = Math.hypot(dx, dy, dz) || 0.001;
		this.tracers.push({ fx, fy, fz, dx: dx / dist, dy: dy / dist, dz: dz / dist, dist, speed, len, head: 0, thick, r, g, b, done, arrived: false });
	}

	explode(x: number, y: number, z: number, scale: number, withCrater = true) {
		const s = Math.min(2.4, scale);
		const A = this.add;
		const S = this.smoke;
		A.spawn(x, y + 0.8 * s, z, 0, 0, 0, 0.14, 4 * s, 8 * s, 2.2, 1.35, 0.5, 1, 1.4, 0.45, 0.1, 0);
		const nf = Math.round(4 + 5 * s);
		for (let i = 0; i < nf; i++) {
			const a = Math.random() * Math.PI * 2;
			const up = rand(0.25, 1);
			const sp = rand(2.5, 8) * s;
			A.spawn(
				x + rand(-0.6, 0.6) * s, y + rand(0.3, 1.2) * s, z + rand(-0.6, 0.6) * s,
				Math.cos(a) * sp * (1 - up * 0.5), sp * up, Math.sin(a) * sp * (1 - up * 0.5),
				rand(0.45, 0.9), rand(1.2, 1.8) * s, rand(2.6, 3.8) * s,
				1.7, 0.62, 0.12, 0.9, 0.7, 0.12, 0.02, 0,
				3.2, 3
			);
		}
		const ns = Math.round(10 * s);
		for (let i = 0; i < ns; i++) {
			const a = Math.random() * Math.PI * 2;
			const sp = rand(10, 26) * Math.sqrt(s);
			A.spawn(x, y + 0.5, z, Math.cos(a) * sp * 0.6, rand(6, 18) * Math.sqrt(s), Math.sin(a) * sp * 0.6, rand(0.4, 0.9), 0.35, 0.18, 3.5, 2.4, 1, 1, 2, 0.6, 0.1, 0, 0.6, -28);
		}
		const nk = Math.round(4 + 6 * s);
		for (let i = 0; i < nk; i++) {
			S.spawn(
				x + rand(-1, 1) * s, y + rand(0.5, 2) * s, z + rand(-1, 1) * s,
				rand(-1.4, 1.4) * s, rand(1.5, 4.2), rand(-1.4, 1.4) * s,
				rand(3, 6.5), rand(1.6, 2.4) * s, rand(4.5, 7) * s,
				0.14, 0.12, 0.11, 0.72, 0.4, 0.38, 0.35, 0,
				0.9, 0.35, 0.12
			);
		}
		for (let i = 0; i < 8; i++) {
			const a = (i / 8) * Math.PI * 2 + rand(0, 0.5);
			const sp = rand(7, 12) * s;
			S.spawn(x, y + 0.4, z, Math.cos(a) * sp, rand(0.2, 1), Math.sin(a) * sp, rand(1.4, 2.4), 1.2 * s, 4.2 * s, 0.46, 0.39, 0.29, 0.55, 0.52, 0.47, 0.38, 0, 2.6, 0);
		}
		const nd = Math.round(6 * s);
		for (let i = 0; i < nd; i++) {
			const a = Math.random() * Math.PI * 2;
			S.spawn(x, y + 0.5, z, Math.cos(a) * rand(3, 8) * s, rand(7, 15) * Math.sqrt(s), Math.sin(a) * rand(3, 8) * s, rand(0.7, 1.2), 0.45, 0.35, 0.1, 0.08, 0.06, 1, 0.12, 0.1, 0.08, 1, 0.2, -30);
		}
		if (this.rings.length < 48) this.rings.push({ x, y: y + 0.3, z, age: 0, life: 0.45, r: 8 * s, c: new THREE.Color(1.3, 0.85, 0.45) });
		// borrow the dimmest light for a real flash on the terrain
		if (s >= 0.8) {
			let l = this.lights[0];
			for (const k of this.lights) if (k.intensity < l.intensity) l = k;
			l.position.set(x, y + 4 * s, z);
			l.intensity = 260 * s;
			l.distance = 30 + 40 * s;
		}
		if (withCrater) this.hooks.crater(x, z, 1.6 + 2.2 * s);
		this.hooks.shake(0.25 * s * s, x, z);
		this.hooks.sound('boom', x, z, s);
	}

	// ── ordnance ────────────────────────────────────────────────────────

	/** Ballistic artillery rocket with a smoke trail. */
	rocket(sx: number, sy: number, sz: number, tx: number, tz: number, hit: (x: number, z: number) => void) {
		const ty = heightAt(tx, tz);
		const dist = Math.hypot(tx - sx, tz - sz);
		this.ords.push({ kind: 'rocket', x: sx, y: sy, z: sz, sx, sy, sz, tx, ty, tz, vx: 0, vy: 0, vz: 0, t: 0, T: 1.4 + dist / 55, apex: 12 + dist * 0.16, trail: 0, hit });
		this.muzzle(sx, sy, sz, 2.4);
		this.hooks.sound('rocket', sx, sz, 1);
	}

	/** Straight, fast guided missile (air-launched). */
	missile(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, speed: number, hit: (x: number, z: number) => void) {
		const dist = Math.hypot(tx - sx, ty - sy, tz - sz);
		this.ords.push({ kind: 'missile', x: sx, y: sy, z: sz, sx, sy, sz, tx, ty, tz, vx: 0, vy: 0, vz: 0, t: 0, T: dist / speed, apex: 0, trail: 0, hit });
		this.hooks.sound('whoosh', sx, sz, 0.8);
	}

	/** A nuclear warhead coming down steep and fast under a white-hot trail. */
	warhead(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, speed: number, hit: (x: number, z: number) => void) {
		const dist = Math.hypot(tx - sx, ty - sy, tz - sz);
		this.ords.push({ kind: 'warhead', x: sx, y: sy, z: sz, sx, sy, sz, tx, ty, tz, vx: 0, vy: 0, vz: 0, t: 0, T: dist / speed, apex: 0, trail: 0, hit });
	}

	bomb(x: number, y: number, z: number, vx: number, vz: number, hit: (x: number, z: number) => void) {
		this.ords.push({ kind: 'bomb', x, y, z, sx: x, sy: y, sz: z, tx: 0, ty: 0, tz: 0, vx, vy: -2, vz, t: 0, T: 99, apex: 0, trail: 0, hit });
	}

	// ── frame ───────────────────────────────────────────────────────────

	update(dt: number) {
		for (let i = this.fires.length - 1; i >= 0; i--) {
			const f = this.fires[i];
			f.t += dt;
			if (f.t > f.life) {
				this.fires.splice(i, 1);
				continue;
			}
			const k = Math.min(1, (f.life - f.t) / (f.life * 0.35)); // dies down over the last third
			if (Math.random() < dt * 22 * f.s * k) this.flame(f.x + rand(-1, 1) * f.s, f.y + 0.3, f.z + rand(-1, 1) * f.s, 1.6 * f.s * (0.6 + 0.4 * k));
			if (Math.random() < dt * 3.5 * k) this.puff(f.x, f.y + 1.5, f.z, 1.4 * f.s, 0.1, 0.1 + 0.6 * k, 5);
		}
		this.add.update(dt);
		this.smoke.update(dt);
		this.updateTracers(dt);
		this.updateOrdnance(dt);
		this.updateRings(dt);
		for (const l of this.lights) l.intensity *= Math.exp(-dt * 9);
	}

	private updateTracers(dt: number) {
		const mesh = this.tracerMesh;
		const col = mesh.instanceColor!.array as Float32Array;
		let n = 0;
		for (let i = this.tracers.length - 1; i >= 0; i--) {
			const t = this.tracers[i];
			t.head += t.speed * dt;
			if (!t.arrived && t.head >= t.dist) {
				t.arrived = true;
				t.done?.();
			}
			const head = Math.min(t.head, t.dist);
			const tail = Math.max(0, t.head - t.len);
			if (tail >= t.dist) {
				this.tracers[i] = this.tracers[this.tracers.length - 1];
				this.tracers.pop();
				continue;
			}
			const mid = (head + tail) / 2;
			this.v.set(t.fx + t.dx * mid, t.fy + t.dy * mid, t.fz + t.dz * mid);
			this.q.setFromUnitVectors(this.X, this.s.set(t.dx, t.dy, t.dz));
			this.s.set(Math.max(0.01, head - tail), t.thick, t.thick);
			this.m.compose(this.v, this.q, this.s);
			mesh.setMatrixAt(n, this.m);
			col[n * 3] = t.r;
			col[n * 3 + 1] = t.g;
			col[n * 3 + 2] = t.b;
			n++;
		}
		mesh.count = n;
		mesh.instanceMatrix.needsUpdate = true;
		mesh.instanceColor!.needsUpdate = true;
	}

	private updateOrdnance(dt: number) {
		let nb = 0;
		for (let i = this.ords.length - 1; i >= 0; i--) {
			const o = this.ords[i];
			o.t += dt;
			let done = false;
			if (o.kind === 'rocket') {
				const u = Math.min(1, o.t / o.T);
				o.x = o.sx + (o.tx - o.sx) * u;
				o.z = o.sz + (o.tz - o.sz) * u;
				o.y = o.sy + (o.ty - o.sy) * u + o.apex * 4 * u * (1 - u);
				done = u >= 1;
				this.add.spawn(o.x, o.y, o.z, 0, 0, 0, 0.06, 1.3, 0.6, 3.2, 1.8, 0.6, 1, 2, 0.6, 0.1, 0);
				if (Math.random() < 0.6) this.smoke.spawn(o.x, o.y, o.z, rand(-0.3, 0.3), rand(0, 0.5), rand(-0.3, 0.3), rand(1.4, 2.2), 0.7, 2.6, 0.78, 0.77, 0.74, 0.5, 0.85, 0.84, 0.82, 0, 1, 0.3);
			} else if (o.kind === 'warhead') {
				const u = Math.min(1, o.t / o.T);
				o.x = o.sx + (o.tx - o.sx) * u;
				o.y = o.sy + (o.ty - o.sy) * u;
				o.z = o.sz + (o.tz - o.sz) * u;
				done = u >= 1;
				this.add.spawn(o.x, o.y, o.z, 0, 0, 0, 0.08, 4.5, 2, 5, 4.4, 3.6, 1, 3, 1.4, 0.4, 0);
				for (let k = 0; k < 2; k++)
					this.smoke.spawn(o.x + rand(-0.6, 0.6), o.y + rand(-0.6, 0.6), o.z + rand(-0.6, 0.6), rand(-0.4, 0.4), rand(-0.2, 0.4), rand(-0.4, 0.4), rand(4, 6), 1.6, 6, 0.95, 0.95, 0.94, 0.7, 0.9, 0.9, 0.9, 0, 0.5, 0.15);
			} else if (o.kind === 'missile') {
				const u = Math.min(1, o.t / o.T);
				o.x = o.sx + (o.tx - o.sx) * u;
				o.y = o.sy + (o.ty - o.sy) * u;
				o.z = o.sz + (o.tz - o.sz) * u;
				done = u >= 1;
				this.add.spawn(o.x, o.y, o.z, 0, 0, 0, 0.05, 1.6, 0.8, 3.6, 2.6, 1.4, 1, 2, 0.8, 0.2, 0);
				if (Math.random() < 0.7) this.smoke.spawn(o.x, o.y, o.z, rand(-0.2, 0.2), rand(-0.1, 0.3), rand(-0.2, 0.2), rand(1.8, 2.8), 0.6, 2.4, 0.9, 0.9, 0.9, 0.55, 0.9, 0.9, 0.9, 0, 0.8, 0.2);
			} else {
				o.vy -= 34 * dt;
				o.x += o.vx * dt;
				o.y += o.vy * dt;
				o.z += o.vz * dt;
				done = o.y <= heightAt(o.x, o.z);
				if (!done && nb < 96) {
					this.v.set(o.x, o.y, o.z);
					this.q.setFromUnitVectors(this.X, this.s.set(o.vx, o.vy, o.vz).normalize());
					this.s.set(1.3, 1.3, 1.3);
					this.m.compose(this.v, this.q, this.s);
					this.bombMesh.setMatrixAt(nb++, this.m);
				}
			}
			if (done) {
				this.ords[i] = this.ords[this.ords.length - 1];
				this.ords.pop();
				o.hit(o.x, o.z);
			}
		}
		this.bombMesh.count = nb;
		this.bombMesh.instanceMatrix.needsUpdate = true;
	}

	private updateRings(dt: number) {
		const mesh = this.ringMesh;
		const col = mesh.instanceColor!.array as Float32Array;
		let n = 0;
		for (let i = this.rings.length - 1; i >= 0; i--) {
			const r = this.rings[i];
			r.age += dt;
			if (r.age >= r.life) {
				this.rings[i] = this.rings[this.rings.length - 1];
				this.rings.pop();
				continue;
			}
			const t = r.age / r.life;
			const rad = r.r * (0.15 + 0.85 * (1 - (1 - t) * (1 - t)));
			this.v.set(r.x, r.y, r.z);
			this.q.identity();
			this.s.set(rad, 1, rad);
			this.m.compose(this.v, this.q, this.s);
			mesh.setMatrixAt(n, this.m);
			const f = (1 - t) * (1 - t);
			col[n * 3] = r.c.r * f;
			col[n * 3 + 1] = r.c.g * f;
			col[n * 3 + 2] = r.c.b * f;
			n++;
		}
		mesh.count = n;
		mesh.instanceMatrix.needsUpdate = true;
		mesh.instanceColor!.needsUpdate = true;
	}
}
