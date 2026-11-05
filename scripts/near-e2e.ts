/**
 * Live end-to-end run of the NEAR payout rail on testnet (needs `npm run near:setup` first).
 * Boots the real app in-process (fixture research, PayPal simulator, REAL NEAR testnet), asks a question, waits for the
 * settlement, then re-verifies every claimed transaction directly against the NEAR RPC and reads the on-chain receipt
 * log from the contract. Writes docs/evidence/near-e2e.json. Exit code 1 if anything does not check out.
 */
import fs from "node:fs";
import { serve } from "@hono/node-server";
import { JsonRpcProvider } from "near-api-js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { PayPalClient } from "../src/paypal/client.js";
import { makeLLM } from "../src/llm/index.js";
import { makeFetcher } from "../src/fetcher.js";
import { createApp } from "../src/app.js";
import { makeNearRail } from "../src/near/index.js";
import type { Ctx } from "../src/service.js";

for (const line of fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const port = 3917;
const cfg = loadConfig({
  ...process.env, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, DB_PATH: ":memory:", MIN_PAYOUT_CENTS: "10",
  LLM_PROVIDER: "fixture", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", ALLOW_DEV_GRANT: "1",
} as any);
if (cfg.near.mode !== "live") { console.error("NEAR is not configured: run `npm run near:setup` first"); process.exit(2); }
const db = openDb(":memory:");
const near = makeNearRail(cfg)!;
const ctx: Ctx = {
  cfg, db, paypal: new PayPalClient({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret, baseUrl: cfg.paypal.baseUrl }),
  llm: makeLLM(cfg, {} as any), fetcher: makeFetcher(cfg.publicUrl), settleLock: Promise.resolve(), near,
};
const server = serve({ fetch: createApp(ctx).fetch, port });
const base = cfg.publicUrl;
let cookie = "";
const api = async (p: string, json?: unknown) => {
  const r = await fetch(base + p, { method: json ? "POST" : "GET", headers: { ...(json ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json() as Promise<any>;
};
const provider = new JsonRpcProvider({ url: cfg.near.rpcUrl });
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

const status = await api("/api/near/status");
console.log("NEAR status:", JSON.stringify(status));
check("NEAR rail is live on testnet", status.enabled && status.mode === "live" && status.network === "testnet");
const before = await near.client.balance();

await api("/api/me");
await api("/api/dev/grant", { cents: 500 });
const ask = await api("/api/ask", { question: "How can I compost food scraps in a small apartment?", feeCents: 100 });
let ans: any;
for (let i = 0; i < 120; i++) { ans = await api(`/api/answers/${ask.answerId}`); if (ans.status === "done" || ans.status === "error") break; await new Promise((r) => setTimeout(r, 1000)); }
check("answer completed", ans.status === "done", ans.error ?? "");
for (const e of ans.events) console.log(`  [${e.stage}] ${e.message}`);

const nearSources = ans.sources.filter((s: any) => s.payoutRail === "near");
check("at least one source was paid on the NEAR rail", nearSources.length >= 1, nearSources.map((s: any) => s.near.account).join(", "));
const evidence: any[] = [];
for (const s of nearSources) {
  const n = s.near;
  check(`${s.domain}: payout SUCCESS with a real tx hash`, s.payoutStatus === "SUCCESS" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(n.txHash ?? ""), n.txHash);
  const tx: any = await provider.viewTransactionStatus({ txHash: n.txHash, accountId: near.client.accountId, waitUntil: "FINAL" } as any);
  const failed = JSON.stringify(tx.receipts_outcome ?? []).includes('"Failure"');
  const act = tx.transaction?.actions?.[0]?.Transfer?.deposit;
  check(`${s.domain}: chain confirms Transfer of ${act} yocto to ${n.account}`, !failed && tx.transaction.receiver_id === n.account && act === n.yoctoNear && tx.final_execution_status === "FINAL", tx.final_execution_status);
  check(`${s.domain}: on-chain receipt logged`, n.receiptStatus === "LOGGED" && !!n.receiptTx, n.receiptTx ?? n.receiptStatus);
  evidence.push({ domain: s.domain, account: n.account, cents: s.shareCents, yocto: n.yoctoNear, usdPerNear: n.usdPerNear, txHash: n.txHash, txUrl: n.txUrl, receiptTx: n.receiptTx, receiptUrl: n.receiptUrl });
}
const rec = await api("/api/near/receipts");
check("contract returns the receipts", rec.receipts?.length >= nearSources.length, `${rec.receipts?.length} on contract ${rec.contract}`);
for (const r of rec.receipts ?? []) {
  const hit = evidence.find((e) => e.txHash === r.payout_tx);
  if (hit) check(`receipt #${r.id} references payout tx and amount`, r.yocto_near === hit.yocto && r.payee === hit.account, `${r.payee} ${r.usd_cents}c`);
}
const after = await near.client.balance();
console.log(`settlement balance ${Number(before / 10n ** 20n) / 1e4} -> ${Number(after / 10n ** 20n) / 1e4} NEAR`);
fs.mkdirSync("docs/evidence", { recursive: true });
fs.writeFileSync("docs/evidence/near-e2e.json", JSON.stringify({ ranAt: new Date().toISOString(), network: near.client.network, settlementAccount: near.client.accountId, receiptContract: near.client.receiptContract, question: ans.question, receipt: ans.receipt, payouts: evidence, onchainReceipts: rec.receipts, checks }, null, 2) + "\n");
server.close();
const bad = checks.filter((c) => !c.ok);
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : `\nALL ${checks.length} CHECKS PASSED. Evidence: docs/evidence/near-e2e.json`);
process.exit(bad.length ? 1 : 0);
