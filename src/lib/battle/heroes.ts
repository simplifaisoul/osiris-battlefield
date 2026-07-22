// HERO UNITS — the whales walk the field as fully animated characters.
// Crowds stay GPU-instanced; only the handful of TITAN/GOD legends on the
// field at once (≤ HERO_MAX) are skinned+rigged, so the animation cost stays
// trivial. Models: KayKit Character Pack: Skeletons (CC0) — the army of the
// dead suits the war for the Duat. If loading fails, every claim returns -1
// and legends fall back to the instanced guardians. Nothing can break.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

export type HeroKind = 'warrior' | 'rogue';
export type HeroState = 'spawn' | 'idle' | 'walk' | 'run' | 'attack' | 'death' | 'cheer';

const HERO_MAX = 10;
const SRC: Record<HeroKind, string> = { warrior: '/models/Skeleton_Warrior.glb', rogue: '/models/Skeleton_Rogue.glb' };
const ATTACKS: Record<HeroKind, string[]> = {
	warrior: ['2H_Melee_Attack_Chop', '2H_Melee_Attack_Slice', '2H_Melee_Attack_Spin'],
	rogue: ['1H_Melee_Attack_Stab', '1H_Melee_Attack_Slice_Diagonal', 'Dualwield_Melee_Attack_Stab']
};
const IDLE: Record<HeroKind, string> = { warrior: '2H_Melee_Idle', rogue: 'Idle_Combat' };
const CLIP: Record<Exclude<HeroState, 'attack' | 'idle'>, string> = {
	spawn: 'Skeletons_Awaken_Standing', walk: 'Walking_D_Skeletons',
	run: 'Running_A', death: 'Death_C_Skeletons', cheer: 'Cheer'
};
const ONESHOT: HeroState[] = ['spawn', 'attack', 'death'];
const TINT: Record<'bull' | 'bear', THREE.Color> = {
	bull: new THREE.Color('#7dffb0'), bear: new THREE.Color('#ff8a95')
};

type Hero = {
	obj: THREE.Object3D; mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[];
	kind: HeroKind; action: THREE.AnimationAction | null; state: HeroState | ''; free: boolean;
	mats: THREE.MeshToonMaterial[];
};

export class HeroPool {
	ready = false;
	private templates: Partial<Record<HeroKind, { scene: THREE.Group; clips: THREE.AnimationClip[] }>> = {};
	private pool: Hero[] = [];
	private scene: THREE.Scene | null = null;
	private grad: THREE.Texture;

	constructor() {
		const steps = new Uint8Array([80, 140, 200, 255]);
		this.grad = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
		this.grad.minFilter = THREE.NearestFilter; this.grad.magFilter = THREE.NearestFilter; this.grad.needsUpdate = true;
	}

	async load(scene: THREE.Scene) {
		this.scene = scene;
		const loader = new GLTFLoader();
		const [w, r] = await Promise.all([loader.loadAsync(SRC.warrior), loader.loadAsync(SRC.rogue)]);
		this.templates.warrior = { scene: w.scene, clips: w.animations };
		this.templates.rogue = { scene: r.scene, clips: r.animations };
		this.ready = true;
	}

	// borrow an animated hero; -1 when unloaded or the pool is spent
	claim(kind: HeroKind, team: 'bull' | 'bear'): number {
		if (!this.ready || !this.scene) return -1;
		let idx = this.pool.findIndex((h) => h.free && h.kind === kind);
		if (idx < 0) {
			if (this.pool.length >= HERO_MAX) return -1;
			const t = this.templates[kind]; if (!t) return -1;
			const obj = cloneSkeleton(t.scene);
			const mats: THREE.MeshToonMaterial[] = [];
			obj.traverse((o) => {
				const mesh = o as THREE.Mesh;
				if (!mesh.isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) return;
				mesh.castShadow = true;
				const src = mesh.material as THREE.MeshStandardMaterial;
				if (src && !Array.isArray(src)) {
					// re-clothe in the battlefield's toon look, keeping the pack's texture
					const toon = new THREE.MeshToonMaterial({ map: src.map ?? null, gradientMap: this.grad });
					mesh.material = toon; mats.push(toon);
				}
			});
			this.scene.add(obj);
			this.pool.push({ obj, mixer: new THREE.AnimationMixer(obj), clips: t.clips, kind, action: null, state: '', free: true, mats });
			idx = this.pool.length - 1;
		}
		const h = this.pool[idx];
		h.free = false; h.state = ''; h.action?.stop(); h.action = null; h.obj.visible = true;
		// keep the pack's palette true and add a team-colored inner glow — a dark robe
		// multiplied by a tint is just a black blob under the night lighting
		for (const mt of h.mats) { mt.color.set('#ffffff'); mt.emissive.copy(TINT[team]).multiplyScalar(0.3); }
		return idx;
	}

	release(idx: number) {
		const h = this.pool[idx]; if (!h) return;
		h.free = true; h.obj.visible = false; h.action?.stop(); h.action = null; h.state = '';
	}

	// drive one hero for this frame: place it and crossfade its animation state
	pose(idx: number, x: number, y: number, z: number, faceRad: number, scale: number, state: HeroState) {
		const h = this.pool[idx]; if (!h || h.free) return;
		h.obj.position.set(x, y, z);
		h.obj.rotation.y = faceRad + Math.PI / 2; // unit forward is local +x; the model faces +Z
		h.obj.scale.setScalar(scale);
		if (state === h.state) return;
		// one-shots must finish before a same-priority state retriggers; death always wins
		if (h.state && ONESHOT.includes(h.state) && state !== 'death' && h.action && !this.finished(h)) return;
		const name = state === 'attack' ? ATTACKS[h.kind][(Math.random() * ATTACKS[h.kind].length) | 0] : state === 'idle' ? IDLE[h.kind] : CLIP[state];
		const clip = THREE.AnimationClip.findByName(h.clips, name); if (!clip) return;
		const next = h.mixer.clipAction(clip);
		next.reset();
		if (ONESHOT.includes(state)) { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
		else next.setLoop(THREE.LoopRepeat, Infinity);
		if (h.action && h.action !== next) { next.crossFadeFrom(h.action, 0.18, false); }
		next.play();
		h.action = next; h.state = state;
	}

	private finished(h: Hero): boolean {
		return !!h.action && h.action.loop === THREE.LoopOnce && h.action.time >= (h.action.getClip().duration - 0.05);
	}

	update(dt: number) {
		for (const h of this.pool) {
			if (h.free) continue;
			h.mixer.update(dt);
			// a completed one-shot (except death) settles back into combat idle
			if (h.state !== 'death' && h.state && ONESHOT.includes(h.state) && this.finished(h)) {
				h.state = ''; // next pose() call picks the live state
			}
		}
	}

	dispose() {
		for (const h of this.pool) { h.mixer.stopAllAction(); h.obj.removeFromParent(); }
		this.pool.length = 0;
	}
}
