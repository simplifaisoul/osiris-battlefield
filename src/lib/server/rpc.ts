// Solana JSON-RPC + price history for the wallet tracker. Calls are serialized
// and spaced so the public endpoint's rate limit isn't hit, with backoff on 429.
// Set OSIRIS_RPC_URL to use a private RPC instead.

import { env } from '$env/dynamic/private';
import { MINT, POOL } from './osiris';

const rpcUrl = () => env.OSIRIS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
let chain: Promise<unknown> = Promise.resolve();

export function rpc<T>(method: string, params: unknown[]): Promise<T> {
	const run = async (): Promise<T> => {
		for (let attempt = 0; attempt < 4; attempt++) {
			const wait = lastCall + 140 - Date.now();
			if (wait > 0) await sleep(wait);
			lastCall = Date.now();
			const res = await fetch(rpcUrl(), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
				signal: AbortSignal.timeout(20_000)
			});
			const body = res.status === 429 ? null : await res.json().catch(() => null);
			if (!body || body.error?.code === 429) {
				await sleep(700 * 2 ** attempt);
				continue;
			}
			if (body.error) throw new Error(body.error.message || 'RPC error');
			return body.result as T;
		}
		throw new Error('RPC rate limited, try again shortly');
	};
	const p = chain.then(run, run);
	chain = p.catch(() => {});
	return p;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
	let n = 0n;
	for (const b of bytes) n = n * 256n + BigInt(b);
	let s = '';
	while (n > 0n) {
		s = B58[Number(n % 58n)] + s;
		n /= 58n;
	}
	for (const b of bytes) {
		if (b) break;
		s = '1' + s;
	}
	return s;
}

export const isAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

// ── the mint: owning token program, supply ─────────────────────────────

let mintCache: { at: number; program: string; supply: number; decimals: number } | null = null;

export async function mintInfo() {
	if (mintCache && Date.now() - mintCache.at < 600_000) return mintCache;
	const r = await rpc<{ value: { owner: string; data: { parsed: { info: { supply: string; decimals: number } } } } }>('getAccountInfo', [
		MINT(),
		{ encoding: 'jsonParsed' }
	]);
	const info = r.value.data.parsed.info;
	mintCache = { at: Date.now(), program: r.value.owner, supply: Number(info.supply) / 10 ** info.decimals, decimals: info.decimals };
	return mintCache;
}

// ── price history (GeckoTerminal 4h candles back to the pool's launch) ─

let ohlcvCache: { at: number; candles: [number, number][] } | null = null; // [unix s, close usd], oldest first

async function candles(): Promise<[number, number][]> {
	if (ohlcvCache && Date.now() - ohlcvCache.at < 600_000) return ohlcvCache.candles;
	const res = await fetch(
		`https://api.geckoterminal.com/api/v2/networks/solana/pools/${POOL()}/ohlcv/hour?aggregate=4&limit=1000&currency=usd`,
		{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }
	);
	if (!res.ok) {
		if (ohlcvCache) return ohlcvCache.candles;
		throw new Error(`GeckoTerminal ${res.status}`);
	}
	const list: number[][] = (await res.json())?.data?.attributes?.ohlcv_list || [];
	const out = list.map((c) => [c[0], c[4]] as [number, number]).sort((a, b) => a[0] - b[0]);
	ohlcvCache = { at: Date.now(), candles: out };
	return out;
}

/** USD token price in force at `ms` (the candle it falls in; the first candle for anything earlier). */
export async function priceAt(ms: number): Promise<number | null> {
	const c = await candles();
	if (!c.length) return null;
	const t = ms / 1000;
	let best = c[0][1];
	for (const [ts, close] of c) {
		if (ts > t) break;
		best = close;
	}
	return best;
}
