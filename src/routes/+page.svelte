<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Battle, Stats, Overlay, BattleEvent } from '$lib/battle/engine';

	let canvas = $state<HTMLCanvasElement | null>(null);
	let battle: Battle | null = null;

	let stats = $state<Stats>({ bulls: 0, bears: 0, bullPower: 0, bearPower: 0, frontPct: 50, casualtiesBull: 0, casualtiesBear: 0, fps: 0 });
	let overlay = $state<Overlay>({ tracked: [], titans: [] });
	let token = $state<any>(null);
	let feed = $state<{ id: number; text: string; team: string; big: boolean }[]>([]);
	let booting = $state(true);

	let trackInput = $state('');
	let tracking = $state(false);
	let focus = $state(false);

	const seen = new Set<string>();
	let feedId = 1;
	let tradeTimer: any, tokenTimer: any;

	const mask = (a: string) => (a && a.length > 8 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '—');
	const fmtUsd = (n: number) => (n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'K' : '$' + n.toFixed(0));
	const fmtPrice = (n: number) => (n >= 1 ? '$' + n.toFixed(4) : '$' + n.toPrecision(3));
	const pctStr = (p: number) => (p >= 0.01 ? p.toFixed(2) + '%' : p.toFixed(3) + '%');

	// Live pressure from recent trades
	let buyUsd = $state(0), sellUsd = $state(0);
	const pressure = $derived(buyUsd + sellUsd > 0 ? (buyUsd / (buyUsd + sellUsd)) * 100 : 50);

	function pushFeed(text: string, team: string, big = false) {
		feed = [{ id: feedId++, text, team, big }, ...feed].slice(0, 14);
	}

	async function loadToken() {
		try {
			const r = await fetch('/api/token');
			if (r.ok) { token = await r.json(); battle?.setSupply(token.supply); }
		} catch {}
	}

	function pctOf(amount: number): number {
		return token?.supply ? (amount / token.supply) * 100 : 0.015;
	}

	async function loadTrades(seed = false) {
		try {
			const r = await fetch('/api/trades');
			const d = await r.json();
			const trades: any[] = d.trades || [];
			// window pressure over the visible tape
			let b = 0, s = 0;
			for (const t of trades.slice(0, 40)) (t.kind === 'buy' ? (b += t.usd) : (s += t.usd));
			buyUsd = b; sellUsd = s;

			// oldest → newest so the army builds in order
			const ordered = [...trades].reverse();
			for (const t of ordered) {
				if (seen.has(t.tx)) continue;
				seen.add(t.tx);
				const pct = pctOf(t.amount);
				battle?.spawn({ wallet: t.wallet, kind: t.kind, usd: t.usd, pct });
				if (!seed) {
					const tierBig = pct >= 0.25;
					pushFeed(`${mask(t.wallet)} ${t.kind === 'buy' ? 'BOUGHT' : 'SOLD'} ${pctStr(pct)} · ${fmtUsd(t.usd)}`, t.kind === 'buy' ? 'bull' : 'bear', tierBig);
				}
			}
		} catch {}
	}

	function doTrack() {
		const w = trackInput.trim();
		if (w.length < 32) { pushFeed('Enter a valid Solana wallet to track your unit.', 'bear'); return; }
		tracking = true;
		battle?.setTrackWallet(w);
		pushFeed(`Tracking ${mask(w)} — your warriors glow gold on the field.`, 'bull');
	}
	function stopTrack() {
		tracking = false; focus = false;
		battle?.setTrackWallet(null); battle?.setFocus(false);
	}
	function toggleFocus() { focus = !focus; battle?.setFocus(focus); }

	const trackedSummary = $derived.by(() => {
		const t = overlay.tracked;
		if (!t.length) return null;
		const kills = t.reduce((a, u) => a + u.kills, 0);
		const order = ['SOLDIER', 'ELITE', 'CHAMPION', 'TITAN', 'GOD', 'GARRISON'];
		const best = t.reduce((a, u) => (order.indexOf(u.tier) > order.indexOf(a) ? u.tier : a), 'SOLDIER');
		return { count: t.length, kills, best, team: t[0].team };
	});

	onMount(() => {
		let alive = true;
		(async () => {
			const { Battle } = await import('$lib/battle/engine');
			if (!alive || !canvas) return;
			battle = new Battle(canvas);
			battle.onStats = (s) => (stats = s);
			battle.onOverlay = (o) => (overlay = o);
			battle.onEvent = (e: BattleEvent) => {
				if (e.type === 'legend') pushFeed(`⚡ ${e.tier} DEPLOYED — ${mask(e.wallet)} moved ${pctStr(e.pct)}!`, e.team, true);
			};
			battle.start();

			await loadToken();
			// Garrison from real 24h buy/sell counts, then seed recent trades
			const g = (n: number) => Math.max(20, Math.min(150, Math.round(n)));
			battle.spawnGarrison(g(token?.buys24h ?? 80), g(token?.sells24h ?? 80));
			await loadTrades(true);
			booting = false;

			tradeTimer = setInterval(() => loadTrades(false), 5000);
			tokenTimer = setInterval(loadToken, 15000);
		})();

		return () => { alive = false; };
	});

	onDestroy(() => {
		clearInterval(tradeTimer); clearInterval(tokenTimer);
		battle?.dispose();
	});
</script>

<svelte:head><title>OSIRIS · War for the Duat</title></svelte:head>

<canvas bind:this={canvas} class="scene"></canvas>

<!-- battlefield unit labels -->
<div class="labels">
	{#each overlay.titans.slice(0, 10) as t}
		{#if t.on}<div class="titan-label" class:bear={t.team === 'bear'} style="left:{t.x}px;top:{t.y}px">{t.label}</div>{/if}
	{/each}
	{#each overlay.tracked.slice(0, 8) as u}
		{#if u.on}
			<div class="track-label" style="left:{u.x}px;top:{u.y}px">
				<div class="tl-tier">◆ {u.tier}</div>
				<div class="tl-hp"><span style="width:{(u.hp / u.maxHp) * 100}%"></span></div>
				{#if u.kills > 0}<div class="tl-kills">{u.kills} slain</div>{/if}
			</div>
		{/if}
	{/each}
</div>

{#if booting}
	<div class="boot">
		<div class="boot-eye display">𓂀</div>
		<div class="boot-title display">SUMMONING THE LEGIONS</div>
		<div class="boot-sub mono">Reading the on-chain battlefield…</div>
	</div>
{/if}

<!-- TOP BAR -->
<header class="topbar">
	<div class="brand">
		<span class="brand-mark display">☥ OSIRIS</span>
		<span class="brand-sub mono">WAR FOR THE DUAT</span>
	</div>
	<div class="price glass">
		{#if token}
			<span class="mono dim">$OSIRIS</span>
			<span class="mono p">{fmtPrice(token.priceUsd)}</span>
			<span class="mono" class:gold={token.change24h >= 0} class:crimson={token.change24h < 0}>{token.change24h >= 0 ? '+' : ''}{token.change24h.toFixed(2)}%</span>
			<span class="mono dim">·</span>
			<span class="live-dot"></span><span class="mono live">LIVE</span>
			<span class="mono dim">· {stats.fps}fps</span>
		{/if}
	</div>
</header>

<!-- WAR METER -->
<div class="war-meter glass">
	<div class="wm-labels mono">
		<span class="gold">⚔ LEGION OF OSIRIS · BUYS</span>
		<span class="crimson">SELLS · HORDE OF SET ⚔</span>
	</div>
	<div class="wm-bar">
		<div class="wm-buy" style="width:{pressure}%"></div>
		<div class="wm-front" style="left:{stats.frontPct}%" title="front line"></div>
	</div>
	<div class="wm-sub mono">
		<span class="gold">{stats.bulls} units · {fmtUsd(buyUsd)}</span>
		<span class="dim">FRONT LINE {stats.frontPct < 48 ? 'PUSHING SET ▶' : stats.frontPct > 52 ? '◀ OSIRIS FALLING BACK' : 'STALEMATE'}</span>
		<span class="crimson">{fmtUsd(sellUsd)} · {stats.bears} units</span>
	</div>
</div>

<!-- ARMY PANELS -->
<div class="army left glass">
	<div class="army-head gold display">LEGION OF OSIRIS</div>
	<div class="army-stat"><span class="mono dim">STANDING</span><span class="mono big gold">{stats.bulls}</span></div>
	<div class="army-stat"><span class="mono dim">FALLEN</span><span class="mono">{stats.casualtiesBull}</span></div>
	<div class="army-stat"><span class="mono dim">24H BUYS</span><span class="mono">{token?.buys24h ?? '—'}</span></div>
</div>
<div class="army right glass">
	<div class="army-head crimson display">HORDE OF SET</div>
	<div class="army-stat"><span class="mono dim">STANDING</span><span class="mono big crimson">{stats.bears}</span></div>
	<div class="army-stat"><span class="mono dim">FALLEN</span><span class="mono">{stats.casualtiesBear}</span></div>
	<div class="army-stat"><span class="mono dim">24H SELLS</span><span class="mono">{token?.sells24h ?? '—'}</span></div>
</div>

<!-- KILLFEED -->
<div class="feed">
	{#each feed as f (f.id)}
		<div class="feed-row glass" class:big={f.big} class:bull={f.team === 'bull'} class:bear={f.team === 'bear'}>
			<span class="feed-tag mono">{f.team === 'bull' ? '⬆' : '⬇'}</span>
			<span class="feed-text mono">{f.text}</span>
		</div>
	{/each}
</div>

<!-- TRACK YOUR UNIT -->
<div class="track glass">
	<div class="track-head mono"><span class="gold">◆</span> TRACK YOUR UNIT</div>
	{#if !tracking}
		<div class="track-row">
			<input class="input" bind:value={trackInput} placeholder="Your Solana wallet…" onkeydown={(e) => e.key === 'Enter' && doTrack()} />
			<button class="btn btn-gold" onclick={doTrack}>TRACK</button>
		</div>
		<div class="track-hint mono dim">Enter your wallet to find your warriors on the field.</div>
	{:else}
		<div class="track-live">
			{#if trackedSummary}
				<div class="ts-row"><span class="mono dim">UNITS ON FIELD</span><span class="mono gold big">{trackedSummary.count}</span></div>
				<div class="ts-row"><span class="mono dim">HIGHEST RANK</span><span class="mono">{trackedSummary.best}</span></div>
				<div class="ts-row"><span class="mono dim">ENEMIES SLAIN</span><span class="mono crimson">{trackedSummary.kills}</span></div>
			{:else}
				<div class="ts-empty mono dim">No living units for this wallet right now. Buy or sell to deploy one ⚔</div>
			{/if}
			<div class="track-actions">
				<button class="btn" class:btn-gold={focus} onclick={toggleFocus}>{focus ? '◉ FOLLOWING' : '⤢ FOLLOW CAM'}</button>
				<button class="btn" onclick={stopTrack}>✕ STOP</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.scene { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; z-index: 0; }
	.labels { position: fixed; inset: 0; z-index: 5; pointer-events: none; }

	.titan-label { position: absolute; transform: translate(-50%, -100%); font-family: var(--display); font-size: 13px; font-weight: 800;
		color: var(--gold-hi); text-shadow: 0 0 10px rgba(var(--gold-rgb),0.8), 0 2px 4px #000; letter-spacing: 0.1em; white-space: nowrap; }
	.titan-label.bear { color: #ff9aa6; text-shadow: 0 0 10px rgba(var(--crimson-rgb),0.8), 0 2px 4px #000; }

	.track-label { position: absolute; transform: translate(-50%, -100%); text-align: center; white-space: nowrap; }
	.tl-tier { font-family: var(--mono); font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 0 8px var(--gold), 0 2px 3px #000; }
	.tl-hp { width: 46px; height: 4px; border-radius: 3px; background: rgba(0,0,0,0.6); margin: 3px auto 0; overflow: hidden; border: 1px solid rgba(var(--gold-rgb),0.5); }
	.tl-hp span { display: block; height: 100%; background: var(--gold); }
	.tl-kills { font-family: var(--mono); font-size: 8px; color: var(--gold-hi); margin-top: 2px; text-shadow: 0 1px 2px #000; }

	.boot { position: fixed; inset: 0; z-index: 40; background: var(--bg); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
	.boot-eye { font-size: 60px; color: var(--gold); animation: glow 2s infinite; }
	.boot-title { font-size: 26px; font-weight: 800; letter-spacing: 0.2em; color: #fff; }
	.boot-sub { font-size: 11px; letter-spacing: 0.2em; color: var(--gold); }

	.topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; padding: 18px 22px; pointer-events: none; }
	.brand { display: flex; flex-direction: column; }
	.brand-mark { font-size: 22px; font-weight: 800; color: var(--gold); letter-spacing: 0.08em; text-shadow: 0 0 20px rgba(var(--gold-rgb),0.4); }
	.brand-sub { font-size: 8px; letter-spacing: 0.4em; color: var(--text-3); margin-top: 2px; }
	.price { display: flex; align-items: center; gap: 12px; padding: 11px 18px; pointer-events: auto; }
	.price .p { font-size: 15px; font-weight: 700; color: #fff; }
	.price .live { color: var(--crimson); font-size: 10px; letter-spacing: 0.1em; }

	.war-meter { position: fixed; top: 62px; left: 50%; transform: translateX(-50%); z-index: 10; width: min(620px, 90vw); padding: 12px 18px; }
	.wm-labels { display: flex; justify-content: space-between; font-size: 9px; letter-spacing: 0.08em; margin-bottom: 8px; }
	.wm-bar { position: relative; height: 14px; border-radius: 8px; overflow: hidden; background: linear-gradient(90deg, rgba(var(--crimson-rgb),0.35), rgba(var(--crimson-rgb),0.55)); }
	.wm-buy { height: 100%; background: linear-gradient(90deg, rgba(var(--gold-rgb),0.65), var(--gold)); box-shadow: 0 0 16px rgba(var(--gold-rgb),0.5); transition: width 0.8s cubic-bezier(0.16,1,0.3,1); }
	.wm-front { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #fff; box-shadow: 0 0 10px #fff; transition: left 0.8s cubic-bezier(0.16,1,0.3,1); }
	.wm-sub { display: flex; justify-content: space-between; font-size: 9px; margin-top: 8px; letter-spacing: 0.05em; }

	.army { position: fixed; top: 150px; z-index: 10; width: 168px; padding: 14px 16px; }
	.army.left { left: 22px; animation: slidein 0.6s both; }
	.army.right { right: 22px; animation: slidein 0.6s both; }
	.army-head { font-size: 13px; font-weight: 800; letter-spacing: 0.08em; margin-bottom: 12px; }
	.army-stat { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--line); }
	.army-stat .mono { font-size: 12px; }
	.army-stat .dim { font-size: 9px; letter-spacing: 0.1em; }
	.army-stat .big { font-size: 22px; font-weight: 700; }

	.feed { position: fixed; bottom: 18px; left: 22px; z-index: 10; width: 340px; display: flex; flex-direction: column-reverse; gap: 6px; max-height: 46vh; }
	.feed-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; animation: slidein 0.35s both; border-left: 2px solid transparent; }
	.feed-row.bull { border-left-color: var(--gold); }
	.feed-row.bear { border-left-color: var(--crimson); }
	.feed-row.big { box-shadow: 0 0 24px rgba(var(--gold-rgb),0.25); }
	.feed-tag { font-size: 12px; }
	.feed-row.bull .feed-tag { color: var(--gold); }
	.feed-row.bear .feed-tag { color: var(--crimson); }
	.feed-text { font-size: 10px; color: var(--text); letter-spacing: 0.02em; }

	.track { position: fixed; bottom: 18px; right: 22px; z-index: 10; width: 300px; padding: 16px; }
	.track-head { font-size: 11px; letter-spacing: 0.12em; color: #fff; margin-bottom: 12px; }
	.track-row { display: flex; gap: 8px; }
	.track-row .input { flex: 1; }
	.track-hint { font-size: 9px; margin-top: 8px; line-height: 1.5; }
	.ts-row { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--line); }
	.ts-row .dim { font-size: 9px; letter-spacing: 0.1em; }
	.ts-row .mono { font-size: 12px; }
	.ts-row .big { font-size: 20px; font-weight: 700; }
	.ts-empty { font-size: 9px; line-height: 1.6; padding: 8px 0; }
	.track-actions { display: flex; gap: 8px; margin-top: 12px; }
	.track-actions .btn { flex: 1; text-align: center; }

	@media (max-width: 760px) {
		.army, .track { display: none; }
		.feed { width: calc(100vw - 44px); max-height: 30vh; }
		.war-meter { top: 58px; }
	}
</style>
