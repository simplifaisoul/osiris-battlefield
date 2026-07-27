// EVERY fighter is a real, professionally-designed, fully-animated character.
// Bulls muster as the living (KayKit Adventurers — knight, rogue, barbarian);
// bears rise as the undead horde (KayKit Skeletons). All CC0. Crowds stay smooth
// because the whole army is a pool of skinned meshes capped at CAP, each driven by
// its own AnimationMixer.
//
// The five base models would look like five clone-armies, so every fighter that
// takes the field is individualised two ways: a COLOUR SKIN (a per-team palette of
// tints — crimson, azure, bronze knights; bleached, mossy, frost skeletons) and a
// WEAPON LOADOUT variant (the KayKit models bundle a whole armoury — swords, a
// two-hander, three shield types, axes, crossbows — so one model fields many looks).
//
// KayKit's modular design: Adventurers bundle every weapon as a toggleable mesh, so
// one model serves several roles and loadouts. Skeletons ship bare with `handslot`
// bones, so we clone the Adventurers' weapon meshes onto their hands.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Team = 'bull' | 'bear';
export type Role = 'spear' | 'duelist' | 'archer' | 'chariot' | 'guardian';
export type CharState = 'spawn' | 'idle' | 'walk' | 'run' | 'attack' | 'death' | 'cheer';

const CAP = 380; // hard ceiling on concurrent skinned characters

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
// one look a fighter can wear: which bundled weapons to show (Adventurers), which
// donor weapons to clone onto the hand bones (Skeletons), and the matching attack set
type Variant = { show?: string[]; attach?: WeaponSlot[]; atk: string[] };
type Def = { model: string; scale: number; ranged: boolean; skel: boolean; variants: Variant[] };

// each role fields several loadouts; a fighter rolls one when it takes the field
const DEFS: Record<Team, Record<Role, Def>> = {
	bull: {
		spear: { model: 'knight', scale: 2.0, ranged: false, skel: false, variants: [
			{ show: ['1H_Sword', 'Round_Shield'], atk: ATK.sword1h },
			{ show: ['1H_Sword', 'Rectangle_Shield'], atk: ATK.sword1h },
			{ show: ['1H_Sword', 'Spike_Shield'], atk: ATK.sword1h },
			{ show: ['2H_Sword'], atk: ATK.axe2h }
		] },
		duelist: { model: 'rogue', scale: 1.95, ranged: false, skel: false, variants: [
			{ show: ['Knife', 'Knife_Offhand'], atk: ATK.dual }
		] },
		archer: { model: 'rogue', scale: 1.95, ranged: true, skel: false, variants: [
			{ show: ['1H_Crossbow'], atk: ATK.bow },
			{ show: ['2H_Crossbow'], atk: ATK.bow }
		] },
		chariot: { model: 'barb', scale: 2.2, ranged: false, skel: false, variants: [
			{ show: ['2H_Axe'], atk: ATK.axe2h },
			{ show: ['1H_Axe', 'Barbarian_Round_Shield'], atk: ATK.sword1h }
		] },
		guardian: { model: 'barb', scale: 2.6, ranged: false, skel: false, variants: [
			{ show: ['2H_Axe'], atk: ATK.axe2h },
			{ show: ['1H_Axe', 'Barbarian_Round_Shield'], atk: ATK.sword1h }
		] }
	},
	bear: {
		spear: { model: 'skelWar', scale: 2.0, ranged: false, skel: true, variants: [
			{ attach: [['sword', 'r'], ['shield', 'l']], atk: ATK.sword1h },
			{ attach: [['sword', 'r'], ['rect_shield', 'l']], atk: ATK.sword1h },
			{ attach: [['sword', 'r'], ['spike_shield', 'l']], atk: ATK.sword1h }
		] },
		duelist: { model: 'skelRog', scale: 1.95, ranged: false, skel: true, variants: [
			{ attach: [['knife', 'r'], ['knife', 'l']], atk: ATK.dual }
		] },
		archer: { model: 'skelRog', scale: 1.95, ranged: true, skel: true, variants: [
			{ attach: [['crossbow', 'r']], atk: ATK.bow }
		] },
		chariot: { model: 'skelWar', scale: 2.2, ranged: false, skel: true, variants: [
			{ attach: [['axe', 'r']], atk: ATK.axe2h },
			{ attach: [['sword2h', 'r']], atk: ATK.axe2h }
		] },
		guardian: { model: 'skelWar', scale: 2.6, ranged: false, skel: true, variants: [
			{ attach: [['axe', 'r']], atk: ATK.axe2h },
			{ attach: [['sword2h', 'r']], atk: ATK.axe2h }
		] }
	}
};

// donor weapon meshes pulled out of the Adventurer models and shared everywhere
const DONORS: Record<string, { from: string; node: string }> = {
	sword: { from: 'knight', node: '1H_Sword' },
	sword2h: { from: 'knight', node: '2H_Sword' },
	shield: { from: 'knight', node: 'Round_Shield' },
	rect_shield: { from: 'knight', node: 'Rectangle_Shield' },
	spike_shield: { from: 'knight', node: 'Spike_Shield' },
	knife: { from: 'rogue', node: 'Knife' },
	crossbow: { from: 'rogue', node: '1H_Crossbow' },
	axe: { from: 'barb', node: '2H_Axe' }
};

// faint team emissive so the hosts read from the war camera — a whisper of warmth on
// the living, cold moonlight on the undead. The per-instance colour skin rides on top.
const TINT: Record<Team, number> = { bull: 0x6a8f4a, bear: 0x5a6a86 };

// per-fighter colour skins (multiplied over the model's own texture). Gentle enough
// to read as dyed cloth / weathered steel, not neon — a varied host, not a rainbow.
const SKINS: Record<Team, number[]> = {
	// living host: steel, crimson, azure, forest, bronze, royal, pale
	bull: [0xffffff, 0xf2a0a0, 0xa6bcf0, 0xa8dca0, 0xf0cf8a, 0xc4a8ee, 0xdfe3ea],
	// undead: bleached bone, moss, dried-blood rust, frost, grave-violet, verdigris
	bear: [0xe2e6ee, 0xb6c6b2, 0xceac9e, 0xacbcd2, 0xccc2d6, 0xa6b8ac]
};

const ONESHOT: CharState[] = ['spawn', 'attack', 'death'];

type Inst = {
	obj: THREE.Object3D; mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[];
	team: Team; role: Role; def: Def; atk: string[]; skinScale: number;
	state: CharState | ''; action: THREE.AnimationAction | null; free: boolean;
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
		// Each character ships as ~6 separate skinned body-part meshes that all share
		// ONE material and ONE skeleton — merging them collapses 6 draw calls per
		// fighter into 1, which is the difference between 36fps and a smooth army.
		for (const k of keys) this.mergeBody(this.templates[k].scene);
		// tint each faction's own materials with a faint emissive so teams read from the war camera
		for (const k of keys) {
			const bear = k.startsWith('skel');
			this.templates[k].scene.traverse((o) => {
				const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
				if (m && !Array.isArray(m) && 'emissive' in m) { m.emissive = new THREE.Color(TINT[bear ? 'bear' : 'bull']); m.emissiveIntensity = bear ? 0.06 : 0.045; }
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
				// neutral material on borrowed steel so a tinted blade doesn't ride a skeleton
				clone.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) { const src = mesh.material as THREE.MeshStandardMaterial; const nm = src.clone(); nm.emissive = new THREE.Color(0x000000); mesh.material = nm; } });
				this.donors[key] = clone;
			}
		}
		this.ready = true;
	}

	// collapse a character's body-part skinned meshes into one mesh per material
	private mergeBody(root: THREE.Object3D) {
		const parts: THREE.SkinnedMesh[] = [];
		root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) parts.push(o as THREE.SkinnedMesh); });
		if (parts.length < 2) return;
		const head = parts[0];
		const group = parts.filter((s) => s.material === head.material && s.skeleton === head.skeleton && s.parent === head.parent);
		if (group.length < 2) return;
		let merged: THREE.BufferGeometry | null = null;
		try { merged = mergeGeometries(group.map((s) => s.geometry), false); } catch { merged = null; }
		if (!merged) return; // mismatched attributes — leave the character as-is
		const mesh = new THREE.SkinnedMesh(merged, head.material as THREE.Material);
		mesh.name = 'body_merged';
		mesh.frustumCulled = false;
		head.parent!.add(mesh);
		mesh.bind(head.skeleton, head.bindMatrix);
		for (const s of group) s.parent?.remove(s);
	}

	// give this fighter its own colour skin — clone the body materials and multiply in
	// a palette tint. Skips the skeletons' glowing eyes and runs BEFORE weapons attach,
	// so borrowed steel stays neutral.
	private applySkin(obj: THREE.Object3D, team: Team): number {
		const skin = SKINS[team][(Math.random() * SKINS[team].length) | 0];
		const tint = new THREE.Color(skin);
		obj.traverse((o) => {
			const mesh = o as THREE.Mesh;
			if (!mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
			const mat = mesh.material as THREE.MeshStandardMaterial;
			if (!mat || Array.isArray(mat) || mat.name === 'Glow') return;
			const nm = mat.clone();
			nm.color = (mat.color ? mat.color.clone() : new THREE.Color(0xffffff)).multiply(tint);
			mesh.material = nm;
		});
		return skin;
	}

	claim(team: Team, role: Role): number {
		if (!this.ready || !this.scene) return -1;
		let idx = this.pool.findIndex((h) => h.free && h.team === team && h.role === role);
		if (idx < 0) {
			if (this.pool.length >= CAP) return -1;
			const def = DEFS[team][role];
			const tpl = this.templates[def.model];
			if (!tpl) return -1;
			const variant = def.variants[(Math.random() * def.variants.length) | 0];
			const obj = skeletonClone(tpl.scene) as THREE.Object3D;
			// no real shadow casting — the engine grounds every fighter with an
			// instanced blob shadow instead (see buildUnitShadows)
			obj.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.Mesh).castShadow = false; });
			// arm it: hide the bundled weapons we don't want (Adventurers) ...
			if (variant.show) {
				// strip the unused weapons out of the hierarchy entirely — hidden meshes
				// still cost a world-matrix update every frame for every fighter
				const keep = new Set(variant.show);
				const drop: THREE.Object3D[] = [];
				obj.traverse((o) => { if (/sword|shield|axe|knife|crossbow|bow|spike|rectangle|badge|offhand/i.test(o.name) && (o as THREE.Mesh).isMesh && !keep.has(o.name)) drop.push(o); });
				for (const o of drop) o.parent?.remove(o);
			}
			// ... then dye the body before any borrowed steel goes on
			const skinScale = 0.9 + Math.random() * 0.18;
			this.applySkin(obj, team);
			// ... or clone weapon meshes onto the hand bones (Skeletons)
			if (variant.attach) {
				const slots: Record<string, THREE.Object3D> = {};
				obj.traverse((o) => { if (/handslotr/i.test(o.name)) slots.r = o; else if (/handslotl/i.test(o.name)) slots.l = o; });
				for (const [donor, bone] of variant.attach) {
					const src = this.donors[donor]; const host = slots[bone];
					if (src && host) host.add(src.clone());
				}
			}
			this.scene.add(obj);
			this.pool.push({ obj, mixer: new THREE.AnimationMixer(obj), clips: tpl.clips, team, role, def, atk: variant.atk, skinScale, state: '', action: null, free: true });
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
			case 'attack': return h.atk[(Math.random() * h.atk.length) | 0];
		}
	}

	// place + animate one character this frame; unit forward (local +x) maps to model +Z
	pose(idx: number, x: number, y: number, z: number, faceRad: number, scale: number, state: CharState) {
		const h = this.pool[idx]; if (!h || h.free) return;
		h.obj.position.set(x, y, z);
		h.obj.rotation.y = faceRad + Math.PI / 2;
		h.obj.scale.setScalar(scale * h.def.scale * h.skinScale);
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
