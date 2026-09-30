// $OSIRIS wallet intel for the War Room: the on-chain roster (holders → Bulls,
// wallets that sold out → Bears) and each wallet's service record, fetched on
// demand through a paced queue so the public RPC behind it isn't hammered.

export type Holder = { wallet: string; account: string; amount: number; pct: number; rank: number };
export type Exited = { wallet: string; account: string };

export type Intel = {
	wallet: string;
	none?: boolean; // never held $OSIRIS
	account?: string;
	amount: number;
	pct: number;
	exited?: boolean;
	since?: number | null; // first transaction on its token account
	sinceApprox?: boolean; // 2000+ transactions: it's been holding at least this long
	lastMove?: number | null;
	txs?: number;
	entryMc?: number | null; // market cap (the front) the day it joined
	lastMoveMc?: number | null;
};

export type Tape = { buy: number; sell: number; last: number };

export class HolderIntel {
	holders: Holder[] = [];
	exited: Exited[] = [];
	holderCount = 0;
	exitedCount = 0;
	supply = 0;
	loaded = false;
	/** Recent buys/sells per wallet from the live trade tape. */
	tape = new Map<string, Tape>();
	private intel = new Map<string, Intel | 'loading' | 'error'>();
	private queue: string[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private refresh: ReturnType<typeof setInterval> | null = null;
	private stopped = false;

	constructor(private changed: () => void) {}

	start() {
		this.load();
		this.refresh = setInterval(() => this.load(), 120_000);
		this.timer = setInterval(() => this.pump(), 450);
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		if (this.refresh) clearInterval(this.refresh);
	}

	private async load() {
		try {
			const r = await fetch('/api/holders');
			if (!r.ok || this.stopped) return;
			const d = await r.json();
			this.holders = d.holders;
			this.exited = d.exited;
			this.holderCount = d.holderCount;
			this.exitedCount = d.exitedCount;
			this.supply = d.supply;
			this.loaded = true;
			// read the service records of the biggest holders first
			for (const h of this.holders.slice(0, 30)) this.request(h.wallet);
			this.changed();
		} catch {
			/* next refresh */
		}
	}

	get(wallet: string): Intel | undefined {
		const v = this.intel.get(wallet);
		return typeof v === 'object' ? v : undefined;
	}

	state(wallet: string): 'loading' | 'error' | 'ready' | 'unknown' {
		const v = this.intel.get(wallet);
		return v === undefined ? 'unknown' : typeof v === 'object' ? 'ready' : v;
	}

	/** Queue a wallet's lookup; `urgent` jumps the queue (a click, a search). */
	request(wallet: string, urgent = false) {
		const v = this.intel.get(wallet);
		if (v === 'loading' || typeof v === 'object') return;
		if (v === 'error' && !urgent) return;
		const at = this.queue.indexOf(wallet);
		if (at >= 0) {
			if (!urgent) return;
			this.queue.splice(at, 1);
		}
		if (urgent) this.queue.unshift(wallet);
		else this.queue.push(wallet);
	}

	private async pump() {
		const wallet = this.queue.shift();
		if (!wallet) return;
		this.intel.set(wallet, 'loading');
		try {
			const r = await fetch(`/api/wallet?address=${encodeURIComponent(wallet)}`);
			const d = await r.json();
			if (this.stopped) return;
			this.intel.set(wallet, r.ok && !d.error ? d : 'error');
		} catch {
			this.intel.set(wallet, 'error');
		}
		this.changed();
	}

	holderOf(wallet: string): Holder | undefined {
		return this.holders.find((h) => h.wallet === wallet);
	}

	noteTrade(wallet: string, side: 'buy' | 'sell', usd: number, ts: number) {
		const t = this.tape.get(wallet) ?? { buy: 0, sell: 0, last: 0 };
		t[side] += usd;
		t.last = Math.max(t.last, ts);
		this.tape.set(wallet, t);
	}
}

// ── labels ─────────────────────────────────────────────────────────────

export function rankFor(pct: number): string {
	if (pct >= 2) return 'GENERAL';
	if (pct >= 1) return 'COLONEL';
	if (pct >= 0.5) return 'MAJOR';
	if (pct >= 0.2) return 'CAPTAIN';
	if (pct >= 0.05) return 'LIEUTENANT';
	if (pct >= 0.01) return 'SERGEANT';
	return 'PRIVATE';
}

/** Chevrons for the rank, for tight rows. */
export function insignia(pct: number): string {
	const r = rankFor(pct);
	return { GENERAL: '★★', COLONEL: '★', MAJOR: '✦', CAPTAIN: '▮▮', LIEUTENANT: '▮', SERGEANT: '︽', PRIVATE: '︿' }[r] ?? '';
}

const DAY = 86_400_000;

export function statusFor(i: Intel | undefined, tape: Tape | undefined): string {
	if (!i || i.none) return tape?.buy ? 'Fresh recruit' : 'Unknown';
	if (i.exited) return 'Deserted to the Bears';
	if (tape?.buy && !tape.sell) return 'Reinforcing';
	if (tape?.sell && !tape.buy) return 'Trimming';
	const held = i.since ? Date.now() - i.since : 0;
	const still = i.lastMove ? Date.now() - i.lastMove : 0;
	if (held < DAY) return 'Fresh recruit';
	if (held >= 30 * DAY && still >= 14 * DAY) return 'Diamond hands';
	if (held >= 7 * DAY) return 'Veteran';
	return 'Holding the line';
}

export function duration(ms: number): string {
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${Math.max(1, m)}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ${m % 60}m`;
	const d = Math.floor(h / 24);
	return `${d}d ${h % 24}h`;
}

export const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
