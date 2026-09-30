import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MINT } from '$lib/server/osiris';
import { rpc, isAddress, mintInfo, priceAt } from '$lib/server/rpc';

// One wallet's service record for $OSIRIS: its balance, when its token account
// first saw a transaction (holding since), when it last moved, and the market
// cap — the "front" — on those days.
const cache = new Map<string, { at: number; body: unknown }>();
const TTL = 300_000;

type Parsed = { pubkey: string; account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } };
type Sig = { blockTime: number | null; signature: string };

export const GET: RequestHandler = async ({ url }) => {
	const address = url.searchParams.get('address') || '';
	if (!isAddress(address)) return json({ error: 'not a Solana address' }, { status: 400 });
	const hit = cache.get(address);
	if (hit && Date.now() - hit.at < TTL) return json(hit.body);
	try {
		const mint = await mintInfo();
		const owned = await rpc<{ value: Parsed[] }>('getTokenAccountsByOwner', [address, { mint: MINT() }, { encoding: 'jsonParsed' }]);
		if (!owned.value.length) {
			const body = { wallet: address, none: true, amount: 0, pct: 0 };
			cache.set(address, { at: Date.now(), body });
			return json(body);
		}
		let amount = 0;
		let main = owned.value[0];
		for (const a of owned.value) {
			const ui = a.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
			amount += ui;
			if (ui > (main.account.data.parsed.info.tokenAmount.uiAmount ?? 0)) main = a;
		}
		// newest first; walk back at most two pages to find the first transaction
		let sigs = await rpc<Sig[]>('getSignaturesForAddress', [main.pubkey, { limit: 1000 }]);
		let txs = sigs.length;
		const newest = sigs[0]?.blockTime ?? null;
		let oldest = sigs[sigs.length - 1];
		let sinceApprox = false;
		if (sigs.length === 1000) {
			sigs = await rpc<Sig[]>('getSignaturesForAddress', [main.pubkey, { limit: 1000, before: oldest.signature }]);
			txs += sigs.length;
			if (sigs.length) oldest = sigs[sigs.length - 1];
			sinceApprox = sigs.length === 1000;
		}
		const since = oldest?.blockTime ? oldest.blockTime * 1000 : null;
		const lastMove = newest ? newest * 1000 : null;
		const entry = since ? await priceAt(since) : null;
		const last = lastMove ? await priceAt(lastMove) : null;
		const body = {
			wallet: address,
			account: main.pubkey,
			amount,
			pct: (amount / mint.supply) * 100,
			exited: amount === 0,
			since,
			sinceApprox,
			lastMove,
			txs,
			entryMc: entry ? entry * mint.supply : null,
			lastMoveMc: last ? last * mint.supply : null,
			updatedAt: Date.now()
		};
		if (cache.size > 5000) cache.clear();
		cache.set(address, { at: Date.now(), body });
		return json(body);
	} catch (e) {
		if (hit) return json(hit.body);
		return json({ error: (e as Error).message }, { status: 502 });
	}
};
