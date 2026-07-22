// A wallet-unit's rank is decided by the share of circulating supply its trade moved.
export type Tier = {
	name: string;
	min: number; // minimum % of supply
	scale: number;
	hp: number;
	dmg: number;
	glyph: string;
};

// Highest first. Scales stay close — rank shows through gear and heroes, not size.
// TITAN is the apex: the greatest whales take the field as deathless champions.
export const TIERS: Tier[] = [
	{ name: 'TITAN', min: 0.25, scale: 1.36, hp: 1800, dmg: 60, glyph: '𓉔' },
	{ name: 'CHAMPION', min: 0.05, scale: 1.14, hp: 560, dmg: 22, glyph: '𓋹' },
	{ name: 'ELITE', min: 0.01, scale: 1.02, hp: 240, dmg: 11, glyph: '𓆃' },
	{ name: 'SOLDIER', min: 0, scale: 0.92, hp: 95, dmg: 6, glyph: '𓀀' }
];

export function tierForPct(pct: number): Tier {
	for (const t of TIERS) if (pct >= t.min) return t;
	return TIERS[TIERS.length - 1];
}

export const GARRISON: Tier = { name: 'GARRISON', min: 0, scale: 0.86, hp: 60, dmg: 4, glyph: '𓀀' };
