import "node:process";

export interface Config {
  port: number;
  publicUrl: string;
  dbPath: string;
  paypal: { clientId: string; clientSecret: string; baseUrl: string; webhookId: string; simulator: boolean };
  llm: { provider: "anthropic" | "openai" | "fixture"; model: string; webSearch: boolean; fallbacks: boolean };
  minPayoutCents: number;
  minFeeCents: number;
  maxFeeCents: number;
  defaultFeeCents: number;
  minScore: number;
  injectionPenalty: number;
  escrowTtlDays: number;
  maxBatchCents: number;
  packs: { id: string; label: string; cents: number }[];
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = num(env.PORT, 3000);
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");
  const hasPayPal = !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  const forceSim = env.PAYPAL_SIMULATOR === "1";
  const simulator = forceSim || !hasPayPal;
  const provider: Config["llm"]["provider"] =
    env.LLM_PROVIDER === "fixture" ? "fixture"
    : env.ANTHROPIC_API_KEY ? "anthropic"
    : env.OPENAI_API_KEY ? "openai"
    : "fixture";
  const model =
    provider === "anthropic" ? env.FOOTNOTE_MODEL || "claude-sonnet-5-5"
    : provider === "openai" ? env.FOOTNOTE_MODEL || env.OPENAI_MODEL || "gpt-4.1"
    : "fixture";
  return {
    port,
    publicUrl,
    dbPath: env.DB_PATH || "data/footnote.db",
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID || "sim-client",
      clientSecret: env.PAYPAL_CLIENT_SECRET || "sim-secret",
      baseUrl: simulator ? `${publicUrl}/_sim/paypal` : env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com",
      webhookId: env.PAYPAL_WEBHOOK_ID || "",
      simulator,
    },
    llm: {
      provider,
      model,
      webSearch: env.WEB_SEARCH !== "off",
      fallbacks: env.FOOTNOTE_FALLBACKS !== "off",
    },
    minPayoutCents: num(env.MIN_PAYOUT_CENTS, 100),
    minFeeCents: num(env.MIN_FEE_CENTS, 25),
    maxFeeCents: num(env.MAX_FEE_CENTS, 100),
    defaultFeeCents: 50,
    minScore: num(env.MIN_SCORE, 0.15),
    injectionPenalty: num(env.INJECTION_PENALTY, 0.5),
    escrowTtlDays: num(env.ESCROW_TTL_DAYS, 30),
    maxBatchCents: num(env.MAX_BATCH_CENTS, 2000),
    packs: [
      { id: "pack5", label: "$5 starter pack", cents: 500 },
      { id: "pack10", label: "$10 pack", cents: 1000 },
    ],
  };
}

export const dollars = (cents: number) => (cents / 100).toFixed(2);
