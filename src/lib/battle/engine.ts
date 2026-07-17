import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
	EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, VignetteEffect,
	ToneMappingEffect, ToneMappingMode
} from 'postprocessing';
import { createNoise2D } from 'simplex-noise';
import { tierForPct, GARRISON, TIERS, type Tier } from './tiers';

export type Team = 'bull' | 'bear';
export type Cls = 'spear' | 'duelist' | 'archer' | 'guardian';
export type SpawnInput = { wallet: string; kind: Team | 'buy' | 'sell'; usd: number; pct: number };

export type BattleEvent = {
	type: 'spawn' | 'kill' | 'legend' | 'duel' | 'strike';
	team: Team; tier: string; cls: Cls; wallet: string; usd: number; pct: number; god?: boolean;
};

export type Commander = { wallet: string; kills: number; tier: string; team: Team };
export type Comp = { spear: number; duelist: number; archer: number; guardian: number };

export type Stats = {
	bulls: number; bears: number; bullPower: number; bearPower: number;
	frontPct: number; casualtiesBull: number; casualtiesBear: number; fps: number;
	round: number; winBull: number; winBear: number;
	phase: 'battle' | 'victory'; winner: Team | null; warPhase: WarPhase;
	totalKills: number; biggestWhaleUsd: number; biggestWhaleWallet: string;
	commanders: Commander[]; bullComp: Comp; bearComp: Comp;
};

export type Overlay = {
	tracked: { x: number; y: number; on: boolean; tier: string; team: Team; hp: number; maxHp: number; kills: number; wallet: string }[];
	titans: { x: number; y: number; on: boolean; label: string; team: Team }[];
	kills: { x: number; y: number; on: boolean; team: Team; age: number }[];
};

type Unit = {
	team: Team; sign: number; cls: Cls; ranged: boolean;
	tier: string; scale: number; hp: number; maxHp: number; dmg: number;
	standoff: number; speed: number;
	wallet: string; x: number; z: number; rank: number; bob: number; age: number;
	cd: number; kills: number; idx: number; dying: number;
	tracked: boolean; legend: boolean; melee: boolean;
	// duel state
	target: Unit | null; retarget: number; atkCd: number; strike: number; face: number;
	tint: number; struck: number; swingSide: number;
	// formation posting: quantized file (slot) across the field, rank depth (row) behind the front
	lane: number; slot: number; row: number; frontJitter: number; flank: boolean;
};

// the war breathes like a real field battle:
// FORM (dress ranks, champions duel between the hosts) → ADVANCE (walk forward in step under
// massed volleys) → CHARGE (horns, final sprint) → MELEE (open fighting) → REGROUP (carry the
// line back, re-dress, recover the wounded)
export type WarPhase = 'form' | 'advance' | 'charge' | 'melee' | 'regroup';
const PHASE_CYCLE = 47; // seconds per full rhythm — a slow, deliberate war
function phaseAt(t: number): WarPhase {
	const T = t % PHASE_CYCLE;
	return T < 10 ? 'form' : T < 18 ? 'advance' : T < 21 ? 'charge' : T < 37 ? 'melee' : 'regroup';
}

// per-class attack pacing (seconds between strikes)
const ATK_CD: Record<Cls, number> = { spear: 1.05, duelist: 0.55, archer: 1.15, guardian: 2.4 };
const KILL_TEMPO = 1.7; // global lethality multiplier (per-hit = dmg * cd * tempo) — fights last
const ACQUIRE_R = 18; // how far a melee unit will lock onto an enemy

const MAX = 500;
const FRONT_MAX = 50;
const CAP = FRONT_MAX + 19;
const ARENA_Z = 54;
// the battlefield is a bounded board floating in a dark void
const BOARD_W = 200;
const BOARD_D = 150;
const ROAD_Z = 9; // horizontal road across the map
const MELEE = 4.2;
const SPEED = 8; // deliberate marching pace — the charge multiplier provides the sprint
const UNIT_SCALE = 2.35;
const CLASSES: Cls[] = ['spear', 'duelist', 'archer', 'guardian'];

const CLASS_STATS: Record<Cls, { hpMul: number; dmgMul: number; scaleMul: number; ranged: boolean; standoff: number; speedMul: number }> = {
	spear: { hpMul: 1.0, dmgMul: 1.0, scaleMul: 1.0, ranged: false, standoff: 0.8, speedMul: 1.0 },
	duelist: { hpMul: 0.78, dmgMul: 1.9, scaleMul: 0.95, ranged: false, standoff: 0.6, speedMul: 1.45 },
	archer: { hpMul: 0.55, dmgMul: 1.7, scaleMul: 0.9, ranged: true, standoff: 13, speedMul: 1.05 },
	guardian: { hpMul: 2.6, dmgMul: 2.5, scaleMul: 1.0, ranged: false, standoff: 0.9, speedMul: 0.62 }
};

const GOLD = new THREE.Color('#2fd66b');
const CRIMSON = new THREE.Color('#ff5560');

// The battlefield is a hill whose summit is the market cap.
const HILL_H = 1.1; // gentle rolling terrain — the war map is near-flat, not a peak
const HILL_SIG = FRONT_MAX * 0.85;
function hillY(x: number): number { return HILL_H * Math.exp(-(x * x) / (2 * HILL_SIG * HILL_SIG)); }
// ground height a unit stands on — matches the terrain's z-taper so nothing floats at the rim
function groundY(x: number, z: number): number {
	const zTaper = THREE.MathUtils.clamp(1 - (Math.abs(z) - ARENA_Z) / 14, 0, 1);
	return hillY(x) * zTaper;
}

function hash01(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0) / 4294967296;
}
function pickClass(tier: string, seed: number): Cls {
	if (tier === 'TITAN' || tier === 'GOD') return 'guardian';
	// melee-forward mix: the war is decided blade to blade, archers in support
	if (seed < 0.34) return 'spear';
	if (seed < 0.68) return 'duelist';
	return 'archer';
}
function easeOutBack(t: number): number { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

// ---------- toon look ----------

function toonMaterial(): THREE.MeshToonMaterial {
	const steps = new Uint8Array([70, 135, 200, 255]);
	const grad = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
	grad.minFilter = THREE.NearestFilter; grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
	return new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: grad });
}

type Palette = { cloth: string; clothDark: string; skin: string; metal: string; wood: string; leather: string; accent: string };
// night-war hosts: deep emerald vs blood crimson linen, blackened bronze, firelight gold
const PAL: Record<Team, Palette> = {
	bull: { cloth: '#2ce46e', clothDark: '#14a04a', skin: '#c98d4f', metal: '#c49238', wood: '#7e5228', leather: '#5c4028', accent: '#ffd34d' },
	bear: { cloth: '#ff4256', clothDark: '#b52738', skin: '#b97e42', metal: '#c49238', wood: '#6e4522', leather: '#523524', accent: '#ffd34d' }
};

function paint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
	const c = new THREE.Color(hex);
	const n = g.attributes.position.count;
	const arr = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
	g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
	return g;
}

// ---------- chunky character builders (stylised ancient-Egyptian warriors) ----------

function chunkyBase(p: Palette): THREE.BufferGeometry[] {
	const parts: THREE.BufferGeometry[] = [];
	// flat sandals
	const b1 = paint(new THREE.BoxGeometry(0.26, 0.12, 0.38), p.leather); b1.translate(-0.18, 0.06, 0.04);
	const b2 = paint(new THREE.BoxGeometry(0.26, 0.12, 0.38), p.leather); b2.translate(0.18, 0.06, 0.04);
	// bare bronze legs
	const g1 = paint(new THREE.CylinderGeometry(0.12, 0.11, 0.34, 6), p.skin); g1.translate(-0.15, 0.28, 0.02);
	const g2 = paint(new THREE.CylinderGeometry(0.12, 0.11, 0.34, 6), p.skin); g2.translate(0.15, 0.28, 0.02);
	// shendyt kilt in team linen, flared, with a gold waist sash
	const kilt = paint(new THREE.CylinderGeometry(0.34, 0.47, 0.4, 10), p.cloth); kilt.translate(0, 0.56, 0);
	const sash = paint(new THREE.CylinderGeometry(0.36, 0.36, 0.1, 10), p.accent); sash.translate(0, 0.78, 0);
	// bare bronze torso
	const body = paint(new THREE.CylinderGeometry(0.3, 0.36, 0.5, 10), p.skin); body.translate(0, 1.0, 0);
	// broad gold pectoral collar
	const collar = paint(new THREE.CylinderGeometry(0.33, 0.42, 0.14, 10), p.accent); collar.translate(0, 1.2, 0);
	// big head with kohl-lined eyes
	const head = paint(new THREE.SphereGeometry(0.4, 12, 10), p.skin); head.translate(0, 1.56, 0.02);
	const k1 = paint(new THREE.BoxGeometry(0.2, 0.05, 0.05), '#161020'); k1.translate(-0.15, 1.66, 0.36);
	const k2 = paint(new THREE.BoxGeometry(0.2, 0.05, 0.05), '#161020'); k2.translate(0.15, 1.66, 0.36);
	const e1 = paint(new THREE.SphereGeometry(0.062, 6, 5), '#20160f'); e1.translate(-0.15, 1.6, 0.36);
	const e2 = paint(new THREE.SphereGeometry(0.062, 6, 5), '#20160f'); e2.translate(0.15, 1.6, 0.36);
	parts.push(b1, b2, g1, g2, kilt, sash, body, collar, head, k1, k2, e1, e2);
	return parts;
}

// khat head-cloth: cap, browband, and a neck flap behind
function khat(p: Palette, capHex: string): THREE.BufferGeometry[] {
	const cap = paint(new THREE.SphereGeometry(0.43, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), capHex); cap.translate(0, 1.64, 0.02);
	const band = paint(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 12), p.accent); band.translate(0, 1.68, 0.02);
	const flap = paint(new THREE.BoxGeometry(0.5, 0.5, 0.12), capHex); flap.rotateX(0.16); flap.translate(0, 1.42, -0.3);
	return [cap, band, flap];
}

// bronze khopesh — hilt rising from the fist into a curved sickle blade
function khopesh(p: Palette, side: number, scale = 1): THREE.BufferGeometry[] {
	const hilt = paint(new THREE.CylinderGeometry(0.045 * scale, 0.055 * scale, 0.42 * scale, 6), p.leather);
	hilt.rotateZ(-0.28 * side); hilt.translate(0.68 * side * scale, 1.12 * scale, 0.1);
	const guard = paint(new THREE.SphereGeometry(0.08 * scale, 6, 5), p.accent);
	guard.translate(0.63 * side * scale, 0.94 * scale, 0.1);
	const blade = paint(new THREE.TorusGeometry(0.28 * scale, 0.045 * scale, 6, 14, Math.PI * 1.15), p.metal);
	blade.rotateZ(side < 0 ? Math.PI * 0.9 : -0.25); blade.translate(0.76 * side * scale, 1.5 * scale, 0.1);
	return [hilt, guard, blade];
}
function armPair(p: Palette, weaponSide = 1): THREE.BufferGeometry[] {
	// chunky bronze arms with big fists and gold wrist cuffs
	const aR = paint(new THREE.CylinderGeometry(0.11, 0.13, 0.5, 8), p.skin); aR.rotateZ(-0.9 * weaponSide); aR.translate(0.45 * weaponSide, 1.02, 0.06);
	const cR = paint(new THREE.CylinderGeometry(0.12, 0.12, 0.09, 8), p.accent); cR.rotateZ(-0.9 * weaponSide); cR.translate(0.57 * weaponSide, 0.95, 0.08);
	const fR = paint(new THREE.SphereGeometry(0.15, 8, 6), p.skin); fR.translate(0.62 * weaponSide, 0.9, 0.1);
	const aL = paint(new THREE.CylinderGeometry(0.11, 0.13, 0.5, 8), p.skin); aL.rotateZ(0.9 * weaponSide); aL.translate(-0.45 * weaponSide, 1.02, 0.06);
	const cL = paint(new THREE.CylinderGeometry(0.12, 0.12, 0.09, 8), p.accent); cL.rotateZ(0.9 * weaponSide); cL.translate(-0.57 * weaponSide, 0.95, 0.08);
	const fL = paint(new THREE.SphereGeometry(0.15, 8, 6), p.skin); fL.translate(-0.62 * weaponSide, 0.9, 0.1);
	return [aR, cR, fR, aL, cL, fL];
}

function buildSpearman(p: Palette): THREE.BufferGeometry {
	const parts = [...chunkyBase(p), ...armPair(p), ...khat(p, p.clothDark)];
	// bronze-tipped war spear in the right fist
	const shaft = paint(new THREE.CylinderGeometry(0.045, 0.045, 2.5, 6), p.wood); shaft.translate(0.62, 1.35, 0.1);
	const tip = paint(new THREE.ConeGeometry(0.13, 0.44, 6), p.metal); tip.translate(0.62, 2.76, 0.1);
	// tall Egyptian shield — rounded top, gold eye boss
	const shield = paint(new THREE.BoxGeometry(0.72, 0.82, 0.08), p.clothDark); shield.translate(-0.68, 0.94, 0.08);
	const shTop = paint(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 12, 1, false, 0, Math.PI), p.clothDark);
	shTop.rotateX(Math.PI / 2); shTop.translate(-0.68, 1.35, 0.08);
	const rim = paint(new THREE.BoxGeometry(0.78, 0.1, 0.1), p.accent); rim.translate(-0.68, 0.56, 0.08);
	const boss = paint(new THREE.SphereGeometry(0.13, 8, 6), p.accent); boss.translate(-0.68, 1.02, 0.13);
	parts.push(shaft, tip, shield, shTop, rim, boss);
	const m = mergeGeometries(parts, false)!; m.computeVertexNormals(); return m;
}

function buildDuelist(p: Palette): THREE.BufferGeometry {
	// twin-khopesh blade dancer — both sickle-swords raised, dark iron pauldron spikes
	const parts = [...chunkyBase(p), ...armPair(p), ...khopesh(p, 1), ...khopesh(p, -1)];
	// gold circlet with a rearing-serpent crest
	const band = paint(new THREE.CylinderGeometry(0.41, 0.41, 0.1, 12), p.accent); band.translate(0, 1.7, 0.02);
	const crest = paint(new THREE.ConeGeometry(0.07, 0.26, 6), p.accent); crest.translate(0, 1.86, 0.34);
	// spiked shoulder studs — the blade dancer means harm
	for (const s of [-1, 1]) {
		const pad = paint(new THREE.SphereGeometry(0.17, 8, 6), '#33303c'); pad.translate(0.34 * s, 1.24, 0.02);
		const spk = paint(new THREE.ConeGeometry(0.07, 0.3, 5), '#8f95a4'); spk.rotateZ(-0.7 * s); spk.translate(0.46 * s, 1.38, 0.02);
		parts.push(pad, spk);
	}
	// flowing back scarf in team linen
	const scarf = paint(new THREE.BoxGeometry(0.5, 0.85, 0.1), p.cloth); scarf.rotateX(0.3); scarf.translate(0, 0.98, -0.34);
	parts.push(band, crest, scarf);
	const m = mergeGeometries(parts, false)!; m.computeVertexNormals(); return m;
}

function buildArcher(p: Palette): THREE.BufferGeometry {
	const parts = [...chunkyBase(p), ...armPair(p), ...khat(p, p.cloth)];
	// recurve bow of horn and gold in the right fist
	const bow = paint(new THREE.TorusGeometry(0.78, 0.05, 8, 20, Math.PI * 1.2), p.wood); bow.rotateY(Math.PI / 2); bow.rotateX(-0.15); bow.translate(0.66, 1.15, 0.1);
	const bt1 = paint(new THREE.SphereGeometry(0.07, 6, 5), p.accent); bt1.translate(0.66, 1.95, 0.25);
	const bt2 = paint(new THREE.SphereGeometry(0.07, 6, 5), p.accent); bt2.translate(0.66, 0.38, 0.3);
	// reed quiver on the back
	const quiver = paint(new THREE.CylinderGeometry(0.12, 0.12, 0.55, 8), p.leather); quiver.rotateX(0.45); quiver.translate(-0.16, 1.3, -0.36);
	const fl = paint(new THREE.BoxGeometry(0.2, 0.16, 0.06), p.cloth); fl.rotateX(0.45); fl.translate(-0.16, 1.62, -0.52);
	parts.push(bow, bt1, bt2, quiver, fl);
	const m = mergeGeometries(parts, false)!; m.computeVertexNormals(); return m;
}

function buildGuardian(p: Palette): THREE.BufferGeometry {
	// WHALE AVATAR: jackal-headed guardian of the Duat — towering, gold-collared, great khopesh
	const parts = [...chunkyBase(p), ...armPair(p)];
	const dark = '#4a4260'; // moonlit iron — dark, but never a black blob against the night field
	// jackal skull, muzzle and tall ears over the head
	const skull = paint(new THREE.BoxGeometry(0.56, 0.5, 0.54), dark); skull.translate(0, 1.66, 0.02);
	const snout = paint(new THREE.BoxGeometry(0.22, 0.2, 0.46), dark); snout.translate(0, 1.56, 0.44);
	const nose = paint(new THREE.BoxGeometry(0.1, 0.1, 0.08), '#000000'); nose.translate(0, 1.58, 0.68);
	const ear1 = paint(new THREE.BoxGeometry(0.14, 0.52, 0.18), dark); ear1.rotateZ(0.12); ear1.translate(-0.19, 2.1, -0.02);
	const ear2 = paint(new THREE.BoxGeometry(0.14, 0.52, 0.18), dark); ear2.rotateZ(-0.12); ear2.translate(0.19, 2.1, -0.02);
	const in1 = paint(new THREE.BoxGeometry(0.07, 0.3, 0.08), p.accent); in1.rotateZ(0.12); in1.translate(-0.19, 2.08, 0.07);
	const in2 = paint(new THREE.BoxGeometry(0.07, 0.3, 0.08), p.accent); in2.rotateZ(-0.12); in2.translate(0.19, 2.08, 0.07);
	// burning gold eyes
	const ey1 = paint(new THREE.SphereGeometry(0.07, 6, 5), p.accent); ey1.translate(-0.14, 1.72, 0.3);
	const ey2 = paint(new THREE.SphereGeometry(0.07, 6, 5), p.accent); ey2.translate(0.14, 1.72, 0.3);
	// great khopesh in the right hand, ankh of judgement in the left
	parts.push(...khopesh(p, 1, 1.25));
	const loop = paint(new THREE.TorusGeometry(0.13, 0.045, 6, 12), p.accent); loop.translate(-0.66, 1.32, 0.12);
	const bar = paint(new THREE.BoxGeometry(0.34, 0.06, 0.06), p.accent); bar.translate(-0.66, 1.14, 0.12);
	const stem = paint(new THREE.BoxGeometry(0.06, 0.34, 0.06), p.accent); stem.translate(-0.66, 0.94, 0.12);
	parts.push(skull, snout, nose, ear1, ear2, in1, in2, ey1, ey2, loop, bar, stem);
	const m = mergeGeometries(parts, false)!; m.computeVertexNormals(); return m;
}

function buildArrowGeo(): THREE.BufferGeometry {
	const shaft = paint(new THREE.CylinderGeometry(0.035, 0.035, 1.2, 5), '#8a5a2b');
	const tip = paint(new THREE.ConeGeometry(0.09, 0.22, 6), '#dfe4ea'); tip.translate(0, 0.7, 0);
	const fl = paint(new THREE.BoxGeometry(0.18, 0.22, 0.02), '#ffffff'); fl.translate(0, -0.58, 0);
	const m = mergeGeometries([shaft, tip, fl], false)!; m.computeVertexNormals(); return m;
}

// ---------- environment textures ----------

function groundTexture(): THREE.Texture {
	const c = document.createElement('canvas'); c.width = c.height = 512;
	const x = c.getContext('2d')!;
	x.fillStyle = '#b0a996'; x.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 18000; i++) { const v = 165 + Math.random() * 80; x.fillStyle = `rgba(${v},${v - 6},${v - 20},${Math.random() * 0.4})`; x.fillRect(Math.random() * 512, Math.random() * 512, 2, 2); }
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 3); t.anisotropy = 4; return t;
}
function skyTexture(): THREE.Texture {
	// a black-metal night: violet-black void, dense stars, a pale blood moon
	const c = document.createElement('canvas'); c.width = 512; c.height = 512;
	const x = c.getContext('2d')!;
	const g = x.createLinearGradient(0, 0, 0, 512);
	g.addColorStop(0, '#050309'); g.addColorStop(0.5, '#0a0510'); g.addColorStop(0.82, '#140911'); g.addColorStop(1, '#1a0c10');
	x.fillStyle = g; x.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 340; i++) {
		const sx = Math.random() * 512, sy = Math.pow(Math.random(), 1.5) * 360;
		x.fillStyle = `rgba(210,205,255,${0.07 + Math.random() * 0.42})`;
		x.beginPath(); x.arc(sx, sy, 0.3 + Math.random() * 1.1, 0, Math.PI * 2); x.fill();
	}
	// the blood moon — a pale disc ringed in dull crimson haze
	const mx = 396, my = 92;
	const halo = x.createRadialGradient(mx, my, 8, mx, my, 88);
	halo.addColorStop(0, 'rgba(255,120,110,0.30)'); halo.addColorStop(0.4, 'rgba(160,50,60,0.12)'); halo.addColorStop(1, 'rgba(0,0,0,0)');
	x.fillStyle = halo; x.fillRect(mx - 90, my - 90, 180, 180);
	const disc = x.createRadialGradient(mx - 6, my - 6, 2, mx, my, 26);
	disc.addColorStop(0, '#ffe9df'); disc.addColorStop(0.75, '#e8b5a4'); disc.addColorStop(1, '#b06a5e');
	x.fillStyle = disc; x.beginPath(); x.arc(mx, my, 26, 0, Math.PI * 2); x.fill();
	// faint craters
	x.fillStyle = 'rgba(140,80,70,0.25)';
	for (const [cx, cy, cr] of [[388, 84, 5], [404, 100, 4], [392, 102, 3], [408, 82, 2.5]] as const) { x.beginPath(); x.arc(cx, cy, cr, 0, Math.PI * 2); x.fill(); }
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function radialTexture(hex: string): THREE.Texture {
	const c = document.createElement('canvas'); c.width = c.height = 128;
	const x = c.getContext('2d')!;
	const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, hex); g.addColorStop(1, 'rgba(0,0,0,0)');
	x.fillStyle = g; x.fillRect(0, 0, 128, 128);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Battle {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private composer!: EffectComposer;

	private armies: Record<string, { mesh: THREE.InstancedMesh; free: number[]; top: number }> = {};
	private units: Unit[] = [];
	private frontX = 0;
	private terrainH: (x: number, z: number) => number = () => 0;

	private arrowMesh!: THREE.InstancedMesh;
	private PROJ = 320;
	private proj!: { active: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; dmg: number; team: Team; life: number }[];
	private projHead = 0;

	private raf = 0; private last = 0; private time = 0; private frame = 0;
	private focus = false; private trackWallet: string | null = null;
	private shake = 0; private statTick = 0; private fpsAvg = 60;
	private quality = 2; private qualTick = 0;
	private unbind: (() => void)[] = [];
	private timeScale = 1; private slowmo = 0; private momentum = 0;
	// war campaign: front advances to a base → theater falls → resets with the newer mcap
	private phase: 'battle' | 'victory' = 'battle';
	private winner: Team | null = null;
	private campaign = 1;
	private wonUntil = 0;
	private winsBull = 0; private winsBear = 0;
	private warClock = 0; private battlePhase: WarPhase = 'form';
	// massed archery: volleys loose together on a shared signal during the standoff phases
	private volleyT = 3; private volleyWindow = 0;
	// the first strike after the horns sound lands in slow motion
	private awaitClash = false;
	// single combat before the hosts — one champion from each side meets in no-man's land
	private duelA: Unit | null = null; private duelB: Unit | null = null;
	onCampaign: ((r: { winner: Team; campaign: number }) => void) | null = null;
	private reinB = 0; private reinS = 0; private accB = 0; private accS = 0;
	private killFx: { x: number; z: number; team: Team; until: number }[] = [];
	private decals!: THREE.InstancedMesh; private DECAL_N = 200; private decalHead = 0;
	private decalLife!: Float32Array; private decalBase!: Float32Array; private decalX!: Float32Array; private decalZ!: Float32Array;

	private commanders = new Map<string, { kills: number; tier: string; team: Team; usd: number }>();
	private totalKills = 0; private biggestWhaleUsd = 0; private biggestWhaleWallet = '';
	private lastGarrison = { bulls: 60, bears: 60 };

	private camYaw = 0.06; private camPitch = 0.46; private camZoom = 0.85;
	private panX = 0; private panZ = 0; private keys = new Set<string>();
	private manualUntil = 0; private dragging = false; private lastPtr = { x: 0, y: 0 };

	private sparks!: THREE.Points; private sparkPos!: Float32Array; private sparkVel!: Float32Array; private sparkLife!: Float32Array; private sparkColor!: Float32Array; private sparkHead = 0; private SPARK_N = 1500;
	private souls!: THREE.Points; private soulPos!: Float32Array; private soulVel!: Float32Array; private soulLife!: Float32Array; private soulColor!: Float32Array; private soulHead = 0; private SOUL_N = 400;

	private auras: THREE.Group[] = [];
	private capitalBull!: THREE.Group; private capitalBear!: THREE.Group; private frontLine!: THREE.Mesh;
	private flags: THREE.Mesh[] = [];
	private dummy = new THREE.Object3D(); private tmpColor = new THREE.Color();
	private _camTarget = new THREE.Vector3(); private _camPos = new THREE.Vector3();
	private q = new THREE.Quaternion(); private upV = new THREE.Vector3(0, 1, 0); private vTmp = new THREE.Vector3();

	casualtiesBull = 0; casualtiesBear = 0;

	onStats: ((s: Stats) => void) | null = null;
	onOverlay: ((o: Overlay) => void) | null = null;
	onEvent: ((e: BattleEvent) => void) | null = null;

	constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
		this.renderer.setSize(innerWidth, innerHeight);
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.toneMapping = THREE.NoToneMapping;

		this.scene.background = skyTexture();
		this.scene.fog = new THREE.FogExp2(0x140a12, 0.0015);

		this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 700);
		this.camera.position.set(0, 40, 60);
		this.camera.lookAt(0, 3, 0);

		this.buildComposer();
		this.buildLights();
		this.buildGround();
		this.buildProps();
		this.capitalBull = this.buildCapital('bull', -CAP);
		this.capitalBear = this.buildCapital('bear', CAP);
		this.frontLine = this.buildFrontLine();
		this.buildGroundText();
		this.buildMcapTicks();
		this.buildMcapSign();
		this.buildArmies();
		this.buildArrows();
		this.buildSparks();
		this.buildSouls();
		this.buildDecals();
		this.buildAuras();

		this.on(window, 'resize', () => this.resize());
		// GPU resets (driver TDR, tab backgrounding) must not leave a dead canvas
		this.on(canvas, 'webglcontextlost', (e) => e.preventDefault());
		this.on(canvas, 'webglcontextrestored', () => {
			this.composer.dispose();
			this.buildComposer();
			this.fxOk = true; this.fxChecked = false;
			this.resize();
		});
		this.bindCamera(canvas);
	}

	private on(t: EventTarget, k: string, fn: EventListener, opt?: AddEventListenerOptions) {
		t.addEventListener(k, fn, opt);
		this.unbind.push(() => t.removeEventListener(k, fn));
	}

	// ---------- pipeline ----------

	// post-processing self-defence: if the composer can't produce a sane frame on this
	// GPU/driver (no float render targets, broken pass → all-white output), drop to a
	// direct render with built-in tone mapping instead of showing a white screen.
	private fxOk = true; private fxChecked = false;

	private buildComposer() {
		const gl = this.renderer.getContext();
		const floatOk = this.renderer.capabilities.isWebGL2
			? !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))
			: !!gl.getExtension('OES_texture_half_float');
		this.composer = new EffectComposer(this.renderer, { multisampling: 0, frameBufferType: floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType });
		this.composer.addPass(new RenderPass(this.scene, this.camera));

		// one lean pass: neon bloom on emissives/tracers, filmic tone map, gentle vignette
		const bloom = new BloomEffect({ intensity: 0.55, luminanceThreshold: 0.62, luminanceSmoothing: 0.3, mipmapBlur: true, radius: 0.65 });
		const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
		const vignette = new VignetteEffect({ offset: 0.22, darkness: 0.42 });
		this.composer.addPass(new EffectPass(this.camera, bloom, tone, vignette));
		this.composer.addPass(new EffectPass(this.camera, new SMAAEffect()));
	}

	private buildLights() {
		// night war: bright silver moonlight key over a cool ambient bed, blood-red rim.
		// intensities are deliberately hot — the ACES pass pulls them back into a readable night.
		this.scene.add(new THREE.HemisphereLight(0x8698d8, 0x4a3a30, 1.25));
		const moon = new THREE.DirectionalLight(0xcfdcff, 2.8);
		moon.position.set(-34, 62, 26); moon.castShadow = true; moon.shadow.mapSize.set(1024, 1024);
		const s = 100; moon.shadow.camera.left = -s; moon.shadow.camera.right = s; moon.shadow.camera.top = s; moon.shadow.camera.bottom = -s; moon.shadow.camera.far = 220; moon.shadow.bias = -0.0004;
		this.scene.add(moon);
		const rim = new THREE.DirectionalLight(0xff5a4a, 1.1);
		rim.position.set(38, 30, -46);
		this.scene.add(rim);
	}

	private buildGround() {
		const mat = new THREE.MeshToonMaterial({ map: groundTexture(), vertexColors: true, gradientMap: (toonMaterial() as THREE.MeshToonMaterial).gradientMap });
		const geo = new THREE.PlaneGeometry(BOARD_W, BOARD_D, 210, 160);
		const noise2D = createNoise2D(() => 0.42);
		const pos = geo.attributes.position as THREE.BufferAttribute;
		const colors = new Float32Array(pos.count * 3);
		// night-war palette: moonlit moor vs ash waste, dark road, gold market-cap gridlines
		const bullSoil = new THREE.Color('#4a7a30'), bearSoil = new THREE.Color('#6e5138');
		const asphalt = new THREE.Color('#2e2e33'), dash = new THREE.Color('#c8c4b8'), grid = new THREE.Color('#ffd166');
		const c = new THREE.Color();
		for (let i = 0; i < pos.count; i++) {
			const px = pos.getX(i), py = pos.getY(i);
			const zTaper = THREE.MathUtils.clamp(1 - (Math.abs(py) - ARENA_Z) / 14, 0, 1);
			// fade the noise out at the board rim too — dips below the skirt read as black holes
			const edge = THREE.MathUtils.clamp(Math.min((BOARD_W / 2 - Math.abs(px)) / 10, (BOARD_D / 2 - Math.abs(py)) / 10), 0, 1);
			const h = hillY(px) * zTaper + noise2D(px * 0.05, py * 0.05) * 0.35 * edge;
			pos.setZ(i, h);
			// held territory split with a soft, noisy seam
			const wob = noise2D(0.5, py * 0.06) * 3;
			const t = THREE.MathUtils.clamp((px + wob + 5) / 10, 0, 1);
			c.copy(bullSoil).lerp(bearSoil, t);
			// hand-painted patches + mow stripes
			const patch = noise2D(px * 0.1, py * 0.1) * 0.5 + 0.5;
			c.multiplyScalar(0.85 + patch * 0.3);
			if (Math.floor(px / 6) % 2 === 0) c.multiplyScalar(1.022);
			// MARKET-CAP GRIDLINES: gold ticks every 8 units — the terrain IS the mcap axis
			const nearGrid = Math.abs(px - Math.round(px / 8) * 8);
			const gx = Math.round(px / 8) * 8;
			if (nearGrid < 0.24 && Math.abs(gx) <= 48) c.lerp(grid, gx === 0 ? 0.5 : 0.26);
			// horizontal ROAD across the whole map
			const roadDist = Math.abs(py - ROAD_Z);
			if (roadDist < 2.1) {
				c.lerp(asphalt, THREE.MathUtils.clamp(1 - (roadDist - 1.4) / 0.7, 0, 1));
				// centre dashes
				if (roadDist < 0.22 && ((px % 7) + 7) % 7 < 3) c.copy(dash);
			}
			colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
		}
		this.terrainH = (x, z) => {
			const zTaper = THREE.MathUtils.clamp(1 - (Math.abs(z) - ARENA_Z) / 14, 0, 1);
			return hillY(x) * zTaper;
		};
		geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		geo.computeVertexNormals();
		const g = new THREE.Mesh(geo, mat); g.rotation.x = -Math.PI / 2; g.receiveShadow = true; this.scene.add(g);
		// dark board skirt so the map reads as a diorama floating in the void
		// top face sits below the terrain's deepest noise valley (−0.35) — if it pokes above,
		// it occludes the ground from shallow camera angles and reads as black puddles
		const skirt = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, 3.4, BOARD_D), new THREE.MeshBasicMaterial({ color: 0x181410 }));
		skirt.position.y = -2.25; this.scene.add(skirt);
		// soft pedestal glow beneath the floating diorama
		const glow = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W * 2.1, BOARD_D * 2.3), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(70,120,95,0.5)'), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
		glow.rotation.x = -Math.PI / 2; glow.position.y = -3.6; this.scene.add(glow);
	}

	private buildProps() {
		const parts: THREE.BufferGeometry[] = [];
		const rng = (a: number, b: number) => a + Math.random() * (b - a);
		const onRoad = (z: number) => Math.abs(z - ROAD_Z) < 3.4;
		// date palms — leaning trunk with a crown of drooping fronds
		const palmAt = (x: number, z: number, s: number, green: string) => {
			const y = this.terrainH(x, z);
			const lean = rng(-0.14, 0.14);
			const trunk = paint(new THREE.CylinderGeometry(0.1 * s, 0.17 * s, 2.0 * s, 6), '#7a5a30');
			trunk.rotateZ(lean); trunk.translate(x, y + 1.0 * s, z);
			const topX = x - Math.sin(lean) * 1.0 * s, topY = y + 2.0 * s;
			for (let f = 0; f < 6; f++) {
				const a = (f / 6) * Math.PI * 2 + rng(0, 0.5);
				const frond = paint(new THREE.BoxGeometry(1.35 * s, 0.06 * s, 0.3 * s), green);
				frond.translate(0.62 * s, 0, 0); frond.rotateZ(-0.5); frond.rotateY(a);
				frond.translate(topX, topY, z);
				parts.push(frond);
			}
			const crown = paint(new THREE.SphereGeometry(0.16 * s, 6, 5), '#5a4020'); crown.translate(topX, topY, z);
			parts.push(trunk, crown);
		};
		// palm groves across BOTH territories — clear of the road, the fighting lane, and the
		// board rim (rim palms silhouette into black smudges against the night sky)
		for (let i = 0; i < 220; i++) {
			const x = rng(-BOARD_W / 2 + 15, BOARD_W / 2 - 15);
			const z = rng(-BOARD_D / 2 + 13, BOARD_D / 2 - 13);
			if (onRoad(z)) continue;
			if (Math.abs(x) < CAP - 6 && Math.abs(z) < ARENA_Z - 4 && Math.random() < 0.82) continue;
			const bull = x < 0;
			const green = bull ? (Math.random() < 0.5 ? '#3d9a44' : '#4fb44c') : (Math.random() < 0.5 ? '#8a9a3a' : '#a8963c');
			palmAt(x, z, rng(0.8, 1.4), green);
		}
		// obelisks flanking the road in each territory
		const obeliskAt = (x: number, z: number, s: number) => {
			const y = this.terrainH(x, z);
			const base = paint(new THREE.BoxGeometry(1.3 * s, 0.5 * s, 1.3 * s), '#b9a274'); base.translate(x, y + 0.25 * s, z);
			const shaft = paint(new THREE.CylinderGeometry(0.28 * s, 0.45 * s, 4.6 * s, 4), '#cdb684'); shaft.rotateY(Math.PI / 4); shaft.translate(x, y + 2.8 * s, z);
			const tip = paint(new THREE.ConeGeometry(0.4 * s, 0.6 * s, 4), '#ffd34d'); tip.rotateY(Math.PI / 4); tip.translate(x, y + 5.4 * s, z);
			parts.push(base, shaft, tip);
		};
		for (const [ox, oz, os] of [[-44, 14.5, 1], [-44, 3.5, 1], [48, 14.5, 1.1], [48, 3.5, 1.1], [-78, -30, 0.8], [76, 38, 0.8]] as const) obeliskAt(ox, oz, os);
		const merged = mergeGeometries(parts, false)!; merged.computeVertexNormals();
		const mesh = new THREE.Mesh(merged, toonMaterial()); mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh);

		// war-torches line the road and ring the capitals — self-lit embers against the night
		const poles: THREE.BufferGeometry[] = [];
		const flames: THREE.BufferGeometry[] = [];
		const torchAt = (x: number, z: number) => {
			const y = this.terrainH(x, z);
			const pole = paint(new THREE.CylinderGeometry(0.09, 0.13, 2.6, 5), '#2e2318'); pole.translate(x, y + 1.3, z);
			const cage = paint(new THREE.CylinderGeometry(0.24, 0.18, 0.3, 5), '#1c1712'); cage.translate(x, y + 2.7, z);
			poles.push(pole, cage);
			const fl = paint(new THREE.ConeGeometry(0.22, 0.62, 6), '#ffb14a'); fl.translate(x, y + 3.1, z);
			const core = paint(new THREE.SphereGeometry(0.12, 6, 5), '#ffe6a0'); core.translate(x, y + 2.92, z);
			flames.push(fl, core);
		};
		for (let tx = -72; tx <= 72; tx += 16) { torchAt(tx, ROAD_Z - 4.2); torchAt(tx + 8, ROAD_Z + 4.2); }
		for (const cx of [-CAP, CAP]) for (const [dx, dz] of [[-9, -9], [9, -9], [-9, 9], [9, 9]] as const) torchAt(cx + dx, dz);
		const pm = mergeGeometries(poles, false)!; pm.computeVertexNormals();
		this.scene.add(new THREE.Mesh(pm, toonMaterial()));
		const fm = mergeGeometries(flames, false)!;
		this.scene.add(new THREE.Mesh(fm, new THREE.MeshBasicMaterial({ vertexColors: true }))); // unlit — burns bright at night

		// oases — dark moonlit pools, one deep in each territory
		const lakeMat = new THREE.MeshBasicMaterial({ color: 0x1d4a68, transparent: true, opacity: 0.62 });
		for (const [lx, lz, r] of [[-54, -40, 10], [60, 42, 11]] as const) {
			const lake = new THREE.Mesh(new THREE.CircleGeometry(r, 24), lakeMat);
			lake.rotation.x = -Math.PI / 2; lake.scale.y = 0.6; lake.position.set(lx, this.terrainH(lx, lz) + 0.12, lz);
			this.scene.add(lake);
		}

		// mud-brick villages — flat-roofed adobe blocks in the back corners
		const vparts: THREE.BufferGeometry[] = [];
		const houseAt = (x: number, z: number, wall: string) => {
			const y = this.terrainH(x, z);
			const h = rng(0.9, 1.4);
			const base = paint(new THREE.BoxGeometry(rng(1.4, 2.0), h, rng(1.2, 1.8)), wall); base.translate(x, y + h / 2, z);
			const roof = paint(new THREE.BoxGeometry(1.1, 0.16, 0.9), '#8a6a3c'); roof.translate(x + rng(-0.3, 0.3), y + h + 0.08, z + rng(-0.2, 0.2));
			const door = paint(new THREE.BoxGeometry(0.3, 0.5, 0.08), '#3a2a16'); door.translate(x, y + 0.25, z + 0.86);
			vparts.push(base, roof, door);
		};
		for (const [vx, vz] of [[-76, 52], [74, -52], [-84, -44], [80, 48]] as const)
			for (let k = 0; k < 4; k++) houseAt(vx + rng(-4, 4), vz + rng(-4, 4), Math.random() < 0.5 ? '#d8c9a8' : '#c8ab7e');
		const vm = mergeGeometries(vparts, false)!; vm.computeVertexNormals();
		const vmesh = new THREE.Mesh(vm, toonMaterial()); vmesh.castShadow = true; this.scene.add(vmesh);
	}

	private buildCapital(team: Team, x: number): THREE.Group {
		const p = PAL[team];
		const grp = new THREE.Group();
		const parts: THREE.BufferGeometry[] = [];
		// obsidian ziggurat — black stone stepped in shadow, gold-trimmed, crowned in team fire
		const steps = [ [14, 3.4], [10.5, 3.0], [7.4, 2.7], [4.6, 2.4] ] as const;
		let y = 0;
		steps.forEach(([w, h], i) => {
			const b = paint(new THREE.BoxGeometry(w, h, w), i % 2 ? '#211d2a' : '#2b2536'); b.translate(0, y + h / 2, 0); y += h;
			parts.push(b);
			const trim = paint(new THREE.BoxGeometry(w + 0.4, 0.3, w + 0.4), p.accent); trim.translate(0, y, 0); parts.push(trim);
		});
		const geo = mergeGeometries(parts, false)!; geo.computeVertexNormals();
		const body = new THREE.Mesh(geo, toonMaterial()); body.castShadow = true; grp.add(body);
		// glowing capstone
		const cap = new THREE.Mesh(new THREE.ConeGeometry(2, 2.6, 4), new THREE.MeshBasicMaterial({ color: team === 'bull' ? 0x7dffb0 : 0xff8a95 }));
		cap.position.y = y + 1.3; cap.rotation.y = Math.PI / 4; grp.add(cap);
		// banner
		const pole = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.1, 0.1, 5.4, 6), '#7a4c26'), toonMaterial());
		pole.position.set(0, y + 2.6, 0); grp.add(pole);
		const flag = new THREE.Mesh(paint(new THREE.PlaneGeometry(3.4, 1.9), p.cloth), new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide, gradientMap: toonMaterial().gradientMap }));
		flag.position.set(1.8, y + 4.4, 0); grp.add(flag);
		this.flags.push(flag);
		grp.position.set(x, 0, 0);
		this.scene.add(grp);
		return grp;
	}

	private buildFrontLine(): THREE.Mesh {
		// crisp glowing seam instead of a wide haze column
		const m = new THREE.Mesh(new THREE.PlaneGeometry(2.2, ARENA_Z * 2 + 12), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,244,200,0.9)'), color: 0xfff2c0, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
		m.rotation.x = -Math.PI / 2; m.position.y = 0.06; this.scene.add(m); return m;
	}

	private priceTex!: THREE.CanvasTexture;
	private priceCanvas!: HTMLCanvasElement;
	private buildGroundText() {
		const c = document.createElement('canvas'); c.width = 1024; c.height = 256; this.priceCanvas = c;
		this.priceTex = new THREE.CanvasTexture(c); this.priceTex.colorSpace = THREE.SRGBColorSpace;
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 15), new THREE.MeshBasicMaterial({ map: this.priceTex, transparent: true, opacity: 0.55, depthWrite: false }));
		mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, 0.25, 40);
		this.scene.add(mesh);
		this.setPriceLabel('$OSIRIS', '');
	}
	// dollar tick labels along the field edges — the terrain is a live market-cap price
	// ladder (NewHedge-style): every gold gridline is a real $ level around the current cap
	private mcapTicks: { gx: number; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture }[] = [];
	private lastLadderMcap = 0;
	private buildMcapTicks() {
		for (let gx = -48; gx <= 48; gx += 16) {
			if (gx === 0) continue;
			const c = document.createElement('canvas'); c.width = 192; c.height = 56;
			const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
			this.mcapTicks.push({ gx, canvas: c, tex });
			this.drawTick(gx, null);
			const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false }));
			sp.scale.set(9.6, 2.8, 1);
			sp.position.set(gx, 1.6, -ARENA_Z - 7);
			this.scene.add(sp);
			// mirrored on the near edge for reads from every camera angle
			const sp2 = sp.clone();
			sp2.position.set(gx, 1.6, ARENA_Z + 9);
			this.scene.add(sp2);
		}
	}
	private drawTick(gx: number, mcap: number | null) {
		const t = this.mcapTicks.find((k) => k.gx === gx); if (!t) return;
		const x = t.canvas.getContext('2d')!;
		x.clearRect(0, 0, 192, 56);
		x.textAlign = 'center'; x.textBaseline = 'middle';
		const col = gx > 0 ? 'rgba(122,255,176,0.95)' : 'rgba(255,138,149,0.95)';
		x.font = '700 15px "JetBrains Mono", monospace';
		x.fillStyle = 'rgba(255,255,255,0.4)';
		x.fillText(`${gx > 0 ? '+' : ''}${gx}%`, 96, 10);
		x.font = '800 27px "JetBrains Mono", monospace';
		x.fillStyle = col;
		x.shadowColor = 'rgba(0,0,0,0.9)'; x.shadowBlur = 6;
		x.fillText(mcap ? fmtUsdShort(mcap * (1 + gx / 100)) : '····', 96, 34);
		x.shadowBlur = 0;
		t.tex.needsUpdate = true;
	}
	// re-label the ladder from the live market cap (skips redraws under 0.5% moves)
	setMcapLadder(mcap: number) {
		if (!mcap || Math.abs(mcap - this.lastLadderMcap) / mcap < 0.005) return;
		this.lastLadderMcap = mcap;
		for (const t of this.mcapTicks) this.drawTick(t.gx, mcap);
	}

	private mcapSprite!: THREE.Sprite;
	private mcapCanvas!: HTMLCanvasElement;
	private mcapTex!: THREE.CanvasTexture;
	private buildMcapSign() {
		const c = document.createElement('canvas'); c.width = 512; c.height = 200; this.mcapCanvas = c;
		this.mcapTex = new THREE.CanvasTexture(c); this.mcapTex.colorSpace = THREE.SRGBColorSpace;
		this.mcapSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.mcapTex, transparent: true, depthTest: false }));
		this.mcapSprite.scale.set(18, 7, 1);
		this.mcapSprite.renderOrder = 999;
		this.scene.add(this.mcapSprite);
		this.setMarketCap('—', 0);
	}
	setMarketCap(value: string, dir: number) {
		if (!this.mcapCanvas) return;
		const x = this.mcapCanvas.getContext('2d')!;
		x.clearRect(0, 0, 512, 200);
		const up = dir >= 0;
		const col = up ? '#2fe07a' : '#ff5560';
		// pill background
		x.fillStyle = 'rgba(10,14,12,0.82)';
		const rr = (px: number, py: number, w: number, h: number, r: number) => { x.beginPath(); x.moveTo(px + r, py); x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r); x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath(); };
		rr(16, 40, 480, 120, 26); x.fill(); x.lineWidth = 5; x.strokeStyle = col; x.stroke();
		x.textAlign = 'center'; x.textBaseline = 'middle';
		x.font = '700 26px "JetBrains Mono", monospace'; x.fillStyle = 'rgba(255,255,255,0.55)';
		x.fillText('MARKET CAP', 256, 68);
		x.font = '800 62px "JetBrains Mono", monospace'; x.fillStyle = '#fff';
		x.fillText(value, 236, 122);
		// direction arrow
		x.fillStyle = col; x.font = '800 60px system-ui, sans-serif';
		x.fillText(up ? '▲' : '▼', 236 + x.measureText(value).width / 2 + 44, 122);
		this.mcapTex.needsUpdate = true;
	}
	setPriceLabel(price: string, sub: string) {
		if (!this.priceCanvas) return;
		const x = this.priceCanvas.getContext('2d')!;
		x.clearRect(0, 0, 1024, 256);
		x.textAlign = 'center'; x.textBaseline = 'middle';
		x.font = '700 34px "JetBrains Mono", monospace'; x.fillStyle = 'rgba(30,30,20,0.6)';
		x.fillText(sub || 'CURRENT PRICE', 512, 40);
		x.font = '800 120px "JetBrains Mono", monospace';
		x.lineWidth = 10; x.strokeStyle = 'rgba(255,255,255,0.55)'; x.strokeText(price, 512, 150);
		x.fillStyle = 'rgba(35,32,20,0.85)'; x.fillText(price, 512, 150);
		this.priceTex.needsUpdate = true;
	}

	private buildArmies() {
		const builders: Record<Cls, (p: Palette) => THREE.BufferGeometry> = { spear: buildSpearman, duelist: buildDuelist, archer: buildArcher, guardian: buildGuardian };
		for (const team of ['bull', 'bear'] as Team[]) {
			for (const cls of CLASSES) {
				const mesh = new THREE.InstancedMesh(builders[cls](PAL[team]), toonMaterial(), MAX);
				mesh.castShadow = true; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = MAX;
				this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
				for (let i = 0; i < MAX; i++) { mesh.setMatrixAt(i, this.dummy.matrix); const v = 0.92 + Math.random() * 0.16; mesh.setColorAt(i, this.tmpColor.setScalar(v)); }
				mesh.instanceMatrix.needsUpdate = true;
				this.scene.add(mesh);
				const free: number[] = []; for (let i = 0; i < MAX; i++) free.push(MAX - 1 - i);
				this.armies[`${team}:${cls}`] = { mesh, free, top: -1 };
			}
		}
	}

	private buildArrows() {
		this.arrowMesh = new THREE.InstancedMesh(buildArrowGeo(), new THREE.MeshBasicMaterial({ vertexColors: true }), this.PROJ);
		this.arrowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.arrowMesh.count = this.PROJ; this.arrowMesh.frustumCulled = false;
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (let i = 0; i < this.PROJ; i++) { this.arrowMesh.setMatrixAt(i, this.dummy.matrix); this.arrowMesh.setColorAt(i, this.tmpColor.set(0xffffff)); }
		this.scene.add(this.arrowMesh);
		this.proj = Array.from({ length: this.PROJ }, () => ({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dmg: 0, team: 'bull' as Team, life: 0 }));
	}

	private buildSparks() {
		const N = this.SPARK_N; this.sparkPos = new Float32Array(N * 3); this.sparkColor = new Float32Array(N * 3); this.sparkVel = new Float32Array(N * 3); this.sparkLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.sparkPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.sparkColor, 3));
		this.sparks = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.95)'), size: 0.55, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.35 }));
		this.sparks.frustumCulled = false; this.scene.add(this.sparks);
	}
	private buildSouls() {
		const N = this.SOUL_N; this.soulPos = new Float32Array(N * 3); this.soulColor = new Float32Array(N * 3); this.soulVel = new Float32Array(N * 3); this.soulLife = new Float32Array(N);
		for (let i = 0; i < N; i++) this.soulPos[i * 3 + 1] = -999;
		const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.soulPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.soulColor, 3));
		this.souls = new THREE.Points(g, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,0.9)'), size: 1.5, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0.25 }));
		this.souls.frustumCulled = false; this.scene.add(this.souls);
	}

	private buildDecals() {
		// battle scars where warriors fall — fade out by shrinking
		const geo = new THREE.CircleGeometry(0.85, 10); geo.rotateX(-Math.PI / 2);
		this.decals = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0x2b1d10, transparent: true, opacity: 0.34, depthWrite: false }), this.DECAL_N);
		this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.decals.count = this.DECAL_N; this.decals.frustumCulled = false;
		this.decalLife = new Float32Array(this.DECAL_N); this.decalBase = new Float32Array(this.DECAL_N);
		this.decalX = new Float32Array(this.DECAL_N); this.decalZ = new Float32Array(this.DECAL_N);
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (let i = 0; i < this.DECAL_N; i++) this.decals.setMatrixAt(i, this.dummy.matrix);
		this.scene.add(this.decals);
	}
	private addDecal(x: number, z: number, s: number) {
		const i = this.decalHead; this.decalHead = (this.decalHead + 1) % this.DECAL_N;
		this.decalLife[i] = 26; this.decalBase[i] = s * (0.9 + Math.random() * 0.7);
		this.decalX[i] = x; this.decalZ[i] = z;
	}
	private updateDecals(dt: number) {
		let dirty = false;
		for (let i = 0; i < this.DECAL_N; i++) {
			if (this.decalLife[i] <= 0) continue;
			this.decalLife[i] -= dt;
			const k = THREE.MathUtils.clamp(this.decalLife[i] / 26, 0, 1);
			this.dummy.position.set(this.decalX[i], groundY(this.decalX[i], this.decalZ[i]) + 0.03 + (i % 9) * 0.0022, this.decalZ[i]);
			this.dummy.rotation.set(0, (i * 0.7) % Math.PI, 0);
			this.dummy.scale.setScalar(this.decalBase[i] * Math.sqrt(k));
			this.dummy.updateMatrix();
			this.decals.setMatrixAt(i, this.dummy.matrix);
			dirty = true;
		}
		if (dirty) this.decals.instanceMatrix.needsUpdate = true;
	}

	private buildAuras() {
		const runeGeo = new THREE.RingGeometry(1.05, 1.3, 40), rune2Geo = new THREE.RingGeometry(1.55, 1.68, 40), crownGeo = new THREE.OctahedronGeometry(0.22, 0);
		for (let i = 0; i < 12; i++) {
			const grp = new THREE.Group();
			const r1 = new THREE.Mesh(runeGeo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); r1.rotation.x = -Math.PI / 2; r1.position.y = 0.08; r1.name = 'r1';
			const r2 = new THREE.Mesh(rune2Geo, new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); r2.rotation.x = -Math.PI / 2; r2.position.y = 0.08; r2.name = 'r2';
			const crown = new THREE.Mesh(crownGeo, new THREE.MeshBasicMaterial({ color: 0xffd34d })); crown.name = 'crown';
			grp.add(r1, r2, crown); grp.visible = false; this.scene.add(grp); this.auras.push(grp);
		}
	}

	// ---------- camera ----------

	private bindCamera(canvas: HTMLCanvasElement) {
		this.on(canvas, 'pointerdown', (e) => { const p = e as PointerEvent; this.dragging = true; this.lastPtr = { x: p.clientX, y: p.clientY }; this.manualUntil = performance.now() + 7000; });
		this.on(window, 'pointerup', () => (this.dragging = false));
		this.on(window, 'pointermove', (e) => {
			if (!this.dragging) return;
			const p = e as PointerEvent;
			const dx = p.clientX - this.lastPtr.x, dy = p.clientY - this.lastPtr.y; this.lastPtr = { x: p.clientX, y: p.clientY };
			this.camYaw -= dx * 0.005; this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.0035, 0.05, 0.95); this.manualUntil = performance.now() + 7000;
		});
		this.on(canvas, 'wheel', (e) => { e.preventDefault(); this.camZoom = THREE.MathUtils.clamp(this.camZoom * (1 + Math.sign((e as WheelEvent).deltaY) * 0.08), 0.45, 2.0); }, { passive: false });
		this.on(window, 'keydown', (e) => {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA') return; // never hijack typing
			const k = (e as KeyboardEvent).key.toLowerCase(); if ('wasd'.includes(k)) this.keys.add(k);
		});
		this.on(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).key.toLowerCase()));
		this.on(window, 'blur', () => this.keys.clear()); // no stuck pan on alt-tab
	}

	// ---------- public API ----------

	setSupply(_s: number) {}
	setMomentum(m: number) { this.momentum = m; }
	// continuous garrison reinforcements/sec per side — scales with the selected timeframe's txn rate
	setReinforceRates(b: number, s: number) { this.reinB = b; this.reinS = s; }
	setTrackWallet(w: string | null) { this.trackWallet = w ? w.trim() : null; for (const u of this.units) u.tracked = !!this.trackWallet && u.wallet === this.trackWallet; }
	setFocus(f: boolean) { this.focus = f; }
	resetCamera() { this.manualUntil = 0; this.camYaw = 0.06; this.camPitch = 0.46; this.camZoom = 0.85; this.panX = 0; this.panZ = 0; }

	spawnGarrison(bulls: number, bears: number) {
		this.lastGarrison = { bulls, bears };
		for (let i = 0; i < bulls; i++) this.addUnit('bull', pickClass('SOLDIER', Math.random()), GARRISON, '', false, true);
		for (let i = 0; i < bears; i++) this.addUnit('bear', pickClass('SOLDIER', Math.random()), GARRISON, '', false, true);
	}

	spawn(input: SpawnInput) {
		const team: Team = input.kind === 'buy' || input.kind === 'bull' ? 'bull' : 'bear';
		let tier = tierForPct(input.pct);
		// on microcap tokens a few dollars can move 1% of supply — hold the top ranks to a
		// dollar floor too, so GOD/TITAN spectacle stays rare enough to mean something
		if (tier.name === 'GOD' && input.usd < 2000) tier = TIERS[1];
		if (tier.name === 'TITAN' && input.usd < 400) tier = TIERS[2];
		const god = tier.name === 'GOD';
		const legend = god || tier.name === 'TITAN';
		const cls = pickClass(tier.name, hash01(input.wallet + input.usd));
		const u = this.addUnit(team, cls, tier, input.wallet, legend, false);
		// every real trade lands with a visible team-coloured muster flash
		if (u) this.spawnBurst(u.x, groundY(u.x, u.z) + 1.2, u.z, team === 'bull' ? GOLD : CRIMSON, legend ? 26 : 6);
		if (input.wallet) {
			// bounded roster — drop the least notable wallet when full
			if (!this.commanders.has(input.wallet) && this.commanders.size >= 160) {
				let worstK: string | null = null, worst = Infinity;
				for (const [w, c] of this.commanders) { const score = c.kills * 1000 + c.usd; if (score < worst) { worst = score; worstK = w; } }
				if (worstK) this.commanders.delete(worstK);
			}
			const c = this.commanders.get(input.wallet) || { kills: 0, tier: tier.name, team, usd: 0 };
			c.team = team; c.usd = Math.max(c.usd, input.usd); if (rankIdx(tier.name) > rankIdx(c.tier)) c.tier = tier.name;
			this.commanders.set(input.wallet, c);
			if (input.usd > this.biggestWhaleUsd) { this.biggestWhaleUsd = input.usd; this.biggestWhaleWallet = input.wallet; }
		}
		if (legend) { this.shake = Math.min(1.6, this.shake + (god ? 1.4 : 0.7)); if (god) this.slowmo = 1.1; }
		this.onEvent?.({ type: legend ? 'legend' : 'spawn', team, tier: tier.name, cls, wallet: input.wallet, usd: input.usd, pct: input.pct, god });
		// a whale entering the field calls down a sky strike on the enemy host
		if (legend) {
			this.skyStrike(team, god);
			this.onEvent?.({ type: 'strike', team, tier: god ? 'GOD' : 'TITAN', cls, wallet: input.wallet, usd: input.usd, pct: input.pct, god });
		}
	}

	private addUnit(team: Team, cls: Cls, tier: Tier, wallet: string, legend: boolean, atFront: boolean): Unit | null {
		const army = this.armies[`${team}:${cls}`]; if (!army || !army.free.length) return null;
		const idx = army.free.pop()!;
		const sign = team === 'bull' ? -1 : 1;
		const st = CLASS_STATS[cls];
		this.units.push({
			team, sign, cls, ranged: st.ranged, tier: tier.name,
			scale: tier.scale * st.scaleMul, hp: tier.hp * st.hpMul, maxHp: tier.hp * st.hpMul, dmg: tier.dmg * st.dmgMul,
			standoff: st.standoff, speed: SPEED * st.speedMul,
			wallet,
			x: atFront ? sign * (3 + Math.random() * 13) : sign * (CAP - 2 - Math.random() * 4),
			// rear spawns muster on the road and march to the front in columns
			z: atFront ? (Math.random() - 0.5) * ARENA_Z * 2 : ROAD_Z + (Math.random() - 0.5) * 7,
			rank: atFront ? Math.random() * 3 : Math.random() * 6,
			bob: Math.random() * Math.PI * 2, age: 0, cd: Math.random() * 1.5, kills: 0, idx, dying: 0,
			tracked: !!this.trackWallet && wallet === this.trackWallet, legend, melee: false,
			target: null, retarget: Math.random() * 0.4, atkCd: Math.random() * 0.8, strike: 0,
			face: sign < 0 ? 0 : Math.PI, // rotY that points local +x (weapon/barrel) at the enemy side
			tint: 0.92 + Math.random() * 0.16, struck: 0, swingSide: Math.random() < 0.5 ? 1 : -1,
			lane: (Math.random() - 0.5) * ARENA_Z * 2,
			// formation post: quantized file across the field, class decides the rank depth
			slot: Math.round(((Math.random() - 0.5) * (ARENA_Z * 2 - 6)) / 2.6) * 2.6,
			row: cls === 'guardian' ? 0 : cls === 'spear' ? (Math.random() < 0.55 ? 0 : 1) : 2 + ((Math.random() * 2) | 0),
			frontJitter: -3 + Math.random() * 14, // ranged skirmish depth
			flank: !st.ranged && (cls === 'duelist' ? Math.random() < 0.3 : Math.random() < 0.08)
		});
		return this.units[this.units.length - 1];
	}

	start() { this.last = performance.now(); this.loop(); }
	dispose() {
		cancelAnimationFrame(this.raf);
		for (const off of this.unbind) off();
		this.unbind = [];
		this.scene.traverse((o) => {
			const m = o as THREE.Mesh;
			if (m.geometry) m.geometry.dispose();
			const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
			for (const mat of mats) { (mat as THREE.MeshBasicMaterial).map?.dispose(); mat.dispose(); }
		});
		this.composer.dispose(); this.renderer.dispose();
	}
	private resize() { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight); }

	// ---------- particles ----------

	private spawnBurst(x: number, y: number, z: number, color: THREE.Color, n: number) {
		for (let k = 0; k < n; k++) { const i = this.sparkHead; this.sparkHead = (this.sparkHead + 1) % this.SPARK_N; this.sparkPos[i * 3] = x; this.sparkPos[i * 3 + 1] = y; this.sparkPos[i * 3 + 2] = z; this.sparkVel[i * 3] = (Math.random() - 0.5) * 9; this.sparkVel[i * 3 + 1] = 2 + Math.random() * 8; this.sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 9; this.sparkLife[i] = 0.5 + Math.random() * 0.5; this.sparkColor[i * 3] = color.r; this.sparkColor[i * 3 + 1] = color.g; this.sparkColor[i * 3 + 2] = color.b; }
	}
	private spawnSoul(x: number, y: number, z: number, color: THREE.Color) {
		const i = this.soulHead; this.soulHead = (this.soulHead + 1) % this.SOUL_N; this.soulPos[i * 3] = x; this.soulPos[i * 3 + 1] = y; this.soulPos[i * 3 + 2] = z; this.soulVel[i * 3] = (Math.random() - 0.5) * 0.6; this.soulVel[i * 3 + 1] = 2.4 + Math.random() * 1.4; this.soulVel[i * 3 + 2] = (Math.random() - 0.5) * 0.6; this.soulLife[i] = 2.2 + Math.random() * 1.2; const c = color.clone().lerp(new THREE.Color(0xffffff), 0.5); this.soulColor[i * 3] = c.r; this.soulColor[i * 3 + 1] = c.g; this.soulColor[i * 3 + 2] = c.b;
	}
	private updateParticles(dt: number) {
		const p = this.sparkPos, v = this.sparkVel, l = this.sparkLife;
		for (let i = 0; i < this.SPARK_N; i++) { if (l[i] <= 0) continue; l[i] -= dt; v[i * 3 + 1] -= 14 * dt; p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt; if (l[i] <= 0) p[i * 3 + 1] = -999; }
		(this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true; (this.sparks.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
		const sp = this.soulPos, sv = this.soulVel, sl = this.soulLife;
		for (let i = 0; i < this.SOUL_N; i++) { if (sl[i] <= 0) continue; sl[i] -= dt; sp[i * 3] += sv[i * 3] * dt + Math.sin(this.time * 2 + i) * 0.01; sp[i * 3 + 1] += sv[i * 3 + 1] * dt; sp[i * 3 + 2] += sv[i * 3 + 2] * dt; if (sl[i] <= 0) sp[i * 3 + 1] = -999; }
		(this.souls.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true; (this.souls.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
	}

	// ---------- sky strikes (whale events) ----------

	// TITAN buy/sell → a falcon comet dives on the enemy host; GOD → the Spear of Ra,
	// a sky-beam that annihilates a knot of enemies. The market's biggest orders land
	// as unmissable battlefield events, scaled like NewHedge's liquidation strikes.
	private strikesFx: { mode: 'comet' | 'beam'; t: number; dur: number; sx: number; sy: number; sz: number; tx: number; ty: number; tz: number; team: Team; god: boolean; mesh: THREE.Mesh; hit: boolean }[] = [];

	private skyStrike(team: Team, god: boolean) {
		if (this.strikesFx.length >= 4) return;
		const foes: Unit[] = [];
		for (const u of this.units) if (u.team !== team && u.dying <= 0) foes.push(u);
		if (!foes.length) return;
		// aim at an enemy just behind the front, biased toward the thick of the host
		const sign = team === 'bull' ? 1 : -1;
		let best = foes[0], bd = Infinity;
		for (const e of foes) {
			const d = Math.abs(e.x - (this.frontX + sign * 7)) + Math.abs(e.z) * 0.25 + Math.random() * 9;
			if (d < bd) { bd = d; best = e; }
		}
		const tx = best.x, tz = best.z, ty = groundY(tx, tz);
		const col = team === 'bull' ? 0xffe08a : 0xff8a95;
		if (god) {
			const geo = new THREE.CylinderGeometry(1.7, 2.6, 90, 12, 1, true);
			const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
			const mesh = new THREE.Mesh(geo, mat);
			mesh.position.set(tx, ty + 45, tz);
			this.scene.add(mesh);
			this.strikesFx.push({ mode: 'beam', t: 0, dur: 1.1, sx: tx, sy: ty + 45, sz: tz, tx, ty, tz, team, god, mesh, hit: false });
		} else {
			const geo = new THREE.OctahedronGeometry(0.9, 0); geo.scale(1, 2.6, 1);
			const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
			const mesh = new THREE.Mesh(geo, mat);
			const sx = tx - sign * 42, sy = ty + 34, sz = tz + (Math.random() - 0.5) * 24;
			mesh.position.set(sx, sy, sz);
			this.scene.add(mesh);
			this.strikesFx.push({ mode: 'comet', t: 0, dur: 0.55, sx, sy, sz, tx, ty, tz, team, god, mesh, hit: false });
		}
	}

	private updateStrikes(dt: number) {
		for (let i = this.strikesFx.length - 1; i >= 0; i--) {
			const s = this.strikesFx[i];
			s.t += dt;
			const k = Math.min(1, s.t / s.dur);
			if (s.mode === 'comet') {
				// dive along a shallow arc, trailing embers
				const x = THREE.MathUtils.lerp(s.sx, s.tx, k);
				const y = THREE.MathUtils.lerp(s.sy, s.ty + 0.5, k * k);
				const z = THREE.MathUtils.lerp(s.sz, s.tz, k);
				s.mesh.position.set(x, y, z);
				this.vTmp.set(s.tx - s.sx, (s.ty - s.sy) * 2 * k, s.tz - s.sz).normalize();
				this.q.setFromUnitVectors(this.upV, this.vTmp);
				s.mesh.quaternion.copy(this.q);
				const c = s.team === 'bull' ? GOLD : CRIMSON;
				for (let n = 0; n < 3; n++) {
					const ti = this.sparkHead; this.sparkHead = (this.sparkHead + 1) % this.SPARK_N;
					this.sparkPos[ti * 3] = x + (Math.random() - 0.5); this.sparkPos[ti * 3 + 1] = y + (Math.random() - 0.5); this.sparkPos[ti * 3 + 2] = z + (Math.random() - 0.5);
					this.sparkVel[ti * 3] = 0; this.sparkVel[ti * 3 + 1] = 1; this.sparkVel[ti * 3 + 2] = 0;
					this.sparkLife[ti] = 0.25 + Math.random() * 0.2;
					this.sparkColor[ti * 3] = c.r * 2; this.sparkColor[ti * 3 + 1] = c.g * 2; this.sparkColor[ti * 3 + 2] = c.b * 2;
				}
				if (k >= 1 && !s.hit) { s.hit = true; this.strikeImpact(s.team, s.tx, s.tz, false); }
			} else {
				// beam: flash in, hold, fade — impact lands as the beam reaches full burn
				const op = k < 0.2 ? k / 0.2 : k > 0.7 ? (1 - k) / 0.3 : 1;
				(s.mesh.material as THREE.MeshBasicMaterial).opacity = op * 0.85;
				s.mesh.scale.x = s.mesh.scale.z = 0.7 + Math.sin(this.time * 30) * 0.12 + k * 0.5;
				s.mesh.rotation.y += dt * 3;
				if (k >= 0.25 && !s.hit) { s.hit = true; this.strikeImpact(s.team, s.tx, s.tz, true); }
			}
			if (k >= 1) {
				this.scene.remove(s.mesh);
				s.mesh.geometry.dispose();
				(s.mesh.material as THREE.Material).dispose();
				this.strikesFx.splice(i, 1);
			}
		}
	}

	private strikeImpact(team: Team, x: number, z: number, god: boolean) {
		const col = team === 'bull' ? GOLD : CRIMSON;
		this.spawnBurst(x, groundY(x, z) + 1, z, col, god ? 130 : 60);
		this.addDecal(x, z, god ? 3 : 1.8);
		this.shake = Math.min(2, this.shake + (god ? 1.5 : 0.8));
		let hits = 0;
		const maxHits = god ? 8 : 4, r2 = (god ? 9 : 6) ** 2, dmg = god ? 700 : 300;
		for (const e of this.units) {
			if (e.team === team || e.dying > 0) continue;
			const dx = e.x - x, dz = e.z - z;
			if (dx * dx + dz * dz < r2) {
				e.hp -= dmg; e.struck = 0.2;
				if (e.hp <= 0) this.kill(e, []);
				if (++hits >= maxHits) break;
			}
		}
	}

	// ---------- projectiles ----------

	private fireArrowAt(u: Unit, t: Unit) {
		const p = this.proj[this.projHead]; this.projHead = (this.projHead + 1) % this.PROJ;
		const sx = u.x, sy = hillY(u.x) + 1.4 * u.scale * UNIT_SCALE, sz = u.z;
		// aim at the target with slight scatter
		const tx = t.x + (Math.random() - 0.5) * 1.6, tz = t.z + (Math.random() - 0.5) * 1.6, ty = hillY(tx) + 0.9;
		const dist = Math.hypot(tx - sx, tz - sz);
		const T = THREE.MathUtils.clamp(dist / 30, 0.45, 0.95), g = 18; // high, slow arcs — volleys hang in the air
		p.active = true; p.x = sx; p.y = sy; p.z = sz;
		p.dmg = u.dmg * ATK_CD.archer * KILL_TEMPO * 0.6; p.team = u.team; p.life = T + 0.25;
		p.vx = (tx - sx) / T; p.vz = (tz - sz) / T; p.vy = (ty - sy + 0.5 * g * T * T) / T;
		// muzzle flash toward the target
		this.spawnBurst(sx + ((tx - sx) / dist) * 1.1, sy, sz + ((tz - sz) / dist) * 1.1, new THREE.Color(0xffe9a0), 3);
	}

	private updateArrows(dt: number) {
		const g = 18; let dirty = false;
		for (let i = 0; i < this.PROJ; i++) {
			const p = this.proj[i];
			if (!p.active) continue;
			p.vy -= g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.life -= dt;
			if (p.y <= hillY(p.x) + 0.4 || p.life <= 0) {
				p.active = false;
				this.spawnBurst(p.x, hillY(p.x) + 0.6, p.z, p.team === 'bull' ? GOLD : CRIMSON, 4);
				let best: Unit | null = null, bd = 9;
				for (const e of this.units) { if (e.team === p.team || e.dying > 0) continue; const dx = e.x - p.x, dz = e.z - p.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = e; } }
				if (best) { best.hp -= p.dmg * this.guardMul(best); best.struck = 0.16; if (best.hp <= 0) this.kill(best, []); }
				this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); this.arrowMesh.setMatrixAt(i, this.dummy.matrix); dirty = true;
				continue;
			}
			this.vTmp.set(p.vx, p.vy, p.vz).normalize();
			this.q.setFromUnitVectors(this.upV, this.vTmp);
			this.dummy.position.set(p.x, p.y, p.z); this.dummy.quaternion.copy(this.q); this.dummy.scale.setScalar(1.55); this.dummy.updateMatrix();
			this.arrowMesh.setMatrixAt(i, this.dummy.matrix);
			// HDR tracer colour — pushes past 1.0 so the bloom pass streaks it across the night
			this.arrowMesh.setColorAt(i, this.tmpColor.copy(p.team === 'bull' ? GOLD : CRIMSON).lerp(new THREE.Color(0xffffff), 0.4).multiplyScalar(2.4));
			// short-lived ember trail behind each shaft
			if (Math.random() < 0.45) {
				const ti = this.sparkHead; this.sparkHead = (this.sparkHead + 1) % this.SPARK_N;
				this.sparkPos[ti * 3] = p.x; this.sparkPos[ti * 3 + 1] = p.y; this.sparkPos[ti * 3 + 2] = p.z;
				this.sparkVel[ti * 3] = 0; this.sparkVel[ti * 3 + 1] = 0.4; this.sparkVel[ti * 3 + 2] = 0;
				this.sparkLife[ti] = 0.14 + Math.random() * 0.1;
				const tc = p.team === 'bull' ? GOLD : CRIMSON;
				this.sparkColor[ti * 3] = tc.r * 1.6; this.sparkColor[ti * 3 + 1] = tc.g * 1.6; this.sparkColor[ti * 3 + 2] = tc.b * 1.6;
			}
			dirty = true;
		}
		if (dirty) { this.arrowMesh.instanceMatrix.needsUpdate = true; if (this.arrowMesh.instanceColor) this.arrowMesh.instanceColor.needsUpdate = true; }
	}

	// ---------- loop ----------

	private loop = () => {
		this.raf = requestAnimationFrame(this.loop);
		this.frame++;
		const now = performance.now();
		const rawDt = Math.min((now - this.last) / 1000, 0.25); this.last = now;
		const dt = Math.min(rawDt, 0.05); this.time += rawDt;
		this.fpsAvg = this.fpsAvg * 0.92 + (1 / Math.max(rawDt, 0.001)) * 0.08;
		// adaptive resolution: shed pixels before shedding frames, climb back when headroom returns
		this.qualTick += rawDt;
		if (this.qualTick > 2.5) {
			this.qualTick = 0;
			if (this.fpsAvg < 45 && this.quality > 0) this.applyQuality(this.quality - 1);
			else if (this.fpsAvg > 58 && this.quality < 2) this.applyQuality(this.quality + 1);
		}
		this.slowmo = Math.max(0, this.slowmo - rawDt);
		this.timeScale += ((this.slowmo > 0 ? 0.32 : 1) - this.timeScale) * Math.min(1, rawDt * 6);
		const simDt = dt * this.timeScale;

		this.step(simDt);
		this.updateArrows(simDt);
		this.updateStrikes(simDt);
		this.updateParticles(simDt);
		this.updateDecals(simDt);
		this.render(dt);

		this.statTick += dt; if (this.statTick > 0.2) { this.statTick = 0; this.emitStats(); }
		if (this.frame % 2 === 0) this.emitOverlay(); // 30Hz is plenty for DOM labels
	};

	private applyQuality(q: number) {
		this.quality = q;
		const ratio = q === 2 ? Math.min(devicePixelRatio, 1.5) : q === 1 ? 1 : 0.75;
		this.renderer.setPixelRatio(ratio);
		this.resize();
	}

	private emptyComp(): Comp { return { spear: 0, duelist: 0, archer: 0, guardian: 0 }; }
	private _bullPower = 0; private _bearPower = 0; private _bullCount = 0; private _bearCount = 0;
	private _bullComp = this.emptyComp(); private _bearComp = this.emptyComp();

	private step(dt: number) {
		this.warClock += dt;
		const np = phaseAt(this.warClock);
		if (np !== this.battlePhase) {
			this.battlePhase = np;
			if (np === 'form') this.beginDuel();
			else if (np === 'advance') { this.duelA = null; this.duelB = null; } // champions rejoin the line
			else if (np === 'charge') this.awaitClash = true;
		}
		// volley signal: during standoffs the archers loose together, every few breaths
		this.volleyT -= dt;
		if (this.volleyT <= 0) { this.volleyT = 4.5; this.volleyWindow = 0.5; }
		else this.volleyWindow -= dt;
		// a fallen (or removed) champion ends the single combat
		if (this.duelA && (this.duelA.dying > 0 || this.duelA.hp <= 0)) this.duelA = null;
		if (this.duelB && (this.duelB.dying > 0 || this.duelB.hp <= 0)) this.duelB = null;
		if (!this.duelA || !this.duelB) { this.duelA = null; this.duelB = null; }
		let bullPower = 0, bearPower = 0, bullCount = 0, bearCount = 0;
		const bc = this.emptyComp(), rc = this.emptyComp();
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.team === 'bull') { bullCount++; bc[u.cls]++; bullPower += u.dmg * (u.ranged ? 0.6 : 1); }
			else { bearCount++; rc[u.cls]++; bearPower += u.dmg * (u.ranged ? 0.6 : 1); }
		}

		if (this.phase === 'battle') {
			const tot = bullPower + bearPower;
			const delta = tot > 0 ? (bullPower - bearPower) / tot : 0;
			const bias = THREE.MathUtils.clamp(this.momentum / 25, -1, 1) * FRONT_MAX * 0.35;
			// 0.95 ≥ the 0.9 win threshold — total battlefield dominance can actually storm the base
			const target = THREE.MathUtils.clamp(delta * FRONT_MAX * 0.95 + bias, -FRONT_MAX, FRONT_MAX);
			this.frontX += (target - this.frontX) * Math.min(1, dt * 0.4);
			// a side reaches the enemy base → the theater falls
			if (this.frontX > FRONT_MAX * 0.9) this.winCampaign('bull');
			else if (this.frontX < -FRONT_MAX * 0.9) this.winCampaign('bear');
		} else if (performance.now() >= this.wonUntil) {
			this.resetCampaign();
		}

		// timeframe-driven reinforcements keep the war supplied (paused while a theater falls)
		if (this.phase === 'battle') {
			this.accB += this.reinB * dt; this.accS += this.reinS * dt;
			while (this.accB >= 1) { this.accB -= 1; this.addUnit('bull', pickClass('SOLDIER', Math.random()), GARRISON, '', false, false); }
			while (this.accS >= 1) { this.accS -= 1; this.addUnit('bear', pickClass('SOLDIER', Math.random()), GARRISON, '', false, false); }
		}

		// live rosters for target acquisition
		const bullsAlive: Unit[] = [], bearsAlive: Unit[] = [];
		for (const u of this.units) if (u.dying <= 0) (u.team === 'bull' ? bullsAlive : bearsAlive).push(u);

		const acquire = (u: Unit, range: number, rangedOnly = false): Unit | null => {
			const foes = u.team === 'bull' ? bearsAlive : bullsAlive;
			let best: Unit | null = null, bd = range * range;
			for (const e of foes) {
				if (e.dying > 0 || e.hp <= 0 || (rangedOnly && !e.ranged)) continue;
				const dx = e.x - u.x, dz = e.z - u.z, d = dx * dx + dz * dz;
				if (d < bd) { bd = d; best = e; }
			}
			return best;
		};

		for (const u of this.units) {
			if (u.dying > 0) { u.dying -= dt; continue; }
			u.age += dt;
			u.rank = Math.max(0, u.rank - dt * 1.5); u.bob += dt * 9;
			u.strike = Math.max(0, u.strike - dt);
			u.struck = Math.max(0, u.struck - dt);
			u.atkCd -= dt;
			u.retarget -= dt;

			// theater fell: winners celebrate where they stand, losers rout to their capital
			if (this.phase === 'victory' && this.winner) {
				u.melee = false; u.target = null; u.strike = 0;
				if (u.team === this.winner) {
					u.bob += dt * 9; // double-time victory bounce
				} else {
					u.x += u.sign * u.speed * 1.6 * dt;
					const flee = u.sign < 0 ? Math.PI : 0; // run home, backs to the enemy
					let dA = flee - u.face;
					while (dA > Math.PI) dA -= Math.PI * 2;
					while (dA < -Math.PI) dA += Math.PI * 2;
					u.face += dA * Math.min(1, dt * 6);
				}
				continue;
			}

			// (re)acquire a real enemy to fight — how far we lock on breathes with the war rhythm
			const wp = this.battlePhase;
			const holding = wp === 'form' || wp === 'advance' || wp === 'regroup';
			const dueling = this.isDueling(u);
			const shaken = u.hp < u.maxHp * 0.3; // badly wounded — falls back, fights only if pressed
			if (dueling) {
				u.target = u === this.duelA ? this.duelB : this.duelA;
			} else if (u.retarget <= 0 || !u.target || u.target.hp <= 0 || u.target.dying > 0) {
				const range = u.ranged ? 34 : shaken ? 5 : wp === 'charge' ? 30 : wp === 'melee' ? ACQUIRE_R : 5;
				// flankers raid the enemy's archer line when the melee opens
				u.target = (u.flank && wp === 'melee' ? acquire(u, 36, true) : null) || acquire(u, range);
				u.retarget = 0.3 + Math.random() * 0.3;
			}

			let desiredFace: number | null = null;

			if (u.ranged) {
				// archers hold staggered firing lines — depth varies per unit
				u.melee = false;
				const tx = this.frontX + u.sign * (u.standoff + u.rank * 0.9 + Math.max(0, u.frontJitter) * 0.55);
				u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), u.speed * dt);
				// drift toward their lane so the line fills the whole arena depth
				u.z += Math.sign(u.lane - u.z) * Math.min(Math.abs(u.lane - u.z), u.speed * 0.3 * dt);
				if (u.target && (u.target.dying > 0 || u.target.hp <= 0)) u.target = null;
				if (u.target) {
					desiredFace = Math.atan2(-(u.target.z - u.z), u.target.x - u.x);
					// fire-control: loose at will in the fray, but volley together during the standoff
					const freeFire = wp === 'charge' || wp === 'melee';
					if (u.atkCd <= 0 && (freeFire || this.volleyWindow > 0)) {
						this.fireArrowAt(u, u.target); u.atkCd = ATK_CD.archer + Math.random() * 0.7;
						u.strike = 0.3;
					}
				}
			} else if (u.target && u.target.dying <= 0 && u.target.hp > 0 && (dueling || !holding || this.inContact(u, u.target))) {
				const t = u.target;
				const dx = t.x - u.x, dz = t.z - u.z;
				const dist = Math.hypot(dx, dz);
				const reach = (u.scale + t.scale) * 0.5 * UNIT_SCALE * 1.1 + (u.cls === 'guardian' ? 1.1 : 0.45);
				desiredFace = Math.atan2(-dz, dx);
				if (dist > reach) {
					// close with the enemy — a sounded charge doubles the fury
					const step = Math.min(dist - reach * 0.9, u.speed * (wp === 'charge' ? 1.7 : 1) * dt);
					u.x += (dx / dist) * step; u.z += (dz / dist) * step;
					u.melee = dist < reach * 3;
					// dust kicked up under the charge
					if (wp === 'charge' && Math.random() < dt * 1.4) this.spawnBurst(u.x, groundY(u.x, u.z) + 0.25, u.z, this.tmpColor.set(0x6b5c44) as THREE.Color, 2);
				} else {
					// in reach — strike on cooldown
					u.melee = true;
					if (u.atkCd <= 0) {
						u.atkCd = ATK_CD[u.cls] * (0.9 + Math.random() * 0.2);
						u.strike = 0.32;
						u.swingSide = -u.swingSide; // duelists alternate blades, others shift their stance
						// the first blow after the horns lands in slow motion — the lines have met
						if (this.awaitClash) { this.awaitClash = false; this.slowmo = Math.max(this.slowmo, 0.8); this.shake = Math.min(1.4, this.shake + 0.5); }
						const per = u.dmg * ATK_CD[u.cls] * KILL_TEMPO;
						const col = u.team === 'bull' ? GOLD : CRIMSON;
						this.spawnBurst(t.x, hillY(t.x) + 1.1, t.z, col, u.cls === 'guardian' ? 12 : 5);
						// knockback
						const kb = u.cls === 'guardian' ? 0.9 : 0.3;
						t.x += (dx / Math.max(0.01, dist)) * kb; t.z += (dz / Math.max(0.01, dist)) * kb * 0.4;
						t.hp -= per * this.guardMul(t); t.struck = 0.16;
						if (t.hp <= 0) this.kill(t, [u]);
						// a guardian's great khopesh cleaves through nearby enemies
						if (u.cls === 'guardian') {
							const foes = u.team === 'bull' ? bearsAlive : bullsAlive;
							let hits = 0;
							for (const e of foes) {
								if (e === t || e.dying > 0 || e.hp <= 0) continue;
								const ex = e.x - t.x, ez = e.z - t.z;
								if (ex * ex + ez * ez < 2.4 * 2.4) { e.hp -= per * 0.55 * this.guardMul(e); e.struck = 0.16; if (e.hp <= 0) this.kill(e, [u]); if (++hits >= 3) break; }
							}
							this.shake = Math.min(1.2, this.shake + 0.12);
						}
					}
				}
			} else if (u.flank && !holding) {
				// FLANKERS sweep the arena edge, cross behind the line, and strike from the side
				u.melee = false;
				const wx = this.frontX - u.sign * (5 + Math.max(0, u.frontJitter));
				const wz = (u.lane >= 0 ? 1 : -1) * (ARENA_Z - 3);
				const dx = wx - u.x, dz = wz - u.z, d = Math.hypot(dx, dz);
				if (d > 1) { const st2 = Math.min(d, u.speed * 1.1 * dt); u.x += (dx / d) * st2; u.z += (dz / d) * st2; }
				desiredFace = Math.atan2(-dz, dx);
			} else {
				// DRESS RANKS — hold a formation post behind the front. The hosts stand apart to
				// form, walk forward together on the advance, and pour through on the charge.
				u.melee = false;
				if (holding && !dueling) u.target = null;
				const base = holding ? (wp === 'advance' ? 3.2 : 8) : 2.4;
				const press = wp === 'charge' ? -5.5 : wp === 'melee' ? -0.5 : 0;
				const rowEff = u.row + (shaken ? 4 : 0); // the wounded fall back through the ranks
				const fx2 = this.frontX + u.sign * (base + rowEff * 1.7 + press);
				const fz2 = THREE.MathUtils.clamp(u.slot, -ARENA_Z + 2, ARENA_Z - 2);
				const ddx = fx2 - u.x, ddz = fz2 - u.z, dd = Math.hypot(ddx, ddz);
				if (dd > 0.15) {
					const st2 = Math.min(dd, u.speed * (wp === 'charge' ? 1.6 : 1) * dt);
					u.x += (ddx / dd) * st2; u.z += (ddz / dd) * st2;
				}
				desiredFace = u.sign < 0 ? 0 : Math.PI; // eyes on the enemy line
			}

			// smooth facing
			if (desiredFace !== null) {
				let dAng = desiredFace - u.face;
				while (dAng > Math.PI) dAng -= Math.PI * 2;
				while (dAng < -Math.PI) dAng += Math.PI * 2;
				u.face += dAng * Math.min(1, dt * 9);
			} else {
				const home = u.sign < 0 ? 0 : Math.PI;
				let dAng = home - u.face;
				while (dAng > Math.PI) dAng -= Math.PI * 2;
				while (dAng < -Math.PI) dAng += Math.PI * 2;
				u.face += dAng * Math.min(1, dt * 5);
			}
		}

		// separation — spatial hash keeps fighters from stacking into a single blob
		const grid = new Map<number, Unit[]>();
		for (const u of this.units) {
			if (u.dying > 0) continue;
			const key = Math.floor((u.x + 80) / 1.9) * 512 + Math.floor((u.z + 60) / 1.9);
			let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); }
			arr.push(u);
		}
		for (const arr of grid.values()) {
			const n = Math.min(arr.length, 7);
			for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
				const a = arr[i], b = arr[j];
				const dx = b.x - a.x, dz = b.z - a.z;
				const d2 = dx * dx + dz * dz;
				const min = (a.scale + b.scale) * 0.42 * UNIT_SCALE;
				if (d2 < min * min && d2 > 0.0001) {
					const d = Math.sqrt(d2), push = (min - d) * 0.4;
					const px = (dx / d) * push, pz = (dz / d) * push;
					a.x -= px; a.z -= pz; b.x += px; b.z += pz;
				}
			}
		}
		// keep everyone inside the arena and off the capitals
		for (const u of this.units) {
			if (u.dying > 0) continue;
			u.z = THREE.MathUtils.clamp(u.z, -ARENA_Z - 2, ARENA_Z + 2);
			u.x = THREE.MathUtils.clamp(u.x, -CAP + 3, CAP - 3);
		}

		this.updateInstances();

		this.frontLine.position.x = this.frontX; this.frontLine.position.y = hillY(this.frontX) + 0.12;
		(this.frontLine.material as THREE.MeshBasicMaterial).opacity = 0.2 + Math.sin(this.time * 5) * 0.07;
		// the market-cap marker rides the front line (its altitude on the hill)
		this.mcapSprite.position.set(this.frontX, hillY(this.frontX) + 11 + Math.sin(this.time * 1.5) * 0.4, 0);

		this._bullPower = bullPower; this._bearPower = bearPower; this._bullCount = bullCount; this._bearCount = bearCount; this._bullComp = bc; this._bearComp = rc;
	}

	// choose each side's champion for single combat: highest tier, closest to the front
	private pickChampion(team: Team): Unit | null {
		let best: Unit | null = null, bs = -Infinity;
		for (const u of this.units) {
			if (u.team !== team || u.dying > 0 || u.hp <= 0 || u.ranged) continue;
			const s = rankIdx(u.tier) * 10 - Math.abs(u.x - this.frontX) * 0.05 - Math.abs(u.z) * 0.02;
			if (s > bs) { bs = s; best = u; }
		}
		return best;
	}

	private beginDuel() {
		const a = this.pickChampion('bull'), b = this.pickChampion('bear');
		if (!a || !b) return;
		this.duelA = a; this.duelB = b;
		this.onEvent?.({ type: 'duel', team: 'bull', tier: `${a.tier} vs ${b.tier}`, cls: a.cls, wallet: a.wallet, usd: 0, pct: 0 });
	}

	private isDueling(u: Unit): boolean { return u === this.duelA || u === this.duelB; }

	// a dressed spearman keeps his great shield up between clashes — volleys glance off the wall
	private guardMul(t: Unit): number {
		if (t.cls !== 'spear') return 1;
		const wp = this.battlePhase;
		return wp === 'form' || wp === 'advance' || wp === 'regroup' ? 0.6 : 1;
	}

	// already blade-to-blade — you cannot disengage mid-fight to dress ranks
	private inContact(u: Unit, t: Unit): boolean {
		const dx = t.x - u.x, dz = t.z - u.z;
		const r = (u.scale + t.scale) * 0.5 * UNIT_SCALE * 1.1 + 3.4;
		return dx * dx + dz * dz < r * r;
	}

	private winCampaign(team: Team) {
		this.phase = 'victory'; this.winner = team; this.wonUntil = performance.now() + 4000; this.shake = 1.7;
		if (team === 'bull') this.winsBull++; else this.winsBear++;
		const loser = team === 'bull' ? this.capitalBear : this.capitalBull;
		// the fallen base erupts
		this.spawnBurst(loser.position.x, 4, 0, team === 'bull' ? CRIMSON : GOLD, 140);
		for (let k = 0; k < 6; k++) this.addDecal(loser.position.x + (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, 2.5);
		this.onCampaign?.({ winner: team, campaign: this.campaign });
	}

	private resetCampaign() {
		this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
		for (const u of this.units) this.armies[`${u.team}:${u.cls}`].mesh.setMatrixAt(u.idx, this.dummy.matrix);
		for (const key in this.armies) { const a = this.armies[key]; a.mesh.instanceMatrix.needsUpdate = true; a.free = []; for (let i = 0; i < MAX; i++) a.free.push(MAX - 1 - i); }
		this.units = []; this.frontX = 0; this.winner = null; this.phase = 'battle'; this.campaign++;
		this.warClock = 0; this.battlePhase = 'form'; this.duelA = null; this.duelB = null; this.awaitClash = false;
		this.spawnGarrison(this.lastGarrison.bulls, this.lastGarrison.bears);
	}

	private kill(u: Unit, killers: Unit[]) {
		if (u.dying > 0) return; // already down — never double-count a casualty
		u.dying = 8; // fall, lie as a casualty on the field, then fade
		this.spawnBurst(u.x, hillY(u.x) + 1.2, u.z, u.team === 'bull' ? GOLD : CRIMSON, u.legend ? 40 : 9);
		this.spawnSoul(u.x, hillY(u.x) + 1.6, u.z, u.team === 'bull' ? GOLD : CRIMSON);
		this.addDecal(u.x, u.z, u.scale);
		if (u.team === 'bull') this.casualtiesBull++; else this.casualtiesBear++;
		this.totalKills++;
		// each casualty physically shoves the front toward the loser's base
		this.frontX = THREE.MathUtils.clamp(this.frontX + (u.team === 'bear' ? 0.08 : -0.08), -FRONT_MAX, FRONT_MAX);
		this.killFx.push({ x: u.x, z: u.z, team: u.team, until: performance.now() + 1200 });
		if (this.killFx.length > 40) this.killFx.shift();
		if (killers.length) { const killer = killers[(Math.random() * killers.length) | 0]; killer.kills++; if (killer.wallet) { const c = this.commanders.get(killer.wallet); if (c) c.kills++; } }
		this.onEvent?.({ type: 'kill', team: u.team, tier: u.tier, cls: u.cls, wallet: u.wallet, usd: 0, pct: 0 });
	}

	private updateInstances() {
		const dirty = new Set<THREE.InstancedMesh>();
		for (const key in this.armies) this.armies[key].top = -1;
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i];
			if (u.dying <= 0 && u.hp <= 0) continue;
			const army = this.armies[`${u.team}:${u.cls}`];
			if (u.idx > army.top) army.top = u.idx;
			const mesh = army.mesh;
			const d = this.dummy, gy = groundY(u.x, u.z);
			// spawn pop-in (Clash-style overshoot)
			const pop = u.age < 0.45 ? easeOutBack(Math.min(1, u.age / 0.45)) : 1;
			const s = u.scale * UNIT_SCALE * Math.max(0.01, pop);
			if (u.dying > 0) {
				// fall over (0.45s) → lie as a casualty → sink away in the last second
				const elapsed = 8 - u.dying;
				const fall = Math.min(1, elapsed / 0.45);
				const fade = u.dying < 1 ? u.dying : 1;
				// fallen warriors topple sideways; guardians crumble slowly, still upright
				const flopAmt = u.cls === 'guardian' ? 0.5 : 0.94;
				const flop = (u.idx % 2 === 0 ? 1 : -1) * fall * (Math.PI / 2) * flopAmt;
				d.position.set(u.x, gy + (1 - fall) * 0.2 - (1 - fade) * 0.55, u.z);
				d.scale.setScalar(s * (0.55 + fade * 0.45));
				d.rotation.set(0, u.face, flop);
			} else if (u.ranged) {
				const hop = Math.abs(Math.sin(u.bob * 0.6)) * 0.06 * u.scale;
				// draw-and-loose: lean back on strike, snap forward on release
				const loose = u.strike > 0 ? Math.sin((0.3 - u.strike) / 0.3 * Math.PI) * 0.28 : 0;
				d.position.set(u.x, gy + hop, u.z);
				d.scale.setScalar(s);
				d.rotation.set(-loose * 0.6, u.face, Math.sin(u.bob * 0.5) * 0.05);
			} else if (u.strike > 0) {
				// weapon strike: anticipation wind-up then chop into the target
				const t = 1 - u.strike / 0.32; // 0 → 1 over the swing
				const swing = t < 0.35 ? -t / 0.35 * 0.55 : Math.sin((t - 0.35) / 0.65 * Math.PI) * (u.cls === 'guardian' ? 0.95 : 0.7);
				const lungeF = t < 0.35 ? 0 : Math.sin((t - 0.35) / 0.65 * Math.PI) * (u.cls === 'duelist' ? 0.7 : 0.4);
				// duelists carve alternating diagonal arcs — left blade, then right
				const roll = u.cls === 'duelist' ? Math.sin(t * Math.PI) * 0.5 * u.swingSide : 0;
				const fx = Math.cos(u.face), fz = -Math.sin(u.face); // forward (local +x) from face angle
				d.position.set(u.x + fx * lungeF, gy + Math.abs(Math.sin(u.bob * 2)) * 0.06 * u.scale, u.z + fz * lungeF);
				d.scale.setScalar(s);
				d.rotation.set(swing, u.face, roll);
			} else if (u.melee) {
				// guard stance — tense bounce facing the enemy
				d.position.set(u.x, gy + Math.abs(Math.sin(u.bob * 2.4)) * 0.07 * u.scale, u.z);
				d.scale.setScalar(s);
				d.rotation.set(0.06, u.face, Math.sin(u.bob * 3) * 0.05);
			} else {
				// march in step — the cadence ripples down the file like a drilled phalanx
				const bp = this.battlePhase;
				const braced = u.cls === 'spear' && (bp === 'form' || bp === 'advance' || bp === 'regroup');
				const gait = Math.sin(u.ranged ? u.bob : this.time * 8.5 + u.slot * 0.35 + u.row * 0.9);
				if (braced) {
					// shield wall: planted, leaning into the shield, barely swaying
					d.position.set(u.x, gy + Math.abs(gait) * 0.05 * u.scale, u.z);
					d.scale.setScalar(s);
					d.rotation.set(0.16, u.face, gait * 0.03);
				} else {
					d.position.set(u.x, gy + Math.abs(gait) * 0.22 * u.scale, u.z);
					d.scale.setScalar(s);
					d.rotation.set(0.1, u.face, gait * 0.14);
				}
			}
			d.updateMatrix(); mesh.setMatrixAt(u.idx, d.matrix); dirty.add(mesh);
			// colour: hit-flash > tracked glow > base tint
			if (u.struck > 0) mesh.setColorAt(u.idx, this.tmpColor.set(2.4, 2.2, 2.0));
			else if (u.tracked) mesh.setColorAt(u.idx, this.tmpColor.set(1.6, 1.5, 1.1));
			else mesh.setColorAt(u.idx, this.tmpColor.setScalar(u.tint));
		}
		for (let i = this.units.length - 1; i >= 0; i--) {
			const u = this.units[i]; if (u.dying > 0 || u.hp > 0) continue;
			const army = this.armies[`${u.team}:${u.cls}`];
			this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); army.mesh.setMatrixAt(u.idx, this.dummy.matrix); dirty.add(army.mesh); army.free.push(u.idx); this.units.splice(i, 1);
		}
		for (const m of dirty) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
		// only draw the occupied slice of each army buffer — empty ranks cost nothing
		for (const key in this.armies) { const a = this.armies[key]; a.mesh.count = a.top + 1; }
	}

	private render(dt: number) {
		if (this.keys.size) {
			const spd = 46 * dt * this.camZoom, sy = Math.sin(this.camYaw), cy = Math.cos(this.camYaw);
			if (this.keys.has('w')) { this.panX -= sy * spd; this.panZ -= cy * spd; }
			if (this.keys.has('s')) { this.panX += sy * spd; this.panZ += cy * spd; }
			if (this.keys.has('a')) { this.panX -= cy * spd; this.panZ += sy * spd; }
			if (this.keys.has('d')) { this.panX += cy * spd; this.panZ -= sy * spd; }
			this.panX = THREE.MathUtils.clamp(this.panX, -88, 88); this.panZ = THREE.MathUtils.clamp(this.panZ, -66, 66);
		}

		const target = this._camTarget.set(this.panX, 1, this.panZ);
		let radius = 60 * this.camZoom;
		let height = THREE.MathUtils.lerp(24, 128, this.camPitch) * (0.55 + this.camZoom * 0.45);

		if (this.focus) {
			const tracked = this.units.find((u) => u.tracked && u.dying <= 0);
			if (tracked) { target.set(tracked.x, 3, tracked.z); radius = 26 * this.camZoom; height = 22 * this.camZoom; }
		}

		const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 2 : 0, shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
		this.shake = Math.max(0, this.shake - dt * 1.4);
		this.camera.position.lerp(this._camPos.set(target.x + Math.sin(this.camYaw) * radius + shakeX, height + shakeY, target.z + Math.cos(this.camYaw) * radius), Math.min(1, dt * 2.6));
		this.camera.lookAt(target);

		// waving banners
		for (let i = 0; i < this.flags.length; i++) {
			const f = this.flags[i];
			f.rotation.y = Math.sin(this.time * 2.2 + i * 2) * 0.28;
			f.position.x = 1.8 + Math.sin(this.time * 2.2 + i * 2) * 0.15;
		}

		this.updateAuras(dt);
		if (!this.fxOk || location.search.includes('nofx')) {
			this.renderer.render(this.scene, this.camera);
			return;
		}
		try {
			this.composer.render(dt);
		} catch {
			this.disableFx();
			this.renderer.render(this.scene, this.camera);
			return;
		}
		// one-time sanity probe a few frames in: an all-white buffer means a broken pipeline
		if (!this.fxChecked && this.frame > 12) {
			this.fxChecked = true;
			if (this.frameIsBlownOut()) this.disableFx();
		}
	}

	private frameIsBlownOut(): boolean {
		const gl = this.renderer.getContext();
		const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
		if (!w || !h) return false;
		const px = new Uint8Array(4);
		for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.35], [0.75, 0.35], [0.3, 0.75], [0.7, 0.75]] as const) {
			gl.readPixels((w * fx) | 0, (h * fy) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
			if (px[0] < 250 || px[1] < 250 || px[2] < 250) return false; // any normal pixel → frame is fine
		}
		return true;
	}

	private disableFx() {
		if (!this.fxOk) return;
		this.fxOk = false;
		// direct rendering still gets filmic grading via the renderer itself
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.scene.traverse((o) => {
			const mats = (o as THREE.Mesh).material;
			for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) m.needsUpdate = true;
		});
	}

	private updateAuras(dt: number) {
		let ai = 0;
		for (const u of this.units) {
			if (ai >= this.auras.length) break;
			if ((u.tracked || u.legend) && u.dying <= 0) {
				const g = this.auras[ai++]; g.visible = true; g.position.set(u.x, groundY(u.x, u.z) + 0.02, u.z);
				const col = u.tracked ? 0xffffff : u.team === 'bull' ? 0x5effa0 : 0xff7a86; const s = u.scale * UNIT_SCALE;
				g.scale.setScalar(THREE.MathUtils.clamp(s, 0.8, 3.4));
				const r1 = g.getObjectByName('r1'), r2 = g.getObjectByName('r2'), crown = g.getObjectByName('crown');
				if (r1) { r1.rotation.z += dt * 0.6; (((r1 as THREE.Mesh).material) as THREE.MeshBasicMaterial).color.setHex(col); }
				if (r2) { r2.rotation.z -= dt * 0.4; (((r2 as THREE.Mesh).material) as THREE.MeshBasicMaterial).color.setHex(col); }
				if (crown) { crown.position.y = s * 2.9 + Math.sin(this.time * 2 + u.bob) * 0.12; crown.rotation.y += dt * 1.6; ((crown as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(col); }
			}
		}
		for (; ai < this.auras.length; ai++) this.auras[ai].visible = false;
	}

	private emitStats() {
		if (!this.onStats) return;
		const commanders = [...this.commanders.entries()].filter(([w]) => w).map(([wallet, c]) => ({ wallet, kills: c.kills, tier: c.tier, team: c.team })).sort((a, b) => b.kills - a.kills || rankIdx(b.tier) - rankIdx(a.tier)).slice(0, 5);
		this.onStats({
			bulls: this._bullCount, bears: this._bearCount, bullPower: this._bullPower, bearPower: this._bearPower,
			frontPct: THREE.MathUtils.clamp(((this.frontX + FRONT_MAX) / (FRONT_MAX * 2)) * 100, 0, 100),
			casualtiesBull: this.casualtiesBull, casualtiesBear: this.casualtiesBear, fps: Math.round(this.fpsAvg),
			round: this.campaign, winBull: this.winsBull, winBear: this.winsBear, phase: this.phase, winner: this.winner, warPhase: this.battlePhase,
			totalKills: this.totalKills, biggestWhaleUsd: this.biggestWhaleUsd, biggestWhaleWallet: this.biggestWhaleWallet,
			commanders, bullComp: this._bullComp, bearComp: this._bearComp
		});
	}

	private emitOverlay() {
		if (!this.onOverlay) return;
		const v = new THREE.Vector3();
		const project = (x: number, y: number, z: number) => { v.set(x, y, z).project(this.camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, on: v.z < 1 }; };
		const tracked: Overlay['tracked'] = [], titans: Overlay['titans'] = [];
		for (const u of this.units) {
			if (u.dying > 0) continue;
			if (u.tracked) { const p = project(u.x, hillY(u.x) + u.scale * 2.3, u.z); tracked.push({ x: p.x, y: p.y, on: p.on, tier: u.tier, team: u.team, hp: Math.max(0, u.hp), maxHp: u.maxHp, kills: u.kills, wallet: u.wallet }); }
			else if (u.legend) { const p = project(u.x, hillY(u.x) + u.scale * 2.3, u.z); titans.push({ x: p.x, y: p.y, on: p.on, label: u.tier, team: u.team }); }
		}
		// floating casualty markers, rising as they fade
		const now = performance.now();
		this.killFx = this.killFx.filter((k) => k.until > now);
		const kills: Overlay['kills'] = [];
		for (const k of this.killFx) {
			const age = 1 - (k.until - now) / 1200;
			const p = project(k.x, groundY(k.x, k.z) + 2.2 + age * 2.4, k.z);
			kills.push({ x: p.x, y: p.y, on: p.on, team: k.team, age });
		}
		this.onOverlay({ tracked, titans, kills });
	}
}

function rankIdx(t: string): number { return ['GARRISON', 'SOLDIER', 'ELITE', 'CHAMPION', 'TITAN', 'GOD'].indexOf(t); }

function fmtUsdShort(n: number): string {
	if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
	if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
	return '$' + n.toFixed(0);
}
