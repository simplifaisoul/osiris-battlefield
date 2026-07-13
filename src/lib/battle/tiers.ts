// A wallet-unit's rank is decided by the share of circulating supply its trade moved.
export type Tier = {
	name: string;
	min: number; // minimum % of supply
	scale: number;
	hp: number;
	dmg: number;
	glyph: string;
};

// Highest first.
export const TIERS: Tier[] = [
	{ name: 'GOD', min: 1.0, scale: 3.6, hp: 3000, dmg: 90, glyph: '𓂀' },
	{ name: 'TITAN', min: 0.25, scale: 2.3, hp: 1300, dmg: 46, glyph: '𓉔' },
	{ name: 'CHAMPION', min: 0.05, scale: 1.55, hp: 560, dmg: 22, glyph: '𓋹' },
	{ name: 'ELITE', min: 0.01, scale: 1.12, hp: 240, dmg: 11, glyph: '𓆃' },
	{ name: 'SOLDIER', min: 0, scale: 0.85, hp: 95, dmg: 6, glyph: '𓀀' }
];

export function tierForPct(pct: number): Tier {
	for (const t of TIERS) if (pct >= t.min) return t;
	return TIERS[TIERS.length - 1];
}

export const GARRISON: Tier = { name: 'GARRISON', min: 0, scale: 0.68, hp: 60, dmg: 4, glyph: '𓀀' };
