// The battlefield. Ties the world, armies, air strikes, effects, camera and
// audio together and runs the round: a price range centred on the price at the
// start, with end zones four marker rows out. The front line sits exactly on the
// live price. Push through an end zone and that side wins the range; the field
// resets around the latest price and the next battle begins.

import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import * as W from './world';
import { buildScenery, type Scenery } from './scenery';
import { Army, BULL, BEAR, DIR, type Pick } from './army';
import { Air, type StrikeKind } from './air';
import { Fx } from './fx';
import { Nukes } from './nuke';
import { CameraRig } from './camera';
import { WarAudio } from './audio';
import type { Forces } from '$lib/market/types';

export type Team = 'bull' | 'bear';

export type RoundEvent =
	| { type: 'new'; round: number; lo: number; hi: number; center: number }
	| { type: 'win'; round: number; winner: Team; level: number };

/** Live facts about the unit picked on the field. */
export type Selected = {
	kind: 'soldier' | 'tank';
	team: Team;
	wallet: string | null;
	alive: boolean;
	kills: number;
	bornAt: number; // ms it took the field
	bornFront: number; // price / market cap it took the field at
	record: { soldiers: number; tanks: number; kills: number; deaths: number } | null; // its wallet, all units
};

export type BattleStats = {
	selected: Selected | null;
	fps: number;
	soldiers: [number, number];
	tanks: [number, number];
	casualties: [number, number];
	round: number;
	wins: [number, number];
	phase: 'idle' | 'fight' | 'victory';
	progress: number; // 0 = Bears' end zone, 1 = Bulls' end zone
};

/** How the current theater's prices map onto the board. */
export type Scale = {
	step(price: number): number;
	level(v: number): string;
	price(v: number): string;
	current: string; // "CURRENT PRICE"
};

const GROUND_FONT = '"Press Start 2P", ui-monospace, monospace';
const VICTORY_SECONDS = 6.5;

export class Battlefield {
	private renderer: THREE.WebGLRenderer;
	private composer: EffectComposer;
	private scene = new THREE.Scene();
	private rig: CameraRig;
	private sun: THREE.DirectionalLight;
	private shadowExtent = 0;
	private ground: THREE.Mesh;
	private uniforms: W.GroundUniforms;
	private markers: W.MarkerPaint;
	private scorch: W.ScorchPaint;
	private army: Army;
	private air: Air;
	private nukes: Nukes;
	private fx: Fx;
	readonly audio = new WarAudio();

	private scale: Scale | null = null;
	private price = 0;
	private round = 0;
	private center = 0;
	private step = 1;
	private lo = 0;
	private hi = 0;
	private phase: BattleStats['phase'] = 'idle';
	private phaseT = 0;
	private winner = -1;
	private wins: [number, number] = [0, 0];
	private front = 0;
	private vol = 0;
	private buf = [14, 14];
	private scenery: Scenery;
	private hazeT = 0;
	private selected: Pick | null = null;
	private marker = new THREE.Group();

	private label: { mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; text: string; at: number };
	private signs: THREE.Sprite[] = [];
	private flags: { mesh: THREE.Mesh; base: Float32Array }[] = [];
	private raf = 0;
	private last = performance.now();
	private frames = 0;
	private fpsAt = performance.now();
	private fps = 60;
	private slowFor = 0;
	private statsAt = 0;
	private ro: ResizeObserver;
	private mobile: boolean;
	private infantry: number;
	private disposed = false;

	constructor(
		private canvas: HTMLCanvasElement,
		private on: {
			round(e: RoundEvent): void;
			stats(s: BattleStats): void;
			flash(strength: number): void;
			select(s: Selected | null): void;
			followEnded(): void;
		}
	) {
		this.mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
		this.infantry = this.mobile ? 640 : 1150;

		const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
		r.setPixelRatio(Math.min(devicePixelRatio, this.mobile ? 1.5 : 1.75));
		r.shadowMap.enabled = true;
		r.shadowMap.type = THREE.PCFSoftShadowMap;
		r.toneMapping = THREE.NoToneMapping;
		r.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer = r;

		const bg = new THREE.Color('#0b100c');
		this.scene.background = bg;
		this.scene.fog = new THREE.Fog(bg, 400, 1400);

		this.rig = new CameraRig(canvas);
		this.rig.onTap = (x, y) => {
			const p = this.army.pick(this.rig.camera, x, y, canvas.clientWidth, canvas.clientHeight);
			this.selected = p;
			this.on.select(p ? this.describe(p) : null);
		};
		this.rig.onFollowEnd = () => this.on.followEnded();

		// light: soft sky fill + a warm low sun from the upper left of the view
		this.scene.add(new THREE.HemisphereLight('#dde8ff', '#4b3f2b', 1.2));
		this.sun = new THREE.DirectionalLight('#fff0da', 2.8);
		this.sun.castShadow = true;
		this.sun.shadow.mapSize.set(this.mobile ? 1024 : 2048, this.mobile ? 1024 : 2048);
		this.sun.shadow.bias = -0.0004;
		this.sun.shadow.normalBias = 0.4;
		this.sun.shadow.camera.near = 10;
		this.sun.shadow.camera.far = 900;
		this.scene.add(this.sun, this.sun.target);

		// ground + paint layers
		this.markers = new W.MarkerPaint(this.mobile ? 2048 : 4096);
		this.markers.tex.anisotropy = r.capabilities.getMaxAnisotropy();
		this.scorch = new W.ScorchPaint(this.mobile ? 1024 : 1536);
		this.uniforms = {
			uFront: { value: 0 },
			uTime: { value: 0 },
			uBufBull: { value: 14 },
			uBufBear: { value: 14 },
			uMarkers: { value: this.markers.tex },
			uScorch: { value: this.scorch.tex },
			uBoard: { value: new THREE.Vector4(W.MINX, W.MINZ, W.W, W.D) }
		};
		this.ground = W.buildGround(this.uniforms);
		this.scene.add(this.ground, W.buildSlab(), W.buildWater(this.uniforms.uTime), W.buildRoad());
		this.scenery = buildScenery({ uTime: this.uniforms.uTime, uFront: this.uniforms.uFront }, this.mobile);
		this.scene.add(this.scenery.group);
		this.scenery.group.traverse((o) => {
			if (o instanceof THREE.Sprite && o.name === 'sign') this.signs.push(o);
			if (o instanceof THREE.Mesh && o.name === 'flag') {
				const pos = o.geometry.attributes.position.array as Float32Array;
				this.flags.push({ mesh: o, base: pos.slice() });
			}
		});

		this.fx = new Fx({
			shake: (a, x, z) => {
				const d = Math.hypot(x - this.rig.target.x, z - this.rig.target.z);
				this.rig.jolt(a * Math.max(0, 1 - d / (this.rig.dist * 1.4 + 40)));
			},
			sound: (kind, x, z, s) => this.audio.play(kind, x, z, s),
			crater: (x, z, rad) => this.scorch.crater(x, z, rad)
		});
		this.army = new Army(this.fx, {
			shot: (x, z) => this.audio.play('shot', x, z),
			cannon: (x, z) => this.audio.play('cannon', x, z),
			track: (x, z, rot) => this.scorch.track(x, z, rot)
		});
		this.air = new Air(this.fx, this.army, {
			sound: (k, x, z) => this.audio.play(k, x, z),
			nuke: (x, z, s, victims) => this.detonate(x, z, s, victims)
		});
		this.nukes = new Nukes(this.fx);
		this.scene.add(this.army.group, this.air.group, this.fx.group, this.nukes.group);

		this.label = this.makeLabel();
		this.scene.add(this.label.mesh);

		// the picked unit: a gold ring on the ground and a thin beam of light above it
		const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.8, 0.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
		this.marker.add(new THREE.Mesh(new THREE.RingGeometry(1.3, 1.7, 40).rotateX(-Math.PI / 2), ringMat));
		const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 14, 6).translate(0, 7, 0), ringMat);
		this.marker.add(beam);
		this.marker.visible = false;
		this.marker.renderOrder = 30;
		this.scene.add(this.marker);

		// post: HDR → bloom (fire, tracers, the front line) → tone map → vignette
		this.composer = new EffectComposer(r, {
			frameBufferType: THREE.HalfFloatType,
			multisampling: Math.min(4, r.capabilities.maxSamples)
		});
		this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
		this.composer.addPass(
			new EffectPass(
				this.rig.camera,
				new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.92, luminanceSmoothing: 0.25, intensity: 1.1, radius: 0.7 }),
				new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }),
				new VignetteEffect({ offset: 0.3, darkness: 0.6 })
			)
		);

		this.ro = new ResizeObserver(() => this.resize());
		this.ro.observe(canvas.parentElement ?? canvas);
		this.resize();
		this.rig.recenter(new THREE.Vector3(0, 0, W.roadZ(0)));
		this.rig.update(1, new THREE.Vector3());

		// the ground labels use a pixel font; repaint once it has loaded
		document.fonts?.load(`16px ${GROUND_FONT}`).then(() => this.paintMarkers(), () => {});
		this.raf = requestAnimationFrame(this.loop);
	}

	// ── public API ─────────────────────────────────────────────────────

	/** Switch theater: the next price starts a fresh battle on the new scale. */
	setScale(s: Scale) {
		this.scale = s;
		this.phase = 'idle';
		this.price = 0;
		this.army.clear();
		this.air.clear();
		this.nukes.clear();
		this.fx.clear();
		this.scorch.clear();
		this.front = 0;
		this.selected = null;
		this.rig.follow = null;
		this.markers.paint([], [], GROUND_FONT);
		this.label.text = '';
	}

	setPrice(p: number) {
		if (!(p > 0) || !this.scale) return;
		this.price = p;
		if (this.phase === 'idle') this.startRound(p);
	}

	/** Size the armies from the book and the tape. `heavyRef` = a tank-sized trade. */
	setForces(f: Forces, heavyRef: number) {
		const wall = (f.bidWall + 1) / (f.bidWall + f.askWall + 2);
		const flowTot = f.flowBuy + f.flowSell;
		const flow = flowTot > 0 ? f.flowBuy / flowTot : 0.5;
		const w = Math.min(1, flowTot / Math.max(1, heavyRef));
		const share = Math.min(0.8, Math.max(0.2, 0.5 + (wall - 0.5) * 0.8 + (flow - 0.5) * 0.9 * w));
		const bulls = Math.round(this.infantry * share);
		const heavy = f.heavyBuy + f.heavySell;
		const intensity = Math.min(1, Math.log10(1 + heavy / Math.max(1, heavyRef)) / 1.5);
		const hShare = (f.heavyBuy + 1) / (heavy + 2);
		const tanks = (hs: number, sh: number) => Math.min(20, Math.max(2, Math.round(3 + 14 * intensity * hs + 6 * (sh - 0.5))));
		const trucks = (sh: number) => Math.min(4, 1 + Math.round(2 * f.volatility) + (sh > 0.55 ? 1 : 0));
		this.army.targets = {
			inf: [bulls, this.infantry - bulls],
			tanks: [tanks(hShare, share), tanks(1 - hShare, 1 - share)],
			launchers: [trucks(share), trucks(1 - share)]
		};
		this.vol = f.volatility;
		const bidShare = (f.bidWall + 1) / (f.bidWall + f.askWall + 2);
		this.buf = [5 + 26 * bidShare, 5 + 26 * (1 - bidShare)];
	}

	/** A trade reached the field: a fresh squad, and armour for a big one. */
	reinforce(team: Team, soldiers: number, tank: boolean, wallet?: string) {
		if (this.phase !== 'fight') return;
		const s = team === 'bull' ? BULL : BEAR;
		if (soldiers > 0) this.army.squad(s, soldiers, wallet);
		if (tank) this.army.deployTank(s, wallet);
	}

	/** `attacker` flies the strike; it lands on the other side. */
	strike(kind: StrikeKind | 'barrage', attacker: Team, scale = 1) {
		if (this.phase === 'idle') return;
		const s = attacker === 'bull' ? BULL : BEAR;
		if (kind === 'barrage') this.army.barrage(s, Math.round(3 + 3 * scale));
		else if (kind === 'nuke' || this.air.active < 12) this.air.strike(kind, s, scale);
	}

	/** A warhead landed: mushroom cloud, everything close in dies, the enemy further out. */
	private detonate(x: number, z: number, scale: number, victims: number) {
		const y = W.heightAt(x, z);
		this.nukes.spawn(x, y, z, scale);
		this.army.blast(x, z, 13 * scale, 1, -1);
		this.army.blast(x, z, 32 * scale, 0.95, victims);
		this.scorch.crater(x, z, 22 * scale);
		this.scorch.crater(x, z, 12 * scale);
		// the fireball chars the woods and villages around ground zero and leaves them burning
		this.scenery.scorch(x, z, 30 * scale);
		for (let k = 0; k < 14; k++) {
			const a = Math.random() * Math.PI * 2;
			const r = (6 + Math.random() * 22) * scale;
			this.fx.burn(x + Math.cos(a) * r, z + Math.sin(a) * r, 1 + Math.random(), 12 + Math.random() * 14);
		}
		this.rig.jolt(3);
		this.audio.play('nuke', x, z, scale);
		const d = Math.hypot(x - this.rig.target.x, z - this.rig.target.z);
		this.on.flash(Math.max(0.35, 1 - d / (this.rig.dist * 2.5)));
	}

	recenter() {
		this.follow(false);
		this.rig.recenter(new THREE.Vector3(this.front, 0, W.roadZ(this.front)));
	}

	/** Who deploys first on each side: wallets in priority order. Units draw identities from these. */
	setRoster(bull: string[], bear: string[]) {
		this.army.setRoster(BULL, bull);
		this.army.setRoster(BEAR, bear);
	}

	/** Gold-highlight every unit of a wallet (null clears). Returns what it has on the field. */
	track(wallet: string | null) {
		this.army.track(wallet);
		return wallet ? this.army.record(wallet) : null;
	}

	/** A wallet's units on the field and its kills / losses this session. */
	record(wallet: string) {
		return this.army.record(wallet);
	}

	/** Pick one of a wallet's units (soldier or tank) so the camera can find it. */
	selectWallet(wallet: string): Selected | null {
		const p = this.army.unitOf(wallet);
		this.selected = p;
		const d = p ? this.describe(p) : null;
		this.on.select(d);
		return d;
	}

	clearSelection() {
		this.selected = null;
		this.follow(false);
		this.on.select(null);
	}

	/** Ride the camera along with the selected unit. */
	follow(on: boolean) {
		const info = on && this.selected ? this.army.info(this.selected) : null;
		this.rig.follow = info ? new THREE.Vector3(info.x, 0, info.z) : null;
		if (info) this.rig.zoomTo(90);
	}

	private describe(p: Pick): Selected | null {
		const i = this.army.info(p);
		if (!i) return null;
		return {
			kind: i.kind,
			team: i.side === BULL ? 'bull' : 'bear',
			wallet: i.wallet,
			alive: i.alive,
			kills: i.kills,
			bornAt: i.bornAt,
			bornFront: i.bornFront,
			record: i.wallet ? this.army.record(i.wallet) : null
		};
	}

	setSound(on: boolean) {
		this.audio.setEnabled(on);
	}

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.raf);
		this.ro.disconnect();
		this.rig.dispose();
		this.audio.dispose();
		this.composer.dispose();
		this.renderer.dispose();
	}

	// ── rounds ─────────────────────────────────────────────────────────

	private frontFor(p: number) {
		return (-(p - this.center) / this.step) * W.SPACING;
	}

	private startRound(p: number) {
		const s = this.scale!;
		this.round++;
		this.center = p;
		this.step = s.step(p);
		this.lo = p - W.RANGE_STEPS * this.step;
		this.hi = p + W.RANGE_STEPS * this.step;
		this.phase = 'fight';
		this.phaseT = 0;
		this.winner = -1;
		this.army.clear();
		this.air.clear();
		this.fx.clear();
		this.scorch.clear();
		this.front = 0;
		this.army.front = 0;
		this.army.seed();
		this.paintMarkers();
		this.label.text = '';
		this.on.round({ type: 'new', round: this.round, lo: this.lo, hi: this.hi, center: p });
		this.audio.play('round');
	}

	private win(side: number) {
		this.phase = 'victory';
		this.phaseT = 0;
		this.winner = side;
		this.wins[side]++;
		const team: Team = side === BULL ? 'bull' : 'bear';
		this.on.round({ type: 'win', round: this.round, winner: team, level: side === BULL ? this.hi : this.lo });
		this.audio.play('victory');
		// the victors' air force hits the beaten line and its HQ
		this.air.strike('bomber', side, 1.4);
		const loserHQ = side === BULL ? W.HQ.bear : W.HQ.bull;
		setTimeout(() => !this.disposed && this.air.strike('jet', side, 1.5, { x: loserHQ.x, z: loserHQ.z }), 1400);
	}

	private paintMarkers() {
		if (!this.scale || this.phase === 'idle') return;
		const s = this.scale;
		const rows: { x: number; label: string }[] = [];
		const xHi = this.frontFor(this.hi);
		const xLo = this.frontFor(this.lo);
		const k0 = Math.ceil((this.center - 8 * this.step) / this.step);
		const k1 = Math.floor((this.center + 8 * this.step) / this.step);
		for (let k = k0; k <= k1; k++) {
			const level = k * this.step;
			const x = this.frontFor(level);
			if (x < W.MINX + 12 || x > W.MAXX - 12) continue;
			if (Math.abs(x - xHi) < 7 || Math.abs(x - xLo) < 7) continue;
			rows.push({ x, label: s.level(level) });
		}
		this.markers.paint(
			rows,
			[
				{ x: xHi, label: 'BULLS WIN ' + s.level(this.hi), color: '#44d27a' },
				{ x: xLo, label: 'BEARS WIN ' + s.level(this.lo), color: '#f0605a' }
			],
			GROUND_FONT
		);
	}

	// ── the "CURRENT PRICE" ground label ───────────────────────────────

	private makeLabel() {
		const canvas = document.createElement('canvas');
		canvas.width = 1024;
		canvas.height = 256;
		const tex = new THREE.CanvasTexture(canvas);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 8;
		const g = new THREE.PlaneGeometry(40, 10);
		g.rotateX(-Math.PI / 2);
		g.translate(20, 0, 0); // anchored at its left edge
		const mesh = new THREE.Mesh(
			g,
			new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
		);
		mesh.renderOrder = 5;
		return { mesh, canvas, tex, text: '', at: 0 };
	}

	private updateLabel(now: number) {
		const s = this.scale;
		const L = this.label;
		L.mesh.visible = this.phase !== 'idle' && !!s;
		if (!s || this.phase === 'idle') return;
		const x0 = this.front + 2.5;
		const z = W.roadZ(x0 + 20) - 17;
		let y = -99;
		for (let dx = 0; dx <= 40; dx += 8) for (let dz = -5; dz <= 5; dz += 5) y = Math.max(y, W.heightAt(x0 + dx, z + dz));
		L.mesh.position.set(x0, y + 0.12, z);
		const text = s.price(this.price);
		if (text === L.text || now - L.at < 120) return;
		L.text = text;
		L.at = now;
		const c = L.canvas.getContext('2d')!;
		c.clearRect(0, 0, 1024, 256);
		c.textBaseline = 'middle';
		c.font = `26px ${GROUND_FONT}`;
		c.fillStyle = 'rgba(10,14,10,0.55)';
		c.fillText(s.current, 12, 58);
		c.fillStyle = 'rgba(236,255,240,0.92)';
		c.fillText(s.current, 8, 54);
		let size = 64;
		c.font = `${size}px ${GROUND_FONT}`;
		while (c.measureText(text).width > 1000 && size > 30) c.font = `${(size -= 4)}px ${GROUND_FONT}`;
		c.fillStyle = 'rgba(10,14,10,0.6)';
		c.fillText(text, 14, 158);
		c.fillStyle = '#ffffff';
		c.fillText(text, 8, 152);
		L.tex.needsUpdate = true;
	}

	// ── frame ──────────────────────────────────────────────────────────

	private resize() {
		const el = this.canvas.parentElement ?? this.canvas;
		const w = el.clientWidth || innerWidth;
		const h = el.clientHeight || innerHeight;
		this.renderer.setSize(w, h, false);
		this.composer.setSize(w, h, false);
		this.rig.camera.aspect = w / h;
		this.rig.camera.updateProjectionMatrix();
	}

	private loop = () => {
		if (this.disposed) return;
		this.raf = requestAnimationFrame(this.loop);
		const now = performance.now();
		const dt = Math.min(0.05, (now - this.last) / 1000);
		this.last = now;
		this.update(dt, now);
		this.composer.render(dt);
		this.frames++;
		if (now - this.fpsAt > 1000) {
			this.fps = (this.frames * 1000) / (now - this.fpsAt);
			this.frames = 0;
			this.fpsAt = now;
			this.adapt();
		}
	};

	/** Keep it smooth on weaker GPUs: step the render resolution down. */
	private adapt() {
		if (this.fps < 40) this.slowFor++;
		else this.slowFor = 0;
		const pr = this.renderer.getPixelRatio();
		if (this.slowFor >= 3 && pr > 1) {
			this.renderer.setPixelRatio(Math.max(1, pr - 0.25));
			this.resize();
			this.slowFor = 0;
		}
	}

	private update(dt: number, now: number) {
		const edge = (W.RANGE_STEPS + 0.35) * W.SPACING;
		let target = this.front;
		if (this.phase === 'fight') {
			target = Math.max(-edge, Math.min(edge, this.frontFor(this.price)));
			if (this.price >= this.hi) this.win(BULL);
			else if (this.price <= this.lo) this.win(BEAR);
		} else if (this.phase === 'victory') {
			this.phaseT += dt;
			const loser = 1 - this.winner;
			// the winners roll on toward the beaten base
			target = DIR[loser] * (W.RANGE_STEPS + 1.4) * W.SPACING;
			this.army.rout(loser, dt);
			if (this.phaseT > VICTORY_SECONDS) this.startRound(this.price);
		}
		this.front += (target - this.front) * (1 - Math.exp(-dt * (this.phase === 'victory' ? 0.8 : 2.2)));

		this.army.front = this.front;
		this.army.volatility = this.vol;
		this.army.price = this.price;
		if (this.phase !== 'idle') this.army.update(dt); // no one deploys before the first price
		this.air.update(dt);
		this.nukes.update(dt);
		this.fx.update(dt);
		this.scorch.update(now);

		// battle smoke drifting low along the lines
		this.hazeT -= dt;
		if (this.hazeT <= 0 && this.phase !== 'idle') {
			this.hazeT = 0.28;
			const hz = W.MINZ + 10 + Math.random() * (W.D - 20);
			const hx = this.army.frontAt(hz) + (Math.random() - 0.5) * 26;
			this.fx.haze(hx, W.heightAt(hx, hz) + 1.5 + Math.random() * 3, hz);
		}

		const u = this.uniforms;
		u.uFront.value = this.front;
		u.uTime.value = this.army.time;
		u.uBufBull.value += (this.buf[0] - u.uBufBull.value) * Math.min(1, dt * 2);
		u.uBufBear.value += (this.buf[1] - u.uBufBear.value) * Math.min(1, dt * 2);
		this.updateLabel(now);

		this.rig.update(dt, new THREE.Vector3(this.front, 0, W.roadZ(this.front) * 0.5));
		this.followLight();
		this.audio.setListener(this.rig.target.x, this.rig.target.z, this.rig.dist);

		const fog = this.scene.fog as THREE.Fog;
		fog.near = this.rig.dist * 1.15;
		fog.far = this.rig.dist * 3.4 + 320;

		// signs keep a constant on-screen size
		const cam = this.rig.camera;
		const h = this.canvas.clientHeight || 800;
		const k = (2 * Math.tan((cam.fov * Math.PI) / 360)) / h;
		for (const sp of this.signs) sp.scale.set(k * 110, k * 57, 1);
		for (const f of this.flags) {
			const pos = f.mesh.geometry.attributes.position as THREE.BufferAttribute;
			const a = pos.array as Float32Array;
			for (let i = 0; i < pos.count; i++) {
				const x = f.base[i * 3];
				a[i * 3 + 2] = f.base[i * 3 + 2] + Math.sin(x * 1.7 - this.army.time * 6) * 0.22 * ((x + 2) / 4);
			}
			pos.needsUpdate = true;
		}

		// keep the picked unit marked, and the follow cam on it
		const sel = this.selected ? this.army.info(this.selected) : null;
		this.marker.visible = !!sel;
		if (sel) {
			this.marker.position.set(sel.x, sel.y + 0.15, sel.z);
			const pulse = 1 + Math.sin(now / 180) * 0.12;
			this.marker.scale.set(pulse * (sel.kind === 'tank' ? 2.2 : 1), 1, pulse * (sel.kind === 'tank' ? 2.2 : 1));
			if (this.rig.follow) this.rig.follow.set(sel.x, 0, sel.z);
		} else if (this.rig.follow && this.selected) {
			this.rig.follow = null;
			this.on.followEnded();
		}

		if (now - this.statsAt > 500) {
			this.statsAt = now;
			const tanks: [number, number] = [0, 0];
			for (const t of this.army.tanks) if (!t.wreck) tanks[t.side]++;
			this.on.stats({
				fps: Math.round(this.fps),
				soldiers: [this.army.alive[0], this.army.alive[1]],
				tanks,
				casualties: [this.army.casualties[0], this.army.casualties[1]],
				round: this.round,
				wins: [this.wins[0], this.wins[1]],
				phase: this.phase,
				progress: this.hi > this.lo ? Math.min(1, Math.max(0, (this.price - this.lo) / (this.hi - this.lo))) : 0.5,
				selected: this.selected ? this.describe(this.selected) : null
			});
		}
	}

	private followLight() {
		const t = this.rig.target;
		const dir = new THREE.Vector3(-0.55, 0.78, -0.3).normalize();
		this.sun.position.set(t.x + dir.x * 400, dir.y * 400, t.z + dir.z * 400);
		this.sun.target.position.set(t.x, 0, t.z);
		const e = Math.min(340, Math.max(45, this.rig.dist * 0.8));
		if (Math.abs(e - this.shadowExtent) / e > 0.06) {
			this.shadowExtent = e;
			const c = this.sun.shadow.camera;
			c.left = -e;
			c.right = e;
			c.top = e;
			c.bottom = -e;
			c.updateProjectionMatrix();
		}
	}
}
