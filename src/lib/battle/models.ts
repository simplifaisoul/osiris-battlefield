// Procedural low-poly models in the style of plastic toy army men. Every model is
// built facing +x, standing on y = 0, from merged primitives carrying vertex
// colours; team colour comes from the instance colour, so white parts take the
// plastic tint and dark parts stay dark.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Geo = THREE.BufferGeometry;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function tint(g: Geo, shade: number | THREE.Color): Geo {
	const c = typeof shade === 'number' ? new THREE.Color(shade, shade, shade) : shade;
	const n = g.attributes.position.count;
	const a = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		a[i * 3] = c.r;
		a[i * 3 + 1] = c.g;
		a[i * 3 + 2] = c.b;
	}
	g.setAttribute('color', new THREE.BufferAttribute(a, 3));
	return g;
}

export function merge(parts: Geo[]): Geo {
	const flat = parts.map((p) => {
		const g = p.index ? p.toNonIndexed() : p;
		g.deleteAttribute('uv');
		return g;
	});
	const m = mergeGeometries(flat)!;
	m.computeBoundingSphere();
	return m;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, shade: number | THREE.Color = 1, rx = 0, ry = 0, rz = 0) {
	const g = new THREE.BoxGeometry(w, h, d);
	if (rx) g.rotateX(rx);
	if (ry) g.rotateY(ry);
	if (rz) g.rotateZ(rz);
	g.translate(x, y, z);
	return tint(g, shade);
}

/** A box stretched between two points (limbs, barrels). */
function limb(a: THREE.Vector3, b: THREE.Vector3, t: number, shade: number | THREE.Color = 1, t2 = t) {
	const dir = b.clone().sub(a);
	const g = new THREE.BoxGeometry(dir.length(), t, t2);
	g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(1, 0, 0), dir.clone().normalize()));
	g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
	return tint(g, shade);
}

function ball(r: number, x: number, y: number, z: number, shade: number | THREE.Color = 1, sx = 1, sy = 1, sz = 1, seg = 8) {
	const g = new THREE.SphereGeometry(r, seg, Math.max(4, seg - 2));
	g.scale(sx, sy, sz);
	g.translate(x, y, z);
	return tint(g, shade);
}

function helmet(x: number, y: number, z: number) {
	const dome = new THREE.SphereGeometry(0.21, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2);
	dome.scale(1, 0.85, 1);
	dome.translate(x, y, z);
	const brim = new THREE.CylinderGeometry(0.25, 0.25, 0.035, 10);
	brim.translate(x, y, z);
	return [tint(dome, 1), tint(brim, 1)];
}

function cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, shade: number | THREE.Color = 1, rx = 0, rz = 0) {
	const g = new THREE.CylinderGeometry(rt, rb, h, seg);
	if (rx) g.rotateX(rx);
	if (rz) g.rotateZ(rz);
	g.translate(x, y, z);
	return tint(g, shade);
}

const GUN = 0.78;

// ── infantry: three poses ─────────────────────────────────────────────────

/** Standing, rifle shouldered and aimed along +x. */
export function soldierStand(): Geo {
	return merge([
		limb(V(0.1, 0.9, 0.12), V(0.16, 0.04, 0.14), 0.2, 1, 0.22),
		limb(V(-0.08, 0.9, -0.12), V(-0.24, 0.04, -0.16), 0.2, 1, 0.22),
		box(0.32, 0.64, 0.46, 0, 1.2, 0),
		box(0.34, 0.1, 0.48, 0, 0.92, 0, 0.85),
		ball(0.15, 0.04, 1.64, 0),
		...helmet(0.03, 1.68, 0),
		// trigger arm + support arm cradling the rifle
		limb(V(0, 1.44, -0.25), V(0.2, 1.32, -0.24), 0.12),
		limb(V(0.2, 1.32, -0.24), V(0.3, 1.42, -0.06), 0.11),
		limb(V(0.02, 1.44, 0.25), V(0.34, 1.3, 0.2), 0.12),
		limb(V(0.34, 1.3, 0.2), V(0.58, 1.4, 0.0), 0.11),
		limb(V(-0.08, 1.4, -0.05), V(1.0, 1.45, -0.03), 0.075, GUN),
		box(0.26, 0.14, 0.08, -0.06, 1.36, -0.05, GUN)
	]);
}

/** Kneeling, aiming. */
export function soldierKneel(): Geo {
	const d = -0.3;
	return merge([
		limb(V(0.04, 0.62, 0.13), V(0.46, 0.56, 0.13), 0.21),
		limb(V(0.46, 0.56, 0.13), V(0.46, 0.04, 0.13), 0.19),
		limb(V(-0.04, 0.62, -0.13), V(0.06, 0.1, -0.13), 0.21),
		limb(V(0.06, 0.1, -0.13), V(-0.46, 0.07, -0.13), 0.19),
		box(0.32, 0.62, 0.46, 0, 0.95, 0),
		ball(0.15, 0.04, 1.64 + d, 0),
		...helmet(0.03, 1.68 + d, 0),
		limb(V(0, 1.44 + d, -0.25), V(0.2, 1.32 + d, -0.24), 0.12),
		limb(V(0.2, 1.32 + d, -0.24), V(0.3, 1.42 + d, -0.06), 0.11),
		limb(V(0.02, 1.44 + d, 0.25), V(0.34, 1.3 + d, 0.2), 0.12),
		limb(V(0.34, 1.3 + d, 0.2), V(0.58, 1.4 + d, 0.0), 0.11),
		limb(V(-0.08, 1.4 + d, -0.05), V(1.0, 1.45 + d, -0.03), 0.075, GUN)
	]);
}

/** Running, rifle held across the chest. */
export function soldierRun(): Geo {
	return merge([
		limb(V(0.02, 0.9, 0.12), V(0.34, 0.5, 0.12), 0.21),
		limb(V(0.34, 0.5, 0.12), V(0.26, 0.04, 0.12), 0.19),
		limb(V(-0.02, 0.9, -0.12), V(-0.18, 0.46, -0.12), 0.21),
		limb(V(-0.18, 0.46, -0.12), V(-0.5, 0.24, -0.12), 0.19),
		box(0.32, 0.64, 0.46, 0.1, 1.2, 0, 1, 0, 0, -0.22),
		ball(0.15, 0.24, 1.62, 0),
		...helmet(0.23, 1.66, 0),
		limb(V(0.16, 1.44, -0.25), V(0.34, 1.18, -0.2), 0.12),
		limb(V(0.34, 1.18, -0.2), V(0.46, 1.34, -0.02), 0.11),
		limb(V(0.18, 1.44, 0.25), V(0.42, 1.36, 0.2), 0.12),
		limb(V(0.42, 1.36, 0.2), V(0.62, 1.56, 0.04), 0.11),
		limb(V(0.0, 1.02, 0.2), V(0.78, 1.72, -0.08), 0.075, GUN)
	]);
}

/** A little white skull left where a soldier fell. */
export function skull(): Geo {
	return merge([
		ball(0.3, 0, 0.34, 0, 1, 1.05, 0.95, 1, 9),
		box(0.26, 0.14, 0.3, 0.12, 0.12, 0),
		box(0.06, 0.1, 0.09, 0.28, 0.36, 0.1, 0.12),
		box(0.06, 0.1, 0.09, 0.28, 0.36, -0.1, 0.12)
	]);
}

// ── armour ─────────────────────────────────────────────────────────────────

export function tankHull(): Geo {
	const dark = 0.26;
	return merge([
		box(4.3, 0.8, 2.2, 0, 0.78, 0),
		box(1.0, 0.55, 2.16, 2.08, 0.96, 0, 0.95, 0, 0, 0.62),
		box(3.5, 0.34, 2.44, -0.15, 1.28, 0, 0.94),
		box(4.8, 0.86, 0.56, 0, 0.46, 1.24, dark),
		box(4.8, 0.86, 0.56, 0, 0.46, -1.24, dark),
		...[-1.6, -0.55, 0.55, 1.6].flatMap((x) => [
			cyl(0.34, 0.34, 0.06, 8, x, 0.42, 1.54, 0.4, Math.PI / 2),
			cyl(0.34, 0.34, 0.06, 8, x, 0.42, -1.54, 0.4, Math.PI / 2)
		]),
		box(0.5, 0.3, 0.5, -1.95, 1.55, 0.8, 0.7),
		box(0.5, 0.3, 0.5, -1.95, 1.55, -0.8, 0.7)
	]);
}

/** Turret + gun, pivoting about the hull's origin. Muzzle at TANK_MUZZLE. */
export function tankTurret(): Geo {
	const t = new THREE.CylinderGeometry(1.0, 1.18, 0.72, 6);
	t.scale(1.2, 1, 1);
	t.translate(-0.2, 1.8, 0);
	return merge([
		tint(t, 1),
		limb(V(0.7, 1.84, 0), V(3.3, 1.9, 0), 0.17, 0.82),
		box(0.34, 0.24, 0.24, 3.32, 1.9, 0, 0.6),
		cyl(0.3, 0.3, 0.14, 8, -0.5, 2.22, 0.34, 0.75),
		box(0.7, 0.2, 0.2, -0.4, 2.3, -0.5, 0.5)
	]);
}
export const TANK_MUZZLE = V(3.5, 1.9, 0);

export function rocketTruck(): Geo {
	const tire = 0.16;
	return merge([
		box(5.2, 0.36, 2.0, 0, 0.78, 0, 0.36),
		box(1.5, 1.35, 2.1, 1.95, 1.4, 0),
		box(0.06, 0.55, 1.7, 2.72, 1.66, 0, 0.18),
		box(2.9, 1.0, 1.84, -0.7, 1.72, 0, 0.92, 0, 0, 0.42),
		box(0.08, 0.86, 1.6, 0.66, 2.34, 0, 0.2, 0, 0, 0.42),
		...[2.0, -0.5, -1.7].flatMap((x) => [
			cyl(0.46, 0.46, 0.34, 10, x, 0.46, 0.98, tire, Math.PI / 2),
			cyl(0.46, 0.46, 0.34, 10, x, 0.46, -0.98, tire, Math.PI / 2)
		])
	]);
}
export const TRUCK_LAUNCH = V(0.7, 2.4, 0);

/** Anti-aircraft emplacement: a sandbagged pit and the gun's pedestal. */
export function aaMount(): Geo {
	const bag = new THREE.Color('#b8a275');
	const bags: Geo[] = [];
	for (let k = 0; k < 14; k++) {
		const a = (k / 14) * Math.PI * 2;
		bags.push(box(1.1, 0.5, 0.6, Math.cos(a) * 2.6, 0.25, Math.sin(a) * 2.6, bag, 0, -a + Math.PI / 2));
	}
	return merge([cyl(2.3, 2.5, 0.25, 12, 0, 0.12, 0, 0.45), cyl(0.35, 0.5, 1.3, 8, 0, 0.75, 0, 0.5), ...bags]);
}

/** The twin-barrelled gun, pivoting (yaw and elevation) about its own origin; barrels along +x. */
export function aaGuns(): Geo {
	return merge([
		box(1.3, 0.75, 1.1, 0, 0, 0),
		box(0.5, 0.9, 0.12, -0.2, 0.3, 0.62, 0.7),
		box(0.5, 0.9, 0.12, -0.2, 0.3, -0.62, 0.7),
		limb(V(0.5, 0.12, 0.26), V(3.1, 0.12, 0.26), 0.13, 0.35),
		limb(V(0.5, 0.12, -0.26), V(3.1, 0.12, -0.26), 0.13, 0.35),
		cyl(0.3, 0.3, 0.35, 8, -0.3, 0.45, 0, 0.3, Math.PI / 2)
	]);
}
export const AA_MUZZLE = 3.2;

// ── aircraft ─────────────────────────────────────────────────────────────

export function heliBody(): Geo {
	return merge([
		ball(1, 0.5, 0, 0, 1, 2.1, 0.95, 0.95, 10),
		ball(1, 1.75, 0.3, 0, 0.22, 0.85, 0.62, 0.72, 8),
		limb(V(-1.0, 0.15, 0), V(-4.4, 0.5, 0), 0.34, 0.95),
		box(0.8, 1.2, 0.1, -4.35, 0.95, 0, 0.9, 0, 0, 0.3),
		box(0.9, 0.08, 1.6, -4.1, 0.5, 0, 0.9),
		box(0.7, 0.12, 2.8, 0.3, -0.32, 0, 0.8),
		cyl(0.2, 0.2, 1.1, 8, 0.4, -0.45, 1.35, 0.4, 0, Math.PI / 2),
		cyl(0.2, 0.2, 1.1, 8, 0.4, -0.45, -1.35, 0.4, 0, Math.PI / 2),
		box(3.2, 0.08, 0.1, 0.5, -1.05, 0.72, 0.3),
		box(3.2, 0.08, 0.1, 0.5, -1.05, -0.72, 0.3),
		limb(V(1.2, -1.05, 0.72), V(1.0, -0.6, 0.55), 0.08, 0.3),
		limb(V(-0.3, -1.05, 0.72), V(-0.2, -0.6, 0.55), 0.08, 0.3),
		limb(V(1.2, -1.05, -0.72), V(1.0, -0.6, -0.55), 0.08, 0.3),
		limb(V(-0.3, -1.05, -0.72), V(-0.2, -0.6, -0.55), 0.08, 0.3),
		cyl(0.18, 0.22, 0.4, 8, 0.4, 1.0, 0, 0.5)
	]);
}

export function heliRotor(): Geo {
	return merge([box(9, 0.05, 0.36, 0, 0, 0, 0.25), box(0.36, 0.05, 9, 0, 0, 0, 0.25), cyl(0.22, 0.22, 0.2, 8, 0, 0, 0, 0.3)]);
}

/** A thin plate from an outline: in the x–z plane (wings), or x–y when `vertical` (fins). */
function plate(pts: [number, number][], t: number, y: number, shade: number | THREE.Color = 1, vertical = false) {
	const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b))), { depth: t, bevelEnabled: false });
	g.translate(0, 0, -t / 2);
	if (!vertical) g.rotateX(Math.PI / 2); // outline y → world z, thickness → world y
	g.translate(0, y, 0);
	return tint(g, shade);
}
const mirror = (pts: [number, number][]) => pts.map(([a, b]) => [a, -b] as [number, number]);

export function jet(): Geo {
	const nose = new THREE.ConeGeometry(0.56, 2.4, 10);
	nose.rotateZ(-Math.PI / 2);
	nose.translate(4.4, 0, 0);
	const wing: [number, number][] = [[1.4, 0.4], [-1.2, 4.9], [-2.3, 4.9], [-2.8, 0.4]];
	const tail: [number, number][] = [[-2.6, 0.3], [-3.6, 2.0], [-4.1, 2.0], [-3.9, 0.3]];
	return merge([
		cyl(0.58, 0.52, 6.4, 10, 0, 0, 0, 1, 0, Math.PI / 2),
		tint(nose, 1),
		ball(1, 2.2, 0.45, 0, 0.25, 1.25, 0.42, 0.46, 8),
		plate(wing, 0.14, -0.08, 0.95),
		plate(mirror(wing), 0.14, -0.08, 0.95),
		plate(tail, 0.1, 0.05, 0.95),
		plate(mirror(tail), 0.1, 0.05, 0.95),
		plate([[-2.3, 0.4], [-3.6, 2.4], [-4.2, 2.4], [-3.9, 0.4]], 0.12, 0, 0.92, true),
		cyl(0.5, 0.45, 0.5, 10, -3.4, 0, 0, 0.2, 0, Math.PI / 2)
	]);
}

export function bomber(): Geo {
	const nose = new THREE.ConeGeometry(0.95, 3, 10);
	nose.rotateZ(-Math.PI / 2);
	nose.translate(6.6, 0, 0);
	const wing: [number, number][] = [[2.6, 0.9], [0.4, 12.5], [-1.2, 12.5], [-1.6, 0.9]];
	const tail: [number, number][] = [[-4.0, 0.5], [-5.0, 3.8], [-5.8, 3.8], [-5.6, 0.5]];
	return merge([
		cyl(0.95, 0.85, 10.4, 10, 0.2, 0, 0, 1, 0, Math.PI / 2),
		tint(nose, 1),
		plate(wing, 0.24, 0.1, 0.94),
		plate(mirror(wing), 0.24, 0.1, 0.94),
		...[-7.2, -3.6, 3.6, 7.2].map((z) => cyl(0.45, 0.4, 2.4, 8, 1.4, -0.35, z, 0.55, 0, Math.PI / 2)),
		plate(tail, 0.16, 0.3, 0.94),
		plate(mirror(tail), 0.16, 0.3, 0.94),
		plate([[-4.2, 0.6], [-5.6, 3.6], [-6.3, 3.6], [-6.0, 0.6]], 0.16, 0, 0.94, true),
		ball(1, 4.6, 0.55, 0, 0.25, 1.4, 0.5, 0.6, 8)
	]);
}

export function bombShape(): Geo {
	return merge([cyl(0.22, 0.22, 1.0, 8, 0, 0, 0, 1, 0, Math.PI / 2), ball(0.22, 0.5, 0, 0, 1), box(0.3, 0.3, 0.04, -0.55, 0, 0, 1)]);
}

// ── scenery ────────────────────────────────────────────────────────────────

const PINE = new THREE.Color('#2f5d2a');
const PINE2 = new THREE.Color('#284f25');
const BARK = new THREE.Color('#5a3f28');
const LEAF = new THREE.Color('#3f6f2c');

export function pine(): Geo {
	const cone = (r: number, h: number, y: number, c: THREE.Color) => {
		const g = new THREE.ConeGeometry(r, h, 7);
		g.translate(0, y, 0);
		return tint(g, c);
	};
	return merge([cyl(0.2, 0.28, 1.4, 5, 0, 0.7, 0, BARK), cone(1.45, 2.5, 2.3, PINE2), cone(1.1, 2.1, 3.5, PINE), cone(0.72, 1.7, 4.55, PINE)]);
}

export function broadleaf(): Geo {
	const crown = new THREE.IcosahedronGeometry(1.55, 0);
	crown.scale(1, 0.9, 1);
	crown.translate(0, 3.1, 0);
	const crown2 = new THREE.IcosahedronGeometry(1.0, 0);
	crown2.translate(0.7, 3.8, 0.3);
	return merge([cyl(0.2, 0.28, 2.2, 5, 0, 1.1, 0, BARK), tint(crown, LEAF), tint(crown2, LEAF)]);
}

const WALL = new THREE.Color('#e9dcc0');
const ROOF = new THREE.Color('#8e4a33');
const BARN = new THREE.Color('#a4402f');
const SLATE = new THREE.Color('#4b4540');

function roofPrism(len: number, w: number, h: number, y: number, c: THREE.Color) {
	const g = new THREE.CylinderGeometry(1, 1, len, 3);
	g.rotateZ(Math.PI / 2); // ridge along x
	g.rotateX(-Math.PI / 2); // apex up
	g.scale(1, h / 1.5, w / 1.73);
	g.translate(0, y + h / 3, 0);
	return tint(g, c);
}

export function house(): Geo {
	return merge([
		box(3.4, 2.1, 2.6, 0, 1.05, 0, WALL),
		roofPrism(3.8, 3.1, 1.6, 2.1, ROOF),
		box(0.4, 1.0, 0.4, 0.9, 3.0, 0.5, 0.55),
		box(0.05, 0.8, 0.5, 1.72, 0.7, 0, 0.3),
		box(0.05, 0.5, 0.5, 1.72, 1.4, 0.8, 0.35)
	]);
}

export function barn(): Geo {
	return merge([box(5.4, 2.8, 3.6, 0, 1.4, 0, BARN), roofPrism(5.8, 4.2, 2.0, 2.8, SLATE), box(0.05, 1.8, 1.6, 2.72, 0.9, 0, 0.9)]);
}

export function rock(): Geo {
	const g = new THREE.DodecahedronGeometry(1, 0);
	g.scale(1.3, 0.7, 1);
	g.translate(0, 0.35, 0);
	return merge([tint(g, new THREE.Color('#8a8a82'))]);
}

export function sandbag(): Geo {
	return merge([box(1.1, 0.42, 0.6, 0, 0.21, 0, new THREE.Color('#b8a275'))]);
}
