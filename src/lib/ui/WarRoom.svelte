<script lang="ts">
	// The War Room: every unit on the field is somebody. On $OSIRIS the Bulls are
	// the wallets still holding and the Bears the ones that sold out, each with a
	// service record read from the chain; on SOL the squads are the whale orders
	// that sent them. Pick a unit on the field (or a row here) to open its dossier.

	import type { HolderIntel, Holder } from '$lib/market/holders';
	import { rankFor, insignia, statusFor, duration, shortDate } from '$lib/market/holders';
	import type { Selected } from '$lib/battle/engine';
	import { usd, grouped, shortAddr } from '$lib/market/format';

	export type Order = { key: string; side: 'buy' | 'sell'; usd: number; venue: string; ts: number; front: number };
	type Record = { soldiers: number; tanks: number; kills: number; deaths: number } | null;

	let {
		theaterId,
		intel,
		tick,
		orders,
		focus,
		selected,
		record,
		price,
		fmtFront,
		tracked,
		following,
		open = $bindable(true),
		onFocus,
		onTrack,
		onFollow,
		onClose
	}: {
		theaterId: 'osiris' | 'sol';
		intel: HolderIntel | null;
		tick: number;
		orders: Order[];
		focus: string | null;
		selected: Selected | null;
		record: Record;
		price: number;
		fmtFront: (v: number) => string;
		tracked: string | null;
		following: boolean;
		open?: boolean;
		onFocus: (wallet: string) => void;
		onTrack: (wallet: string | null) => void;
		onFollow: (on: boolean) => void;
		onClose: () => void;
	} = $props();

	let tab = $state<'holders' | 'exited'>('holders');
	let query = $state('');
	let limit = $state(120);
	const now = () => Date.now();
	const isAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
	const tokens = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0));
	const pctStr = (p: number) => (p >= 0.1 ? p.toFixed(2) : p >= 0.01 ? p.toFixed(3) : p.toFixed(4)) + '%';
	const delta = (from: number | null | undefined) => (from && price ? (price / from - 1) * 100 : null);
	const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

	const orderOf = (key: string | null) => (key ? orders.find((o) => o.key === key) : undefined);

	// the dossier for whoever is in focus
	const dossier = $derived.by(() => {
		void tick;
		if (!focus) return null;
		if (focus.startsWith('order#')) return { kind: 'order' as const, order: orderOf(focus) };
		const i = intel?.get(focus);
		const h = intel?.holderOf(focus);
		const tape = intel?.tape.get(focus);
		return { kind: 'wallet' as const, wallet: focus, i, h, tape, state: intel?.state(focus) ?? 'unknown' };
	});

	const rows = $derived.by(() => {
		void tick;
		if (!intel) return [] as (Holder | { wallet: string; account: string; rank: number; amount: number; pct: number })[];
		const q = query.trim().toLowerCase();
		const list =
			tab === 'holders'
				? intel.holders
				: intel.exited.map((e, k) => ({ ...e, rank: k + 1, amount: 0, pct: 0 }));
		return q && !isAddress(query.trim()) ? list.filter((r) => r.wallet.toLowerCase().includes(q)) : list;
	});

	function submit(e: Event) {
		e.preventDefault();
		const q = query.trim();
		if (isAddress(q)) {
			onFocus(q);
			query = '';
		}
	}

	const tokenPrice = $derived.by(() => {
		void tick;
		return intel?.supply ? price / intel.supply : 0;
	});
	const head = $derived.by(() => {
		void tick;
		return intel?.loaded ? `${grouped(intel.holderCount)} HOLDERS · ${grouped(intel.exitedCount)} DESERTED` : 'READING THE CHAIN…';
	});
</script>

<section class="room" class:closed={!open} aria-label="War Room: wallet tracking">
	<header>
		<div>
			<div class="label">WAR ROOM</div>
			<div class="ptitle">
				{#if theaterId === 'osiris'}
					{head}
				{:else}
					WHALE ORDERS · {orders.length}
				{/if}
			</div>
		</div>
		<button class="chev" aria-label={open ? 'Collapse War Room' : 'Expand War Room'} onclick={() => (open = !open)}>{open ? '▾' : '▴'}</button>
	</header>

	{#if open}
		{#if theaterId === 'osiris'}
			<form class="search" onsubmit={submit}>
				<input
					placeholder="Paste a wallet to track, or filter…"
					bind:value={query}
					spellcheck="false"
					autocomplete="off"
					aria-label="Wallet address or filter"
				/>
				{#if isAddress(query.trim())}<button type="submit">TRACK</button>{/if}
			</form>
		{/if}


		{#if theaterId === 'osiris'}
			<div class="tabs" role="tablist">
				<button role="tab" aria-selected={tab === 'holders'} class:on={tab === 'holders'} onclick={() => (tab = 'holders')}>
					BULLS · HOLDING
				</button>
				<button role="tab" aria-selected={tab === 'exited'} class:on={tab === 'exited'} onclick={() => (tab = 'exited')}>
					BEARS · DESERTED
				</button>
			</div>
			<div class="colhead mono">
				<span>#</span><span>WALLET</span><span class="r">{tab === 'holders' ? 'SUPPLY' : ''}</span><span class="r">HELD</span><span class="r">JOINED</span>
			</div>
			<ul class="list">
				{#each rows.slice(0, limit) as r (r.wallet)}
					{@const i = intel?.get(r.wallet)}
					{@const d = delta(i?.entryMc)}
					<li class:sel={focus === r.wallet} class:gold={tracked === r.wallet}>
						<button onclick={() => onFocus(r.wallet)} title={r.wallet}>
							<span class="n mono">{tab === 'holders' ? r.rank : ''}</span>
							<span class="w mono">{#if tab === 'holders'}<i>{insignia(r.pct)}</i>{/if}{shortAddr(r.wallet)}</span>
							<span class="r mono">{tab === 'holders' ? pctStr(r.pct) : ''}</span>
							<span class="r mono dim">{i?.since ? duration((i.exited && i.lastMove ? i.lastMove : now()) - i.since).split(' ')[0] : '·'}</span>
							<span class="r mono {d === null ? 'dim' : d >= 0 ? 'up' : 'down'}">{i?.entryMc ? fmtFront(i.entryMc) : '·'}</span>
						</button>
					</li>
				{:else}
					<li class="empty">{intel?.loaded ? 'No match.' : 'Reading the chain…'}</li>
				{/each}
				{#if rows.length > limit}
					<li class="more"><button onclick={() => (limit += 200)}>Show {Math.min(200, rows.length - limit)} more of {grouped(rows.length)}</button></li>
				{/if}
			</ul>
			<div class="hint">Click any soldier or tank on the field to see who it is.</div>
		{:else}
			<ul class="list">
				{#each orders as o (o.key)}
					<li class:sel={focus === o.key}>
						<button class="order" onclick={() => onFocus(o.key)}>
							<span class="mono {o.side === 'buy' ? 'up' : 'down'}">{o.side === 'buy' ? '▲' : '▼'} {usd(o.usd)}</span>
							<span class="dim">{o.venue}</span>
							<span class="r mono dim">{duration(now() - o.ts)}</span>
							<span class="r mono">{fmtFront(o.front)}</span>
						</button>
					</li>
				{:else}
					<li class="empty">Waiting for whale orders…</li>
				{/each}
			</ul>
			<div class="hint">Each whale order sends its own squad. Click one on the field, or here.</div>
		{/if}
	{/if}
</section>

<!-- the dossier pops out beside the War Room so the roster stays in view -->
	{#if dossier || selected}
		<div class="dossier">
			<button class="x" aria-label="Close dossier" onclick={onClose}>×</button>

			{#if dossier?.kind === 'wallet'}
				{@const i = dossier.i}
				{@const h = dossier.h}
				{@const amount = i?.amount ?? h?.amount ?? 0}
				{@const pct = i?.pct ?? h?.pct ?? 0}
				{@const exited = i?.exited || (i && amount === 0)}
				<div class="d-top">
					<span class="chip {exited ? 'bear' : selected?.team ?? 'bull'}">
						{exited ? 'DESERTER' : h ? `HOLDER #${h.rank}` : i?.none ? 'TRADER' : 'HOLDER'}
					</span>
					{#if amount > 0}<span class="rank"><b>{insignia(pct)}</b> {rankFor(pct)}</span>{/if}
				</div>
				<div class="d-wallet mono">
					<a href="https://solscan.io/account/{dossier.wallet}" target="_blank" rel="noopener noreferrer" title={dossier.wallet}>{shortAddr(dossier.wallet)} ↗</a>
					<span class="status">{statusFor(i, dossier.tape)}</span>
				</div>

				{#if dossier.state === 'loading' || dossier.state === 'unknown'}
					<div class="d-loading">Reading its service record from the chain…</div>
				{:else if dossier.state === 'error'}
					<div class="d-loading">The chain is busy — try again in a moment.</div>
				{:else if i?.none}
					<div class="d-loading">This wallet has never held $OSIRIS.</div>
				{/if}

				{#if i && !i.none}
					<div class="grid">
						{#if exited}
							<div class="cell wide">
								<span class="k">SERVED</span>
								<span class="v">{i.since ? shortDate(i.since) : '?'} → {i.lastMove ? shortDate(i.lastMove) : '?'}</span>
								<span class="s">{i.since && i.lastMove ? duration(i.lastMove - i.since) + ' in the line' : ''}</span>
							</div>
							<div class="cell">
								<span class="k">JOINED AT</span>
								<span class="v">{i.entryMc ? fmtFront(i.entryMc) : '—'}</span>
								<span class="s">front</span>
							</div>
							<div class="cell">
								<span class="k">LEFT AT</span>
								<span class="v">{i.lastMoveMc ? fmtFront(i.lastMoveMc) : '—'}</span>
								{#if i.entryMc && i.lastMoveMc}{@const m = (i.lastMoveMc / i.entryMc - 1) * 100}<span class="s {m >= 0 ? 'up' : 'down'}">{signed(m)} while holding</span>{/if}
							</div>
						{:else}
							<div class="cell">
								<span class="k">HOLDING</span>
								<span class="v">{i.since ? (i.sinceApprox ? '≥ ' : '') + duration(now() - i.since) : '—'}</span>
								<span class="s">{i.since ? 'since ' + shortDate(i.since) : ''}</span>
							</div>
							<div class="cell">
								<span class="k">JOINED AT</span>
								<span class="v">{i.entryMc ? fmtFront(i.entryMc) : '—'}</span>
								{#if delta(i.entryMc) !== null}{@const m = delta(i.entryMc)!}<span class="s {m >= 0 ? 'up' : 'down'}">front {signed(m)} since</span>{/if}
							</div>
							<div class="cell">
								<span class="k">BALANCE</span>
								<span class="v">{tokens(amount)}</span>
								<span class="s">{pctStr(pct)} · {tokenPrice ? usd(amount * tokenPrice) : '—'}</span>
							</div>
							<div class="cell">
								<span class="k">LAST MOVE</span>
								<span class="v">{i.lastMove ? duration(now() - i.lastMove) + ' ago' : '—'}</span>
								<span class="s">{i.txs ? `${i.txs}${i.sinceApprox ? '+' : ''} txs` : ''}</span>
							</div>
						{/if}
						{#if dossier.tape}
							<div class="cell wide">
								<span class="k">ON THE TAPE (24H)</span>
								<span class="v"><b class="up">+{usd(dossier.tape.buy)}</b> · <b class="down">−{usd(dossier.tape.sell)}</b></span>
							</div>
						{/if}
					</div>
				{/if}
			{:else if dossier?.kind === 'order'}
				{@const o = dossier.order}
				<div class="d-top">
					<span class="chip {o?.side === 'sell' ? 'bear' : 'bull'}">WHALE {o?.side === 'sell' ? 'SELL' : 'BUY'}</span>
				</div>
				{#if o}
					<div class="grid">
						<div class="cell">
							<span class="k">ORDER</span>
							<span class="v">{usd(o.usd)}</span>
							<span class="s">{o.venue}</span>
						</div>
						<div class="cell">
							<span class="k">HIT THE BOOK</span>
							<span class="v">{duration(now() - o.ts)} ago</span>
							<span class="s">at the {fmtFront(o.front)} front</span>
						</div>
					</div>
				{/if}
			{:else if selected}
				<div class="d-top">
					<span class="chip {selected.team}">MILITIA</span>
				</div>
				<div class="d-loading">
					{theaterId === 'osiris'
						? `No name on this one: ${selected.team === 'bull' ? 'buy-side' : 'sell-side'} pool liquidity holding the line.`
						: `${selected.team === 'bull' ? 'Bid' : 'Ask'}-side book liquidity holding the line.`}
				</div>
			{/if}

			{#if selected}
				<div class="unit">
					<span class="k">{selected.kind === 'tank' ? 'TANK' : 'SOLDIER'}</span>
					<span class={selected.alive ? 'up' : 'down'}>{selected.alive ? 'In the line' : 'KIA'}</span>
					· {selected.kills} kill{selected.kills === 1 ? '' : 's'}
					· deployed {duration(now() - selected.bornAt)} ago{selected.bornFront ? ` at the ${fmtFront(selected.bornFront)} front` : ''}
				</div>
			{/if}
			{#if record && (record.soldiers || record.tanks || record.kills || record.deaths)}
				<div class="unit">
					<span class="k">ALL UNITS</span>
					{record.soldiers} soldier{record.soldiers === 1 ? '' : 's'}{record.tanks ? ` + ${record.tanks} tank${record.tanks === 1 ? '' : 's'}` : ''} on the field ·
					{record.kills} kills · {record.deaths} fallen
				</div>
			{/if}

			<div class="acts">
				{#if selected?.alive}
					<button class:on={following} onclick={() => onFollow(!following)}>{following ? '◉ FOLLOWING' : '◎ FOLLOW'}</button>
				{/if}
				{#if focus}
					<button class:on={tracked === focus} onclick={() => onTrack(tracked === focus ? null : focus)}>
						{tracked === focus ? '★ TRACKING' : '☆ TRACK IN GOLD'}
					</button>
				{/if}
			</div>
		</div>
	{/if}

<style>
	.room {
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: 12px;
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1 1 auto;
		overflow: hidden;
		pointer-events: auto;
	}
	.room.closed {
		flex: none;
	}
	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: 11px 12px 8px 14px;
	}
	.label {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.1em;
		color: var(--text-3);
	}
	.ptitle {
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.06em;
		margin-top: 3px;
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
	.mono {
		font-family: var(--mono);
	}
	.up {
		color: var(--bull);
	}
	.down {
		color: var(--bear);
	}
	.dim {
		color: var(--text-3);
	}

	.search {
		display: flex;
		gap: 6px;
		padding: 0 10px 8px;
	}
	.search input {
		flex: 1;
		min-width: 0;
		font: 600 11px var(--mono);
		color: var(--text);
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid var(--line);
		border-radius: 7px;
		padding: 7px 9px;
		outline: none;
	}
	.search input:focus {
		border-color: rgba(255, 201, 60, 0.5);
	}
	.search button,
	.acts button {
		font: 800 10px var(--mono);
		letter-spacing: 0.06em;
		color: #1b1405;
		background: #f0cd72;
		border: 0;
		border-radius: 7px;
		padding: 0 10px;
		cursor: pointer;
	}

	.dossier {
		position: absolute;
		right: calc(100% + 12px);
		top: 0;
		width: 312px;
		max-height: 100%;
		overflow-y: auto;
		padding: 12px 13px 13px;
		border-radius: 12px;
		background: linear-gradient(160deg, rgba(255, 201, 60, 0.1), rgba(255, 255, 255, 0.02)), var(--panel-2);
		border: 1px solid rgba(255, 201, 60, 0.3);
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
		pointer-events: auto;
		animation: pop-in 0.25s ease-out both;
	}
	@keyframes pop-in {
		from {
			opacity: 0;
			transform: translateX(10px);
		}
	}
	@media (max-width: 900px) {
		.dossier {
			position: fixed;
			left: 10px;
			right: 10px;
			top: auto;
			bottom: 10px;
			width: auto;
			max-height: 58vh;
			z-index: 5;
		}
	}
	.x {
		position: absolute;
		top: 6px;
		right: 8px;
		background: none;
		border: 0;
		color: var(--text-3);
		font-size: 18px;
		cursor: pointer;
		line-height: 1;
	}
	.d-top {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-right: 18px;
	}
	.chip {
		font: 800 9.5px var(--mono);
		letter-spacing: 0.08em;
		padding: 3px 7px;
		border-radius: 5px;
	}
	.chip.bull {
		background: rgba(var(--bull-rgb), 0.18);
		color: var(--bull);
	}
	.chip.bear {
		background: rgba(var(--bear-rgb), 0.18);
		color: var(--bear);
	}
	.rank {
		font: 800 10px var(--mono);
		letter-spacing: 0.08em;
		color: #f0cd72;
	}
	.d-wallet {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		margin-top: 7px;
		font-size: 14px;
		font-weight: 800;
	}
	.d-wallet a {
		color: var(--text);
		text-decoration: none;
	}
	.d-wallet a:hover {
		text-decoration: underline;
	}
	.status {
		font: 700 10.5px var(--sans);
		color: #f0cd72;
		white-space: nowrap;
	}
	.d-loading {
		font-size: 11px;
		color: var(--text-2);
		margin-top: 8px;
		line-height: 1.45;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
		margin-top: 10px;
	}
	.cell {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 7px 8px;
		border-radius: 7px;
		background: rgba(0, 0, 0, 0.25);
		min-width: 0;
	}
	.cell.wide {
		grid-column: span 2;
	}
	.k {
		font: 700 9px var(--mono);
		letter-spacing: 0.1em;
		color: var(--text-3);
	}
	.v {
		font: 800 14px var(--mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.s {
		font: 600 10px var(--sans);
		color: var(--text-3);
	}
	.s.up {
		color: var(--bull);
	}
	.s.down {
		color: var(--bear);
	}
	.unit {
		margin-top: 8px;
		font-size: 11px;
		color: var(--text-2);
		line-height: 1.45;
	}
	.unit .k {
		margin-right: 6px;
	}
	.acts {
		display: flex;
		gap: 6px;
		margin-top: 10px;
	}
	.acts button {
		height: 28px;
		background: rgba(255, 255, 255, 0.06);
		color: var(--text);
		border: 1px solid var(--line);
	}
	.acts button.on {
		background: #f0cd72;
		color: #1b1405;
		border-color: transparent;
	}

	.tabs {
		display: flex;
		gap: 4px;
		padding: 0 10px 6px;
	}
	.tabs button {
		flex: 1;
		font: 800 9.5px var(--mono);
		letter-spacing: 0.06em;
		padding: 6px 4px;
		border-radius: 6px;
		border: 1px solid var(--line);
		background: none;
		color: var(--text-3);
		cursor: pointer;
	}
	.tabs button.on {
		color: var(--text);
		background: rgba(255, 255, 255, 0.08);
	}
	.colhead,
	.list li button {
		display: grid;
		grid-template-columns: 28px 1fr 58px 40px 64px;
		gap: 6px;
		align-items: center;
	}
	.colhead {
		padding: 2px 16px 4px;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: var(--text-3);
	}
	.r {
		text-align: right;
	}
	.list {
		list-style: none;
		overflow-y: auto;
		min-height: 60px;
		flex: 1 1 auto;
		padding: 0 8px 6px;
	}
	.list li button {
		width: 100%;
		padding: 5px 8px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--text);
		cursor: pointer;
		text-align: left;
		font-size: 11px;
	}
	.list li button:hover {
		background: rgba(255, 255, 255, 0.05);
	}
	.list li.sel button {
		background: rgba(255, 201, 60, 0.12);
	}
	.list li.gold .w {
		color: #ffc93c;
	}
	.list .n {
		color: var(--text-3);
		font-size: 10px;
	}
	.list .w {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.list .w i {
		font-style: normal;
		color: #f0cd72;
		margin-right: 5px;
		font-size: 9px;
	}
	.list li button.order {
		grid-template-columns: 1fr 64px 44px 70px;
	}
	.list li.empty,
	.list li.more {
		padding: 10px;
		font-size: 11px;
		color: var(--text-3);
		text-align: center;
	}
	.list li.more button {
		display: block;
		text-align: center;
		color: #f0cd72;
	}
	.hint {
		padding: 6px 14px 10px;
		font-size: 10px;
		color: var(--text-3);
		border-top: 1px solid var(--line);
	}
</style>
