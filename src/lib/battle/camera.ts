// Map-style camera: WASD / arrows / drag to pan, wheel or pinch to zoom toward
// the cursor, right-drag (or Q/E) to rotate. When left alone it drifts back to
// follow the front line. Explosions shake it.

import * as THREE from 'three';
import { MINX, MAXX, MINZ, MAXZ } from './world';

const DEG = Math.PI / 180;
export const HOME = { dist: 470, yaw: 30 * DEG, pitch: 52 * DEG };

export class CameraRig {
	readonly camera: THREE.PerspectiveCamera;
	target = new THREE.Vector3();
	dist = HOME.dist;
	yaw = HOME.yaw;
	pitch = HOME.pitch;
	private goal = { target: new THREE.Vector3(), dist: HOME.dist, yaw: HOME.yaw, pitch: HOME.pitch };
	private shake = 0;
	private lastInput = -1e9;
	private keys = new Set<string>();
	private pointers = new Map<number, { x: number; y: number }>();
	private drag: { mode: 'pan' | 'rotate'; x: number; y: number } | null = null;
	private pinch = 0;
	private ray = new THREE.Raycaster();
	private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	private listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];
	private tap: { x: number; y: number; t: number; moved: number } | null = null;
	/** A click that wasn't a drag, in canvas pixels. */
	onTap: ((x: number, y: number) => void) | null = null;
	/** While set, the camera rides along over this point; any pan by hand lets go. */
	follow: THREE.Vector3 | null = null;
	onFollowEnd: (() => void) | null = null;

	constructor(private el: HTMLElement) {
		this.camera = new THREE.PerspectiveCamera(34, 1, 1, 6000);
		this.on(el, 'pointerdown', (e) => this.down(e as PointerEvent));
		this.on(window, 'pointermove', (e) => this.move(e as PointerEvent));
		this.on(window, 'pointerup', (e) => this.up(e as PointerEvent));
		this.on(window, 'pointercancel', (e) => this.up(e as PointerEvent));
		this.on(el, 'wheel', (e) => this.wheel(e as WheelEvent), { passive: false });
		this.on(el, 'contextmenu', (e) => e.preventDefault());
		this.on(window, 'keydown', (e) => this.key(e as KeyboardEvent, true));
		this.on(window, 'keyup', (e) => this.key(e as KeyboardEvent, false));
		this.on(window, 'blur', () => this.keys.clear());
	}

	private on(t: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) {
		t.addEventListener(type, fn, opts);
		this.listeners.push([t, type, fn, opts]);
	}

	dispose() {
		for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
	}

	private touched() {
		this.lastInput = performance.now();
	}

	/** Snap the view back over `point` at the home angle. */
	recenter(point: THREE.Vector3) {
		this.goal.target.copy(point);
		this.goal.dist = HOME.dist;
		this.goal.yaw = HOME.yaw;
		this.goal.pitch = HOME.pitch;
		this.lastInput = -1e9;
	}

	/** Ease in (never out) to at most `dist`. */
	zoomTo(dist: number) {
		this.goal.dist = Math.min(this.goal.dist, dist);
	}

	jolt(amount: number) {
		this.shake = Math.min(3, this.shake + amount);
	}

	// ── input ──────────────────────────────────────────────────────────

	private key(e: KeyboardEvent, down: boolean) {
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
		const k = e.key.toLowerCase();
		if (!['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) return;
		if (down) this.keys.add(k);
		else this.keys.delete(k);
		this.touched();
	}

	private down(e: PointerEvent) {
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (this.pointers.size === 1) {
			const rotate = e.button === 2 || e.ctrlKey || e.shiftKey;
			this.drag = { mode: rotate ? 'rotate' : 'pan', x: e.clientX, y: e.clientY };
			this.tap = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 } : null;
		} else if (this.pointers.size === 2) {
			this.tap = null;
			this.drag = null;
			const [a, b] = [...this.pointers.values()];
			this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
		}
		this.touched();
	}

	private move(e: PointerEvent) {
		const p = this.pointers.get(e.pointerId);
		if (!p) return;
		const dx = e.clientX - p.x;
		const dy = e.clientY - p.y;
		p.x = e.clientX;
		p.y = e.clientY;
		if (this.tap) this.tap.moved += Math.abs(dx) + Math.abs(dy);
		// a deliberate drag of the map lets go of whatever the camera was following
		if (this.follow && this.drag?.mode === 'pan' && (this.tap?.moved ?? 99) > 6) this.release();
		if (this.pointers.size === 2) {
			const [a, b] = [...this.pointers.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (this.pinch > 0) this.zoomBy(this.pinch / Math.max(1, d));
			this.pinch = d;
			this.pan(dx / 2, dy / 2);
		} else if (this.drag?.mode === 'pan') this.pan(dx, dy);
		else if (this.drag?.mode === 'rotate') {
			this.goal.yaw -= dx * 0.005;
			this.goal.pitch = Math.min(82 * DEG, Math.max(22 * DEG, this.goal.pitch + dy * 0.004));
		}
		this.touched();
	}

	private up(e: PointerEvent) {
		const wasTap = this.tap && this.pointers.size === 1 && this.tap.moved < 6 && performance.now() - this.tap.t < 450;
		this.pointers.delete(e.pointerId);
		if (this.pointers.size < 2) this.pinch = 0;
		if (this.pointers.size === 0) this.drag = null;
		if (wasTap && e.type === 'pointerup') {
			const r = this.el.getBoundingClientRect();
			this.onTap?.(e.clientX - r.left, e.clientY - r.top);
		}
		this.tap = null;
	}

	private release() {
		this.follow = null;
		this.onFollowEnd?.();
	}

	private wheel(e: WheelEvent) {
		e.preventDefault();
		const f = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.0022);
		// zoom toward the ground point under the cursor
		const r = this.el.getBoundingClientRect();
		const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
		this.ray.setFromCamera(ndc, this.camera);
		const hit = new THREE.Vector3();
		const before = this.goal.dist;
		this.zoomBy(f);
		if (f < 1 && this.ray.ray.intersectPlane(this.plane, hit)) {
			const k = 1 - this.goal.dist / before;
			this.goal.target.x += (hit.x - this.goal.target.x) * k;
			this.goal.target.z += (hit.z - this.goal.target.z) * k;
		}
		this.touched();
	}

	private zoomBy(f: number) {
		this.goal.dist = Math.min(640, Math.max(28, this.goal.dist * f));
	}

	/** Pan by screen pixels, keeping the ground under the pointer. */
	private pan(dx: number, dy: number) {
		const h = this.el.clientHeight || 1;
		const wpp = (2 * this.dist * Math.tan((this.camera.fov * DEG) / 2)) / h;
		const rx = Math.cos(this.yaw);
		const rz = Math.sin(this.yaw);
		const fx = Math.sin(this.yaw);
		const fz = -Math.cos(this.yaw);
		const k = 1 / Math.max(0.35, Math.sin(this.pitch));
		this.goal.target.x += -dx * wpp * rx + dy * wpp * k * fx;
		this.goal.target.z += -dx * wpp * rz + dy * wpp * k * fz;
	}

	// ── frame ──────────────────────────────────────────────────────────

	update(dt: number, follow: THREE.Vector3) {
		const g = this.goal;
		// keyboard pan / rotate
		const sp = this.dist * 1.1 * dt;
		const fx = Math.sin(this.yaw);
		const fz = -Math.cos(this.yaw);
		const rx = Math.cos(this.yaw);
		const rz = Math.sin(this.yaw);
		for (const k of this.keys) {
			if (k === 'w' || k === 'arrowup') (g.target.x += fx * sp), (g.target.z += fz * sp);
			if (k === 's' || k === 'arrowdown') (g.target.x -= fx * sp), (g.target.z -= fz * sp);
			if (k === 'd' || k === 'arrowright') (g.target.x += rx * sp), (g.target.z += rz * sp);
			if (k === 'a' || k === 'arrowleft') (g.target.x -= rx * sp), (g.target.z -= rz * sp);
			if (k === 'q') g.yaw += dt * 1.2;
			if (k === 'e') g.yaw -= dt * 1.2;
		}
		if (this.keys.size) {
			this.touched();
			if (this.follow && [...this.keys].some((k) => k !== 'q' && k !== 'e')) this.release();
		}

		if (this.follow) {
			// ride along with the followed unit
			g.target.x = this.follow.x;
			g.target.z = this.follow.z;
			this.touched();
		} else if (performance.now() - this.lastInput > 14_000) {
			// idle: ease back onto the front line
			const k = 1 - Math.exp(-dt * 0.6);
			g.target.x += (follow.x - g.target.x) * k;
			g.target.z += (follow.z - g.target.z) * k;
		}
		g.target.x = Math.min(MAXX + 40, Math.max(MINX - 40, g.target.x));
		g.target.z = Math.min(MAXZ + 40, Math.max(MINZ - 40, g.target.z));

		const k = 1 - Math.exp(-dt * 7);
		this.target.lerp(g.target, k);
		this.dist += (g.dist - this.dist) * k;
		this.yaw += (g.yaw - this.yaw) * k;
		this.pitch += (g.pitch - this.pitch) * k;

		const cp = Math.cos(this.pitch);
		const cam = this.camera;
		cam.position.set(
			this.target.x - Math.sin(this.yaw) * cp * this.dist,
			this.target.y + Math.sin(this.pitch) * this.dist,
			this.target.z + Math.cos(this.yaw) * cp * this.dist
		);
		cam.lookAt(this.target);
		if (this.shake > 0.001) {
			const a = this.shake * this.dist * 0.004;
			cam.position.x += (Math.random() - 0.5) * a;
			cam.position.y += (Math.random() - 0.5) * a;
			cam.position.z += (Math.random() - 0.5) * a;
			this.shake *= Math.exp(-dt * 5);
		}
	}
}
