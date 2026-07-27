// The battlefield's world dressing — no more hand-coded box "palms" and cylinder
// "obelisks". Trees, rocks, castles, banners and crates are real CC0 models from
// the KayKit Medieval Hexagon Pack (same artist and art style as the fighters),
// loaded from a flat folder (each .gltf + its .bin + one shared texture atlas).
// Static props, so scattered instances are GPU-instanced for almost no cost.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type Placement = { x: number; z: number; y?: number; s: number; r: number };

export class Scenery {
	ready = false;
	private scene: THREE.Scene | null = null;
	private protos: Record<string, THREE.Mesh> = {};

	async load(scene: THREE.Scene, names: string[]) {
		this.scene = scene;
		const loader = new GLTFLoader();
		const loaded = await Promise.all(names.map((n) => loader.loadAsync(`/models/hex/${n}.gltf`)));
		names.forEach((n, i) => {
			let mesh: THREE.Mesh | null = null;
			loaded[i].scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !mesh) mesh = o as THREE.Mesh; });
			if (mesh) {
				const src = (mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
				if (src && !Array.isArray(src)) { src.roughness = 0.9; src.metalness = 0; }
				this.protos[n] = mesh as THREE.Mesh;
			}
		});
		this.ready = true;
	}

	// scatter many copies of one prop as a single instanced draw call
	scatter(name: string, places: Placement[]) {
		const proto = this.protos[name];
		if (!proto || !this.scene || !places.length) return;
		const inst = new THREE.InstancedMesh(proto.geometry, proto.material, places.length);
		// static world props cast real moonlight shadows onto the field (instanced, so the
		// shadow pass stays cheap); the characters keep their soft blob contact shadows.
		inst.castShadow = true; inst.receiveShadow = true; inst.frustumCulled = false;
		const d = new THREE.Object3D();
		places.forEach((p, i) => {
			d.position.set(p.x, p.y ?? 0, p.z); d.rotation.set(0, p.r, 0); d.scale.setScalar(p.s); d.updateMatrix();
			inst.setMatrixAt(i, d.matrix);
		});
		inst.instanceMatrix.needsUpdate = true;
		this.scene.add(inst);
	}

	// place one prop (castles, big set pieces); returns it so callers can parent to it
	place(name: string, x: number, y: number, z: number, s: number, r: number): THREE.Object3D | null {
		const proto = this.protos[name];
		if (!proto || !this.scene) return null;
		const m = proto.clone();
		m.material = proto.material; // share the atlas material
		m.position.set(x, y, z); m.rotation.y = r; m.scale.setScalar(s);
		m.castShadow = true; m.receiveShadow = true;
		this.scene.add(m);
		return m;
	}
}
