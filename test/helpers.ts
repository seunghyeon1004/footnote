import { serve } from "@hono/node-server";
import net from "node:net";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { PayPalClient } from "../src/paypal/client.js";
import { makeLLM } from "../src/llm/index.js";
import { makeFetcher } from "../src/fetcher.js";
import { createApp } from "../src/app.js";
import type { Ctx } from "../src/service.js";

export const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

export async function boot(env: Record<string, string> = {}, extra: { near?: Ctx["near"] } = {}) {
  const port = await freePort();
  const cfg = loadConfig({ PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, DB_PATH: ":memory:", MIN_PAYOUT_CENTS: "10", LLM_PROVIDER: "fixture", ...env } as any);
  const db = openDb(":memory:");
  const ctx: Ctx = {
    cfg, db,
    paypal: new PayPalClient({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret, baseUrl: cfg.paypal.baseUrl }),
    llm: makeLLM(cfg, {} as any), fetcher: makeFetcher(cfg.publicUrl), settleLock: Promise.resolve(), near: extra.near ?? null,
  };
  const server = serve({ fetch: createApp(ctx).fetch, port });
  const base = cfg.publicUrl;
  let cookie = "";
  const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const res = await fetch(base + path, {
      redirect: "manual", ...init,
      headers: { ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(init.headers as any) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html/redirect */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { ctx, cfg, db, base, api, close: () => server.close() };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitDone(api: Awaited<ReturnType<typeof boot>>["api"], id: string, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api(`/api/answers/${id}`);
    if (r.json.status === "done" || r.json.status === "error") return r.json;
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for answer: " + JSON.stringify(r.json.events));
    await sleep(120);
  }
}

/** Buy the $5 pack through the (simulated) PayPal Orders v2 flow. */
export async function buyCredits(h: Awaited<ReturnType<typeof boot>>, packId = "pack5") {
  const c = await h.api("/api/checkout/create", { method: "POST", json: { packId } });
  if (c.status !== 200) throw new Error("checkout failed " + c.text);
  const page = await fetch(c.json.approveUrl);
  const html = await page.text();
  const action = /action="([^"]+)"/.exec(html)![1];
  const ret = new URL(action);
  ret.searchParams.set("token", c.json.orderId);
  ret.searchParams.set("PayerID", "SIMPAYER");
  return h.api(ret.pathname + ret.search);
}
