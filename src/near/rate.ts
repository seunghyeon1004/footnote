/** USD -> NEAR conversion. Amounts are computed in BigInt yoctoNEAR (1 NEAR = 1e24 yocto); no floating point money. */
export interface RateQuote {
  usdPerNear: number;
  source: string; // "fixed" | "coingecko" | "coingecko-cache"
}
export interface RateProvider {
  quote(): Promise<RateQuote>;
}

export function centsToYocto(cents: number, usdPerNear: number): bigint {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("cents must be a positive integer");
  if (!Number.isFinite(usdPerNear) || usdPerNear <= 0) throw new Error("bad NEAR/USD rate");
  const micro = BigInt(Math.round(usdPerNear * 1_000_000));
  if (micro <= 0n) throw new Error("bad NEAR/USD rate");
  return (BigInt(cents) * 10n ** 24n * 1_000_000n) / (100n * micro);
}

export function fixedRate(usdPerNear: number): RateProvider {
  return { quote: async () => ({ usdPerNear, source: "fixed" }) };
}

/** Live CoinGecko price with a short cache. If the feed fails and nothing fresh is cached it THROWS: we never guess a price. */
export function coingeckoRate(opts: { fetchImpl?: typeof fetch; ttlMs?: number; staleOkMs?: number } = {}): RateProvider {
  const f = opts.fetchImpl ?? fetch;
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const staleOk = opts.staleOkMs ?? 60 * 60_000;
  let cache: { at: number; rate: number } | null = null;
  return {
    async quote() {
      const t = Date.now();
      if (cache && t - cache.at < ttl) return { usdPerNear: cache.rate, source: "coingecko-cache" };
      try {
        const r = await f("https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`coingecko ${r.status}`);
        const j = (await r.json()) as { near?: { usd?: number } };
        const rate = j?.near?.usd;
        if (typeof rate !== "number" || !(rate > 0)) throw new Error("coingecko returned no NEAR price");
        cache = { at: t, rate };
        return { usdPerNear: rate, source: "coingecko" };
      } catch (e) {
        if (cache && t - cache.at < staleOk) return { usdPerNear: cache.rate, source: "coingecko-cache" };
        throw new Error(`no NEAR/USD rate available (${(e as Error).message}); set NEAR_USD_RATE to pay with a fixed rate`);
      }
    },
  };
}
