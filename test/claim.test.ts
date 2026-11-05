import { describe, it, expect } from "vitest";
import { openDb, now } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { PayPalClient } from "../src/paypal/client.js";
import { fixtureLLM } from "../src/llm/fixture.js";
import { claimDomain, type Ctx } from "../src/service.js";
import { recordAccrual } from "../src/ledger.js";

describe("domain claim", () => {
  function setup(siteFiles: Record<string, string>) {
    const db = openDb(":memory:");
    const payouts: any[] = [];
    const paypal = { async createPayoutBatch(a: any) { payouts.push(a); return { batchId: "PBX", status: "PENDING" }; } } as unknown as PayPalClient;
    const fetcher = async (url: string) => ({ url, status: url in siteFiles ? 200 : 404, contentType: "text/html", body: siteFiles[url] ?? "" });
    const ctx: Ctx = { cfg: loadConfig({ MIN_PAYOUT_CENTS: "100" } as any), db, paypal, llm: fixtureLLM(), fetcher, settleLock: Promise.resolve() };
    db.prepare(`INSERT INTO users(id,name,balance_cents,created_at) VALUES ('u','g',0,?)`).run(now());
    db.prepare(`INSERT INTO answers(id,user_id,question,fee_cents,status,created_at) VALUES ('a','u','q',50,'done',?)`).run(now());
    db.prepare(`INSERT INTO creators(domain,label,root,payee_method,updated_at) VALUES ('gnome.test','Gnome','https://gnome.test/','none',?)`).run(now());
    for (let i = 1; i <= 2; i++) {
      const s = db.prepare(`INSERT INTO sources(answer_id,n,url,title,domain,share_cents) VALUES ('a',?,?,?,?,19)`).run(i, "https://gnome.test/p", "t", "gnome.test");
      recordAccrual(db, { sourceId: Number(s.lastInsertRowid), answerId: "a", domain: "gnome.test", cents: 19, payee: { method: "none", label: "", email: null, paypalMe: null, evidenceUrl: null } });
    }
    return { ctx, db, payouts };
  }

  it("verifies the meta tag, releases escrow, and pays immediately even below the $1 minimum", async () => {
    const { ctx, db, payouts } = setup({ "https://gnome.test/": `<meta name="footnote:paypal" content="owner@gnome.test">` });
    const r: any = await claimDomain(ctx, "gnome.test");
    expect(r).toMatchObject({ ok: true, verifiedEmail: "owner@gnome.test", releasedCents: 38 });
    expect(payouts[0].items[0]).toMatchObject({ email: "owner@gnome.test", cents: 38 });
    expect(db.prepare(`SELECT DISTINCT status FROM accruals`).all()).toEqual([{ status: "PENDING" }]);
    expect(db.prepare(`SELECT payee_method m, email e FROM creators`).get()).toEqual({ m: "meta_tag", e: "owner@gnome.test" });
    // second claim: nothing left
    expect((await claimDomain(ctx, "gnome.test")).ok).toBe(false);
  });

  it("works with /.well-known/footnote.json", async () => {
    const { ctx } = setup({ "https://gnome.test/": "<p>x</p>", "https://gnome.test/.well-known/footnote.json": '{"version":1,"paypal":{"email":"o@gnome.test"}}' });
    expect((await claimDomain(ctx, "gnome.test")).ok).toBe(true);
  });

  it("does not accept a paypal.me link as proof of domain control", async () => {
    const { ctx, payouts } = setup({ "https://gnome.test/": `<a href="https://paypal.me/thief">tip</a>` });
    const r = await claimDomain(ctx, "gnome.test");
    expect(r.ok).toBe(false);
    expect(payouts).toHaveLength(0);
  });

  it("rejects unknown domains", async () => {
    const { ctx } = setup({});
    expect((await claimDomain(ctx, "nope.test")).status).toBe(404);
  });
});
