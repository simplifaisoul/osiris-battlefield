// The battlefield board: a raised diorama slab of rolling farmland with a road,
// lakes, and a price ladder painted across it. The ground shader tints each side
// by territory (dry ochre for the Bears, green for the Bulls), shades the
// liquidity buffers either side of the front, and draws the glowing front line.

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

// ── board geometry (world units) ──────────────────────────────────────────
// x is the price axis: higher prices lie WEST (toward the Bear base), so a rally
// pushes the Bulls' line west. z runs along the front.
export const MINX = -300;
export const MAXX = 300;
export const MINZ = -170;
export const MAXZ = 170;
export const W = MAXX - MINX;
export const D = MAXZ - MINZ;
export const SPACING = 44; // world units per price step
export const RANGE_STEPS = 4; // each round spans ±4 steps; the end zones sit there
export const BASE_X = 262;
export const WATER_Y = -0.8;
export const SLAB_Y = -16;

export const LAKES = [
	{ x: 214, z: -116, r: 30 },
	{ x: -204, z: 120, r: 21 }
];

export const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function mulberry32(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const noise = createNoise2D(mulberry32(7331));

export const roadZ = (x: number) => 16 * Math.sin(x / 95 + 0.6) + 6 * Math.sin(x / 41 + 1.1);

/** The front line's gentle lateral wave. Mirrored exactly in the ground shader. */
export const wobble = (z: number, t: number) =>
	2.2 * Math.sin(z * 0.045 + t * 0.35) + 1.3 * Math.sin(z * 0.11 - t * 0.5 + 1.7) + 0.7 * Math.sin(z * 0.23 + t * 0.9 + 0.4);

export const HQ = {
	bear: new THREE.Vector3(-BASE_X, 0, roadZ(-BASE_X) + 30),
	bull: new THREE.Vector3(BASE_X, 0, roadZ(BASE_X) - 30)
};

function rawHeight(x: number, z: number): number {
	let h = 3.6 * noise(x / 115, z / 115) + 1.7 * noise(x / 47 + 7, z / 47 - 3) + 0.45 * noise(x / 16, z / 16);
	h += 1.4;
	// the road and a wide shoulder are graded flat
	const rz = roadZ(x);
	const roadH = 1.2 + 1.6 * noise(x / 140, 0.37);
	h = lerp(roadH, h, smooth(10, 30, Math.abs(z - rz)));
	// bases sit on levelled ground
	for (const b of [HQ.bear, HQ.bull]) {
		const d = Math.hypot(x - b.x, z - b.z);
		h = lerp(roadH, h, smooth(26, 44, d));
	}
	// lakes: carved basins with soft shores
	for (const l of LAKES) {
		const d = Math.hypot(x - l.x, z - l.z);
		const edge = l.r * (1 + 0.2 * noise(x / 13, z / 13));
		h = lerp(h, Math.min(h, WATER_Y + 0.5), smooth(edge * 1.6, edge, d));
		h = lerp(h, WATER_Y - 2.4, smooth(edge, edge * 0.55, d));
	}
	return h;
}

// ── height field (1 unit grid, bilinear) ─────────────────────────────────
const GW = W + 1;
const GD = D + 1;
const grid = new Float32Array(GW * GD);
for (let j = 0; j < GD; j++) for (let i = 0; i < GW; i++) grid[j * GW + i] = rawHeight(MINX + i, MINZ + j);

export function heightAt(x: number, z: number): number {
	const fx = Math.min(W - 0.001, Math.max(0, x - MINX));
	const fz = Math.min(D - 0.001, Math.max(0, z - MINZ));
	const i = fx | 0;
	const j = fz | 0;
	const tx = fx - i;
	const tz = fz - j;
	const a = grid[j * GW + i];
	const b = grid[j * GW + i + 1];
	const c = grid[(j + 1) * GW + i];
	const d = grid[(j + 1) * GW + i + 1];
	return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

export const isWater = (x: number, z: number) => heightAt(x, z) < WATER_Y + 0.25;

export const clampX = (x: number) => Math.min(MAXX - 6, Math.max(MINX + 6, x));
export const clampZ = (z: number) => Math.min(MAXZ - 6, Math.max(MINZ + 6, z));

// ── ground colour (vertex colours: meadow variation + ploughed fields) ────
export const FIELDS = (() => {
	const r = mulberry32(99);
	const out: { x: number; z: number; w: number; d: number; a: number; tone: number }[] = [];
	for (let i = 0; i < 26; i++) {
		const x = MINX + 30 + r() * (W - 60);
		const z = (r() < 0.5 ? -1 : 1) * (48 + r() * 100);
		out.push({ x, z, w: 26 + r() * 34, d: 18 + r() * 24, a: (r() - 0.5) * 0.5, tone: r() });
	}
	return out;
})();

// ground colours are authored in sRGB (what you'd pick in a colour picker)
const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const DIRT = srgb(0.5, 0.43, 0.3);
const SAND = srgb(0.62, 0.57, 0.4);

function groundColor(x: number, z: number, h: number, out: THREE.Color) {
	const n1 = noise(x / 38 + 11, z / 38 - 5) * 0.5 + 0.5;
	const n2 = noise(x / 9, z / 9) * 0.5 + 0.5;
	out.setRGB(0.29 + 0.07 * n1, 0.46 + 0.08 * n1, 0.19 + 0.05 * n2, THREE.SRGBColorSpace);
	// crop fields with furrows
	for (const f of FIELDS) {
		const dx = x - f.x;
		const dz = z - f.z;
		const u = dx * Math.cos(f.a) + dz * Math.sin(f.a);
		const v = -dx * Math.sin(f.a) + dz * Math.cos(f.a);
		if (Math.abs(u) < f.w / 2 && Math.abs(v) < f.d / 2) {
			const furrow = Math.sin(u * 1.4) > 0 ? 1 : 0.9;
			if (f.tone < 0.35) out.setRGB(0.64 * furrow, 0.58 * furrow, 0.3 * furrow, THREE.SRGBColorSpace); // wheat
			else if (f.tone < 0.6) out.setRGB(0.44 * furrow, 0.34 * furrow, 0.22 * furrow, THREE.SRGBColorSpace); // ploughed
			else out.setRGB(0.37 * furrow, 0.54 * furrow, 0.22 * furrow, THREE.SRGBColorSpace); // young crop
			break;
		}
	}
	// road shoulders: packed dirt
	const dr = Math.abs(z - roadZ(x));
	if (dr < 9) out.lerp(DIRT, smooth(9, 6, dr) * 0.7);
	// shores
	if (h < WATER_Y + 0.9) out.lerp(SAND, smooth(WATER_Y + 0.9, WATER_Y + 0.2, h));
}

// ── ground shader patch ───────────────────────────────────────────────────

/** Smooth value noise, shared by the ground, water and grass shaders. */
export const NOISE_GLSL = /* glsl */ `
float gHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
	vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
	float a = gHash(i), b = gHash(i + vec2(1.0, 0.0)), c = gHash(i + vec2(0.0, 1.0)), d = gHash(i + vec2(1.0, 1.0));
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// drifting cloud shadow over the board: 0 = sunlit, 1 = under a cloud
float cloudShade(vec2 xz, float t){
	vec2 cp = xz * 0.0055 + vec2(t * 0.011, t * 0.004);
	float cl = vnoise(cp) * 0.6 + vnoise(cp * 2.3 + 7.1) * 0.4;
	return smoothstep(0.52, 0.72, cl);
}`;

/** Front-line geometry + Bull/Bear territory tint (mirrors wobble() in JS). */
export const TERRITORY_GLSL = /* glsl */ `
uniform float uFront, uTime;
float frontDist(vec3 wp){
	float wob = 2.2*sin(wp.z*0.045 + uTime*0.35) + 1.3*sin(wp.z*0.11 - uTime*0.5 + 1.7) + 0.7*sin(wp.z*0.23 + uTime*0.9 + 0.4);
	return wp.x - (uFront + wob);
}
vec3 territory(vec3 base, float fd){
	float lum = dot(base, vec3(0.299, 0.587, 0.114));
	vec3 bear = vec3(lum * 1.7, lum * 1.17, lum * 0.42);
	vec3 bull = base * vec3(0.94, 1.08, 0.9);
	return mix(bear, bull, smoothstep(-0.5, 0.5, fd));
}`;

export type GroundUniforms = {
	uFront: { value: number };
	uTime: { value: number };
	uBufBull: { value: number };
	uBufBear: { value: number };
	uMarkers: { value: THREE.Texture };
	uScorch: { value: THREE.Texture };
	uBoard: { value: THREE.Vector4 };
};

function patchGround(mat: THREE.MeshStandardMaterial, u: GroundUniforms) {
	mat.onBeforeCompile = (s) => {
		Object.assign(s.uniforms, u);
		s.vertexShader = s.vertexShader
			.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;')
			.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWNorm = normalize(mat3(modelMatrix) * objectNormal);')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
		s.fragmentShader = s.fragmentShader
			.replace(
				'#include <common>',
				`#include <common>
varying vec3 vWPos;
varying vec3 vWNorm;
uniform float uBufBull, uBufBear;
uniform sampler2D uMarkers, uScorch;
uniform vec4 uBoard;
${NOISE_GLSL}
${TERRITORY_GLSL}`
			)
			.replace(
				'#include <color_fragment>',
				`#include <color_fragment>
float fd = frontDist(vWPos);
float m1 = vnoise(vWPos.xz * 0.35);
float m2 = vnoise(vWPos.xz * 1.9 + 13.0);
vec3 gBase = diffuseColor.rgb * (0.9 + 0.12 * m1 + 0.06 * m2);
// hilltops catch more light, hollows hold shade
gBase *= 0.9 + clamp(vWPos.y, -2.0, 6.0) * 0.03;
// steep banks show bare earth
float slope = 1.0 - clamp(vWNorm.y, 0.0, 1.0);
gBase = mix(gBase, vec3(0.2, 0.14, 0.09), smoothstep(0.1, 0.32, slope) * 0.8);
vec3 gCol = territory(gBase, fd);
// no man's land: churned mud where the lines meet
float mudW = 3.8 + 2.2 * vnoise(vec2(vWPos.z * 0.12, 3.1));
float mud = 1.0 - smoothstep(mudW * 0.45, mudW, abs(fd) + (m1 - 0.5) * 2.2);
gCol = mix(gCol, vec3(0.1, 0.07, 0.045) * (0.7 + 0.6 * m2), mud * 0.9);
float bBull = (1.0 - smoothstep(0.0, uBufBull, fd)) * step(0.0, fd);
float bBear = (1.0 - smoothstep(0.0, uBufBear, -fd)) * step(fd, 0.0);
gCol = mix(gCol, vec3(0.42, 0.85, 0.46), bBull * 0.28);
gCol = mix(gCol, vec3(0.9, 0.36, 0.3), bBear * 0.28);
vec2 bUv = vec2((vWPos.x - uBoard.x) / uBoard.z, 1.0 - (vWPos.z - uBoard.y) / uBoard.w);
vec4 mk = texture2D(uMarkers, bUv);
gCol = mix(gCol, mk.rgb, mk.a);
vec4 sc = texture2D(uScorch, bUv);
gCol = mix(gCol, sc.rgb, sc.a);
gCol *= 1.0 - cloudShade(vWPos.xz, uTime) * 0.32;
diffuseColor.rgb = gCol;`
			)
			.replace(
				'#include <emissivemap_fragment>',
				`#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.78, 1.0, 0.86) * (exp(-abs(fd) / 0.3) * 1.5 + exp(-abs(fd) / 2.6) * 0.07);`
			);
	};
}

/** The height field as a texture, so the water shader knows its depth. */
export function heightTexture(): THREE.DataTexture {
	const data = new Uint16Array(GW * GD);
	for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(grid[i]);
	const t = new THREE.DataTexture(data, GW, GD, THREE.RedFormat, THREE.HalfFloatType);
	t.magFilter = THREE.LinearFilter;
	t.minFilter = THREE.LinearFilter;
	t.needsUpdate = true;
	return t;
}

// ── paint layers ──────────────────────────────────────────────────────────

/** Price-marker rows + end zones, painted into one big ground decal per round. */
export class MarkerPaint {
	readonly canvas = document.createElement('canvas');
	readonly tex: THREE.CanvasTexture;
	private ctx: CanvasRenderingContext2D;
	private s: number;

	constructor(width: number) {
		this.canvas.width = width;
		this.canvas.height = Math.round((width * D) / W);
		this.s = width / W;
		this.ctx = this.canvas.getContext('2d')!;
		this.tex = new THREE.CanvasTexture(this.canvas);
		this.tex.colorSpace = THREE.SRGBColorSpace;
		this.tex.generateMipmaps = true;
		this.tex.minFilter = THREE.LinearMipmapLinearFilter;
	}

	paint(
		rows: { x: number; label: string }[],
		ends: { x: number; label: string; color: string }[],
		font: string
	) {
		const { ctx, s } = this;
		const px = (x: number) => (x - MINX) * s;
		const pz = (z: number) => (z - MINZ) * s;
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		const labelEvery = 68;
		const labelZ: number[] = [];
		for (let z = MINZ + 26; z < MAXZ - 10; z += labelEvery) labelZ.push(z);

		for (const r of rows) {
			const x = px(r.x);
			// hash-mark "ladder": short bars across the row
			ctx.fillStyle = 'rgba(244, 244, 232, 0.8)';
			for (let z = MINZ + 3; z < MAXZ - 3; z += 3.3) {
				if (labelZ.some((lz) => Math.abs(z - lz) < 15)) continue;
				ctx.fillRect(x - 1.25 * s, pz(z) - 0.55 * s, 2.5 * s, 1.1 * s);
			}
			ctx.font = `${Math.round(3.9 * s)}px ${font}`;
			for (const lz of labelZ) {
				ctx.fillStyle = 'rgba(20, 24, 18, 0.35)';
				ctx.fillText(r.label, x + 0.35 * s, pz(lz) + 0.35 * s);
				ctx.fillStyle = 'rgba(248, 248, 238, 0.86)';
				ctx.fillText(r.label, x, pz(lz));
			}
		}

		for (const e of ends) {
			const x = px(e.x);
			// checkered end-zone band
			const cell = 1.6 * s;
			for (let zi = 0, z = 0; z < this.canvas.height; z += cell, zi++) {
				for (let k = 0; k < 2; k++) {
					ctx.fillStyle = (zi + k) % 2 ? e.color : 'rgba(250, 250, 244, 0.85)';
					ctx.fillRect(x - cell + k * cell, z, cell, cell);
				}
			}
			ctx.font = `${Math.round(3.4 * s)}px ${font}`;
			for (const lz of labelZ) {
				const z = pz(lz + labelEvery / 2);
				if (z > this.canvas.height - 10 * s) continue;
				ctx.save();
				ctx.translate(x, z);
				ctx.fillStyle = 'rgba(12, 14, 12, 0.72)';
				const w = ctx.measureText(e.label).width + 2.4 * s;
				ctx.fillRect(-w / 2, -2.6 * s, w, 5.2 * s);
				ctx.fillStyle = e.color;
				ctx.fillText(e.label, 0, 0.1 * s);
				ctx.restore();
			}
		}
		this.tex.needsUpdate = true;
	}
}

/** Scorch marks and craters that slowly weather away. */
export class ScorchPaint {
	readonly canvas = document.createElement('canvas');
	readonly tex: THREE.CanvasTexture;
	private ctx: CanvasRenderingContext2D;
	private s: number;
	private dirty = false;
	private lastUpload = 0;
	private lastFade = 0;

	constructor(width: number) {
		this.canvas.width = width;
		this.canvas.height = Math.round((width * D) / W);
		this.s = width / W;
		this.ctx = this.canvas.getContext('2d')!;
		this.tex = new THREE.CanvasTexture(this.canvas);
		this.tex.colorSpace = THREE.SRGBColorSpace;
	}

	crater(x: number, z: number, r: number) {
		const { ctx, s } = this;
		const cx = (x - MINX) * s;
		const cz = (z - MINZ) * s;
		const rr = Math.max(1.5, r * s);
		const g = ctx.createRadialGradient(cx, cz, 0, cx, cz, rr);
		g.addColorStop(0, 'rgba(28, 22, 16, 0.9)');
		g.addColorStop(0.45, 'rgba(48, 38, 26, 0.7)');
		g.addColorStop(0.8, 'rgba(70, 58, 40, 0.3)');
		g.addColorStop(1, 'rgba(70, 58, 40, 0)');
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(cx, cz, rr, 0, Math.PI * 2);
		ctx.fill();
		this.dirty = true;
	}

	/** Tank treads: a pair of short dark marks under the tracks, heading `rot`. */
	track(x: number, z: number, rot: number) {
		const { ctx, s } = this;
		ctx.save();
		ctx.translate((x - MINX) * s, (z - MINZ) * s);
		ctx.rotate(-rot);
		ctx.fillStyle = 'rgba(38, 30, 20, 0.32)';
		for (const side of [-1.24, 1.24]) ctx.fillRect(-0.45 * s, side * s - 0.28 * s, 0.9 * s, 0.56 * s);
		ctx.restore();
		this.dirty = true;
	}

	clear() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.dirty = true;
	}

	update(now: number) {
		if (now - this.lastFade > 2000) {
			this.lastFade = now;
			const { ctx } = this;
			ctx.globalCompositeOperation = 'destination-out';
			ctx.fillStyle = 'rgba(0,0,0,0.018)';
			ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
			ctx.globalCompositeOperation = 'source-over';
			this.dirty = true;
		}
		if (this.dirty && now - this.lastUpload > 350) {
			this.tex.needsUpdate = true;
			this.dirty = false;
			this.lastUpload = now;
		}
	}
}

// ── meshes ────────────────────────────────────────────────────────────────

export function buildGround(u: GroundUniforms): THREE.Mesh {
	const segX = 300;
	const segZ = 170;
	const g = new THREE.PlaneGeometry(W, D, segX, segZ);
	g.rotateX(-Math.PI / 2);
	const pos = g.attributes.position as THREE.BufferAttribute;
	const col = new Float32Array(pos.count * 3);
	const c = new THREE.Color();
	for (let i = 0; i < pos.count; i++) {
		const x = pos.getX(i);
		const z = pos.getZ(i);
		const h = heightAt(x, z);
		pos.setY(i, h);
		groundColor(x, z, h, c);
		col[i * 3] = c.r;
		col[i * 3 + 1] = c.g;
		col[i * 3 + 2] = c.b;
	}
	g.setAttribute('color', new THREE.BufferAttribute(col, 3));
	g.computeVertexNormals();
	const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
	patchGround(mat, u);
	const m = new THREE.Mesh(g, mat);
	m.receiveShadow = true;
	return m;
}

/** The slab's cut sides — a grass lip over bands of soil, clay and rock — and the dark table it sits on. */
export function buildSlab(): THREE.Group {
	const group = new THREE.Group();
	const pos: number[] = [];
	const col: number[] = [];
	// strata from the surface down: depth below the local ground, and colour
	const bands: [number, THREE.Color][] = [
		[0, srgb(0.3, 0.42, 0.18)],
		[0.8, srgb(0.24, 0.3, 0.13)],
		[1.1, srgb(0.29, 0.21, 0.13)],
		[3.4, srgb(0.36, 0.26, 0.16)],
		[6.2, srgb(0.47, 0.32, 0.19)],
		[9.5, srgb(0.4, 0.38, 0.35)],
		[13, srgb(0.27, 0.26, 0.24)]
	];
	const c = new THREE.Color();
	const edge = (pts: [number, number][]) => {
		for (let i = 0; i < pts.length - 1; i++) {
			const [x0, z0] = pts[i];
			const [x1, z1] = pts[i + 1];
			const h0 = heightAt(x0, z0);
			const h1 = heightAt(x1, z1);
			// each column gets a little colour jitter so the bands read as rock, not stripes
			const j0 = 0.9 + 0.2 * (noise(x0 * 0.3 + z0 * 0.3, 1.7) * 0.5 + 0.5);
			const j1 = 0.9 + 0.2 * (noise(x1 * 0.3 + z1 * 0.3, 1.7) * 0.5 + 0.5);
			const level = (h: number, k: number) => Math.max(SLAB_Y, k < bands.length ? h - bands[k][0] : SLAB_Y);
			for (let k = 0; k < bands.length; k++) {
				const ya0 = level(h0, k), yb0 = level(h0, k + 1);
				const ya1 = level(h1, k), yb1 = level(h1, k + 1);
				if (ya0 <= SLAB_Y && ya1 <= SLAB_Y) break;
				const ca = bands[k][1];
				const cb = bands[Math.min(k + 1, bands.length - 1)][1];
				const quad = [
					[x0, ya0, z0, ca, j0], [x0, yb0, z0, cb, j0], [x1, ya1, z1, ca, j1],
					[x1, ya1, z1, ca, j1], [x0, yb0, z0, cb, j0], [x1, yb1, z1, cb, j1]
				] as const;
				for (const [x, y, z, cc, j] of quad) {
					pos.push(x, y, z);
					c.copy(cc).multiplyScalar(j * (0.55 + 0.45 * Math.min(1, (y - SLAB_Y) / 8)));
					col.push(c.r, c.g, c.b);
				}
			}
		}
	};
	const step = 2;
	const south: [number, number][] = [];
	const north: [number, number][] = [];
	const west: [number, number][] = [];
	const east: [number, number][] = [];
	for (let x = MINX; x <= MAXX; x += step) {
		south.push([x, MAXZ]);
		north.push([MAXX - (x - MINX), MINZ]);
	}
	for (let z = MINZ; z <= MAXZ; z += step) {
		east.push([MAXX, MAXZ - (z - MINZ)]);
		west.push([MINX, z]);
	}
	edge(south);
	edge(north);
	edge(east);
	edge(west);
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
	g.computeVertexNormals();
	const sideMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, flatShading: true });
	// the sides the camera sees face away from the sun: let the strata glow a little so they still read
	sideMat.onBeforeCompile = (s) => {
		s.fragmentShader = s.fragmentShader.replace(
			'#include <emissivemap_fragment>',
			'#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.42;'
		);
	};
	const sides = new THREE.Mesh(g, sideMat);
	sides.receiveShadow = true;
	group.add(sides);

	const table = new THREE.Mesh(
		new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
		new THREE.MeshStandardMaterial({ color: '#0f1510', roughness: 1 })
	);
	table.position.y = SLAB_Y - 0.05;
	table.receiveShadow = true;
	group.add(table);
	return group;
}

/** Lakes: depth-tinted from the height field, rippling, foaming at the shore, under the same clouds. */
export function buildWater(uTime: { value: number }): THREE.Group {
	const group = new THREE.Group();
	const mat = new THREE.MeshStandardMaterial({
		color: '#ffffff',
		roughness: 0.08,
		metalness: 0.1,
		transparent: true
	});
	const hTex = heightTexture();
	mat.onBeforeCompile = (s) => {
		Object.assign(s.uniforms, {
			uTime,
			uHeight: { value: hTex },
			uBoard: { value: new THREE.Vector4(MINX, MINZ, W, D) },
			uWaterY: { value: WATER_Y }
		});
		s.vertexShader = s.vertexShader
			.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
		s.fragmentShader = s.fragmentShader
			.replace(
				'#include <common>',
				`#include <common>
varying vec3 vWPos;
uniform float uTime, uWaterY;
uniform sampler2D uHeight;
uniform vec4 uBoard;
${NOISE_GLSL}`
			)
			.replace(
				'#include <color_fragment>',
				`#include <color_fragment>
vec2 hUv = vec2((vWPos.x - uBoard.x + 0.5) / (uBoard.z + 1.0), (vWPos.z - uBoard.y + 0.5) / (uBoard.w + 1.0));
float wDepth = uWaterY - texture2D(uHeight, hUv).r;
vec3 wCol = mix(vec3(0.13, 0.46, 0.62), vec3(0.02, 0.13, 0.36), smoothstep(0.2, 2.6, wDepth));
float foamN = vnoise(vWPos.xz * 0.9 + vec2(uTime * 0.35, -uTime * 0.2));
float foam = 1.0 - smoothstep(0.0, 0.5, wDepth + (foamN - 0.5) * 0.35);
foam += (1.0 - smoothstep(0.0, 0.08, abs(wDepth - 0.55 - 0.12 * sin(uTime * 1.3)))) * 0.35;
wCol = mix(wCol, vec3(0.93, 0.95, 0.94), clamp(foam, 0.0, 1.0) * 0.85);
wCol *= 1.0 - cloudShade(vWPos.xz, uTime) * 0.3;
diffuseColor.rgb = wCol;
diffuseColor.a = mix(0.72, 0.95, smoothstep(0.0, 1.2, wDepth));`
			)
			.replace(
				'#include <normal_fragment_maps>',
				`#include <normal_fragment_maps>
vec2 wq = vWPos.xz * 0.42 + vec2(uTime * 0.33, uTime * 0.21);
float w0 = vnoise(wq), wx = vnoise(wq + vec2(0.3, 0.0)), wz = vnoise(wq + vec2(0.0, 0.3));
vec2 wq2 = vWPos.xz * 1.1 - vec2(uTime * 0.5, uTime * 0.12);
float v0 = vnoise(wq2), vx = vnoise(wq2 + vec2(0.3, 0.0)), vz = vnoise(wq2 + vec2(0.0, 0.3));
vec3 wn = normalize(vec3((w0 - wx) * 1.4 + (v0 - vx) * 0.7, 1.0, (w0 - wz) * 1.4 + (v0 - vz) * 0.7));
normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);`
			)
			.replace(
				'#include <emissivemap_fragment>',
				`#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.01, 0.05, 0.12);`
			);
	};
	for (const l of LAKES) {
		// a rectangle over the basin, clipped to the board so it never pokes out of the slab
		const R = l.r * 1.8;
		const x0 = Math.max(MINX, l.x - R);
		const x1 = Math.min(MAXX, l.x + R);
		const z0 = Math.max(MINZ, l.z - R);
		const z1 = Math.min(MAXZ, l.z + R);
		const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), mat);
		m.position.set((x0 + x1) / 2, WATER_Y, (z0 + z1) / 2);
		m.receiveShadow = true;
		group.add(m);
	}
	return group;
}

export function buildRoad(): THREE.Mesh {
	const halfW = 4.6;
	const pos: number[] = [];
	const uv: number[] = [];
	const idx: number[] = [];
	let dist = 0;
	let prev: THREE.Vector2 | null = null;
	let n = 0;
	for (let x = MINX; x <= MAXX; x += 2) {
		const z = roadZ(x);
		const dz = roadZ(x + 0.5) - roadZ(x - 0.5);
		const nx = -dz;
		const nz = 1;
		const l = Math.hypot(nx, nz);
		const p = new THREE.Vector2(x, z);
		if (prev) dist += p.distanceTo(prev);
		prev = p;
		for (const sgn of [-1, 1]) {
			const vx = x + (nx / l) * halfW * sgn;
			const vz = z + (nz / l) * halfW * sgn;
			pos.push(vx, heightAt(vx, vz) + 0.08, vz);
			uv.push(sgn < 0 ? 0 : 1, dist / 24);
		}
		if (n > 0) {
			const a = (n - 1) * 2;
			idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
		}
		n++;
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	g.setIndex(idx);
	g.computeVertexNormals();

	const c = document.createElement('canvas');
	c.width = 128;
	c.height = 256;
	const x = c.getContext('2d')!;
	x.fillStyle = '#403f43';
	x.fillRect(0, 0, 128, 256);
	const r = mulberry32(5);
	for (let i = 0; i < 1400; i++) {
		x.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.04 + r() * 0.05})`;
		x.fillRect(r() * 128, r() * 256, 2, 2);
	}
	x.fillStyle = '#c9a894';
	x.fillRect(0, 0, 12, 256);
	x.fillRect(116, 0, 12, 256);
	x.fillStyle = 'rgba(0,0,0,0.25)';
	x.fillRect(12, 0, 3, 256);
	x.fillRect(113, 0, 3, 256);
	x.fillStyle = '#e9e6dc';
	x.fillRect(61, 0, 6, 120);
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapT = THREE.RepeatWrapping;
	tex.anisotropy = 8;
	const m = new THREE.Mesh(
		g,
		new THREE.MeshStandardMaterial({
			map: tex,
			roughness: 0.9,
			polygonOffset: true,
			polygonOffsetFactor: -2,
			polygonOffsetUnits: -2
		})
	);
	m.receiveShadow = true;
	return m;
}
