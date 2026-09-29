// Fully synthesized battle audio — WebAudio only, no asset files. Every sound is
// triggered by a real battlefield event and attenuated by its distance from the
// camera. Starts off (browsers need a click to allow audio anyway).

export type SoundKind = 'shot' | 'cannon' | 'boom' | 'rocket' | 'whoosh' | 'gun' | 'flak' | 'heli' | 'jet' | 'bomber' | 'siren' | 'nuke' | 'victory' | 'round';

export class WarAudio {
	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private noise: AudioBuffer | null = null;
	enabled = false;
	private lx = 0;
	private lz = 0;
	private ld = 300;
	private shots: number[] = [];

	setEnabled(on: boolean) {
		this.enabled = on;
		if (on && !this.ctx) this.init();
		if (!this.ctx || !this.master) return;
		if (on) this.ctx.resume();
		this.master.gain.setTargetAtTime(on ? 0.85 : 0, this.ctx.currentTime, 0.12);
	}

	setListener(x: number, z: number, dist: number) {
		this.lx = x;
		this.lz = z;
		this.ld = dist;
	}

	private init() {
		const ctx = new AudioContext();
		this.ctx = ctx;
		const comp = ctx.createDynamicsCompressor();
		comp.threshold.value = -16;
		comp.ratio.value = 5;
		comp.connect(ctx.destination);
		this.master = ctx.createGain();
		this.master.gain.value = 0;
		this.master.connect(comp);
		const len = ctx.sampleRate * 2;
		this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
		const d = this.noise.getChannelData(0);
		for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

		// distant battle rumble: low noise, slowly breathing
		const src = ctx.createBufferSource();
		src.buffer = this.noise;
		src.loop = true;
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = 110;
		const amb = ctx.createGain();
		amb.gain.value = 0.16;
		const lfo = ctx.createOscillator();
		lfo.frequency.value = 0.07;
		const lg = ctx.createGain();
		lg.gain.value = 0.06;
		lfo.connect(lg).connect(amb.gain);
		src.connect(lp).connect(amb).connect(this.master);
		src.start();
		lfo.start();
	}

	/** Loudness for an event at (x, z): nearer the camera and more zoomed-in = louder. */
	private level(x: number, z: number): number {
		const d = Math.hypot(x - this.lx, z - this.lz);
		const near = Math.max(0.04, 1 - d / (this.ld * 1.6 + 60));
		const zoom = Math.min(1.5, Math.max(0.45, 260 / this.ld));
		return near * zoom;
	}

	private pan(x: number, z: number): number {
		// rough screen-space pan: the camera looks north-east
		const r = (x - this.lx) * 0.866 + (z - this.lz) * 0.5;
		return Math.max(-0.8, Math.min(0.8, r / (this.ld * 0.8 + 40)));
	}

	play(kind: SoundKind, x = this.lx, z = this.lz, scale = 1) {
		if (!this.enabled || !this.ctx || !this.master || !this.noise) return;
		const ctx = this.ctx;
		const t = ctx.currentTime;
		// announcements carry across the whole field; a nuke is heard everywhere
		let v = kind === 'victory' || kind === 'round' || kind === 'siren' ? 1 : kind === 'nuke' ? Math.max(0.7, this.level(x, z)) : this.level(x, z);
		if (v < 0.03) return;
		if (kind === 'shot') {
			// rifle fire is rate-limited so a big firefight crackles instead of roaring
			const now = performance.now();
			while (this.shots.length && now - this.shots[0] > 1000) this.shots.shift();
			if (this.shots.length > 16) return;
			this.shots.push(now);
			v *= 0.5 + Math.random() * 0.5;
		}
		const out = ctx.createGain();
		const p = ctx.createStereoPanner();
		p.pan.value = this.pan(x, z);
		out.connect(p).connect(this.master);

		const noise = (dur: number, type: BiquadFilterType, f0: number, f1: number, q = 0.8) => {
			const s = ctx.createBufferSource();
			s.buffer = this.noise;
			s.loop = true; // random start offset + long booms can outrun the 2 s buffer
			const f = ctx.createBiquadFilter();
			f.type = type;
			f.frequency.setValueAtTime(f0, t);
			f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
			f.Q.value = q;
			const g = ctx.createGain();
			g.gain.setValueAtTime(1, t);
			g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
			s.connect(f).connect(g).connect(out);
			s.start(t, Math.random() * 1.5);
			s.stop(t + dur + 0.05);
		};
		const tone = (dur: number, type: OscillatorType, f0: number, f1: number, g0: number) => {
			const o = ctx.createOscillator();
			o.type = type;
			o.frequency.setValueAtTime(f0, t);
			o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(g0, t + 0.005);
			g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
			o.connect(g).connect(out);
			o.start(t);
			o.stop(t + dur + 0.05);
		};
		const chord = (notes: readonly (readonly [number, number])[], type: OscillatorType, peak: number, hold: number, end: number, lp?: number) => {
			for (const [hz, d] of notes) {
				const o = ctx.createOscillator();
				o.type = type;
				o.frequency.value = hz;
				const g = ctx.createGain();
				g.gain.setValueAtTime(0.0001, t + d);
				g.gain.exponentialRampToValueAtTime(peak, t + d + 0.05);
				g.gain.setValueAtTime(peak, t + Math.max(d + 0.06, hold));
				g.gain.exponentialRampToValueAtTime(0.0008, t + end);
				if (lp) {
					const f = ctx.createBiquadFilter();
					f.type = 'lowpass';
					f.frequency.value = lp;
					o.connect(f).connect(g).connect(out);
				} else o.connect(g).connect(out);
				o.start(t + d);
				o.stop(t + end + 0.05);
			}
		};
		/** A looping noise bed shaped by an envelope — for engines and rotors. */
		const bed = (filter: BiquadFilterNode, env: [number, number][], dur: number, extra?: (g: GainNode) => void) => {
			const s = ctx.createBufferSource();
			s.buffer = this.noise;
			s.loop = true;
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.0001, t);
			for (const [at, val] of env) g.gain.exponentialRampToValueAtTime(val, t + at);
			extra?.(g);
			s.connect(filter).connect(g).connect(out);
			s.start(t);
			s.stop(t + dur);
		};

		switch (kind) {
			case 'shot':
				out.gain.value = 0.22 * v;
				noise(0.07, 'bandpass', 1500 + Math.random() * 1500, 700, 0.9);
				break;
			case 'cannon':
				out.gain.value = 0.5 * v;
				noise(0.45, 'lowpass', 1400, 160, 0.7);
				tone(0.35, 'sine', 90, 38, 0.9);
				break;
			case 'boom': {
				const s = Math.min(2.6, scale);
				out.gain.value = Math.min(1, 0.35 + 0.28 * s) * v;
				noise(0.9 + 0.5 * s, 'lowpass', 2200, 90, 0.6);
				tone(0.8 + 0.4 * s, 'sine', 62, 24, 1);
				break;
			}
			case 'rocket':
				out.gain.value = 0.18 * v;
				noise(0.9, 'bandpass', 500, 2600, 1.4);
				break;
			case 'whoosh':
				out.gain.value = 0.2 * v;
				noise(0.8, 'highpass', 900, 3200, 0.7);
				break;
			case 'jet': {
				out.gain.value = 0.55 * Math.max(0.35, v);
				const f = ctx.createBiquadFilter();
				f.type = 'lowpass';
				f.frequency.setValueAtTime(300, t);
				f.frequency.exponentialRampToValueAtTime(3200, t + 1.4);
				f.frequency.exponentialRampToValueAtTime(260, t + 3.4);
				p.pan.setValueAtTime(-0.7, t);
				p.pan.linearRampToValueAtTime(0.7, t + 3.2);
				bed(f, [[1.3, 1], [3.6, 0.0008]], 3.8);
				break;
			}
			case 'gun': {
				// rotary cannon: a fast buzz of rounds
				out.gain.value = 0.45 * Math.max(0.3, v);
				const o = ctx.createOscillator();
				o.type = 'sawtooth';
				o.frequency.value = 68;
				const f = ctx.createBiquadFilter();
				f.type = 'bandpass';
				f.frequency.value = 900;
				f.Q.value = 0.7;
				const g = ctx.createGain();
				g.gain.setValueAtTime(0.0001, t);
				g.gain.exponentialRampToValueAtTime(1, t + 0.04);
				g.gain.setValueAtTime(1, t + 1.1);
				g.gain.exponentialRampToValueAtTime(0.0008, t + 1.35);
				o.connect(f).connect(g).connect(out);
				o.start(t);
				o.stop(t + 1.4);
				noise(1.3, 'bandpass', 1800, 900, 0.9);
				break;
			}
			case 'flak': {
				// an AA battery's burst: a quick run of hollow pom-poms
				out.gain.value = 0.3 * v;
				for (let k = 0; k < 6; k++) {
					const at = t + k * 0.13;
					const o = ctx.createOscillator();
					o.type = 'sine';
					o.frequency.setValueAtTime(150, at);
					o.frequency.exponentialRampToValueAtTime(55, at + 0.12);
					const g = ctx.createGain();
					g.gain.setValueAtTime(0.0001, at);
					g.gain.exponentialRampToValueAtTime(0.8, at + 0.005);
					g.gain.exponentialRampToValueAtTime(0.0008, at + 0.14);
					o.connect(g).connect(out);
					o.start(at);
					o.stop(at + 0.16);
				}
				noise(0.9, 'bandpass', 700, 300, 1.2);
				break;
			}
			case 'siren': {
				// air-raid siren: two slow wails
				out.gain.value = 0.16;
				const o = ctx.createOscillator();
				o.type = 'triangle';
				o.frequency.setValueAtTime(380, t);
				o.frequency.linearRampToValueAtTime(880, t + 0.8);
				o.frequency.linearRampToValueAtTime(520, t + 1.3);
				o.frequency.linearRampToValueAtTime(880, t + 2.0);
				o.frequency.linearRampToValueAtTime(360, t + 2.8);
				const g = ctx.createGain();
				g.gain.setValueAtTime(0.0001, t);
				g.gain.exponentialRampToValueAtTime(1, t + 0.3);
				g.gain.setValueAtTime(1, t + 2.3);
				g.gain.exponentialRampToValueAtTime(0.0008, t + 2.9);
				o.connect(g).connect(out);
				o.start(t);
				o.stop(t + 3);
				break;
			}
			case 'nuke': {
				// the crack, then a long rolling roar under a sub-bass drop
				out.gain.value = Math.min(1, 0.9 * v);
				noise(0.5, 'highpass', 3000, 400, 0.5);
				noise(5.5, 'lowpass', 2600, 45, 0.5);
				tone(4.5, 'sine', 44, 14, 1);
				tone(3, 'triangle', 70, 22, 0.5);
				break;
			}
			case 'heli': {
				out.gain.value = 0.35 * Math.max(0.35, v);
				const f = ctx.createBiquadFilter();
				f.type = 'bandpass';
				f.frequency.value = 170;
				f.Q.value = 1.2;
				// rotor chop: a square LFO on the gain
				bed(f, [[1.5, 1], [7, 1], [10, 0.0008]], 10.2, (g) => {
					const lfo = ctx.createOscillator();
					lfo.type = 'square';
					lfo.frequency.value = 12.5;
					const lg = ctx.createGain();
					lg.gain.value = 0.45;
					lfo.connect(lg).connect(g.gain);
					lfo.start(t);
					lfo.stop(t + 10.2);
				});
				break;
			}
			case 'bomber':
				out.gain.value = 0.3 * Math.max(0.4, v);
				chord([[52, 0], [54.5, 0], [104, 0]], 'sawtooth', 0.4, 6, 10, 280);
				break;
			case 'victory':
				out.gain.value = 0.32;
				chord([[261.6, 0], [329.6, 0.12], [392, 0.24], [523.2, 0.42]], 'sawtooth', 0.35, 1.6, 2.6, 1400);
				break;
			case 'round':
				out.gain.value = 0.22;
				chord([[392, 0], [523.2, 0.18]], 'triangle', 0.5, 0.2, 0.7);
				break;
		}
	}

	dispose() {
		this.ctx?.close();
		this.ctx = null;
	}
}
