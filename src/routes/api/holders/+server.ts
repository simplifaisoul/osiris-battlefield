import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MINT, POOL } from '$lib/server/osiris';
import { rpc, base58, mintInfo } from '$lib/server/rpc';

// Every $OSIRIS token account, straight from the chain: wallets still holding
// (the Bulls' roster) and wallets that sold out but never closed the account
// (the Bears'). One getProgramAccounts call, sliced to owner + amount, cached.
let cache: { at: number; body: unknown } | null = null;
const TTL = 90_000;
const LEGACY_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

type Raw = { pubkey: string; account: { data: [string, string] } };

export const GET: RequestHandler = async () => {
	if (cache && Date.now() - cache.at < TTL) return json(cache.body);
	try {
		const mint = await mintInfo();
		const filters: object[] = [{ memcmp: { offset: 0, bytes: MINT() } }];
		if (mint.program === LEGACY_TOKEN) filters.push({ dataSize: 165 });
		const accounts = await rpc<Raw[]>('getProgramAccounts', [
			mint.program,
			{ encoding: 'base64', dataSlice: { offset: 32, length: 40 }, filters }
		]);
		// one wallet can own several accounts: sum them, keep the biggest as its address
		const byOwner = new Map<string, { wallet: string; account: string; amount: number; top: number }>();
		for (const a of accounts) {
			const buf = Uint8Array.from(atob(a.account.data[0]), (c) => c.charCodeAt(0));
			const wallet = base58(buf.subarray(0, 32));
			if (wallet === POOL()) continue; // the pool's own reserve isn't a holder
			const amount = Number(new DataView(buf.buffer).getBigUint64(32, true)) / 10 ** mint.decimals;
			const o = byOwner.get(wallet);
			if (!o) byOwner.set(wallet, { wallet, account: a.pubkey, amount, top: amount });
			else {
				o.amount += amount;
				if (amount > o.top) {
					o.top = amount;
					o.account = a.pubkey;
				}
			}
		}
		const all = [...byOwner.values()];
		const holding = all.filter((o) => o.amount > 0).sort((a, b) => b.amount - a.amount);
		const exited = all.filter((o) => o.amount === 0);
		const body = {
			supply: mint.supply,
			holderCount: holding.length,
			exitedCount: exited.length,
			holders: holding.slice(0, 700).map((o, i) => ({
				wallet: o.wallet,
				account: o.account,
				amount: o.amount,
				pct: (o.amount / mint.supply) * 100,
				rank: i + 1
			})),
			exited: exited.slice(0, 900).map((o) => ({ wallet: o.wallet, account: o.account })),
			updatedAt: Date.now()
		};
		cache = { at: Date.now(), body };
		return json(body);
	} catch (e) {
		if (cache) return json(cache.body);
		return json({ error: (e as Error).message }, { status: 502 });
	}
};
