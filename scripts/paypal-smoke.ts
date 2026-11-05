/* Smoke-test your PayPal sandbox credentials against the real API (no UI needed):
 *   npm run smoke:paypal
 * 1. OAuth token  2. Orders v2 create (prints the approve URL)  3. Payouts v1 batch of $0.01 to a placeholder email, then polls its status.
 * Needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env (sandbox). Payouts must be enabled on the app. */
import fs from "node:fs";
import { PayPalClient } from "../src/paypal/client.js";

if (fs.existsSync(".env")) for (const l of fs.readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) { console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) first."); process.exit(1); }
const pp = new PayPalClient({ clientId: id, clientSecret: secret, baseUrl: process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com" });

await pp.token();
console.log("1. OAuth ok");
const o = await pp.createOrder({ cents: 100, description: "Footnote smoke test", customId: "smoke", returnUrl: "http://localhost:3000/api/checkout/return", cancelUrl: "http://localhost:3000/api/checkout/cancel", requestId: "smoke-" + Date.now() });
console.log("2. Orders v2 ok:", o.orderId, o.status, "\n   approve:", o.approveUrl);
try {
  const sid = "smoke_" + Date.now();
  const b = await pp.createPayoutBatch({ senderBatchId: sid, emailSubject: "Footnote smoke test", emailMessage: "test", items: [{ senderItemId: sid + "_1", email: process.env.SMOKE_PAYEE || "footnote-smoke@example.com", cents: 1, note: "smoke" }] });
  console.log("3. Payouts v1 batch created:", b.batchId, b.status);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const d = await pp.getPayoutBatch(b.batchId);
    console.log("   poll:", d.status, d.items.map((x) => `${x.email}:${x.status}`).join(","));
    if (d.status === "SUCCESS" || d.items.every((x) => x.status !== "PENDING")) break;
  }
} catch (e) {
  console.error("3. Payouts failed:", (e as Error).message, JSON.stringify((e as any).body ?? "").slice(0, 400));
  process.exitCode = 2;
}
