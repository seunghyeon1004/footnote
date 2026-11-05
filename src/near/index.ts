import type { Config } from "../config.js";
import { RealNearClient, SimNearClient, type NearClient } from "./client.js";
import { coingeckoRate, fixedRate, type RateProvider } from "./rate.js";

export interface NearRail {
  client: NearClient;
  rate: RateProvider;
}

/** Build the NEAR rail from config, or null when it is off. Mainnet is refused unless NEAR_ALLOW_MAINNET=1. */
export function makeNearRail(cfg: Config): NearRail | null {
  const n = cfg.near;
  if (n.mode === "off") return null;
  if (n.mode === "simulator") return { client: new SimNearClient(), rate: fixedRate(n.fixedUsdRate ?? 4) };
  if (n.network === "mainnet" && !n.allowMainnet) throw new Error("NEAR_NETWORK=mainnet requires NEAR_ALLOW_MAINNET=1 (real money)");
  return {
    client: new RealNearClient({ network: n.network, rpcUrl: n.rpcUrl, accountId: n.accountId, privateKey: n.privateKey, receiptContract: n.receiptContract || null }),
    rate: n.fixedUsdRate ? fixedRate(n.fixedUsdRate) : coingeckoRate(),
  };
}
