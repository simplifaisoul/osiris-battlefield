// Fully synthesized battle audio — no asset files. WebAudio only.
export class WarAudio {
	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private noise: AudioBuffer | null = null;
	private drumTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	muted = false;

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
		this.startDrone();
		this.startDrums();
	}

	setMuted(m: boolean) {
		this.muted = m;
		if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.15);
	}

	private startDrone() {
		if (!this.ctx || !this.master) return;
		const g = this.ctx.createGain();
		g.gain.value = 0.05;
		const filt = this.ctx.createBiquadFilter();
		filt.type = 'lowpass';
		filt.frequency.value = 220;
		for (const f of [55, 55.4, 82.5]) {
			const o = this.ctx.createOscillator();
			o.type = 'sawtooth';
			o.frequency.value = f;
			o.connect(filt);
			o.start();
		}
		filt.connect(g);
		g.connect(this.master);
		// slow swell
		const lfo = this.ctx.createOscillator();
		const lg = this.ctx.createGain();
		lfo.frequency.value = 0.07;
		lg.gain.value = 0.03;
		lfo.connect(lg);
		lg.connect(g.gain);
		lfo.start();
	}

	private startDrums() {
		let beat = 0;
		this.drumTimer = setInterval(() => {
			if (!this.ctx || this.muted) { beat++; return; }
			const strong = beat % 4 === 0;
			this.tom(strong ? 90 : 70, strong ? 0.5 : 0.28);
			if (beat % 8 === 4) this.tom(120, 0.3);
			beat++;
		}, 340);
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

	// deep war horn for titan/god arrivals
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
		if (this.drumTimer) clearInterval(this.drumTimer);
		this.ctx?.close();
	}
}
