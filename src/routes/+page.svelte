<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Tween } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import type { Battle, Stats, Overlay, BattleEvent, Comp } from '$lib/battle/engine';
	import type { WarAudio } from '$lib/battle/audio';

	let canvas = $state<HTMLCanvasElement | null>(null);
	let battle: Battle | null = null;
	let audio: WarAudio | null = null;

	const EMPTY_COMP: Comp = { spear: 0, duelist: 0, archer: 0, guardian: 0, chariot: 0 };
	const EMPTY: Stats = {
		bulls: 0, bears: 0, bullPower: 0, bearPower: 0, frontPct: 50, casualtiesBull: 0, casualtiesBear: 0,
		fps: 0, round: 1, winBull: 0, winBear: 0, phase: 'battle', winner: null, warPhase: 'form', totalKills: 0,
		biggestWhaleUsd: 0, biggestWhaleWallet: '', commanders: [], bullComp: { ...EMPTY_COMP }, bearComp: { ...EMPTY_COMP }
	};
	let stats = $state<Stats>({ ...EMPTY });
	let overlay = $state<Overlay>({ tracked: [], titans: [], kills: [] });
	let token = $state<any>(null);
	let feed = $state<{ id: number; text: string; side: string; amt: string; big: boolean; stamp: string; icon: string }[]>([]);

	let entered = $state(false);
	let ready = $state(false);
	let muted = $state(false);
	let flashId = $state(0);
	function doFlash() { flashId++; }
	let campaignBanner = $state<{ winner: string; campaign: number; mcap: string } | null>(null);
	let campaignTimer: any;

	let trackInput = $state('');
	let tracking = $state(false);
	let focus = $state(false);

	const seen = new Set<string>();
	let feedId = 1;
	let tradeTimer: any, tokenTimer: any, bannerTimer: any, clockTimer: any;
	function tick() { clock = new Date().toISOString().slice(11, 19); }

	const mask = (a: string) => (a && a.length > 8 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '—');
	const fmtUsd = (n: number) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'K' : '$' + n.toFixed(0));
	const fmtPrice = (n: number) => (n >= 1 ? '$' + n.toFixed(4) : '$' + n.toPrecision(3));
	const pctStr = (p: number) => (p >= 0.01 ? p.toFixed(2) + '%' : p.toFixed(3) + '%');

	let clock = $state('');
	let buyUsd = $state(0), sellUsd = $state(0);

	// the big number counts up/down instead of snapping — the market breathes.
	// first reading snaps instantly so the ticker never shows $0.
	const mcapTween = new Tween(0, { duration: 900, easing: cubicOut });
	let mcapPulse = $state(0);
	let mcapInit = false;

	// ── battle timeframe: 5M / 1H / 24H ──
	type TF = 'm5' | 'h1' | 'h24';
	let tf = $state<TF>('h1');
	const TF_LABEL: Record<TF, string> = { m5: '5M', h1: '1H', h24: '24H' };
	const TF_SECS: Record<TF, number> = { m5: 300, h1: 3600, h24: 86400 };
	const win = $derived.by(() => {
		const chg = token?.change?.[tf] ?? 0;
		const vol = token?.volume?.[tf] ?? 0;
		const buys = token?.txns?.[tf]?.buys ?? 0;
		const sells = token?.txns?.[tf]?.sells ?? 0;
		const tot = buys + sells || 1;
		return { chg, vol, buys, sells, buyVol: vol * (buys / tot), sellVol: vol * (sells / tot), buyPct: (buys / tot) * 100 };
	});
	function applyTf() {
		battle?.setMomentum(win.chg);
		if (token) battle?.setMarketCap(fmtUsd(token.marketCap), win.chg);
		// reinforcement flow scaled from the window's real txn rate
		const scale = 55; // battle-time amplification
		const rate = (n: number) => Math.min(2.2, Math.max(0.18, (n / TF_SECS[tf]) * scale));
		battle?.setReinforceRates(rate(win.buys), rate(win.sells));
	}
	function setTf(next: TF) { tf = next; applyTf(); }
	const pressure = $derived(buyUsd + sellUsd > 0 ? (buyUsd / (buyUsd + sellUsd)) * 100 : 50);
	// frontPct is the bulls' share of the field — high means buyers pushing
	const marketPressure = $derived(
		stats.frontPct > 55 ? { t: 'BUYERS ADVANCING', c: 'green' } :
		stats.frontPct < 45 ? { t: 'SELLERS ADVANCING', c: 'red' } : { t: 'MARKET BALANCED', c: 'dim' }
	);
	const powerShare = $derived(stats.bullPower + stats.bearPower > 0 ? (stats.bullPower / (stats.bullPower + stats.bearPower)) * 100 : 50);
	const maxKills = $derived(Math.max(1, ...stats.commanders.map((c) => c.kills)));

	// Order-book depth (stylised from live buy/sell pressure)
	const depth = $derived.by(() => {
		const bidH = Math.min(1, buyUsd / Math.max(1, buyUsd + sellUsd) + 0.15);
		const askH = Math.min(1, sellUsd / Math.max(1, buyUsd + sellUsd) + 0.15);
		const bid: string[] = [], ask: string[] = [];
		for (let i = 0; i <= 24; i++) {
			const t = i / 24;
			const yb = 60 - Math.pow(t, 1.6) * 54 * bidH - (Math.sin(i * 1.7) * 2);
			bid.push(`${t * 48},${Math.max(6, yb).toFixed(1)}`);
			const ya = 60 - Math.pow(t, 1.6) * 54 * askH - (Math.cos(i * 1.7) * 2);
			ask.push(`${100 - t * 48},${Math.max(6, ya).toFixed(1)}`);
		}
		return { bid: bid.join(' '), ask: ask.join(' ') };
	});

	function pushFeed(text: string, side: string, amt: string, big = false, ts?: number, icon = '') {
		const stamp = new Date((ts ?? Date.now() / 1000) * 1000).toISOString().slice(11, 19);
		feed = [{ id: feedId++, text, side, amt, big, stamp, icon: icon || (side === 'buy' ? '▲' : '▼') }, ...feed].slice(0, 16);
	}

	async function loadToken() {
		try {
			const r = await fetch('/api/token');
			if (r.ok) {
				token = await r.json();
				battle?.setSupply(token.supply);
				battle?.setMcapLadder(token.marketCap);
				battle?.setPriceLabel(fmtPrice(token.priceUsd), '$OSIRIS · CURRENT PRICE');
				document.title = `${fmtUsd(token.marketCap)} · $OSIRIS Battlefield`;
				if (!mcapInit) { mcapInit = true; mcapTween.set(token.marketCap, { duration: 0 }); }
				else {
					if (Math.abs(token.marketCap - mcapTween.target) / Math.max(1, token.marketCap) > 0.001) mcapPulse++;
					mcapTween.target = token.marketCap;
				}
				applyTf();
			}
		} catch {}
	}
	function pctOf(amount: number): number { return token?.supply ? (amount / token.supply) * 100 : 0.015; }

	async function loadTrades(seed = false) {
		try {
			const r = await fetch('/api/trades');
			const d = await r.json();
			const trades: any[] = d.trades || [];
			let b = 0, s = 0;
			for (const t of trades.slice(0, 40)) (t.kind === 'buy' ? (b += t.usd) : (s += t.usd));
			buyUsd = b; sellUsd = s;
			battle?.setPressure(b, s); // live tape drives the front-line liquidity buffers
			for (const t of [...trades].reverse()) {
				if (seen.has(t.tx)) continue;
				seen.add(t.tx);
				const pct = pctOf(t.amount);
				battle?.spawn({ wallet: t.wallet, kind: t.kind, usd: t.usd, pct, quiet: seed });
				if (!seed) {
					const whale = pct >= 0.25, large = t.usd >= 300;
					const price = token?.priceUsd ? fmtPrice(token.priceUsd) : '';
					let label: string;
					if (t.kind === 'buy') label = whale ? `LIQUIDATED SHORT @ ${price}` : large ? 'LARGE BUY TRADE' : 'MARKET BUY';
					else label = whale ? `LIQUIDATED LONG @ ${price}` : large ? 'LARGE SELL TRADE' : 'MARKET SELL';
					const tag = t.kind === 'buy' ? `+1 LONG · ${pctStr(pct)}` : `+1 SHORT · ${pctStr(pct)}`;
					pushFeed(`${label}  ·  ${tag}`, t.kind === 'buy' ? 'buy' : 'sell', fmtUsd(t.usd), whale || large, t.ts, whale ? '✦' : large ? '◆' : '');
				}
			}
		} catch {}
	}

	function doTrack() {
		const w = trackInput.trim();
		if (w.length < 32) { pushFeed('Enter a valid Solana wallet to track your position.', 'sell', '', false, undefined, '◈'); return; }
		tracking = true; battle?.setTrackWallet(w);
		pushFeed(`TRACKING ${mask(w)} — your units marked on the field.`, 'buy', '', false, undefined, '◈');
	}
	function stopTrack() { tracking = false; focus = false; battle?.setTrackWallet(null); battle?.setFocus(false); }
	function toggleFocus() { focus = !focus; battle?.setFocus(focus); }
	function toggleSound() { muted = !muted; audio?.setMuted(muted); }
	function resetCam() { battle?.resetCamera(); }

	const trackedSummary = $derived.by(() => {
		const t = overlay.tracked;
		if (!t.length) return null;
		const kills = t.reduce((a, u) => a + u.kills, 0);
		const order = ['SOLDIER', 'ELITE', 'CHAMPION', 'TITAN', 'GOD', 'GARRISON'];
		const best = t.reduce((a, u) => (order.indexOf(u.tier) > order.indexOf(a) ? u.tier : a), 'SOLDIER');
		return { count: t.length, kills, best };
	});

	const PHASE_META: Record<string, { t: string; ic: string }> = {
		form: { t: 'FORMING RANKS', ic: '⚑' }, advance: { t: 'ADVANCING', ic: '►' },
		charge: { t: 'CHARGE!', ic: '⚔' }, melee: { t: 'MELEE', ic: '⚔' }, regroup: { t: 'REGROUP', ic: '↻' }
	};

	async function enter() {
		entered = true;
		const { WarAudio } = await import('$lib/battle/audio');
		audio = new WarAudio(); audio.start(); audio.setMuted(muted);
	}

	onMount(() => {
		let alive = true;
		if (new URLSearchParams(location.search).has('nointro')) { entered = true; muted = true; }
		(async () => {
			const { Battle } = await import('$lib/battle/engine');
			if (!alive || !canvas) return;
			battle = new Battle(canvas);
			let lastWarPhase = 'form';
			battle.onStats = (s) => {
				if (s.warPhase === 'charge' && lastWarPhase !== 'charge' && s.phase === 'battle') audio?.horn(false);
				lastWarPhase = s.warPhase;
				stats = s;
				// the drums follow the real war rhythm and how thick the fighting is
				audio?.setBattle(s.warPhase, Math.min(s.bulls, s.bears) / 110);
			};
			battle.onOverlay = (o) => (overlay = o);
			battle.onEvent = (e: BattleEvent) => {
				if (e.type === 'legend') {
					const c = e.cls === 'guardian' ? 'GUARDIAN' : e.cls.toUpperCase();
					pushFeed(`${e.tier} ${c} AWAKENS — ${mask(e.wallet)} moved ${pctStr(e.pct)}`, e.team === 'bull' ? 'buy' : 'sell', fmtUsd(e.usd), true, undefined, '◆');
					audio?.horn(!!e.god); if (e.god) doFlash();
				} else if (e.type === 'duel') {
					pushFeed(`SINGLE COMBAT BEFORE THE HOSTS — ${e.tier}`, 'buy', '', true, undefined, '⚔');
				} else if (e.type === 'strike') {
					const hit = e.team === 'bull' ? 'THE BEARS' : 'THE BULLS';
					pushFeed(e.god ? `SPEAR OF RA ANNIHILATES ${hit}` : `FALCON OF HORUS DIVES ON ${hit}`, e.team === 'bull' ? 'buy' : 'sell', fmtUsd(e.usd), true, undefined, e.god ? '☀' : '𓅃');
					audio?.strike(!!e.god);
				} else if (e.type === 'volley') {
					audio?.volley(e.usd);
				} else if (e.type === 'kill') {
					audio?.kill(e.tier === 'TITAN' || e.tier === 'GOD');
				}
			};
			battle.onCampaign = (r) => {
				doFlash();
				audio?.victory(r.winner === 'bull'); audio?.boom();
				campaignBanner = { winner: r.winner, campaign: r.campaign, mcap: token ? fmtUsd(token.marketCap) : '' };
				clearTimeout(campaignTimer); campaignTimer = setTimeout(() => (campaignBanner = null), 3800);
				pushFeed(`${r.winner === 'bull' ? 'BULLS' : 'BEARS'} STORM THE BASE — CAMPAIGN ${r.campaign} FALLS`, r.winner === 'bull' ? 'buy' : 'sell', '', true, undefined, '⚑');
			};
			battle.start();

			await loadToken();
			const g = (n: number) => Math.max(70, Math.min(220, Math.round(n * 1.2)));
			battle.spawnGarrison(g(token?.buys24h ?? 120), g(token?.sells24h ?? 120));
			await loadTrades(true);
			ready = true;

			tick(); clockTimer = setInterval(tick, 1000);
			tradeTimer = setInterval(() => loadTrades(false), 5000);
			tokenTimer = setInterval(loadToken, 15000);
		})();
		return () => { alive = false; };
	});

	onDestroy(() => { clearInterval(tradeTimer); clearInterval(tokenTimer); clearInterval(clockTimer); clearTimeout(bannerTimer); clearTimeout(campaignTimer); audio?.dispose(); battle?.dispose(); });
</script>

<svelte:head><title>OSIRIS · Market Battlefield</title></svelte:head>

<canvas bind:this={canvas} class="scene"></canvas>
<div class="cine"></div>

<div class="labels">
	{#each overlay.titans.slice(0, 10) as t}
		{#if t.on}<div class="titan-label" class:bear={t.team === 'bear'} style="transform:translate3d({t.x}px,{t.y}px,0) translate(-50%,-100%)">{t.label}</div>{/if}
	{/each}
	{#each overlay.tracked.slice(0, 8) as u}
		{#if u.on}
			<div class="track-label" style="transform:translate3d({u.x}px,{u.y}px,0) translate(-50%,-100%)">
				<div class="tl-tier">◆ {u.tier}</div>
				<div class="tl-hp"><span style="width:{(u.hp / u.maxHp) * 100}%"></span></div>
			</div>
		{/if}
	{/each}
	{#each overlay.kills.slice(0, 20) as k}
		{#if k.on}
			<div class="kill-marker mono" class:bear={k.team === 'bear'} style="transform:translate3d({k.x}px,{k.y}px,0) translate(-50%,-100%);opacity:{1 - k.age}">
				✕ {k.team === 'bull' ? 'LONG DOWN' : 'SHORT DOWN'}
			</div>
		{/if}
	{/each}
</div>

{#key flashId}{#if flashId > 0}<div class="flash"></div>{/if}{/key}

{#if campaignBanner}
	<div class="campaign" class:bear={campaignBanner.winner === 'bear'}>
		<div class="camp-mark display">𓂀</div>
		<div class="camp-sub mono">— CAMPAIGN {campaignBanner.campaign} · BASE OVERRUN —</div>
		<div class="camp-title display">{campaignBanner.winner === 'bull' ? 'BULLS STORM THE BASE' : 'BEARS STORM THE BASE'}</div>
		<div class="camp-mcap mono">NEW FRONT OPENS @ <span class:green={campaignBanner.winner === 'bull'} class:red={campaignBanner.winner === 'bear'}>{campaignBanner.mcap}</span> MARKET CAP</div>
	</div>
{/if}

{#if !entered}
	<div class="intro">
		<div class="intro-inner">
			<div class="intro-eye display">𓂀</div>
			<h1 class="intro-title display">OSIRIS <span class="gt">MARKET</span> BATTLEFIELD</h1>
			<div class="intro-tag mono">$OSIRIS · BUYS vs SELLS · LIVE ON-CHAIN WARFARE</div>
			<div class="intro-chips mono">
				<span class="ichip"><i class="live-dot"></i> LIVE ORDER FLOW</span>
				<span class="ichip">𓅃 WHALE SKY STRIKES</span>
				<span class="ichip">⛨ WAR CHARIOTS</span>
				<span class="ichip">☀ GOD BEAMS</span>
			</div>
			<p class="intro-lore">
				Every <span class="green">buy</span> deploys a soldier for the <span class="green">bulls</span>;
				every <span class="red">sell</span> reinforces the <span class="red">bears</span>.
				Bigger orders field mightier warriors — spearmen hold the line, twin-khopesh duelists
				dance through the melee, archers rain bronze, champions ride
				<span class="green">war chariots</span> through the ranks, and whales awaken beast-headed
				<span class="green">guardians</span> of the Duat. The price drives the front. The war never stops.
			</p>
			<button class="enter-btn" onclick={enter} disabled={!ready}><span>{ready ? 'ENTER THE BATTLEFIELD' : 'LOADING ORDER FLOW…'}</span></button>
			<div class="intro-hint mono">W A S D PAN · SCROLL ZOOM · DRAG ORBIT · SOUND ON</div>
		</div>
	</div>
{/if}

<!-- TOP: MARKET CAP + PRICE + PRESSURE -->
<header class="topbar">
	<div class="brand">
		<span class="brand-mark display">☥ OSIRIS</span>
		<span class="brand-sub mono">MARKET BATTLEFIELD</span>
		<span class="brand-rule"></span>
		<span class="brand-clock mono"><span class="live-dot sm"></span> UTC {clock}</span>
	</div>
	<div class="ticker">
		{#if token}
			<div class="mcap">
				<span class="kick mono">$OSIRIS MARKET CAP · AGGREGATED SPOT</span>
				{#key mcapPulse}<span class="mcap-v mono pulse">{fmtUsd(mcapTween.current)}</span>{/key}
			</div>
			<div class="subline mono">
				<span class="price">{fmtPrice(token.priceUsd)}</span>
				<span class="chg-pill" class:up={win.chg >= 0} class:down={win.chg < 0}>{win.chg >= 0 ? '▲' : '▼'} {Math.abs(win.chg).toFixed(2)}% {TF_LABEL[tf]}</span>
				<span class="pressure {marketPressure.c}">{marketPressure.t}</span>
				<span class="live-dot"></span><span class="red mono">LIVE</span>
			</div>
			<div class="front-meter mono" title="Front line — bulls vs bears">
				<span class="fm-side green">◤ {Math.round(stats.frontPct)}%</span>
				<div class="frontbar">
					<span class="fb-fill" style="width:{stats.frontPct}%"></span>
					<span class="fb-notch"></span>
					<span class="fb-marker" style="left:{stats.frontPct}%"></span>
				</div>
				<span class="fm-side red">{Math.round(100 - stats.frontPct)}% ◥</span>
			</div>
			<div class="tf-row mono">
				<div class="tf-toggle">
					{#each (['m5', 'h1', 'h24'] as const) as t}
						<button class="tf-btn" class:on={tf === t} onclick={() => setTf(t)}>{TF_LABEL[t]}</button>
					{/each}
				</div>
				<span class="chip"><span class="dim">VOL</span> {fmtUsd(win.vol)}</span>
				<span class="chip"><span class="dim">TXNS</span> <span class="green">{win.buys}B</span><span class="dim">/</span><span class="red">{win.sells}S</span></span>
				<span class="chip"><span class="dim">FLOW</span> <span class:green={win.buyPct >= 50} class:red={win.buyPct < 50}>{win.buyPct.toFixed(0)}% BUY</span></span>
			</div>
		{/if}
	</div>
	<div class="top-right">
		<div class="tally glass mono warphase" class:hot={stats.warPhase === 'charge' || stats.warPhase === 'melee'}>
			<span class="wp-ic">{PHASE_META[stats.warPhase]?.ic}</span> {PHASE_META[stats.warPhase]?.t}
		</div>
		<div class="tally glass mono"><span class="dim">CAMPAIGN</span> <span class="gold">{stats.round}</span></div>
		<div class="tally glass mono"><span class="green">{stats.winBull}W</span><span class="dim">WARS</span><span class="red">{stats.winBear}W</span></div>
		<button class="icon-btn glass mono" onclick={toggleSound} title={muted ? 'Unmute' : 'Mute'}>{muted ? '🔇' : '🔊'}</button>
	</div>
</header>

<!-- SELL WALL (left) -->
<div class="wall left">
	<div class="wall-kick mono red">SELL WALL · {TF_LABEL[tf]}</div>
	<div class="wall-v mono red">{fmtUsd(win.sellVol)}</div>
	<div class="wall-bar sell"><span style="width:{100 - pressure}%"></span></div>
	<div class="wall-sub mono dim">TAPE {fmtUsd(sellUsd)}</div>
</div>

<!-- BUY WALL (right) -->
<div class="wall right">
	<div class="wall-kick mono green">BUY WALL · {TF_LABEL[tf]}</div>
	<div class="wall-v mono green">{fmtUsd(win.buyVol)}</div>
	<div class="wall-bar buy"><span style="width:{pressure}%"></span></div>
	<div class="wall-sub mono dim">TAPE {fmtUsd(buyUsd)}</div>
</div>

<!-- WAR LEDGER: top killer wallets + casualties (top-left, under sell wall) -->
<div class="ledger glass panel-1">
	<div class="p-head mono"><span><i class="p-glyph">𓁹</i> WAR LEDGER</span><span class="dim">KILLS</span></div>
	{#each stats.commanders as c, i (c.wallet)}
		<div class="ledger-row mono">
			<span class="lg-rank" class:first={i === 0}>{i === 0 ? '𓁹' : '◆'}</span>
			<span class="ledger-w" class:green={c.team === 'bull'} class:red={c.team === 'bear'}>{mask(c.wallet)}</span>
			<span class="ledger-tier dim">{c.tier}</span>
			<span class="lg-bar"><span style="width:{(c.kills / maxKills) * 100}%" class:red={c.team === 'bear'}></span></span>
			<span class="ledger-k">{c.kills}</span>
		</div>
	{:else}
		<div class="ledger-row mono"><span class="dim">Big trades field commanders…</span></div>
	{/each}
	<div class="ledger-foot mono">
		<span class="dim">FALLEN</span>
		<span class="green">{stats.casualtiesBull}</span><span class="dim">/</span><span class="red">{stats.casualtiesBear}</span>
		{#if stats.biggestWhaleUsd > 0}
			<span class="dim">· TOP WHALE</span> <span class="gold">{fmtUsd(stats.biggestWhaleUsd)}</span>
		{/if}
	</div>
</div>

<!-- ORDER BOOK DEPTH (bottom-left) -->
<div class="orderbook glass panel-2">
	<div class="p-head mono"><span><i class="p-glyph">𓈗</i> ORDER BOOK DEPTH</span><span class="dim">AGGREGATED SPOT</span></div>
	<svg viewBox="0 0 100 64" class="ob-chart" preserveAspectRatio="none">
		<polyline points="0,64 {depth.bid} 48,64" fill="rgba(20,241,149,0.16)" stroke="var(--green)" stroke-width="0.8" />
		<polyline points="100,64 {depth.ask} 52,64" fill="rgba(255,77,94,0.16)" stroke="var(--crimson)" stroke-width="0.8" />
		<line x1="50" y1="0" x2="50" y2="64" stroke="rgba(255,255,255,0.25)" stroke-width="0.4" stroke-dasharray="1 1.5" />
	</svg>
	<div class="ob-split mono"><span class="green">BID {pressure.toFixed(0)}%</span><span class="red">ASK {(100 - pressure).toFixed(0)}%</span></div>
	<div class="ob-foot mono">
		<span class="green">{token ? fmtPrice(token.priceUsd * 0.982).replace('$', '') : 'BID'}</span>
		<span class="dim">{token ? fmtPrice(token.priceUsd) : '—'}</span>
		<span class="red">{token ? fmtPrice(token.priceUsd * 1.018).replace('$', '') : 'ASK'}</span>
	</div>
</div>

<!-- ORDER FLOW ARMIES (bottom-left, above track) -->
<div class="forces glass panel-3">
	<div class="p-head mono"><span><i class="p-glyph">⚔</i> ORDER FLOW ARMIES</span><span class="dim">{stats.bulls + stats.bears} FIELDED</span></div>
	<div class="power-bar" title="Fighting power — bulls vs bears">
		<span class="pb-bull" style="width:{powerShare}%"></span>
	</div>
	<div class="force">
		<div class="force-head green mono">◤ BULLS · LONGS <span class="force-n">{stats.bulls}</span></div>
		<div class="force-comp mono"><span><em>SPR</em> {stats.bullComp.spear}</span><span><em>DUE</em> {stats.bullComp.duelist}</span><span><em>ARC</em> {stats.bullComp.archer}</span><span><em>CHA</em> {stats.bullComp.chariot}</span><span><em>GRD</em> {stats.bullComp.guardian}</span></div>
	</div>
	<div class="force">
		<div class="force-head red mono">BEARS · SHORTS ◥ <span class="force-n">{stats.bears}</span></div>
		<div class="force-comp mono"><span><em>SPR</em> {stats.bearComp.spear}</span><span><em>DUE</em> {stats.bearComp.duelist}</span><span><em>ARC</em> {stats.bearComp.archer}</span><span><em>CHA</em> {stats.bearComp.chariot}</span><span><em>GRD</em> {stats.bearComp.guardian}</span></div>
	</div>
</div>

<!-- MARKET FEED (bottom-right) -->
<div class="feed glass panel-1">
	<div class="p-head mono"><span><i class="p-glyph">𓅓</i> MARKET FEED</span><span class="green">● LIVE</span></div>
	<div class="feed-rows">
		{#each feed as f (f.id)}
			<div class="feed-row" class:big={f.big} class:buy={f.side === 'buy'} class:sell={f.side === 'sell'}>
				<span class="feed-ic mono">{f.icon}</span>
				<span class="feed-body">
					<span class="feed-text mono">{f.text}</span>
					<span class="feed-stamp mono dim">{f.stamp} UTC</span>
				</span>
				{#if f.amt}<span class="feed-amt mono">{f.amt}</span>{/if}
			</div>
		{/each}
	</div>
</div>

<!-- TRACK POSITION (bottom-right, below feed) -->
<div class="track glass panel-2">
	{#if !tracking}
		<div class="track-row">
			<input class="input" bind:value={trackInput} placeholder="◈ Track your wallet on the field…" onkeydown={(e) => e.key === 'Enter' && doTrack()} />
			<button class="btn btn-green" onclick={doTrack}>TRACK</button>
		</div>
	{:else}
		<div class="track-live mono">
			<span class="track-dot"></span>
			{#if trackedSummary}
				<span class="dim">YOUR UNITS</span> <span class="green">{trackedSummary.count}</span>
				<span class="dim">· RANK</span> <span>{trackedSummary.best}</span>
				<span class="dim">· SLAIN</span> <span class="red">{trackedSummary.kills}</span>
			{:else}<span class="dim">No live units — trade to deploy</span>{/if}
			<button class="mini" class:on={focus} onclick={toggleFocus}>{focus ? '◉ FOLLOW' : '⤢ FOLLOW'}</button>
			<button class="mini" onclick={stopTrack}>✕</button>
		</div>
	{/if}
</div>

<div class="controls mono dim">
	<span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> PAN
	<span class="sep">·</span> <span class="key">SCROLL</span> ZOOM
	<span class="sep">·</span> DRAG ORBIT
	<span class="sep">·</span> <button class="link" onclick={resetCam}>RESET</button>
	<span class="fps" class:low={stats.fps > 0 && stats.fps < 45}>{stats.fps} FPS</span>
</div>

<style>
	.scene { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; z-index: 0; touch-action: none; }
	/* cinematic letterbox — the scene reads like a shot, not a viewport */
	.cine { position: fixed; inset: 0; z-index: 1; pointer-events: none;
		background: linear-gradient(to bottom, rgba(2,1,4,0.55), transparent 12%), linear-gradient(to top, rgba(2,1,4,0.6), transparent 16%); }
	.labels { position: fixed; inset: 0; z-index: 5; pointer-events: none; }
	.titan-label { position: absolute; left: 0; top: 0; will-change: transform; font-family: var(--display); font-size: 12px; font-weight: 800; color: #7dffb0; text-shadow: 0 0 10px rgba(20,241,149,0.8), 0 2px 4px #000; white-space: nowrap; }
	.titan-label.bear { color: #ff9aa6; text-shadow: 0 0 10px rgba(255,77,94,0.8), 0 2px 4px #000; }
	.track-label { position: absolute; left: 0; top: 0; will-change: transform; text-align: center; white-space: nowrap; }
	.tl-tier { font-family: var(--mono); font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 0 8px var(--green), 0 2px 3px #000; }
	.tl-hp { width: 44px; height: 4px; border-radius: 3px; background: rgba(0,0,0,0.6); margin: 3px auto 0; overflow: hidden; border: 1px solid rgba(20,241,149,0.5); }
	.tl-hp span { display: block; height: 100%; background: var(--green); }

	.campaign { position: fixed; inset: 0; z-index: 57; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; pointer-events: none; animation: rise 0.4s both; background: radial-gradient(circle at 50% 45%, rgba(20,241,149,0.14), transparent 62%); }
	.campaign.bear { background: radial-gradient(circle at 50% 45%, rgba(255,77,94,0.16), transparent 62%); }
	.camp-mark { position: absolute; font-size: 300px; opacity: 0.05; color: #fff; pointer-events: none; }
	.camp-sub { font-size: 12px; letter-spacing: 0.42em; color: var(--text-2); }
	.camp-title { font-size: 54px; font-weight: 900; letter-spacing: 0.03em; color: #fff; text-shadow: 0 0 38px rgba(20,241,149,0.55), 0 4px 20px #000; }
	.campaign.bear .camp-title { text-shadow: 0 0 38px rgba(255,77,94,0.55), 0 4px 20px #000; }
	.camp-mcap { font-size: 15px; letter-spacing: 0.14em; color: var(--text); }

	.kill-marker { position: absolute; left: 0; top: 0; will-change: transform; font-size: 11px; font-weight: 700; color: #baffd6; letter-spacing: 0.04em; text-shadow: 0 0 8px rgba(20,241,149,0.7), 0 2px 3px #000; white-space: nowrap; }
	.kill-marker.bear { color: #ffc2c8; text-shadow: 0 0 8px rgba(255,77,94,0.7), 0 2px 3px #000; }

	.flash { position: fixed; inset: 0; z-index: 58; pointer-events: none; background: radial-gradient(circle at 50% 45%, rgba(255,255,255,0.6), rgba(200,255,220,0.2) 60%, transparent 100%); animation: flashfade 0.65s ease-out forwards; }
	@keyframes flashfade { from { opacity: 1; } to { opacity: 0; } }

	/* ── INTRO ─────────────────────────────────────────── */
	.intro { position: fixed; inset: 0; z-index: 60; background: radial-gradient(circle at 72% 18%, rgba(120,40,50,0.22), transparent 40%), radial-gradient(circle at 50% 40%, rgba(16,10,20,0.9), rgba(4,2,7,0.98)); display: flex; align-items: center; justify-content: center; animation: rise 0.5s both; }
	.intro-inner { text-align: center; max-width: 620px; padding: 30px; }
	.intro-eye { font-size: 64px; color: var(--green); text-shadow: 0 0 40px rgba(20,241,149,0.5); animation: eyepulse 3s ease-in-out infinite; }
	@keyframes eyepulse { 0%, 100% { text-shadow: 0 0 30px rgba(20,241,149,0.4); } 50% { text-shadow: 0 0 60px rgba(20,241,149,0.75); } }
	.intro-title { font-size: 44px; font-weight: 900; letter-spacing: 0.04em; margin: 12px 0 10px; color: #fff; }
	.intro-title .gt { background: linear-gradient(120deg, #5effa0, var(--green) 55%, #0d9e60); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.intro-tag { font-size: 11px; letter-spacing: 0.28em; color: var(--green); margin-bottom: 16px; }
	.intro-chips { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
	.ichip { display: inline-flex; align-items: center; gap: 6px; font-size: 9px; letter-spacing: 0.14em; color: var(--text-2); border: 1px solid var(--line-2); border-radius: 999px; padding: 6px 12px; background: rgba(255,255,255,0.03); }
	.intro-lore { font-size: 14px; line-height: 1.9; color: var(--text-2); margin-bottom: 28px; }
	.enter-btn { position: relative; overflow: hidden; font-family: var(--mono); font-size: 15px; font-weight: 700; letter-spacing: 0.12em; padding: 16px 40px; border-radius: 12px; cursor: pointer; color: #05130b; border: none; background: linear-gradient(120deg, #5effa0, var(--green)); box-shadow: 0 0 40px rgba(20,241,149,0.4); transition: transform 0.2s, box-shadow 0.2s; }
	.enter-btn > span { position: relative; z-index: 1; }
	.enter-btn::after { content: ''; position: absolute; top: 0; bottom: 0; width: 40%; left: -60%; transform: skewX(-20deg); background: linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent); animation: sweep 2.6s ease-in-out infinite; }
	@keyframes sweep { 0%, 55% { left: -60%; } 85%, 100% { left: 130%; } }
	.enter-btn:hover:not(:disabled) { transform: translateY(-2px) scale(1.02); box-shadow: 0 0 60px rgba(20,241,149,0.55); }
	.enter-btn:disabled { opacity: 0.5; cursor: wait; background: rgba(255,255,255,0.1); color: var(--text-2); box-shadow: none; }
	.enter-btn:disabled::after { display: none; }
	.intro-hint { margin-top: 20px; font-size: 9px; letter-spacing: 0.22em; color: var(--text-3); }

	/* ── TOPBAR ────────────────────────────────────────── */
	.topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 10; display: flex; align-items: flex-start; justify-content: space-between; padding: 16px 22px; pointer-events: none; }
	.brand { display: flex; flex-direction: column; width: 210px; }
	.brand-mark { font-size: 21px; font-weight: 800; color: var(--green); letter-spacing: 0.08em; text-shadow: 0 0 20px rgba(20,241,149,0.4); }
	.brand-sub { font-size: 8px; letter-spacing: 0.36em; color: var(--text-3); margin-top: 2px; }
	.brand-rule { width: 118px; height: 1px; margin: 7px 0 5px; background: linear-gradient(90deg, rgba(var(--gold-rgb), 0.7), transparent); }
	.brand-clock { font-size: 10px; letter-spacing: 0.1em; color: var(--text-2); display: inline-flex; align-items: center; gap: 6px; }
	.ticker { text-align: center; animation: rise 0.6s both; }
	.mcap { display: flex; flex-direction: column; align-items: center; }
	.mcap .kick { font-size: 9px; letter-spacing: 0.2em; color: var(--text-3); }
	.mcap-v { font-size: 42px; font-weight: 800; color: #fff; line-height: 1.05; text-shadow: 0 2px 20px rgba(0,0,0,0.6); font-variant-numeric: tabular-nums; }
	.mcap-v.pulse { animation: countflash 0.7s ease-out; }
	@keyframes countflash { 0% { transform: scale(1); } 25% { transform: scale(1.045); text-shadow: 0 0 34px rgba(var(--gold-rgb), 0.6), 0 2px 20px rgba(0,0,0,0.6); } 100% { transform: scale(1); } }
	.subline { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 12px; margin-top: 4px; }
	.subline .price { color: #fff; font-weight: 700; }
	.chg-pill { font-weight: 700; font-size: 11px; padding: 2px 9px; border-radius: 999px; letter-spacing: 0.04em; }
	.chg-pill.up { color: #9affc4; background: rgba(20,241,149,0.12); border: 1px solid rgba(20,241,149,0.35); }
	.chg-pill.down { color: #ffb0b8; background: rgba(255,59,78,0.12); border: 1px solid rgba(255,59,78,0.35); }
	.pressure { font-weight: 700; letter-spacing: 0.05em; }
	.pressure.green { color: var(--green); } .pressure.red { color: var(--crimson); } .pressure.dim { color: var(--text-2); }
	.top-right { display: flex; align-items: center; gap: 8px; pointer-events: auto; width: 210px; justify-content: flex-end; flex-wrap: wrap; }
	.tally { display: flex; gap: 6px; padding: 9px 11px; font-size: 11px; font-weight: 700; align-items: center; transition: border-color 0.2s; }
	.tally:hover { border-color: rgba(var(--gold-rgb), 0.35); }
	.warphase { font-size: 10px; letter-spacing: 0.12em; color: var(--text-2); }
	.wp-ic { color: var(--gold); }
	.warphase.hot { color: var(--crimson); border-color: rgba(var(--crimson-rgb), 0.5); text-shadow: 0 0 14px rgba(var(--crimson-rgb), 0.6); animation: glowpulse 1.2s ease-in-out infinite; }
	.warphase.hot .wp-ic { color: var(--crimson); }
	@keyframes glowpulse { 0%, 100% { box-shadow: 0 0 6px rgba(var(--crimson-rgb), 0.15); } 50% { box-shadow: 0 0 18px rgba(var(--crimson-rgb), 0.4); } }
	.icon-btn { padding: 8px 11px; cursor: pointer; border: 1px solid var(--line); font-size: 13px; line-height: 1; color: var(--text-2); transition: all 0.2s; }
	.icon-btn:hover { color: var(--text); border-color: rgba(var(--gold-rgb), 0.4); }

	/* front meter: the war in one bar */
	.front-meter { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 9px; }
	.fm-side { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; min-width: 52px; }
	.fm-side.green { text-align: right; }
	.fm-side.red { text-align: left; }
	.frontbar { position: relative; width: 300px; height: 6px; border-radius: 4px; overflow: visible; background: linear-gradient(90deg, rgba(20,241,149,0.14), rgba(255,59,78,0.2)); border: 1px solid var(--line-2); }
	.fb-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: linear-gradient(90deg, rgba(20,241,149,0.5), rgba(20,241,149,0.9)); transition: width 0.4s ease; }
	.fb-notch { position: absolute; left: 50%; top: -2px; width: 1px; height: 10px; background: rgba(255,255,255,0.35); }
	.fb-marker { position: absolute; top: -4px; width: 3px; height: 14px; border-radius: 2px; background: #fff; box-shadow: 0 0 10px rgba(255,255,255,0.9); transform: translateX(-50%); transition: left 0.4s ease; }
	.tf-row { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 9px; pointer-events: auto; }
	.tf-toggle { display: flex; gap: 3px; padding: 3px; border-radius: 9px; background: rgba(8,10,8,0.85); border: 1px solid var(--line); }
	.tf-btn { padding: 6px 13px; border-radius: 7px; border: none; background: none; cursor: pointer; font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--text-3); letter-spacing: 0.06em; transition: all 0.15s; }
	.tf-btn:hover { color: var(--text); }
	.tf-btn.on { background: rgba(20,241,149,0.18); color: var(--green); box-shadow: inset 0 0 12px rgba(20,241,149,0.12); }
	.chip { padding: 6px 11px; border-radius: 8px; background: rgba(8,10,8,0.85); border: 1px solid var(--line); font-size: 10px; letter-spacing: 0.04em; color: var(--text); transition: border-color 0.2s; }
	.chip:hover { border-color: rgba(var(--gold-rgb), 0.3); }

	/* ── WALLS ─────────────────────────────────────────── */
	.wall { position: fixed; top: 96px; z-index: 10; animation: rise 0.6s 0.1s both; }
	.wall.left { left: 22px; text-align: left; }
	.wall.right { right: 22px; text-align: right; }
	.wall-kick { font-size: 10px; letter-spacing: 0.2em; opacity: 0.8; }
	.wall-v { font-size: 27px; font-weight: 800; text-shadow: 0 0 20px currentColor; font-variant-numeric: tabular-nums; }
	.wall-bar { width: 120px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.08); margin: 5px 0 3px; overflow: hidden; }
	.wall.right .wall-bar { margin-left: auto; }
	.wall-bar span { display: block; height: 100%; border-radius: 2px; transition: width 0.6s ease; }
	.wall-bar.buy span { background: linear-gradient(90deg, rgba(20,241,149,0.5), var(--green)); margin-left: auto; }
	.wall-bar.sell span { background: linear-gradient(90deg, var(--crimson), rgba(255,59,78,0.5)); }
	.wall-sub { font-size: 9px; letter-spacing: 0.08em; }

	/* ── PANEL SYSTEM ──────────────────────────────────── */
	.p-head { display: flex; justify-content: space-between; align-items: center; font-size: 9px; letter-spacing: 0.15em; color: var(--text-3); margin-bottom: 8px; }
	.p-head > span:first-child { color: var(--text-2); display: inline-flex; align-items: center; gap: 6px; }
	.p-glyph { font-style: normal; color: var(--gold); opacity: 0.9; }
	.panel-1 { animation: rise 0.5s 0.15s both; }
	.panel-2 { animation: rise 0.5s 0.25s both; }
	.panel-3 { animation: rise 0.5s 0.35s both; }
	/* gold targeting-corner brackets on the war-console panels */
	.panel-1, .panel-2, .panel-3 { position: relative; }
	.panel-1::before, .panel-2::before, .panel-3::before,
	.panel-1::after, .panel-2::after, .panel-3::after {
		content: ''; position: absolute; width: 11px; height: 11px; pointer-events: none;
		border: 1px solid rgba(var(--gold-rgb), 0.5);
	}
	.panel-1::before, .panel-2::before, .panel-3::before { top: -1px; left: -1px; border-right: none; border-bottom: none; border-top-left-radius: 11px; }
	.panel-1::after, .panel-2::after, .panel-3::after { bottom: -1px; right: -1px; border-left: none; border-top: none; border-bottom-right-radius: 11px; }

	/* ── LEDGER ────────────────────────────────────────── */
	.ledger { position: fixed; left: 22px; top: 178px; z-index: 10; width: 252px; padding: 11px 14px; }
	.ledger-row { display: flex; align-items: center; gap: 7px; font-size: 10px; padding: 3px 0; }
	.lg-rank { font-size: 9px; color: var(--text-3); width: 12px; flex-shrink: 0; }
	.lg-rank.first { color: var(--gold); text-shadow: 0 0 8px rgba(var(--gold-rgb), 0.5); }
	.ledger-w { width: 82px; flex-shrink: 0; }
	.ledger-w.green { color: #9affc4; } .ledger-w.red { color: #ffb0b8; }
	.ledger-tier { font-size: 8px; letter-spacing: 0.08em; width: 44px; flex-shrink: 0; }
	.lg-bar { flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.07); overflow: hidden; }
	.lg-bar span { display: block; height: 100%; background: rgba(20,241,149,0.6); border-radius: 2px; transition: width 0.5s ease; }
	.lg-bar span.red { background: rgba(255,77,94,0.6); }
	.ledger-k { font-weight: 700; color: #fff; min-width: 16px; text-align: right; }
	.ledger-foot { font-size: 9px; letter-spacing: 0.06em; margin-top: 7px; padding-top: 7px; border-top: 1px solid var(--line); display: flex; gap: 5px; flex-wrap: wrap; }

	/* ── ORDER BOOK ────────────────────────────────────── */
	.orderbook { position: fixed; left: 22px; bottom: 132px; z-index: 10; width: 260px; padding: 12px 14px; }
	.ob-chart { width: 100%; height: 64px; display: block; }
	.ob-split { display: flex; justify-content: space-between; font-size: 9px; font-weight: 700; letter-spacing: 0.08em; margin-top: 5px; }
	.ob-foot { display: flex; justify-content: space-between; font-size: 8px; letter-spacing: 0.1em; margin-top: 3px; color: var(--text-3); }

	/* ── FORCES ────────────────────────────────────────── */
	.forces { position: fixed; left: 22px; bottom: 22px; z-index: 10; width: 260px; padding: 11px 14px; display: flex; flex-direction: column; gap: 7px; }
	.power-bar { position: relative; height: 5px; border-radius: 3px; overflow: hidden; background: linear-gradient(90deg, rgba(255,59,78,0.45), rgba(255,59,78,0.25)); }
	.pb-bull { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, rgba(20,241,149,0.35), rgba(20,241,149,0.8)); transition: width 0.5s ease; }
	.force-head { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; display: flex; justify-content: space-between; }
	.force-n { color: #fff; }
	.force-comp { display: flex; gap: 10px; font-size: 10px; color: var(--text-2); margin-top: 3px; }
	.force-comp em { font-style: normal; font-size: 8px; letter-spacing: 0.08em; color: var(--text-3); }

	/* ── FEED ──────────────────────────────────────────── */
	.feed { position: fixed; right: 22px; bottom: 78px; z-index: 10; width: 352px; padding: 11px 12px; }
	.feed-rows { display: flex; flex-direction: column; gap: 4px; max-height: 38vh; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent); mask-image: linear-gradient(to bottom, #000 72%, transparent); }
	.feed-row { display: flex; align-items: center; gap: 9px; padding: 6px 9px; border-radius: 8px; border-left: 2px solid transparent; background: rgba(255,255,255,0.02); animation: slidein 0.3s both; }
	.feed-row.buy { border-left-color: var(--green); }
	.feed-row.sell { border-left-color: var(--crimson); }
	.feed-row.big { background: linear-gradient(90deg, rgba(var(--gold-rgb), 0.07), rgba(255,255,255,0.02)); box-shadow: 0 0 16px rgba(var(--gold-rgb), 0.1); }
	.feed-ic { flex-shrink: 0; width: 16px; text-align: center; font-size: 11px; color: var(--text-2); }
	.feed-row.buy .feed-ic { color: var(--green); } .feed-row.sell .feed-ic { color: var(--crimson); }
	.feed-row.big .feed-ic { color: var(--gold); text-shadow: 0 0 8px rgba(var(--gold-rgb), 0.6); }
	.feed-body { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
	.feed-text { font-size: 10px; color: var(--text); letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.feed-row.buy .feed-text { color: #9affc4; } .feed-row.sell .feed-text { color: #ffb0b8; }
	.feed-stamp { font-size: 7.5px; letter-spacing: 0.06em; }
	.feed-amt { font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; font-variant-numeric: tabular-nums; }
	.feed-row.big .feed-amt { color: var(--gold-hi); }

	/* ── TRACK ─────────────────────────────────────────── */
	.track { position: fixed; right: 22px; bottom: 22px; z-index: 10; width: 352px; padding: 10px 12px; }
	.track-row { display: flex; gap: 8px; }
	.track-row .input { flex: 1; }
	.btn-green { border-color: rgba(20,241,149,0.5); background: linear-gradient(120deg, rgba(20,241,149,0.2), rgba(20,241,149,0.06)); color: #9affc4; }
	.btn-green:hover { box-shadow: 0 0 18px rgba(20,241,149,0.25); }
	.track-live { display: flex; align-items: center; gap: 7px; font-size: 10px; flex-wrap: wrap; }
	.track-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); animation: blink 1.6s infinite; }
	.mini { font-family: var(--mono); font-size: 9px; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--line); background: rgba(255,255,255,0.03); color: var(--text-2); cursor: pointer; transition: all 0.15s; }
	.mini:hover { color: var(--text); }
	.mini.on { border-color: rgba(20,241,149,0.5); color: var(--green); }

	/* ── BOTTOM CONTROLS ───────────────────────────────── */
	.controls { position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 10; font-size: 9px; letter-spacing: 0.14em; display: flex; align-items: center; gap: 7px; padding: 7px 14px; border-radius: 999px; background: rgba(6,8,7,0.66); border: 1px solid var(--line-2); }
	.key { display: inline-block; border: 1px solid var(--line-2); border-radius: 4px; padding: 2px 6px; color: var(--text-2); background: rgba(255,255,255,0.03); }
	.sep { color: var(--text-3); }
	.fps { margin-left: 6px; color: var(--text-3); font-variant-numeric: tabular-nums; }
	.fps.low { color: var(--crimson); }
	.link { background: none; border: none; color: var(--green); cursor: pointer; font: inherit; letter-spacing: inherit; padding: 0; }
	.link:hover { text-shadow: 0 0 10px rgba(20,241,149,0.6); }

	@media (max-width: 1000px) {
		/* compact war-room: keep the essentials (price, walls, feed, track), drop the rest */
		.orderbook, .forces, .ledger, .controls, .cine { display: none; }
		.topbar { padding: 10px 12px; flex-wrap: wrap; }
		.brand, .top-right { width: auto; }
		.brand-sub, .brand-clock, .brand-rule { display: none; }
		.brand-mark { font-size: 16px; }
		.ticker { order: 3; width: 100%; margin-top: 6px; }
		.mcap-v { font-size: 26px; }
		.subline { font-size: 10px; gap: 8px; flex-wrap: wrap; }
		.frontbar { width: min(240px, 56vw); }
		.fm-side { min-width: 40px; font-size: 9px; }
		.tf-row .chip { display: none; }
		.top-right { gap: 6px; }
		.tally { padding: 6px 8px; font-size: 10px; }
		.icon-btn { padding: 6px 8px; }
		.wall { top: auto; bottom: calc(30vh + 118px); }
		.wall.left { left: 12px; } .wall.right { right: 12px; }
		.wall-v { font-size: 18px; }
		.wall-sub { display: none; }
		.wall-bar { width: 84px; }
		.feed { width: calc(100vw - 24px); right: 12px; bottom: 66px; }
		.feed-rows { max-height: 26vh; }
		.track { width: calc(100vw - 24px); right: 12px; bottom: 12px; }
	}
</style>
