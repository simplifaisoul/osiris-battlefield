// EVERY fighter is a real, professionally-designed, fully-animated character.
// Bulls muster as the living (KayKit Adventurers — knight, rogue, barbarian);
// bears rise as the undead horde (KayKit Skeletons). All CC0. Crowds stay smooth
// because the whole army is a pool of skinned meshes capped at CAP, each driven by
// its own AnimationMixer — measured at 60fps for 140 characters.
//
// KayKit's modular design: Adventurers bundle every weapon as a toggleable mesh, so
// one model serves several roles (a rogue shows daggers for a duelist or a crossbow
// for an archer). Skeletons ship bare with `handslot` bones, so we clone the
// Adventurers' weapon meshes onto their hands — one shared weapon set, both armies.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

export type Team = 'bull' | 'bear';
export type Role = 'spear' | 'duelist' | 'archer' | 'chariot' | 'guardian';
export type CharState = 'spawn' | 'idle' | 'walk' | 'run' | 'attack' | 'death' | 'cheer';

const CAP = 210; // hard ceiling on concurrent skinned characters

const MODELS: Record<string, string> = {
	knight: '/models/Adv_Knight.glb',
	rogue: '/models/Adv_Rogue.glb',
	barb: '/models/Adv_Barbarian.glb',
	skelWar: '/models/Skeleton_Warrior.glb',
	skelRog: '/models/Skeleton_Rogue.glb'
};

// attack clip sets, keyed by weapon style
const ATK = {
	sword1h: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal'],
	dual: ['Dualwield_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Slice', 'Dualwield_Melee_Attack_Stab'],
	axe2h: ['2H_Melee_Attack_Chop', '2H_Melee_Attack_Slice', '2H_Melee_Attack_Spin'],
	bow: ['1H_Ranged_Shoot']
};

type WeaponSlot = [donor: string, bone: 'r' | 'l'];
type Def = { model: string; show?: string[]; attach?: WeaponSlot[]; atk: string[]; scale: number; ranged: boolean; skel: boolean };

const DEFS: Record<Team, Record<Role, Def>> = {
	bull: {
		spear: { model: 'knight', show: ['1H_Sword', 'Round_Shield'], atk: ATK.sword1h, scale: 2.0, ranged: false, skel: false },
		duelist: { model: 'rogue', show: ['Knife', 'Knife_Offhand'], atk: ATK.dual, scale: 1.95, ranged: false, skel: false },
		archer: { model: 'rogue', show: ['1H_Crossbow'], atk: ATK.bow, scale: 1.95, ranged: true, skel: false },
		chariot: { model: 'barb', show: ['2H_Axe'], atk: ATK.axe2h, scale: 2.2, ranged: false, skel: false },
		guardian: { model: 'barb', show: ['2H_Axe'], atk: ATK.axe2h, scale: 2.6, ranged: false, skel: false }
	},
	bear: {
		spear: { model: 'skelWar', attach: [['sword', 'r'], ['shield', 'l']], atk: ATK.sword1h, scale: 2.0, ranged: false, skel: true },
		duelist: { model: 'skelRog', attach: [['knife', 'r'], ['knife', 'l']], atk: ATK.dual, scale: 1.95, ranged: false, skel: true },
		archer: { model: 'skelRog', attach: [['crossbow', 'r']], atk: ATK.bow, scale: 1.95, ranged: true, skel: true },
		chariot: { model: 'skelWar', attach: [['axe', 'r']], atk: ATK.axe2h, scale: 2.2, ranged: false, skel: true },
		guardian: { model: 'skelWar', attach: [['axe', 'r']], atk: ATK.axe2h, scale: 2.6, ranged: false, skel: true }
	}
};

// donor weapon meshes pulled out of the Adventurer models and shared everywhere
const DONORS: Record<string, { from: string; node: string }> = {
	sword: { from: 'knight', node: '1H_Sword' },
	shield: { from: 'knight', node: 'Round_Shield' },
	knife: { from: 'rogue', node: 'Knife' },
	crossbow: { from: 'rogue', node: '1H_Crossbow' },
	axe: { from: 'barb', node: '2H_Axe' }
};

const TINT: Record<Team, number> = { bull: 0x2fe07a, bear: 0xff5560 };
const ONESHOT: CharState[] = ['spawn', 'attack', 'death'];

type Inst = {
	obj: THREE.Object3D; mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[];
	team: Team; role: Role; def: Def; state: CharState | ''; action: THREE.AnimationAction | null; free: boolean;
};

export class CharacterPool {
	ready = false;
	private scene: THREE.Scene | null = null;
	private templates: Record<string, { scene: THREE.Group; clips: THREE.AnimationClip[] }> = {};
	private donors: Record<string, THREE.Object3D> = {};
	private pool: Inst[] = [];

	get count() { return this.pool.reduce((n, i) => n + (i.free ? 0 : 1), 0); }

	async load(scene: THREE.Scene) {
		this.scene = scene;
		const loader = new GLTFLoader();
		const keys = Object.keys(MODELS);
		const loaded = await Promise.all(keys.map((k) => loader.loadAsync(MODELS[k])));
		keys.forEach((k, i) => (this.templates[k] = { scene: loaded[i].scene, clips: loaded[i].animations }));
		// tint each faction's own materials with a faint emissive so teams read from the war camera
		for (const k of keys) {
			const bear = k.startsWith('skel');
			this.templates[k].scene.traverse((o) => {
				const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
				if (m && !Array.isArray(m) && 'emissive' in m) { m.emissive = new THREE.Color(TINT[bear ? 'bear' : 'bull']); m.emissiveIntensity = 0.1; }
			});
		}
		// lift the weapon meshes out of the Adventurers to arm the skeletons
		for (const key in DONORS) {
			const d = DONORS[key];
			let node: THREE.Object3D | null = null;
			this.templates[d.from].scene.traverse((o) => { if (o.name === d.node) node = o; });
			if (node) {
				const clone = (node as THREE.Object3D).clone();
				clone.visible = true;
				// neutral material on borrowed steel so a green blade doesn't ride a red skeleton
				clone.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) { const src = mesh.material as THREE.MeshStandardMaterial; const nm = src.clone(); nm.emissive = new THREE.Color(0x000000); mesh.material = nm; } });
				this.donors[key] = clone;
			}
		}
		this.ready = true;
	}

	claim(team: Team, role: Role): number {
		if (!this.ready || !this.scene) return -1;
		let idx = this.pool.findIndex((h) => h.free && h.team === team && h.role === role);
		if (idx < 0) {
			if (this.pool.length >= CAP) return -1;
			const def = DEFS[team][role];
			const tpl = this.templates[def.model];
			if (!tpl) return -1;
			const obj = skeletonClone(tpl.scene) as THREE.Object3D;
			obj.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.Mesh).castShadow = true; });
			// arm it: hide the bundled weapons we don't want (Adventurers) or clone
			// weapon meshes onto the hand bones (Skeletons)
			if (def.show) {
				const keep = new Set(def.show);
				obj.traverse((o) => { if (/sword|shield|axe|knife|crossbow|bow|spike|rectangle|badge|offhand/i.test(o.name) && (o as THREE.Mesh).isMesh) o.visible = keep.has(o.name); });
			}
			if (def.attach) {
				const slots: Record<string, THREE.Object3D> = {};
				obj.traverse((o) => { if (/handslotr/i.test(o.name)) slots.r = o; else if (/handslotl/i.test(o.name)) slots.l = o; });
				for (const [donor, bone] of def.attach) {
					const src = this.donors[donor]; const host = slots[bone];
					if (src && host) host.add(src.clone());
				}
			}
			this.scene.add(obj);
			this.pool.push({ obj, mixer: new THREE.AnimationMixer(obj), clips: tpl.clips, team, role, def, state: '', action: null, free: true });
			idx = this.pool.length - 1;
		}
		const h = this.pool[idx];
		h.free = false; h.state = ''; h.action?.stop(); h.action = null; h.obj.visible = true;
		return idx;
	}

	release(idx: number) {
		const h = this.pool[idx]; if (!h) return;
		h.free = true; h.obj.visible = false; h.action?.stop(); h.action = null; h.state = '';
	}

	private clipName(h: Inst, state: CharState): string {
		switch (state) {
			case 'spawn': return h.def.skel ? 'Skeletons_Awaken_Standing' : 'Cheer';
			case 'walk': return h.def.skel ? 'Walking_D_Skeletons' : 'Walking_C';
			case 'run': return 'Running_A';
			case 'death': return h.def.skel ? 'Death_C_Skeletons' : 'Death_A';
			case 'cheer': return 'Cheer';
			case 'idle': return 'Idle_Combat';
			case 'attack': return h.def.atk[(Math.random() * h.def.atk.length) | 0];
		}
	}

	// place + animate one character this frame; unit forward (local +x) maps to model +Z
	pose(idx: number, x: number, y: number, z: number, faceRad: number, scale: number, state: CharState) {
		const h = this.pool[idx]; if (!h || h.free) return;
		h.obj.position.set(x, y, z);
		h.obj.rotation.y = faceRad + Math.PI / 2;
		h.obj.scale.setScalar(scale * h.def.scale);
		if (state === h.state) return;
		if (h.state && ONESHOT.includes(h.state) && state !== 'death' && h.action && !this.finished(h)) return;
		const clip = THREE.AnimationClip.findByName(h.clips, this.clipName(h, state));
		if (!clip) return;
		const next = h.mixer.clipAction(clip);
		next.reset();
		if (ONESHOT.includes(state)) { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
		else next.setLoop(THREE.LoopRepeat, Infinity);
		if (state === 'attack') next.timeScale = 1.35;
		else next.timeScale = 1;
		if (h.action && h.action !== next) next.crossFadeFrom(h.action, 0.16, false);
		next.play();
		h.action = next; h.state = state;
	}

	private finished(h: Inst): boolean {
		return !!h.action && h.action.loop === THREE.LoopOnce && h.action.time >= h.action.getClip().duration - 0.05;
	}

	update(dt: number) {
		for (const h of this.pool) {
			if (h.free) continue;
			h.mixer.update(dt);
			if (h.state !== 'death' && h.state && ONESHOT.includes(h.state) && this.finished(h)) h.state = '';
		}
	}

	dispose() {
		for (const h of this.pool) { h.mixer.stopAllAction(); h.obj.removeFromParent(); }
		this.pool.length = 0;
	}
}
