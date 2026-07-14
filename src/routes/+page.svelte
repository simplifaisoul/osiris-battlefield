<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Battle, Stats, Overlay, BattleEvent, Comp } from '$lib/battle/engine';
	import type { WarAudio } from '$lib/battle/audio';

	let canvas = $state<HTMLCanvasElement | null>(null);
	let battle: Battle | null = null;
	let audio: WarAudio | null = null;

	const EMPTY_COMP: Comp = { spear: 0, ronin: 0, archer: 0, colossus: 0 };
	const EMPTY: Stats = {
		bulls: 0, bears: 0, bullPower: 0, bearPower: 0, frontPct: 50, casualtiesBull: 0, casualtiesBear: 0,
		fps: 0, round: 1, winBull: 0, winBear: 0, phase: 'battle', winner: null, totalKills: 0,
		biggestWhaleUsd: 0, biggestWhaleWallet: '', commanders: [], bullComp: { ...EMPTY_COMP }, bearComp: { ...EMPTY_COMP }
	};
	let stats = $state<Stats>({ ...EMPTY });
	let overlay = $state<Overlay>({ tracked: [], titans: [], kills: [] });
	let token = $state<any>(null);
	let feed = $state<{ id: number; text: string; side: string; amt: string; big: boolean; stamp: string }[]>([]);

	let entered = $state(false);
	let ready = $state(false);
	let muted = $state(false);
	let flashId = $state(0);
	function doFlash() { flashId++; }

	let trackInput = $state('');
	let tracking = $state(false);
	let focus = $state(false);

	const seen = new Set<string>();
	let feedId = 1;
	let tradeTimer: any, tokenTimer: any, clashTimer: any, bannerTimer: any, clockTimer: any;
	function tick() { clock = new Date().toISOString().slice(11, 19); }

	const mask = (a: string) => (a && a.length > 8 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '—');
	const fmtUsd = (n: number) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'K' : '$' + n.toFixed(0));
	const fmtPrice = (n: number) => (n >= 1 ? '$' + n.toFixed(4) : '$' + n.toPrecision(3));
	const pctStr = (p: number) => (p >= 0.01 ? p.toFixed(2) + '%' : p.toFixed(3) + '%');

	let clock = $state('');
	let buyUsd = $state(0), sellUsd = $state(0);

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
		const scale = 30; // battle-time amplification
		const rate = (n: number) => Math.min(1.0, Math.max(0.08, (n / TF_SECS[tf]) * scale));
		battle?.setReinforceRates(rate(win.buys), rate(win.sells));
	}
	function setTf(next: TF) { tf = next; applyTf(); }
	const pressure = $derived(buyUsd + sellUsd > 0 ? (buyUsd / (buyUsd + sellUsd)) * 100 : 50);
	const marketPressure = $derived(
		stats.frontPct < 45 ? { t: 'BUYERS ADVANCING', c: 'green' } :
		stats.frontPct > 55 ? { t: 'SELLERS ADVANCING', c: 'red' } : { t: 'MARKET BALANCED', c: 'dim' }
	);

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

	function pushFeed(text: string, side: string, amt: string, big = false, ts?: number) {
		const stamp = new Date((ts ?? Date.now() / 1000) * 1000).toISOString().slice(11, 19);
		feed = [{ id: feedId++, text, side, amt, big, stamp }, ...feed].slice(0, 16);
	}

	async function loadToken() {
		try {
			const r = await fetch('/api/token');
			if (r.ok) {
				token = await r.json();
				battle?.setSupply(token.supply);
				battle?.setPriceLabel(fmtPrice(token.priceUsd), '$OSIRIS · CURRENT PRICE');
				document.title = `${fmtUsd(token.marketCap)} · $OSIRIS Battlefield`;
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
			for (const t of [...trades].reverse()) {
				if (seen.has(t.tx)) continue;
				seen.add(t.tx);
				const pct = pctOf(t.amount);
				battle?.spawn({ wallet: t.wallet, kind: t.kind, usd: t.usd, pct });
				if (!seed) {
					const whale = pct >= 0.25, large = t.usd >= 300;
					const price = token?.priceUsd ? fmtPrice(token.priceUsd) : '';
					let label: string;
					if (t.kind === 'buy') label = whale ? `LIQUIDATED SHORT @ ${price}` : large ? 'LARGE BUY TRADE' : '▲ MARKET BUY';
					else label = whale ? `LIQUIDATED LONG @ ${price}` : large ? 'LARGE SELL TRADE' : '▼ MARKET SELL';
					const tag = t.kind === 'buy' ? `+1 LONG · ${pctStr(pct)}` : `+1 SHORT · ${pctStr(pct)}`;
					pushFeed(`${label}  ·  ${tag}`, t.kind === 'buy' ? 'buy' : 'sell', fmtUsd(t.usd), whale || large, t.ts);
				}
			}
		} catch {}
	}

	function doTrack() {
		const w = trackInput.trim();
		if (w.length < 32) { pushFeed('Enter a valid Solana wallet to track your position.', 'sell', ''); return; }
		tracking = true; battle?.setTrackWallet(w);
		pushFeed(`TRACKING ${mask(w)} — your units marked on the field.`, 'buy', '');
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

	async function enter() {
		entered = true;
		const { WarAudio } = await import('$lib/battle/audio');
		audio = new WarAudio(); audio.start(); audio.setMuted(muted);
	}

	onMount(() => {
		let alive = true;
		(async () => {
			const { Battle } = await import('$lib/battle/engine');
			if (!alive || !canvas) return;
			battle = new Battle(canvas);
			battle.onStats = (s) => (stats = s);
			battle.onOverlay = (o) => (overlay = o);
			battle.onEvent = (e: BattleEvent) => {
				if (e.type === 'legend') {
					const c = e.cls === 'colossus' ? 'TANK' : e.cls.toUpperCase();
					pushFeed(`⚡ ${e.tier} ${c} ROLLS OUT — ${mask(e.wallet)} moved ${pctStr(e.pct)}`, e.team === 'bull' ? 'buy' : 'sell', fmtUsd(e.usd), true);
					audio?.horn(!!e.god); if (e.god) doFlash();
				}
			};
			battle.start();

			await loadToken();
			const g = (n: number) => Math.max(24, Math.min(100, Math.round(n * 0.75)));
			battle.spawnGarrison(g(token?.buys24h ?? 80), g(token?.sells24h ?? 80));
			await loadTrades(true);
			ready = true;

			tick(); clockTimer = setInterval(tick, 1000);
			tradeTimer = setInterval(() => loadTrades(false), 5000);
			tokenTimer = setInterval(loadToken, 15000);
			clashTimer = setInterval(() => {
				if (!audio || muted || stats.phase !== 'battle') return;
				if (stats.bulls > 0 && stats.bears > 0 && Math.random() < 0.7) audio.clash(0.2 + Math.min(1, Math.min(stats.bulls, stats.bears) / 110) * 0.8);
			}, 360);
		})();
		return () => { alive = false; };
	});

	onDestroy(() => { clearInterval(tradeTimer); clearInterval(tokenTimer); clearInterval(clashTimer); clearInterval(clockTimer); clearTimeout(bannerTimer); audio?.dispose(); battle?.dispose(); });
</script>

<svelte:head><title>OSIRIS · Market Battlefield</title></svelte:head>

<canvas bind:this={canvas} class="scene"></canvas>

<div class="labels">
	{#each overlay.titans.slice(0, 10) as t}
		{#if t.on}<div class="titan-label" class:bear={t.team === 'bear'} style="left:{t.x}px;top:{t.y}px">{t.label}</div>{/if}
	{/each}
	{#each overlay.tracked.slice(0, 8) as u}
		{#if u.on}
			<div class="track-label" style="left:{u.x}px;top:{u.y}px">
				<div class="tl-tier">◆ {u.tier}</div>
				<div class="tl-hp"><span style="width:{(u.hp / u.maxHp) * 100}%"></span></div>
			</div>
		{/if}
	{/each}
	{#each overlay.kills.slice(0, 20) as k}
		{#if k.on}
			<div class="kill-marker mono" class:bear={k.team === 'bear'} style="left:{k.x}px;top:{k.y}px;opacity:{1 - k.age}">
				💀 {k.team === 'bull' ? '-1 LONG' : '-1 SHORT'}
			</div>
		{/if}
	{/each}
</div>

{#key flashId}{#if flashId > 0}<div class="flash"></div>{/if}{/key}

{#if !entered}
	<div class="intro">
		<div class="intro-inner">
			<div class="intro-eye display">𓂀</div>
			<h1 class="intro-title display">OSIRIS <span class="green">MARKET</span> BATTLEFIELD</h1>
			<div class="intro-tag mono">$OSIRIS · BUYS vs SELLS · LIVE ON-CHAIN WARFARE</div>
			<p class="intro-lore">
				Every <span class="green">buy</span> deploys a soldier for the <span class="green">bulls</span>;
				every <span class="red">sell</span> reinforces the <span class="red">bears</span>.
				Bigger orders field mightier units — spearmen hold the line, ronin strike, archers rain fire,
				and whales summon <span class="green">colossus</span> war-gods. Watch the order flow fight it out in real time.
			</p>
			<button class="enter-btn" onclick={enter} disabled={!ready}>{ready ? '⚔  ENTER THE BATTLEFIELD' : 'LOADING ORDER FLOW…'}</button>
			<div class="intro-hint mono">W A S D pan · scroll zoom · drag orbit · sound on</div>
		</div>
	</div>
{/if}

<!-- TOP: MARKET CAP + PRICE + PRESSURE -->
<header class="topbar">
	<div class="brand">
		<span class="brand-mark display">☥ OSIRIS</span>
		<span class="brand-sub mono">MARKET BATTLEFIELD</span>
		<span class="brand-clock mono">UTC {clock}</span>
	</div>
	<div class="ticker">
		{#if token}
			<div class="mcap">
				<span class="kick mono">$OSIRIS MARKET CAP · AGGREGATED SPOT</span>
				<span class="mcap-v mono">{fmtUsd(token.marketCap)}</span>
			</div>
			<div class="subline mono">
				<span class="price">{fmtPrice(token.priceUsd)}</span>
				<span class:green={win.chg >= 0} class:red={win.chg < 0}>{win.chg >= 0 ? '+' : ''}{win.chg.toFixed(2)}% {TF_LABEL[tf]}</span>
				<span class="dim">·</span>
				<span class="pressure {marketPressure.c}">MARKET PRESSURE: {marketPressure.t}</span>
				<span class="live-dot"></span><span class="red mono">LIVE</span>
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
		<div class="tally glass mono"><span class="green">{Math.round(stats.frontPct)}%</span><span class="dim">HILL</span><span class="red">{Math.round(100 - stats.frontPct)}%</span></div>
		<button class="icon-btn glass" onclick={toggleSound}>{muted ? '🔇' : '🔊'}</button>
	</div>
</header>

<!-- SELL WALL (left) -->
<div class="wall left">
	<div class="wall-kick mono red">SELL WALL · {TF_LABEL[tf]}</div>
	<div class="wall-v mono red">{fmtUsd(win.sellVol)}</div>
	<div class="wall-sub mono dim">TAPE {fmtUsd(sellUsd)}</div>
</div>

<!-- BUY WALL (right) -->
<div class="wall right">
	<div class="wall-kick mono green">BUY WALL · {TF_LABEL[tf]}</div>
	<div class="wall-v mono green">{fmtUsd(win.buyVol)}</div>
	<div class="wall-sub mono dim">TAPE {fmtUsd(buyUsd)}</div>
</div>

<!-- ORDER BOOK DEPTH (bottom-left) -->
<div class="orderbook glass">
	<div class="ob-head mono"><span class="dim">ORDER BOOK DEPTH</span><span class="dim">AGGREGATED SPOT</span></div>
	<svg viewBox="0 0 100 64" class="ob-chart" preserveAspectRatio="none">
		<polyline points="0,64 {depth.bid} 48,64" fill="rgba(20,241,149,0.16)" stroke="var(--green)" stroke-width="0.8" />
		<polyline points="100,64 {depth.ask} 52,64" fill="rgba(255,77,94,0.16)" stroke="var(--crimson)" stroke-width="0.8" />
		<line x1="50" y1="0" x2="50" y2="64" stroke="rgba(255,255,255,0.25)" stroke-width="0.4" stroke-dasharray="1 1.5" />
	</svg>
	<div class="ob-foot mono">
		<span class="green">{token ? fmtPrice(token.priceUsd * 0.982).replace('$', '') : 'BID'}</span>
		<span class="dim">{token ? fmtPrice(token.priceUsd) : '—'}</span>
		<span class="red">{token ? fmtPrice(token.priceUsd * 1.018).replace('$', '') : 'ASK'}</span>
	</div>
</div>

<!-- ORDER FLOW ARMIES (bottom-left, above track) -->
<div class="forces glass">
	<div class="force">
		<div class="force-head green mono">◤ BULLS · LONGS <span class="force-n">{stats.bulls}</span></div>
		<div class="force-comp mono"><span>🛡 {stats.bullComp.spear}</span><span>🗡 {stats.bullComp.ronin}</span><span>🏹 {stats.bullComp.archer}</span><span>💥 {stats.bullComp.colossus} TANKS</span></div>
	</div>
	<div class="force">
		<div class="force-head red mono">BEARS · SHORTS ◥ <span class="force-n">{stats.bears}</span></div>
		<div class="force-comp mono"><span>🛡 {stats.bearComp.spear}</span><span>🗡 {stats.bearComp.ronin}</span><span>🏹 {stats.bearComp.archer}</span><span>💥 {stats.bearComp.colossus} TANKS</span></div>
	</div>
</div>

<!-- MARKET FEED (bottom-right) -->
<div class="feed glass">
	<div class="feed-head mono"><span>MARKET FEED</span><span class="green">● LIVE</span></div>
	<div class="feed-rows">
		{#each feed as f (f.id)}
			<div class="feed-row" class:big={f.big} class:buy={f.side === 'buy'} class:sell={f.side === 'sell'}>
				<span class="feed-stamp mono dim">{f.stamp}</span>
				<span class="feed-text mono">{f.text}</span>
				{#if f.amt}<span class="feed-src mono">PSWAP</span><span class="feed-amt mono">{f.amt}</span>{/if}
			</div>
		{/each}
	</div>
</div>

<!-- TRACK POSITION (bottom-right, below feed) -->
<div class="track glass">
	{#if !tracking}
		<div class="track-row">
			<input class="input" bind:value={trackInput} placeholder="Track your wallet…" onkeydown={(e) => e.key === 'Enter' && doTrack()} />
			<button class="btn btn-green" onclick={doTrack}>TRACK</button>
		</div>
	{:else}
		<div class="track-live mono">
			{#if trackedSummary}
				<span class="dim">YOUR UNITS</span> <span class="green">{trackedSummary.count}</span>
				<span class="dim">· RANK</span> <span>{trackedSummary.best}</span>
				<span class="dim">· SLAIN</span> <span class="red">{trackedSummary.kills}</span>
			{:else}<span class="dim">No live units — trade to deploy ⚔</span>{/if}
			<button class="mini" class:on={focus} onclick={toggleFocus}>{focus ? '◉ FOLLOW' : '⤢ FOLLOW'}</button>
			<button class="mini" onclick={stopTrack}>✕</button>
		</div>
	{/if}
</div>

<div class="controls mono dim">
	<span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> PAN · <span class="key">SCROLL</span> ZOOM · DRAG ORBIT · <button class="link" onclick={resetCam}>RESET</button>
</div>

<style>
	.scene { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; z-index: 0; touch-action: none; }
	.labels { position: fixed; inset: 0; z-index: 5; pointer-events: none; }
	.titan-label { position: absolute; transform: translate(-50%, -100%); font-family: var(--display); font-size: 12px; font-weight: 800; color: #7dffb0; text-shadow: 0 0 10px rgba(20,241,149,0.8), 0 2px 4px #000; white-space: nowrap; }
	.titan-label.bear { color: #ff9aa6; text-shadow: 0 0 10px rgba(255,77,94,0.8), 0 2px 4px #000; }
	.track-label { position: absolute; transform: translate(-50%, -100%); text-align: center; white-space: nowrap; }
	.tl-tier { font-family: var(--mono); font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 0 8px var(--green), 0 2px 3px #000; }
	.tl-hp { width: 44px; height: 4px; border-radius: 3px; background: rgba(0,0,0,0.6); margin: 3px auto 0; overflow: hidden; border: 1px solid rgba(20,241,149,0.5); }
	.tl-hp span { display: block; height: 100%; background: var(--green); }

	.kill-marker { position: absolute; transform: translate(-50%, -100%); font-size: 11px; font-weight: 700; color: #baffd6; letter-spacing: 0.04em; text-shadow: 0 0 8px rgba(20,241,149,0.7), 0 2px 3px #000; white-space: nowrap; }
	.kill-marker.bear { color: #ffc2c8; text-shadow: 0 0 8px rgba(255,77,94,0.7), 0 2px 3px #000; }
	.feed-src { font-size: 8px; letter-spacing: 0.08em; color: var(--text-3); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; flex-shrink: 0; }

	.flash { position: fixed; inset: 0; z-index: 58; pointer-events: none; background: radial-gradient(circle at 50% 45%, rgba(255,255,255,0.6), rgba(200,255,220,0.2) 60%, transparent 100%); animation: flashfade 0.65s ease-out forwards; }
	@keyframes flashfade { from { opacity: 1; } to { opacity: 0; } }

	.intro { position: fixed; inset: 0; z-index: 60; background: radial-gradient(circle at 50% 40%, rgba(14,20,12,0.7), rgba(4,6,4,0.96)); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; animation: rise 0.5s both; }
	.intro-inner { text-align: center; max-width: 580px; padding: 30px; }
	.intro-eye { font-size: 66px; color: var(--green); text-shadow: 0 0 40px rgba(20,241,149,0.5); }
	.intro-title { font-size: 44px; font-weight: 900; letter-spacing: 0.04em; margin: 12px 0 10px; color: #fff; }
	.intro-tag { font-size: 11px; letter-spacing: 0.28em; color: var(--green); margin-bottom: 22px; }
	.intro-lore { font-size: 14px; line-height: 1.9; color: var(--text-2); margin-bottom: 30px; }
	.enter-btn { font-family: var(--mono); font-size: 15px; font-weight: 700; letter-spacing: 0.12em; padding: 16px 38px; border-radius: 12px; cursor: pointer; color: #05130b; border: none; background: linear-gradient(120deg, #5effa0, var(--green)); box-shadow: 0 0 40px rgba(20,241,149,0.4); transition: transform 0.2s; }
	.enter-btn:hover:not(:disabled) { transform: translateY(-2px) scale(1.02); }
	.enter-btn:disabled { opacity: 0.5; cursor: wait; background: rgba(255,255,255,0.1); color: var(--text-2); box-shadow: none; }
	.intro-hint { margin-top: 20px; font-size: 9px; letter-spacing: 0.22em; color: var(--text-3); }

	.topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 10; display: flex; align-items: flex-start; justify-content: space-between; padding: 16px 22px; pointer-events: none; }
	.brand { display: flex; flex-direction: column; width: 200px; }
	.brand-mark { font-size: 20px; font-weight: 800; color: var(--green); letter-spacing: 0.08em; text-shadow: 0 0 20px rgba(20,241,149,0.4); }
	.brand-sub { font-size: 8px; letter-spacing: 0.36em; color: var(--text-3); margin-top: 2px; }
	.brand-clock { font-size: 10px; letter-spacing: 0.1em; color: var(--text-2); margin-top: 5px; }
	.ticker { text-align: center; }
	.mcap { display: flex; flex-direction: column; align-items: center; }
	.mcap .kick { font-size: 9px; letter-spacing: 0.2em; color: var(--text-3); }
	.mcap-v { font-size: 40px; font-weight: 800; color: #fff; line-height: 1.05; text-shadow: 0 2px 20px rgba(0,0,0,0.6); }
	.subline { display: flex; align-items: center; justify-content: center; gap: 12px; font-size: 12px; margin-top: 4px; }
	.subline .price { color: #fff; font-weight: 700; }
	.pressure { font-weight: 700; letter-spacing: 0.05em; }
	.pressure.green { color: var(--green); } .pressure.red { color: var(--crimson); } .pressure.dim { color: var(--text-2); }
	.top-right { display: flex; align-items: center; gap: 10px; pointer-events: auto; width: 200px; justify-content: flex-end; }
	.tally { display: flex; gap: 6px; padding: 10px 12px; font-size: 12px; font-weight: 700; }
	.icon-btn { padding: 9px 12px; cursor: pointer; border: 1px solid var(--line); font-size: 14px; color: var(--text); }

	.tf-row { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 8px; pointer-events: auto; }
	.tf-toggle { display: flex; gap: 3px; padding: 3px; border-radius: 9px; background: rgba(8,10,8,0.55); border: 1px solid var(--line); backdrop-filter: blur(10px); }
	.tf-btn { padding: 6px 13px; border-radius: 7px; border: none; background: none; cursor: pointer; font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--text-3); letter-spacing: 0.06em; transition: all 0.15s; }
	.tf-btn:hover { color: var(--text); }
	.tf-btn.on { background: rgba(20,241,149,0.18); color: var(--green); }
	.chip { padding: 6px 11px; border-radius: 8px; background: rgba(8,10,8,0.55); border: 1px solid var(--line); font-size: 10px; letter-spacing: 0.04em; color: var(--text); backdrop-filter: blur(10px); }

	.wall { position: fixed; top: 92px; z-index: 10; }
	.wall-sub { font-size: 9px; letter-spacing: 0.08em; margin-top: 2px; }
	.wall.left { left: 22px; text-align: left; }
	.wall.right { right: 22px; text-align: right; }
	.wall-kick { font-size: 10px; letter-spacing: 0.2em; opacity: 0.8; }
	.wall-v { font-size: 26px; font-weight: 800; text-shadow: 0 0 20px currentColor; }

	.orderbook { position: fixed; left: 22px; bottom: 118px; z-index: 10; width: 260px; padding: 12px 14px; }
	.ob-head { display: flex; justify-content: space-between; font-size: 8px; letter-spacing: 0.12em; margin-bottom: 8px; }
	.ob-chart { width: 100%; height: 72px; display: block; }
	.ob-foot { display: flex; justify-content: space-between; font-size: 8px; letter-spacing: 0.1em; margin-top: 6px; }

	.forces { position: fixed; left: 22px; bottom: 60px; z-index: 10; width: 260px; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }
	.force-head { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; display: flex; justify-content: space-between; }
	.force-n { color: #fff; }
	.force-comp { display: flex; gap: 12px; font-size: 10px; color: var(--text-2); margin-top: 3px; }

	.feed { position: fixed; right: 22px; bottom: 66px; z-index: 10; width: 340px; padding: 10px 12px; }
	.feed-head { display: flex; justify-content: space-between; font-size: 9px; letter-spacing: 0.15em; color: var(--text-3); margin-bottom: 8px; }
	.feed-rows { display: flex; flex-direction: column; gap: 4px; max-height: 40vh; overflow: hidden; }
	.feed-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 10px; border-radius: 8px; border-left: 2px solid transparent; background: rgba(255,255,255,0.02); animation: slidein 0.3s both; }
	.feed-row.buy { border-left-color: var(--green); }
	.feed-row.sell { border-left-color: var(--crimson); }
	.feed-row.big { box-shadow: 0 0 18px rgba(20,241,149,0.16); }
	.feed-stamp { font-size: 8px; letter-spacing: 0.03em; flex-shrink: 0; }
	.feed-text { font-size: 10px; color: var(--text); letter-spacing: 0.02em; flex: 1; }
	.feed-row.buy .feed-text { color: #9affc4; } .feed-row.sell .feed-text { color: #ffb0b8; }
	.feed-amt { font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; }

	.track { position: fixed; right: 22px; bottom: 22px; z-index: 10; width: 340px; padding: 10px 12px; }
	.track-row { display: flex; gap: 8px; }
	.track-row .input { flex: 1; }
	.btn-green { border-color: rgba(20,241,149,0.5); background: linear-gradient(120deg, rgba(20,241,149,0.2), rgba(20,241,149,0.06)); color: #9affc4; }
	.track-live { display: flex; align-items: center; gap: 7px; font-size: 10px; flex-wrap: wrap; }
	.mini { font-family: var(--mono); font-size: 9px; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--line); background: rgba(255,255,255,0.03); color: var(--text-2); cursor: pointer; }
	.mini.on { border-color: rgba(20,241,149,0.5); color: var(--green); }

	.controls { position: fixed; bottom: 8px; left: 50%; transform: translateX(-50%); z-index: 10; font-size: 9px; letter-spacing: 0.14em; display: flex; align-items: center; gap: 6px; }
	.key { display: inline-block; border: 1px solid var(--line-2); border-radius: 4px; padding: 2px 6px; color: var(--text-2); }
	.link { background: none; border: none; color: var(--green); cursor: pointer; font: inherit; letter-spacing: inherit; padding: 0; }

	@media (max-width: 1000px) {
		.orderbook, .forces, .track { display: none; }
		.feed { width: calc(100vw - 44px); bottom: 40px; }
		.mcap-v { font-size: 30px; }
		.brand, .top-right { width: auto; }
	}
</style>
