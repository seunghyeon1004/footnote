/** Pure attribution math: scores -> dropped/kept -> normalized shares -> exact cents. */

export interface RawScore {
  n: number;
  score: number; // 0..1 from the attribution agent
  justification: string;
}

export interface ScoredSource extends RawScore {
  domain: string;
  flagged: boolean;
}

export interface Allocation {
  n: number;
  adjustedScore: number;
  dropped: boolean;
  dropReason: string | null;
  sharePct: number; // one decimal
  shareCents: number;
}

export interface AllocateOptions {
  feeCents: number;
  minScore: number;
  injectionPenalty: number; // multiplier applied to flagged sources (0..1)
  ownDomain?: string | null;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
}

export function isSelfCitation(domain: string, ownDomain?: string | null): boolean {
  if (!ownDomain) return false;
  const own = normalizeDomain(ownDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (!own) return false;
  const d = normalizeDomain(domain);
  return d === own || d.endsWith("." + own);
}

/** Largest-remainder apportionment: integer cents that sum exactly to `total`. */
export function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, r: e - Math.floor(e) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return floors;
}

export function allocate(sources: ScoredSource[], opts: AllocateOptions): Allocation[] {
  const out: Allocation[] = sources.map((s) => {
    const base = clamp01(s.score);
    const adjusted = s.flagged ? base * clamp01(opts.injectionPenalty) : base;
    let dropped = false;
    let reason: string | null = null;
    if (isSelfCitation(s.domain, opts.ownDomain)) {
      dropped = true;
      reason = "self-citation: the asker's own domain is never paid";
    } else if (adjusted < opts.minScore) {
      dropped = true;
      reason = base < opts.minScore ? `background only (score ${base.toFixed(2)} < ${opts.minScore})` : `score ${base.toFixed(2)} cut to ${adjusted.toFixed(2)} after injection penalty`;
    }
    return { n: s.n, adjustedScore: adjusted, dropped, dropReason: reason, sharePct: 0, shareCents: 0 };
  });
  const live = out.filter((o) => !o.dropped);
  const cents = apportion(live.map((o) => o.adjustedScore), opts.feeCents);
  const sum = live.reduce((a, o) => a + o.adjustedScore, 0);
  live.forEach((o, i) => {
    o.shareCents = cents[i];
    o.sharePct = sum > 0 ? Math.round((o.adjustedScore / sum) * 1000) / 10 : 0;
  });
  // A source that rounds to 0 cents has earned nothing: drop it and re-apportion once.
  const zero = live.filter((o) => o.shareCents === 0);
  if (zero.length && live.length > zero.length) {
    zero.forEach((o) => {
      o.dropped = true;
      o.dropReason = "share rounds to under 1 cent";
    });
    const rest = out.filter((o) => !o.dropped);
    const c2 = apportion(rest.map((o) => o.adjustedScore), opts.feeCents);
    const s2 = rest.reduce((a, o) => a + o.adjustedScore, 0);
    rest.forEach((o, i) => {
      o.shareCents = c2[i];
      o.sharePct = Math.round((o.adjustedScore / s2) * 1000) / 10;
    });
  }
  return out;
}
