import { serve } from "@hono/node-server";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { PayPalClient } from "./paypal/client.js";
import { makeLLM } from "./llm/index.js";
import { makeFetcher } from "./fetcher.js";
import { createApp } from "./app.js";
import { refreshPendingBatches } from "./ledger.js";
import type { Ctx } from "./service.js";

// tiny .env loader (no dependency); real env vars win
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const ctx: Ctx = {
  cfg,
  db,
  paypal: new PayPalClient({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret, baseUrl: cfg.paypal.baseUrl }),
  llm: makeLLM(cfg),
  fetcher: makeFetcher(cfg.publicUrl),
  settleLock: Promise.resolve(),
};
const app = createApp(ctx);
serve({ fetch: app.fetch, port: cfg.port }, () => {
  console.log(`\n  Footnote  ${cfg.publicUrl}`);
  console.log(`  PayPal:   ${cfg.paypal.simulator ? "SIMULATOR (set PAYPAL_CLIENT_ID/SECRET for the real sandbox)" : "sandbox " + cfg.paypal.baseUrl}`);
  console.log(`  LLM:      ${cfg.llm.provider === "fixture" ? "FIXTURE MODE (set ANTHROPIC_API_KEY for real research)" : cfg.llm.provider + " " + cfg.llm.model}`);
  console.log(`  Payout minimum: ${cfg.minPayoutCents}c\n`);
});
setInterval(() => void refreshPendingBatches(db, ctx.paypal).catch(() => {}), 20_000).unref();
