import "node:process";

export interface NearConfig {
  /** "off" = NEAR rail not offered; "live" = real chain via near-api-js; "simulator" = offline stand-in (labelled). */
  mode: "off" | "live" | "simulator";
  network: "testnet" | "mainnet";
  rpcUrl: string;
  accountId: string;
  privateKey: string;
  receiptContract: string;
  /** Mainnet sends real money: refused unless NEAR_ALLOW_MAINNET=1. */
  allowMainnet: boolean;
  minPayoutCents: number;
  maxPayoutCents: number;
  /** "auto": pay in NEAR when the creator declared a NEAR account and the rail is on. "paypal": never use NEAR. */
  rail: "auto" | "paypal";
  fixedUsdRate: number | null;
}

export interface Config {
  port: number;
  publicUrl: string;
  dbPath: string;
  paypal: { clientId: string; clientSecret: string; baseUrl: string; webhookId: string; simulator: boolean };
  near: NearConfig;
  llm: { provider: "anthropic" | "openai" | "gemini" | "vultr" | "fixture"; model: string; webSearch: boolean; fallbacks: boolean };
  minPayoutCents: number;
  minFeeCents: number;
  maxFeeCents: number;
  defaultFeeCents: number;
  minScore: number;
  injectionPenalty: number;
  escrowTtlDays: number;
  maxBatchCents: number;
  devGrant: boolean;
  welcomeCents: number;
  dailyAnswerCap: number;
  packs: { id: string; label: string; cents: number }[];
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = num(env.PORT, 3000);
  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, "");
  const hasPayPal = !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  const forceSim = env.PAYPAL_SIMULATOR === "1";
  const simulator = forceSim || !hasPayPal;
  const forced = env.LLM_PROVIDER as Config["llm"]["provider"] | undefined;
  const provider: Config["llm"]["provider"] =
    forced === "fixture" ? "fixture"
    : forced === "gemini" && env.GEMINI_API_KEY ? "gemini"
    : forced === "vultr" && env.VULTR_API_KEY ? "vultr"
    : forced === "openai" && env.OPENAI_API_KEY ? "openai"
    : forced === "anthropic" && env.ANTHROPIC_API_KEY ? "anthropic"
    : env.ANTHROPIC_API_KEY ? "anthropic"
    : env.OPENAI_API_KEY ? "openai"
    : env.GEMINI_API_KEY ? "gemini"
    : env.VULTR_API_KEY ? "vultr"
    : "fixture";
  const model =
    provider === "anthropic" ? env.FOOTNOTE_MODEL || "claude-sonnet-5-5"
    : provider === "openai" ? env.FOOTNOTE_MODEL || env.OPENAI_MODEL || "gpt-4.1"
    : provider === "vultr" ? env.FOOTNOTE_MODEL || env.VULTR_MODEL || "llama-3.3-70b-instruct-fp8"
    : provider === "gemini" ? env.FOOTNOTE_MODEL || "gemini-2.5-flash"
    : "fixture";
  const network: "testnet" | "mainnet" = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const hasNear = !!(env.NEAR_ACCOUNT_ID && env.NEAR_PRIVATE_KEY);
  const nearMode: NearConfig["mode"] = env.NEAR_SIMULATOR === "1" ? "simulator" : hasNear ? "live" : "off";
  const fixedRate = Number(env.NEAR_USD_RATE);
  const near: NearConfig = {
    mode: nearMode,
    network,
    rpcUrl: env.NEAR_RPC_URL || (network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"),
    accountId: env.NEAR_ACCOUNT_ID || "",
    privateKey: env.NEAR_PRIVATE_KEY || "",
    receiptContract: env.NEAR_RECEIPT_CONTRACT || "",
    allowMainnet: env.NEAR_ALLOW_MAINNET === "1",
    minPayoutCents: num(env.NEAR_MIN_PAYOUT_CENTS, 10),
    maxPayoutCents: num(env.NEAR_MAX_PAYOUT_CENTS, 500),
    rail: env.FOOTNOTE_RAIL === "paypal" ? "paypal" : "auto",
    fixedUsdRate: Number.isFinite(fixedRate) && fixedRate > 0 ? fixedRate : null,
  };
  return {
    port,
    publicUrl,
    near,
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
    devGrant: env.ALLOW_DEV_GRANT === "1",
    welcomeCents: num(env.WELCOME_CREDITS_CENTS, 0),
    dailyAnswerCap: num(env.DAILY_ANSWER_CAP, 0),
    packs: [
      { id: "pack5", label: "$5 starter pack", cents: 500 },
      { id: "pack10", label: "$10 pack", cents: 1000 },
    ],
  };
}

export const dollars = (cents: number) => (cents / 100).toFixed(2);
