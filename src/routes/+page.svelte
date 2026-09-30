<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { Battlefield, type BattleStats, type RoundEvent, type Scale, type Selected, type Team } from '$lib/battle/engine';
	import { HolderIntel } from '$lib/market/holders';
	import WarRoom, { type Order } from '$lib/ui/WarRoom.svelte';
	import { THEATERS } from '$lib/market/theaters';
	import { OsirisFeed } from '$lib/market/osiris';
	import { SolFeed } from '$lib/market/sol';
	import type { Depth, Forces, MarketEvent, MarketFeed, Quote, StrikeTiers, Theater, Venue } from '$lib/market/types';
	import { usd, grouped, shortAddr, utc } from '$lib/market/format';

	type TheaterId = 'osiris' | 'sol';
	type Tone = 'bull' | 'bear' | 'neutral';
	type FeedItem = { id: number; tone: Tone; text: string; amount: string; badge: string; badgeTone: string; href?: string; title: string };

	let canvas: HTMLCanvasElement;
	let bf: Battlefield | null = null;
	let feed: MarketFeed | null = null;

	let theaterId = $state<TheaterId>('osiris');
	const theater = $derived(THEATERS[theaterId]);
	let price = $state(0);
	let tickPct = $state(0);
	let change24 = $state(0);
	let sub = $state('');
	let status = $state('');
	let clock = $state(utc());
	let depth = $state<Depth | null>(null);
	let forces = $state<Forces | null>(null);
	let items = $state<FeedItem[]>([]);
	let lastEvent = $state('Watching the tape');
	let pressure = $state<Tone>('neutral');
	let sound = $state(false);
	let source = $state('');
	let sources = $state<{ id: string; label: string }[]>([]);
	let depthOpen = $state(innerWidth >= 760); // collapsed by default on phones
	let feedOpen = $state(true);
	let stats = $state<BattleStats | null>(null);
	let range = $state<{ lo: number; hi: number; round: number } | null>(null);
	let banner = $state<{ kind: 'new' | 'win'; team?: Team; title: string; line: string; sub?: string; id: number } | null>(null);
	let showTick = $state(true);
	let failed = $state(false);
	let alert = $state<{ team: Team; line: string; id: number } | null>(null);
	let flash = $state(0); // bumps on every detonation, restarting the white-out
	let flashLevel = $state(1);

	// War Room: who each unit is
	let intel = $state.raw<HolderIntel | null>(null); // not deep-proxied; intelTick signals changes inside it
	let intelTick = $state(0);
	let rosterRef: unknown = null;
	let orders = $state<Order[]>([]);
	let focus = $state<string | null>(null);
	let selected = $state<Selected | null>(null);
	let record = $state<{ soldiers: number; tanks: number; kills: number; deaths: number } | null>(null);
	let tracked = $state<string | null>(null);
	let following = $state(false);
	let roomOpen = $state(innerWidth >= 900);
	let orderId = 0;

	let prevPrice = 0;
	let ticks: { t: number; p: number }[] = [];
	let feedId = 0;
	let bannerTimer: ReturnType<typeof setTimeout> | undefined;
	let alertTimer: ReturnType<typeof setTimeout> | undefined;
	let titleAt = 0;

	const VENUE: Record<Venue | 'strike' | 'nuke' | 'round', [string, string]> = {
		Coinbase: ['C', '#1d5cff'],
		Kraken: ['K', '#6c4df2'],
		Binance: ['B', '#e8b30b'],
		OKX: ['O', '#e9ecef'],
		Bybit: ['Y', '#f7a600'],
		PumpSwap: ['P', '#4ade80'],
		strike: ['✈', '#9fb3c8'],
		nuke: ['☢', '#ffd23f'],
		round: ['⚑', '#e8e3c8']
	};
	const STRIKE_NAME = { heli: 'Helicopter strike', jet: 'Jet strike', bomber: 'Bombing run', nuke: 'Tactical nuke' } as const;

	const scaleOf = (t: Theater): Scale => ({
		step: t.step,
		level: t.level,
		price: t.price,
		current: t.id === 'sol' ? 'CURRENT PRICE' : 'CURRENT MARKET CAP'
	});

	const tiers = (): StrikeTiers => theater.tiers(forces?.liquidity ?? 0);

	function push(i: Omit<FeedItem, 'id' | 'badge' | 'badgeTone'> & { venue: Venue | 'strike' | 'nuke' | 'round' }) {
		const [badge, badgeTone] = VENUE[i.venue];
		items = [{ ...i, id: ++feedId, badge, badgeTone }, ...items].slice(0, 40);
	}

	// ── feed handlers ───────────────────────────────────────────────────

	function onQuote(q: Quote) {
		const now = Date.now();
		tickPct = prevPrice ? ((q.price - prevPrice) / prevPrice) * 100 : 0;
		prevPrice = q.price;
		price = q.price;
		change24 = q.change24h;
		sub = q.sub ?? '';
		bf?.setPrice(q.price);
		// which way the line has been moving over the last ~20s
		ticks.push({ t: now, p: q.price });
		while (ticks.length && now - ticks[0].t > 20_000) ticks.shift();
		const move = q.price - ticks[0].p;
		const eps = theater.step(q.price) * 0.06;
		pressure = move > eps ? 'bull' : move < -eps ? 'bear' : 'neutral';
		if (now - titleAt > 1000) {
			titleAt = now;
			document.title = `${theater.price(q.price)} · ${theater.name} Battlefield`;
		}
	}

	function onDepth(d: Depth | null, f: Forces) {
		depth = d;
		forces = f;
		bf?.setForces(f, Math.max(1, tiers().tank));
	}

	function squadSize(v: number, t: StrikeTiers) {
		return Math.max(3, Math.min(16, Math.round(3 + 4 * Math.log10(1 + v / Math.max(5, t.squad)))));
	}

	/** Map an event size to an air strike tier (or a rocket barrage). `what` names the cause. */
	function strikeFor(v: number, attacker: Team, t: StrikeTiers, barrageMin: number, what: string) {
		const tier = v >= t.nuke ? 'nuke' : v >= t.bomber ? 'bomber' : v >= t.jet ? 'jet' : v >= t.heli ? 'heli' : null;
		if (!tier) {
			if (v >= barrageMin) bf?.strike('barrage', attacker, 1);
			return;
		}
		callStrike(tier, attacker, Math.min(tier === 'nuke' ? 1.8 : 2.2, 1 + 0.35 * Math.log2(v / t[tier])), usd(v), what);
	}

	/** Fly a strike and announce it: a line in the feed, and the alert for a nuke. */
	function callStrike(tier: keyof typeof STRIKE_NAME, attacker: Team, scale: number, amount: string, what: string) {
		const side = attacker === 'bull' ? 'Bulls' : 'Bears';
		bf?.strike(tier, attacker, scale);
		push({
			tone: attacker,
			text: `${STRIKE_NAME[tier]} · ${side}`,
			amount,
			venue: tier === 'nuke' ? 'nuke' : 'strike',
			title: `${STRIKE_NAME[tier]} flown by the ${side}: ${what}`
		});
		if (tier === 'nuke') {
			clearTimeout(alertTimer);
			alert = { team: attacker, line: `${side} · ${what}`, id: ++feedId };
			alertTimer = setTimeout(() => (alert = null), 3400);
		}
	}

	function onEvent(e: MarketEvent) {
		const t = tiers();
		const sol = theaterId === 'sol';
		if (e.type === 'trade') {
			const team: Team = e.side === 'buy' ? 'bull' : 'bear';
			const text = sol
				? `${e.usd >= t.tank ? 'Whale' : 'Large'} ${e.side}`
				: `${e.side === 'buy' ? 'Buy' : 'Sell'} · ${shortAddr(e.wallet)}`;
			if (!sol && e.wallet) intel?.noteTrade(e.wallet, e.side, e.usd, e.ts);
			if (!e.history) {
				// the squad fights under the trader's name (on SOL, the whale order's)
				let who = e.wallet;
				if (sol) {
					who = `order#${++orderId}`;
					orders = [{ key: who, side: e.side, usd: e.usd, venue: e.venue, ts: e.ts, front: price }, ...orders].slice(0, 60);
				}
				if (e.usd >= t.squad) bf?.reinforce(team, squadSize(e.usd, t), e.usd >= t.tank, who);
				// every live buy and sell can call in air power, sized by the order
				strikeFor(e.usd, team, t, Infinity, `${usd(e.usd)} ${e.side} · ${e.venue}`);
			}
			if (e.usd < t.feed) return;
			push({
				tone: team,
				text,
				amount: usd(e.usd),
				venue: e.venue,
				href: e.tx ? `https://solscan.io/tx/${e.tx}` : undefined,
				title: `${e.venue} ${text} ${usd(e.usd)}`
			});
			lastEvent = `${e.venue} · ${sol ? text : e.side === 'buy' ? 'Buy' : 'Sell'}`; // history arrives oldest-first, so this ends on the latest
		} else {
			// a liquidated long is a forced sell: it lands on the Bulls
			const attacker: Team = e.side === 'long' ? 'bear' : 'bull';
			const text = e.side === 'long' ? 'Long liquidated' : 'Short liquidated';
			if (theater.strikesFrom === 'both') strikeFor(e.usd, attacker, t, t.barrage, `${usd(e.usd)} ${text.toLowerCase()} · ${e.venue}`);
			if (e.usd < t.barrage) return;
			push({ tone: attacker, text, amount: usd(e.usd), venue: e.venue, title: `${e.venue} ${text} ${usd(e.usd)}` });
			lastEvent = `${e.venue} · ${text}`;
		}
	}

	function onRound(e: RoundEvent) {
		const f = theater.price;
		clearTimeout(bannerTimer);
		if (e.type === 'new') {
			range = { lo: e.lo, hi: e.hi, round: e.round };
			banner = { kind: 'new', title: 'NEW BATTLE', line: `${f(e.lo)} – ${f(e.hi)}`, sub: `Bears win ${f(e.lo)}  |  Bulls win ${f(e.hi)}`, id: e.round };
			push({ tone: 'neutral', text: `New battle · round ${e.round}`, amount: '', venue: 'round', title: `${f(e.lo)} – ${f(e.hi)}` });
			bannerTimer = setTimeout(() => (banner = null), 6000);
		} else {
			const bull = e.winner === 'bull';
			banner = { kind: 'win', team: e.winner, title: bull ? 'BULLS WIN' : 'BEARS WIN', line: `${bull ? 'Broke through' : 'Broke down to'} ${f(e.level)}`, id: e.round };
			push({ tone: e.winner, text: `${bull ? 'Bulls' : 'Bears'} win the range`, amount: f(e.level), venue: 'round', title: `Round ${e.round}` });
			bannerTimer = setTimeout(() => (banner = null), 5500);
		}
	}

	// ── theater switching ───────────────────────────────────────────────

	function startTheater(id: TheaterId, updateUrl = true) {
		feed?.stop();
		theaterId = id;
		items = [];
		depth = null;
		forces = null;
		price = 0;
		prevPrice = 0;
		ticks = [];
		range = null;
		banner = null;
		alert = null;
		stats = null;
		lastEvent = 'Watching the tape';
		orders = [];
		focus = null;
		selected = null;
		record = null;
		tracked = null;
		following = false;
		intel?.stop();
		intel = null;
		rosterRef = null;
		intelTick++;
		bf?.setScale(scaleOf(THEATERS[id]));
		bf?.track(null);
		if (id === 'osiris') {
			const hi: HolderIntel = new HolderIntel(() => {
				intelTick++;
				// holders fight for the Bulls, deserters for the Bears, biggest first
				if (hi.holders !== rosterRef) {
					rosterRef = hi.holders;
					bf?.setRoster(
						hi.holders.map((h) => h.wallet),
						hi.exited.map((e) => e.wallet)
					);
				}
			});
			intel = hi;
			hi.start();
		}
		feed = id === 'sol' ? new SolFeed() : new OsirisFeed();
		sources = feed.sources;
		source = feed.sources[0].id;
		feed.start({ quote: onQuote, depth: onDepth, event: onEvent, status: (s) => (status = s) });
		if (updateUrl) {
			const u = new URL(location.href);
			if (id === 'sol') u.searchParams.set('m', 'sol');
			else u.searchParams.delete('m');
			replaceState(u, {});
		}
	}

	/** Open a wallet's (or a whale order's) dossier and pick one of its units on the field. */
	function focusOn(who: string) {
		focus = who;
		following = false;
		if (!who.startsWith('order#')) intel?.request(who, true);
		selected = bf?.selectWallet(who) ?? null;
		record = bf?.record(who) ?? null;
		roomOpen = true;
	}

	function trackWallet(w: string | null) {
		tracked = w;
		const rec = bf?.track(w) ?? null;
		// a holder with nobody on the field reports for duty so you have something to watch
		if (w && rec && !rec.soldiers && !rec.tanks && intel?.holderOf(w)) {
			bf?.reinforce('bull', 3, false, w);
			bf?.track(w);
		}
		if (w) setTimeout(() => focus === w && (selected = bf?.selectWallet(w) ?? selected), 80);
	}

	function followUnit(on: boolean) {
		bf?.follow(on);
		following = on && !!selected?.alive;
	}

	function closeDossier() {
		focus = null;
		selected = null;
		record = null;
		following = false;
		bf?.clearSelection();
	}

	function toggleSound() {
		sound = !sound;
		bf?.setSound(sound);
	}

	onMount(() => {
		try {
			bf = new Battlefield(canvas, {
				round: onRound,
				stats: (s) => {
					stats = s;
					if (selected) selected = s.selected;
					record = focus ? (bf?.record(focus) ?? null) : null;
				},
				flash: (k) => {
					flashLevel = k;
					flash++;
				},
				select: (s) => {
					selected = s;
					following = false;
					focus = s?.wallet ?? null;
					if (s?.wallet && !s.wallet.startsWith('order#')) intel?.request(s.wallet, true);
					if (s) roomOpen = true;
					record = focus ? (bf?.record(focus) ?? null) : null;
				},
				followEnded: () => (following = false)
			});
			if (import.meta.env.DEV) (window as any).__bf = bf; // console access while developing
		} catch (err) {
			console.error(err);
			failed = true;
			return;
		}
		// the URL already names the theater on load (and the router isn't ready to rewrite it yet)
		startTheater(new URLSearchParams(location.search).get('m') === 'sol' ? 'sol' : 'osiris', false);
		const c = setInterval(() => (clock = utc()), 1000);
		const flip = setInterval(() => (showTick = !showTick), 5000);
		// optional local tools in src/lib/dev/: loaded by the dev server only, never part of a build
		const devOff: (() => void)[] = [];
		if (import.meta.env.DEV) {
			const tools = import.meta.glob<{ install(api: { strike: typeof callStrike }): () => void }>('../lib/dev/*.ts');
			for (const load of Object.values(tools)) load().then((m) => devOff.push(m.install({ strike: callStrike })));
		}
		return () => {
			for (const off of devOff) off();
			clearInterval(c);
			clearInterval(flip);
			clearTimeout(bannerTimer);
			clearTimeout(alertTimer);
			feed?.stop();
			intel?.stop();
			bf?.dispose();
		};
	});

	// ── derived HUD values ──────────────────────────────────────────────

	const chart = $derived.by(() => {
		if (!depth) return null;
		const W = 300;
		const H = 104;
		const top = 16;
		const d = depth;
		const max = Math.max(d.bids[d.bids.length - 1].c, d.asks[d.asks.length - 1].c, 1);
		const X = (p: number) => ((p - d.lo) / (d.hi - d.lo)) * W;
		const Y = (c: number) => H - (c / max) * (H - top);
		const line = (pts: { p: number; c: number }[]) => {
			let s = `M${X(pts[0].p).toFixed(1)},${H}`;
			let y = H;
			for (const q of pts) {
				const x = X(q.p).toFixed(1);
				s += `L${x},${y.toFixed(1)}`;
				y = Y(q.c);
				s += `L${x},${y.toFixed(1)}`;
			}
			return s;
		};
		const bl = line(d.bids);
		const al = line(d.asks);
		return {
			W,
			H,
			mid: X(d.mid),
			bidLine: bl,
			askLine: al,
			bidArea: `${bl}L${X(d.bids[d.bids.length - 1].p).toFixed(1)},${H}Z`,
			askArea: `${al}L${X(d.asks[d.asks.length - 1].p).toFixed(1)},${H}Z`
		};
	});

	const sourceLabel = $derived(sources.find((s) => s.id === source)?.label ?? '');
	const axis = (v: number) => (theaterId === 'sol' ? grouped(v, 2) : grouped(v));
	const pressureText = $derived(pressure === 'bull' ? 'Buyers advancing' : pressure === 'bear' ? 'Sellers advancing' : 'Holding the line');
	const tickText = $derived(
		showTick || !change24
			? `${tickPct >= 0 ? '+' : ''}${tickPct.toFixed(3)}% tick`
			: `${change24 >= 0 ? '+' : ''}${change24.toFixed(2)}% 24h`
	);
	const tickTone = $derived(showTick || !change24 ? (tickPct > 0 ? 'bull' : tickPct < 0 ? 'bear' : 'neutral') : change24 >= 0 ? 'bull' : 'bear');
	const progress = $derived(stats?.progress ?? 0.5);
</script>

<svelte:head>
	<title>OSIRIS Battlefield</title>
</svelte:head>

<a class="osirisbar" href="https://www.osirisai.live/" target="_blank" rel="noopener">
	<span class="ankh">☥</span> <span class="full">OSIRIS INTELLIGENCE NETWORK <span class="sep">·</span></span> <b>osirisai.live</b> <span class="arrow">↗</span>
</a>

<main>
	<canvas bind:this={canvas} aria-label="3D battlefield"></canvas>

	{#if failed}
		<div class="fail">
			<h1>WebGL isn't available</h1>
			<p>The battlefield needs a browser with hardware-accelerated WebGL 2.</p>
		</div>
	{/if}

	<!-- top-left: clock, brand, theater -->
	<div class="tl">
		<div class="clock mono" aria-label="UTC time">UTC {clock}</div>
		<a class="brand" href="https://www.osirisai.live/" target="_blank" rel="noopener">
			<span class="ankh">☥</span>
			<span>OSIRIS <b>BATTLEFIELD</b></span>
		</a>
		<div class="theaters" role="tablist" aria-label="Market">
			{#each Object.values(THEATERS) as t (t.id)}
				<button role="tab" aria-selected={theaterId === t.id} class:on={theaterId === t.id} onclick={() => theaterId !== t.id && startTheater(t.id)}>
					{t.name}
				</button>
			{/each}
		</div>
		<div class="status">{status}</div>
	</div>

	<!-- top-centre: price + pressure -->
	<div class="top">
		<div class="quote">
			<div class="label">{theater.pairLabel(sourceLabel)}</div>
			<div class="price mono">{price ? theater.price(price) : '—'}</div>
			<div class="tick mono {tickTone}">{price ? tickText : ' '}</div>
			{#if sub}<div class="sub mono">{sub}</div>{/if}
		</div>
		<div class="pressure">
			<div class="label">MARKET PRESSURE</div>
			<div class="ptext {pressure}">{pressureText}</div>
			<div class="pev">{lastEvent}</div>
		</div>
	</div>

	{#if range}
		<div class="roundbar">
			<span class="rb-edge bear mono">{theater.price(range.lo)}</span>
			<div class="rb-track" title="Front line position inside this round's range">
				<div class="rb-fill" style="width:{progress * 100}%"></div>
				<div class="rb-mark" style="left:{progress * 100}%"></div>
			</div>
			<span class="rb-edge bull mono">{theater.price(range.hi)}</span>
			<span class="rb-round">R{range.round} · <b class="bull">{stats?.wins[0] ?? 0}</b>–<b class="bear">{stats?.wins[1] ?? 0}</b></span>
		</div>
	{/if}

	<!-- top-right controls -->
	<div class="tr">
		<button class="icon" title="Recenter battlefield" aria-label="Recenter battlefield" onclick={() => bf?.recenter()}>
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></svg>
		</button>
		<button class="icon sound" class:on={sound} title={sound ? 'Sound on' : 'Sound off'} aria-label={sound ? 'Sound on' : 'Sound off'} onclick={toggleSound}>
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
				><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />{#if sound}<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />{:else}<path d="M17 9l5 6M22 9l-5 6" />{/if}</svg
			>
			<span>{sound ? 'SOUND ON' : 'SOUND OFF'}</span>
		</button>
	</div>

	<!-- walls -->
	<div class="wall sell">
		<div class="label">SELL WALL</div>
		<div class="wv mono">{forces ? usd(forces.askWall) : '—'}</div>
	</div>
	<div class="wall buy">
		<div class="label">BUY WALL</div>
		<div class="wv mono">{forces ? usd(forces.bidWall) : '—'}</div>
	</div>

	<!-- banners -->
	{#if banner}
		{#key banner.id + banner.kind}
			<div class="banner {banner.kind} {banner.team ?? ''}">
				<div class="b-title">{banner.title}</div>
				<div class="b-line mono">{banner.line}</div>
				{#if banner.sub}<div class="b-sub mono">{banner.sub}</div>{/if}
			</div>
		{/key}
	{/if}

	{#if alert}
		{#key alert.id}
			<div class="nuke-alert {alert.team}" role="alert">
				<div class="na-title">☢ TACTICAL NUKE INBOUND</div>
				<div class="na-line mono">{alert.line}</div>
			</div>
		{/key}
	{/if}
	{#key flash}
		{#if flash}<div class="whiteout" style="--k:{flashLevel}"></div>{/if}
	{/key}

	<!-- bottom-left: depth -->
	<section class="panel depth" class:closed={!depthOpen} aria-label="Buy and sell wall depth chart">
		<header>
			<div>
				<div class="label">ORDER BOOK DEPTH</div>
				<div class="ptitle">{theater.depthLabel(sourceLabel)}</div>
			</div>
			<div class="hdr-r">
				{#if depthOpen}
					<label class="src">
						<span class="label">SOURCE</span>
						<select aria-label="Order book source" bind:value={source} onchange={() => feed?.setSource(source)}>
							{#each sources as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
						</select>
					</label>
				{/if}
				<button class="chev" aria-label={depthOpen ? 'Collapse order book depth' : 'Expand order book depth'} onclick={() => (depthOpen = !depthOpen)}>
					{depthOpen ? '▾' : '▴'}
				</button>
			</div>
		</header>
		{#if depthOpen}
			{#if chart && depth}
				<svg class="chart" viewBox="0 0 {chart.W} {chart.H + 2}" preserveAspectRatio="none" aria-label="Bid and ask depth chart">
					<defs>
						<linearGradient id="gb" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#4ade80" stop-opacity="0.45" /><stop offset="1" stop-color="#4ade80" stop-opacity="0.04" /></linearGradient>
						<linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f4636b" stop-opacity="0.45" /><stop offset="1" stop-color="#f4636b" stop-opacity="0.04" /></linearGradient>
					</defs>
					<path d={chart.bidArea} fill="url(#gb)" />
					<path d={chart.askArea} fill="url(#ga)" />
					<path d={chart.bidLine} fill="none" stroke="#4ade80" stroke-width="1.4" vector-effect="non-scaling-stroke" />
					<path d={chart.askLine} fill="none" stroke="#f4636b" stroke-width="1.4" vector-effect="non-scaling-stroke" />
					<line x1={chart.mid} x2={chart.mid} y1="0" y2={chart.H} stroke="rgba(255,255,255,0.35)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
				</svg>
				<div class="chart-tags"><span class="bull">BID WALL</span><span class="bear">ASK WALL</span></div>
				<div class="axis mono"><span>{axis(depth.lo)}</span><b>{axis(depth.mid)}</b><span>{axis(depth.hi)}</span></div>
			{:else}
				<div class="empty">Reading the book…</div>
			{/if}
			<div class="keys" aria-label="Map controls">
				<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>PAN</span><kbd class="wide">SCROLL</kbd><span>ZOOM</span><kbd class="wide">R-DRAG</kbd><span>ROTATE</span>
			</div>
		{/if}
	</section>

	<!-- right column: War Room above the market feed -->
	<div class="rightcol">
		<WarRoom
			{theaterId}
			{intel}
			tick={intelTick}
			{orders}
			{focus}
			{selected}
			{record}
			{price}
			fmtFront={(v) => (theaterId === 'osiris' ? usd(v) : theater.price(v))}
			{tracked}
			{following}
			bind:open={roomOpen}
			onFocus={focusOn}
			onTrack={trackWallet}
			onFollow={followUnit}
			onClose={closeDossier}
		/>
		<section class="panel feed" class:closed={!feedOpen} aria-label="Market feed">
			<header>
				<div class="label">MARKET FEED</div>
				<div class="hdr-r">
					<span class="live"><i></i>LIVE</span>
					<button class="chev" aria-label={feedOpen ? 'Collapse market feed' : 'Expand market feed'} onclick={() => (feedOpen = !feedOpen)}>
						{feedOpen ? '▾' : '▴'}
					</button>
				</div>
			</header>
			{#if feedOpen}
				<ul>
					{#each items as it (it.id)}
						<li class={it.tone} title={it.title}>
							<span class="venue" style="--vc:{it.badgeTone}">{it.badge}</span>
							{#if it.href}
								<a href={it.href} target="_blank" rel="noopener noreferrer">{it.text}</a>
							{:else}
								<span class="txt">{it.text}</span>
							{/if}
							<span class="amt mono">{it.amount}</span>
						</li>
					{:else}
						<li class="neutral quiet"><span class="txt">Listening to the tape…</span></li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>

	{#if stats}
		<div class="forces mono" aria-label="Forces on the field">
			<span class="bull">{stats.soldiers[0]}</span><span class="dim">troops</span><span class="bear">{stats.soldiers[1]}</span>
			<span class="sep">·</span>
			<span class="bull">{stats.tanks[0]}</span><span class="dim">tanks</span><span class="bear">{stats.tanks[1]}</span>
			<span class="sep">·</span>
			<span class="dim">KIA</span><span>{grouped(stats.casualties[0] + stats.casualties[1])}</span>
		</div>
	{/if}

	{#if !price && !failed}
		<div class="loading">
			<div class="spinner"></div>
			<div class="l1">DEPLOYING FORCES</div>
			<div class="l2">{status || 'Connecting…'}</div>
		</div>
	{/if}
</main>

<style>
	.osirisbar {
		position: fixed;
		inset: 0 0 auto 0;
		height: 30px;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		font: 700 11.5px var(--sans);
		letter-spacing: 0.08em;
		color: #1b1405;
		text-decoration: none;
		background: linear-gradient(90deg, #a87a26, #f0cd72 30%, #f7dc8e 50%, #f0cd72 70%, #a87a26);
		box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
		white-space: nowrap;
	}
	.osirisbar b {
		font-weight: 800;
		letter-spacing: 0.02em;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.osirisbar .ankh {
		color: #1b1405;
		font-size: 14px;
	}
	.osirisbar .sep {
		opacity: 0.5;
	}
	.osirisbar:hover {
		filter: brightness(1.08);
	}
	main {
		position: fixed;
		inset: 30px 0 0 0;
		overflow: hidden;
		user-select: none;
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		touch-action: none;
		cursor: grab;
	}
	canvas:active {
		cursor: grabbing;
	}
	.mono {
		font-family: var(--mono);
	}
	.label {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.1em;
		color: var(--text-3);
		text-transform: uppercase;
	}
	.bull {
		color: var(--bull);
	}
	.bear {
		color: var(--bear);
	}
	.neutral,
	.dim {
		color: var(--text-2);
	}

	/* ── top-left ── */
	.tl {
		position: absolute;
		top: 14px;
		left: 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		pointer-events: none;
	}
	.clock {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-2);
		letter-spacing: 0.06em;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.14em;
		color: var(--text-2);
		text-shadow: 0 1px 8px rgba(0, 0, 0, 0.8);
	}
	.brand b {
		color: var(--text);
	}
	a.brand {
		text-decoration: none;
		pointer-events: auto;
		width: max-content;
	}
	a.brand:hover b {
		color: #f0cd72;
	}
	.ankh {
		color: #e8c46a;
		font-size: 15px;
	}
	.theaters {
		display: inline-flex;
		gap: 3px;
		padding: 3px;
		border-radius: 9px;
		background: var(--panel);
		border: 1px solid var(--line);
		pointer-events: auto;
		width: max-content;
	}
	.theaters button {
		font: 700 11px var(--mono);
		letter-spacing: 0.04em;
		color: var(--text-2);
		background: none;
		border: 0;
		padding: 6px 11px;
		border-radius: 6px;
		cursor: pointer;
	}
	.theaters button.on {
		background: rgba(255, 255, 255, 0.1);
		color: var(--text);
	}
	.status {
		font-size: 10px;
		color: var(--text-3);
		letter-spacing: 0.04em;
	}

	/* ── top centre ── */
	.top {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: stretch;
		gap: 18px;
		pointer-events: none;
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.85);
	}
	.quote {
		text-align: right;
	}
	.price {
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		line-height: 1.05;
		margin-top: 2px;
		font-variant-numeric: tabular-nums;
	}
	.tick {
		font-size: 12px;
		font-weight: 700;
		margin-top: 2px;
	}
	.sub {
		font-size: 10.5px;
		color: var(--text-3);
		margin-top: 2px;
	}
	.pressure {
		border-left: 1px solid rgba(255, 255, 255, 0.16);
		padding-left: 16px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		min-width: 190px;
	}
	.ptext {
		font-size: 17px;
		font-weight: 800;
		margin-top: 3px;
		color: var(--text);
	}
	.ptext.bull {
		color: #c9ffd9;
	}
	.ptext.bear {
		color: #ffd0d3;
	}
	.pev {
		font-size: 11px;
		color: var(--text-2);
		margin-top: 2px;
		font-weight: 600;
	}

	/* ── round bar ── */
	.roundbar {
		position: absolute;
		top: 118px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 12px;
		border-radius: 999px;
		background: var(--panel);
		border: 1px solid var(--line);
		font-size: 11px;
		white-space: nowrap;
	}
	.rb-edge {
		font-weight: 700;
		font-size: 11px;
	}
	.rb-track {
		position: relative;
		width: 190px;
		height: 6px;
		border-radius: 3px;
		background: rgba(var(--bear-rgb), 0.35);
		overflow: visible;
	}
	.rb-fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: 3px;
		background: rgba(var(--bull-rgb), 0.75);
		transition: width 0.5s;
	}
	.rb-mark {
		position: absolute;
		top: -4px;
		width: 2px;
		height: 14px;
		margin-left: -1px;
		background: #fff;
		box-shadow: 0 0 8px #fff;
		transition: left 0.5s;
	}
	.rb-round {
		color: var(--text-3);
		font-weight: 600;
	}

	/* ── top right ── */
	.tr {
		position: absolute;
		top: 14px;
		right: 16px;
		display: flex;
		gap: 8px;
	}
	.icon {
		height: 34px;
		min-width: 34px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 0 9px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--panel);
		color: var(--text-2);
		cursor: pointer;
		font: 700 10px var(--mono);
		letter-spacing: 0.06em;
	}
	.icon:hover {
		color: var(--text);
		border-color: rgba(255, 255, 255, 0.2);
	}
	.icon.sound.on {
		color: var(--bull);
		border-color: rgba(var(--bull-rgb), 0.35);
	}

	/* ── walls ── */
	.wall {
		position: absolute;
		top: 170px;
		padding: 10px 16px 11px;
		min-width: 132px;
		pointer-events: none;
	}
	.wall .label {
		color: var(--text-2);
	}
	.wall.sell {
		left: 0;
		background: linear-gradient(90deg, rgba(var(--bear-rgb), 0.24), rgba(var(--bear-rgb), 0.02));
		border-left: 3px solid var(--bear);
	}
	.wall.buy {
		right: 0;
		text-align: right;
		background: linear-gradient(270deg, rgba(var(--bull-rgb), 0.24), rgba(var(--bull-rgb), 0.02));
		border-right: 3px solid var(--bull);
	}
	.wv {
		font-size: 22px;
		font-weight: 800;
		margin-top: 2px;
		text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7);
	}
	.wall.sell .wv {
		color: #ff8d93;
	}
	.wall.buy .wv {
		color: #7df0a6;
	}

	/* ── banners ── */
	.banner {
		position: absolute;
		top: 30%;
		left: 50%;
		transform: translate(-50%, -50%);
		text-align: center;
		pointer-events: none;
		padding: 18px 34px 20px;
		border-radius: 14px;
		background: rgba(8, 11, 9, 0.82);
		border: 1px solid var(--line);
		animation: pop 0.45s cubic-bezier(0.2, 1.3, 0.4, 1) both;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
	}
	.banner.new {
		top: 176px;
		transform: translateX(-50%);
		padding: 12px 26px 14px;
		animation-name: drop;
	}
	.banner.win.bull {
		border-color: rgba(var(--bull-rgb), 0.5);
		box-shadow: 0 0 80px rgba(var(--bull-rgb), 0.25);
	}
	.banner.win.bear {
		border-color: rgba(var(--bear-rgb), 0.5);
		box-shadow: 0 0 80px rgba(var(--bear-rgb), 0.25);
	}
	.b-title {
		font-family: var(--pixel);
		font-size: 14px;
		letter-spacing: 0.08em;
		color: #fff;
	}
	.banner.win .b-title {
		font-size: 34px;
	}
	.banner.win.bull .b-title {
		color: var(--bull);
	}
	.banner.win.bear .b-title {
		color: var(--bear);
	}
	.b-line {
		font-size: 17px;
		font-weight: 800;
		margin-top: 9px;
	}
	.b-sub {
		font-size: 11px;
		color: var(--text-2);
		margin-top: 5px;
		white-space: pre;
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: translate(-50%, -50%) scale(0.85);
		}
	}
	@keyframes drop {
		from {
			opacity: 0;
			transform: translate(-50%, -10px);
		}
	}

	/* ── nuke alert + detonation white-out ── */
	.nuke-alert {
		position: absolute;
		top: 40%;
		left: 50%;
		transform: translate(-50%, -50%);
		text-align: center;
		pointer-events: none;
		padding: 14px 30px 16px;
		border-radius: 10px;
		background: rgba(20, 16, 4, 0.9);
		border: 3px solid transparent;
		border-image: repeating-linear-gradient(45deg, #ffd23f 0 12px, #111 12px 24px) 3;
		animation: pop 0.35s cubic-bezier(0.2, 1.3, 0.4, 1) both, alarm 0.5s steps(2, jump-none) infinite;
		box-shadow: 0 0 80px rgba(255, 210, 63, 0.35);
	}
	.na-title {
		font-family: var(--pixel);
		font-size: 20px;
		letter-spacing: 0.06em;
		color: #ffd23f;
		text-shadow: 0 0 18px rgba(255, 190, 40, 0.8);
	}
	.na-line {
		font-size: 13px;
		font-weight: 800;
		margin-top: 9px;
	}
	.nuke-alert.bull .na-line {
		color: #9ff5bd;
	}
	.nuke-alert.bear .na-line {
		color: #ffb0b4;
	}
	@keyframes alarm {
		50% {
			background: rgba(70, 16, 8, 0.92);
		}
	}
	.whiteout {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: radial-gradient(60% 60% at 50% 45%, #fff, #fff6dc 55%, #ffd9a0);
		animation: whiteout 1.8s ease-out forwards;
	}
	@keyframes whiteout {
		0% {
			opacity: var(--k);
		}
		100% {
			opacity: 0;
		}
	}

	/* ── panels ── */
	.panel {
		position: absolute;
		bottom: 16px;
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: 12px;
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}
	.panel header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		padding: 11px 12px 8px 14px;
	}
	.ptitle {
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.06em;
		margin-top: 3px;
	}
	.hdr-r {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.chev {
		width: 22px;
		height: 22px;
		border-radius: 6px;
		border: 1px solid var(--line);
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-2);
		cursor: pointer;
		font-size: 11px;
	}
	.src {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	select {
		font: 600 11px var(--sans);
		color: var(--text);
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 4px 6px;
		outline: none;
	}
	select option {
		background: #111613;
	}

	.depth {
		left: 16px;
		width: 340px;
	}
	.chart {
		display: block;
		width: calc(100% - 24px);
		height: 104px;
		margin: 0 12px;
	}
	.chart-tags {
		display: flex;
		justify-content: space-between;
		margin: -104px 14px 0;
		height: 104px;
		pointer-events: none;
		font: 800 9px var(--mono);
		letter-spacing: 0.08em;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		padding: 5px 12px 0;
		font-size: 10px;
		color: var(--text-3);
	}
	.axis b {
		color: var(--text);
	}
	.empty {
		padding: 30px 14px;
		font-size: 11px;
		color: var(--text-3);
		text-align: center;
	}
	.keys {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 10px 12px 12px;
		font: 700 9px var(--mono);
		color: var(--text-3);
		letter-spacing: 0.06em;
	}
	.keys span {
		margin: 0 7px 0 3px;
	}
	kbd {
		font: 700 9px var(--mono);
		color: var(--text-2);
		min-width: 18px;
		height: 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-bottom-width: 2px;
		border-radius: 4px;
		padding: 0 4px;
	}

	/* right column: the War Room above the market feed */
	.rightcol {
		position: absolute;
		right: 16px;
		top: 272px;
		bottom: 16px;
		width: 340px;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 10px;
		pointer-events: none;
	}
	.feed {
		position: relative;
		bottom: auto;
		flex: none;
		pointer-events: auto;
	}
	.live {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: 800 10px var(--mono);
		letter-spacing: 0.1em;
	}
	.live i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--bull);
		box-shadow: 0 0 8px var(--bull);
		animation: blink 1.4s infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0.3;
		}
	}
	.feed ul {
		list-style: none;
		max-height: min(24vh, 200px);
		overflow-y: auto;
		padding: 0 8px 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.feed li {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 7px 10px 7px 8px;
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.035);
		border-left: 3px solid rgba(255, 255, 255, 0.2);
		font-size: 12px;
		font-weight: 600;
		animation: slide 0.35s ease-out both;
	}
	.feed li.bull {
		border-left-color: var(--bull);
	}
	.feed li.bear {
		border-left-color: var(--bear);
	}
	.feed li.quiet {
		color: var(--text-3);
		border-left-color: transparent;
	}
	@keyframes slide {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
	}
	.venue {
		flex: none;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font: 800 9px var(--sans);
		color: #0b0f0c;
		background: var(--vc);
	}
	.feed a,
	.feed .txt {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
		text-decoration: none;
	}
	.feed a:hover {
		text-decoration: underline;
	}
	.amt {
		font-size: 12px;
		font-weight: 800;
	}

	.forces {
		position: absolute;
		bottom: 22px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		gap: 6px;
		align-items: baseline;
		font-size: 11px;
		font-weight: 700;
		padding: 6px 12px;
		border-radius: 999px;
		background: var(--panel);
		border: 1px solid var(--line);
		pointer-events: none;
		white-space: nowrap;
	}
	.forces .dim {
		color: var(--text-3);
		font-weight: 600;
	}
	.forces .sep {
		color: var(--text-3);
		margin: 0 4px;
	}

	.loading {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		background: radial-gradient(60% 60% at 50% 50%, rgba(11, 16, 12, 0.55), rgba(11, 16, 12, 0.92));
		pointer-events: none;
	}
	.spinner {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		border: 3px solid rgba(255, 255, 255, 0.12);
		border-top-color: var(--bull);
		border-right-color: var(--bear);
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.l1 {
		font-family: var(--pixel);
		font-size: 12px;
		letter-spacing: 0.1em;
	}
	.l2 {
		font-size: 11px;
		color: var(--text-3);
	}
	.fail {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		text-align: center;
		gap: 8px;
		background: var(--bg);
	}

	/* ── small screens ── */
	@media (max-width: 900px) {
		.top {
			top: 84px;
			gap: 12px;
		}
		.quote .label {
			font-size: 9px;
			white-space: nowrap;
		}
		.price {
			font-size: 28px;
		}
		.pressure {
			min-width: 0;
		}
		.ptext {
			font-size: 13px;
		}
		.roundbar {
			top: 182px;
		}
		.rb-track {
			width: 90px;
		}
		.wall {
			top: 226px;
			min-width: 0;
			padding: 7px 10px;
		}
		.wv {
			font-size: 15px;
		}
		.brand,
		.status,
		.forces {
			display: none;
		}
		.tl {
			top: 12px;
			left: 12px;
			gap: 6px;
		}
		.depth {
			left: 10px;
			bottom: 10px;
			width: calc(50% - 15px);
		}
		.depth .keys,
		.depth .src {
			display: none;
		}
		.rightcol {
			right: 10px;
			bottom: 10px;
			top: 300px;
			width: calc(50% - 15px);
		}
		.feed ul {
			max-height: 18vh;
		}
		.banner.new {
			top: 280px;
		}
		.banner.win .b-title {
			font-size: 22px;
		}
	}
	@media (max-width: 620px) {
		.osirisbar .full {
			display: none;
		}
		.na-title {
			font-size: 13px;
		}
		.icon.sound span {
			display: none;
		}
	}
	@media (max-width: 520px) {
		.pressure {
			display: none;
		}
		.quote {
			text-align: center;
		}
	}
</style>
