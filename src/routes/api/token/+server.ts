import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MINT } from '$lib/server/osiris';

// Live market stats + circulating supply (used to size wallet-units by % of market).
let cache: { at: number; body: unknown } | null = null;
const TTL = 15000;

export const GET: RequestHandler = async () => {
	if (cache && Date.now() - cache.at < TTL) return json(cache.body);
	try {
		const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINT()}`, {
			signal: AbortSignal.timeout(8000)
		});
		const data = await res.json();
		const pairs = data?.pairs || [];
		if (!pairs.length) return json({ error: 'no market data' }, { status: 404 });
		const p = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

		const priceUsd = Number(p.priceUsd) || 0;
		const marketCap = p.marketCap || p.fdv || 0;
		const supply = priceUsd ? marketCap / priceUsd : 0;

		const body = {
			symbol: p.baseToken?.symbol || 'OSIRIS',
			priceUsd,
			marketCap,
			supply,
			liquidity: p.liquidity?.usd || 0,
			volume24h: p.volume?.h24 || 0,
			change24h: p.priceChange?.h24 ?? 0,
			buys24h: p.txns?.h24?.buys ?? 0,
			sells24h: p.txns?.h24?.sells ?? 0,
			// per-window market data for the 5M / 1H / 24H battle timeframes
			change: { m5: p.priceChange?.m5 ?? 0, h1: p.priceChange?.h1 ?? 0, h24: p.priceChange?.h24 ?? 0 },
			volume: { m5: p.volume?.m5 ?? 0, h1: p.volume?.h1 ?? 0, h24: p.volume?.h24 ?? 0 },
			txns: {
				m5: { buys: p.txns?.m5?.buys ?? 0, sells: p.txns?.m5?.sells ?? 0 },
				h1: { buys: p.txns?.h1?.buys ?? 0, sells: p.txns?.h1?.sells ?? 0 },
				h24: { buys: p.txns?.h24?.buys ?? 0, sells: p.txns?.h24?.sells ?? 0 }
			},
			image: p.info?.imageUrl || null,
			url: p.url,
			updatedAt: Date.now()
		};
		cache = { at: Date.now(), body };
		return json(body);
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 500 });
	}
};
