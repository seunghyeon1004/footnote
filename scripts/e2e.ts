/* Drives a RUNNING Footnote server through the whole flow and prints evidence.
 *   npm run demo   (terminal 1)      npm run e2e   (terminal 2)
 * Works against the simulator. Against the real sandbox the checkout step needs a human to approve in the browser. */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let cookie = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string, json?: unknown, method = json === undefined ? "GET" : "POST") {
  const res = await fetch(BASE + path, { method, redirect: "manual", headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const t = await res.text();
  try { return { status: res.status, json: JSON.parse(t), headers: res.headers }; } catch { return { status: res.status, json: null, headers: res.headers, text: t }; }
}
const step = (s: string) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const c = (n: number) => `$${(n / 100).toFixed(2)}`;

const me = await api("/api/me");
console.log("mode:", JSON.stringify(me.json.config.mode));

step("1. Buy credits: PayPal Orders v2 (create -> approve -> capture)");
const o = await api("/api/checkout/create", { packId: "pack5" });
console.log("order:", o.json.orderId, "\napprove:", o.json.approveUrl);
if (!o.json.approveUrl.includes("/_sim/")) {
  console.log("Real sandbox: open the approve URL in a browser, pay with a sandbox buyer account, then re-run with the cookie. (Use the UI for this step.)");
  process.exit(0);
}
const html = await (await fetch(o.json.approveUrl)).text();
const ret = new URL(/action="([^"]+)"/.exec(html)![1]);
ret.searchParams.set("token", o.json.orderId); ret.searchParams.set("PayerID", "SIMPAYER");
const cap = await api(ret.pathname + ret.search);
console.log("capture redirect ->", cap.headers.get("location"), "| balance:", c((await api("/api/me")).json.user.balanceCents));

step("2. Ask a question (fee $0.50)");
const q = process.argv[2] ?? "How can I compost food scraps in a small apartment?";
const { answerId } = (await api("/api/ask", { question: q, feeCents: 50 })).json;
let a: any;
for (;;) {
  a = (await api(`/api/answers/${answerId}`)).json;
  if (a.status === "done" || a.status === "error") break;
  await sleep(300);
}
if (a.status === "error") { console.error("ERROR:", a.error); process.exit(1); }
console.log(a.events.map((e: any) => `  [${e.stage}] ${e.message}`).join("\n"));
console.log("\nANSWER:\n" + a.answerMarkdown);

step("3. Royalty receipt");
console.table(a.sources.map((s: any) => ({ n: s.n, domain: s.domain, score: s.rawScore, share: s.dropped ? "dropped" : `${s.sharePct}% ${c(s.shareCents)}`, payee: s.payee?.method ?? "-", status: s.payoutStatus ?? s.dropReason?.slice(0, 28), injection: s.flagged ? "STRIPPED" : "" })));
console.log("receipt:", JSON.stringify(a.receipt));
for (const s of a.sources.filter((x: any) => x.flagged)) console.log(`injection on ${s.domain}:`, s.flags.map((f: any) => f.snippet.slice(0, 90)));

step("4. Payout status via PayPal webhook (waiting 2.5s)");
await sleep(2500);
const a2 = (await api(`/api/answers/${answerId}`)).json;
console.log(a2.sources.filter((s: any) => s.payoutBatchId).map((s: any) => `${s.domain}: ${s.payoutStatus} (batch ${s.payoutBatchId})`).join("\n"));

step("5. Creator dashboard + ledger");
console.log(JSON.stringify((await api("/api/creators/compost-diaries.demo")).json, null, 1).slice(0, 700));
console.log("ledger:", JSON.stringify({ ...(await api("/api/ledger")).json, batches: undefined }));

step("6. Escrow claim attempt (no payee declared yet)");
console.log((await api("/api/claim", { domain: "garden-gnome-gazette.demo" })).json.message);
export {};
