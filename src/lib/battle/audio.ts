// Fully synthesized battle audio — no asset files. WebAudio only.
// Every sound is driven by a real battle event: the drums follow the war phase
// (and beat in step with the march animation), clashes ring only when warriors
// actually die, volleys whoosh when the archers actually loose, and whale
// strikes get their own comet/beam voices. No constant drone, no random noise.

import type { WarPhase } from './engine';

export class WarAudio {
	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private noise: AudioBuffer | null = null;
	private started = false;
	muted = false;

	// battle state fed from the engine's stats stream
	private phase: WarPhase = 'form';
	private intensity = 0; // 0..1 — how thick the fighting is
	private beatTimer: ReturnType<typeof setTimeout> | null = null;
	private beat = 0;
	private lastKill = 0;

	private ensure() {
		if (this.ctx) return;
		this.ctx = new AudioContext();
		this.master = this.ctx.createGain();
		this.master.gain.value = 0.9;
		this.master.connect(this.ctx.destination);
		// one-shot noise buffer
		const len = this.ctx.sampleRate * 1.5;
		this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
		const d = this.noise.getChannelData(0);
		for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
	}

	start() {
		this.ensure();
		if (!this.ctx || this.started) return;
		this.ctx.resume();
		this.started = true;
		this.startWind();
		this.scheduleBeat();
	}

	setMuted(m: boolean) {
		this.muted = m;
		if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.15);
	}

	// the engine reports the war's rhythm; the drums follow it
	setBattle(phase: WarPhase, intensity: number) {
		this.phase = phase;
		this.intensity = Math.max(0, Math.min(1, intensity));
	}

	// ---------- ambient: faint night wind, nothing more ----------

	private startWind() {
		if (!this.ctx || !this.master || !this.noise) return;
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise; src.loop = true;
		const filt = this.ctx.createBiquadFilter();
		filt.type = 'lowpass'; filt.frequency.value = 240; filt.Q.value = 0.4;
		const g = this.ctx.createGain(); g.gain.value = 0.018;
		// slow gusts
		const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.09;
		const lg = this.ctx.createGain(); lg.gain.value = 0.01;
		lfo.connect(lg); lg.connect(g.gain);
		src.connect(filt); filt.connect(g); g.connect(this.master);
		src.start(); lfo.start();
	}

	// ---------- war drums: cadence follows the phase ----------

	private scheduleBeat() {
		if (!this.ctx) return;
		// advance beat matches the march-step animation cycle (~0.74s)
		const gap =
			this.phase === 'form' ? 1.4 :
			this.phase === 'advance' ? 0.74 :
			this.phase === 'charge' ? 0.21 :
			this.phase === 'melee' ? 0.52 : 1.1; // regroup
		this.beatTimer = setTimeout(() => this.scheduleBeat(), gap * 1000);
		if (this.muted) { this.beat++; return; }
		const b = this.beat++;
		if (this.phase === 'form') {
			// sparse heartbeat while the ranks dress
			this.tom(58, 0.16);
		} else if (this.phase === 'advance') {
			// marching cadence: heavy on the step, light off-beat tap
			this.tom(b % 2 === 0 ? 88 : 68, b % 2 === 0 ? 0.34 : 0.14);
			if (b % 4 === 0) this.tom(120, 0.1);
		} else if (this.phase === 'charge') {
			// rolling toms under the sprint
			this.tom(70 + (b % 3) * 18, 0.3);
		} else if (this.phase === 'melee') {
			// drums back off — the fighting itself carries the mix
			if (this.intensity > 0.1) this.tom(64, 0.1 + this.intensity * 0.12);
		} else if (b % 2 === 0) {
			// regroup: slow, tired pulse
			this.tom(52, 0.1);
		}
	}

	private tom(freq: number, gain: number) {
		if (!this.ctx || !this.master) return;
		const t = this.ctx.currentTime;
		const o = this.ctx.createOscillator();
		const g = this.ctx.createGain();
		o.type = 'sine';
		o.frequency.setValueAtTime(freq * 1.6, t);
		o.frequency.exponentialRampToValueAtTime(freq, t + 0.12);
		g.gain.setValueAtTime(gain, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
		o.connect(g); g.connect(this.master);
		o.start(t); o.stop(t + 0.42);
	}

	// ---------- combat one-shots (fired per real event) ----------

	// a warrior falls: metal ring + body thud. Rate-limited so massacres
	// read as a roar, not a machine gun.
	kill(big = false) {
		if (!this.ctx || !this.master || !this.noise || this.muted) return;
		const now = this.ctx.currentTime;
		if (now - this.lastKill < 0.07) return;
		this.lastKill = now;
		this.clash(big ? 0.9 : 0.35 + Math.random() * 0.25);
		// low thud under the ring
		const o = this.ctx.createOscillator();
		const g = this.ctx.createGain();
		o.type = 'sine';
		o.frequency.setValueAtTime(big ? 110 : 150, now);
		o.frequency.exponentialRampToValueAtTime(big ? 40 : 65, now + 0.16);
		g.gain.setValueAtTime(big ? 0.3 : 0.12, now);
		g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
		o.connect(g); g.connect(this.master);
		o.start(now); o.stop(now + 0.24);
	}

	// short metallic clash — intensity 0..1
	clash(intensity = 0.5) {
		if (!this.ctx || !this.master || !this.noise || this.muted) return;
		const t = this.ctx.currentTime;
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		const filt = this.ctx.createBiquadFilter();
		filt.type = 'bandpass';
		filt.frequency.value = 2600 + Math.random() * 1800;
		filt.Q.value = 0.8;
		const g = this.ctx.createGain();
		const vol = 0.05 + intensity * 0.14;
		g.gain.setValueAtTime(vol, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
		src.connect(filt); filt.connect(g); g.connect(this.master);
		src.start(t); src.stop(t + 0.2);
	}

	// massed archery: the volley signal — dozens of shafts leaving at once
	volley(count: number) {
		if (!this.ctx || !this.master || !this.noise || this.muted) return;
		const t = this.ctx.currentTime;
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		const filt = this.ctx.createBiquadFilter();
		filt.type = 'bandpass'; filt.Q.value = 1.2;
		// rising whoosh as the arc climbs, falling as it drops
		filt.frequency.setValueAtTime(600, t);
		filt.frequency.exponentialRampToValueAtTime(1900, t + 0.22);
		filt.frequency.exponentialRampToValueAtTime(420, t + 0.6);
		const g = this.ctx.createGain();
		const vol = Math.min(0.16, 0.05 + count * 0.004);
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(vol, t + 0.1);
		g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
		src.connect(filt); filt.connect(g); g.connect(this.master);
		src.start(t); src.stop(t + 0.7);
	}

	// whale sky strike: TITAN = falling comet whistle into impact,
	// GOD = rising beam shimmer into a heavier impact
	strike(god = false) {
		if (!this.ctx || !this.master || this.muted) return;
		const t = this.ctx.currentTime;
		const o = this.ctx.createOscillator();
		const g = this.ctx.createGain();
		if (god) {
			o.type = 'sawtooth';
			o.frequency.setValueAtTime(180, t);
			o.frequency.exponentialRampToValueAtTime(1400, t + 0.5);
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(0.12, t + 0.4);
			g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
		} else {
			o.type = 'triangle';
			o.frequency.setValueAtTime(2100, t);
			o.frequency.exponentialRampToValueAtTime(220, t + 0.5);
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(0.14, t + 0.08);
			g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
		}
		o.connect(g); g.connect(this.master);
		o.start(t); o.stop(t + 1);
		// impact lands as the voice resolves
		setTimeout(() => this.impact(god ? 0.5 : 0.3), god ? 420 : 480);
	}

	private impact(vol: number) {
		// deferred by setTimeout from strike() — the context may have closed since
		if (!this.ctx || this.ctx.state === 'closed' || !this.master || !this.noise || this.muted) return;
		const t = this.ctx.currentTime;
		const o = this.ctx.createOscillator();
		const g = this.ctx.createGain();
		o.type = 'sine';
		o.frequency.setValueAtTime(110, t);
		o.frequency.exponentialRampToValueAtTime(30, t + 0.5);
		g.gain.setValueAtTime(vol, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
		o.connect(g); g.connect(this.master);
		o.start(t); o.stop(t + 0.62);
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		const ng = this.ctx.createGain();
		ng.gain.setValueAtTime(vol * 0.5, t);
		ng.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
		src.connect(ng); ng.connect(this.master);
		src.start(t); src.stop(t + 0.42);
	}

	// deep war horn for titan/god arrivals and the charge signal
	horn(god = false) {
		if (!this.ctx || !this.master || this.muted) return;
		const t = this.ctx.currentTime;
		const g = this.ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(god ? 0.3 : 0.2, t + 0.15);
		g.gain.exponentialRampToValueAtTime(0.0001, t + (god ? 2.2 : 1.4));
		const filt = this.ctx.createBiquadFilter();
		filt.type = 'lowpass'; filt.frequency.value = 700;
		const base = god ? 65 : 87;
		for (const m of [1, 1.5, 2.01]) {
			const o = this.ctx.createOscillator();
			o.type = 'sawtooth';
			o.frequency.setValueAtTime(base * m, t);
			o.frequency.linearRampToValueAtTime(base * m * 1.03, t + 1.2);
			o.connect(filt); o.start(t); o.stop(t + (god ? 2.3 : 1.5));
		}
		filt.connect(g); g.connect(this.master);
	}

	// victory fanfare (gold vs dark)
	victory(bull: boolean) {
		if (!this.ctx || !this.master || this.muted) return;
		const t0 = this.ctx.currentTime;
		const notes = bull ? [262, 330, 392, 523] : [196, 233, 294, 233];
		notes.forEach((f, i) => {
			const t = t0 + i * 0.18;
			const o = this.ctx!.createOscillator();
			const g = this.ctx!.createGain();
			o.type = bull ? 'triangle' : 'sawtooth';
			o.frequency.value = f;
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(0.22, t + 0.04);
			g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
			o.connect(g); g.connect(this.master!);
			o.start(t); o.stop(t + 0.62);
		});
	}

	// capital collapse
	boom() {
		if (!this.ctx || !this.master || !this.noise || this.muted) return;
		const t = this.ctx.currentTime;
		const o = this.ctx.createOscillator();
		const g = this.ctx.createGain();
		o.type = 'sine';
		o.frequency.setValueAtTime(120, t);
		o.frequency.exponentialRampToValueAtTime(28, t + 0.9);
		g.gain.setValueAtTime(0.5, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
		o.connect(g); g.connect(this.master);
		o.start(t); o.stop(t + 1.15);
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		const ng = this.ctx.createGain();
		ng.gain.setValueAtTime(0.3, t);
		ng.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
		src.connect(ng); ng.connect(this.master);
		src.start(t); src.stop(t + 0.85);
	}

	dispose() {
		if (this.beatTimer) clearTimeout(this.beatTimer);
		this.ctx?.close();
	}
}
