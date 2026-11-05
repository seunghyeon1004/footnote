import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { boot, buyCredits, waitDone, sleep } from "./helpers.js";

let h: Awaited<ReturnType<typeof boot>>;
beforeAll(async () => { h = await boot(); });
afterAll(() => h.close());

describe("end-to-end (simulator PayPal + fixture LLM)", () => {
  it("serves config and an empty wallet", async () => {
    const me = await h.api("/api/me");
    expect(me.json.user.balanceCents).toBe(0);
    expect(me.json.config.mode).toEqual({ paypal: "simulator", llm: "fixture", llmModel: "fixture", near: "off" });
    expect(me.json.config.demoSites).toHaveLength(7);
  });

  it("refuses to ask without credits (402)", async () => {
    const r = await h.api("/api/ask", { method: "POST", json: { question: "How do I compost indoors?", feeCents: 50 } });
    expect(r.status).toBe(402);
  });

  it("buys a $5 pack via Orders v2 create -> approve -> capture", async () => {
    const ret = await buyCredits(h);
    expect(ret.status).toBe(302);
    expect(ret.headers.get("location")).toContain("checkout=success&added=500");
    expect((await h.api("/api/me")).json.user.balanceCents).toBe(500);
    // replaying the return URL must not double-credit
    const o = h.db.prepare(`SELECT id FROM orders`).get() as any;
    await h.api(`/api/checkout/return?token=${o.id}`);
    expect((await h.api("/api/me")).json.user.balanceCents).toBe(500);
  });

  it("validates fee bounds", async () => {
    expect((await h.api("/api/ask", { method: "POST", json: { question: "valid question?", feeCents: 5 } })).status).toBe(400);
    expect((await h.api("/api/ask", { method: "POST", json: { question: "valid question?", feeCents: 5000 } })).status).toBe(400);
  });

  let first: any;
  it("answers, attributes, resolves payees, strips the injection, and pays through Payouts", async () => {
    const r = await h.api("/api/ask", { method: "POST", json: { question: "How can I compost in a small apartment?", feeCents: 50 } });
    expect(r.status).toBe(202);
    first = await waitDone(h.api, r.json.answerId);
    expect(first.status).toBe("done");
    expect(first.llm.fixture).toBe(true);
    expect(first.answerMarkdown).toMatch(/\[1\]/);

    const by = Object.fromEntries(first.sources.map((s: any) => [s.domain, s]));
    // payee resolution, one per branch
    expect(by["compost-diaries.demo"].payee.method).toBe("meta_tag");
    expect(by["compost-diaries.demo"].payee.email).toBe("compost-diaries@footnote-demo.test");
    expect(by["worm-bin-weekly.demo"].payee.method).toBe("footnote_json");
    expect(by["open-compost-toolkit.demo"].payee.method).toBe("funding_yml");
    expect(by["bokashi-bench.demo"].payee.method).toBe("paypal_me");
    expect(by["garden-gnome-gazette.demo"].payee.method).toBe("none");

    // threshold drop + exact normalization
    expect(by["almanac-reprints.demo"].dropped).toBe(true);
    const kept = first.sources.filter((s: any) => !s.dropped);
    expect(kept.reduce((a: number, s: any) => a + s.shareCents, 0)).toBe(50);
    expect(kept.reduce((a: number, s: any) => a + s.sharePct, 0)).toBeCloseTo(100, 0);

    // prompt injection: flagged, penalised, redirected payee ignored
    const evil = by["quick-compost-hacks.demo"];
    expect(evil.flagged).toBe(true);
    expect(evil.flags.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(first)).not.toContain("evil.example\"}"); // payee never taken from page text
    expect(evil.payee.email).toBeNull();
    expect(evil.shareCents).toBeLessThan(by["compost-diaries.demo"].shareCents);
    expect(evil.payoutStatus).toBe("ESCROW");

    // payment states
    expect(by["garden-gnome-gazette.demo"].payoutStatus).toBe("ESCROW");
    expect(by["bokashi-bench.demo"].payoutStatus).toBe("LINK_ONLY");
    expect(["PENDING", "SUCCESS"]).toContain(by["compost-diaries.demo"].payoutStatus);
    expect(by["compost-diaries.demo"].payoutBatchId).toBeTruthy();
    expect(first.receipt.settledBy).toBe("deterministic");
    expect(first.receipt.paidToSourcesCents + first.receipt.refundedCents).toBe(50);
    expect(first.balanceCents).toBe(450);
  });

  it("completes payout status via the PayPal webhook", async () => {
    await sleep(1800); // simulator delivers PAYMENT.PAYOUTS-ITEM.SUCCEEDED ~1.2s after batch creation
    const v = (await h.api(`/api/answers/${first.id}`)).json;
    const by = Object.fromEntries(v.sources.map((s: any) => [s.domain, s]));
    expect(by["compost-diaries.demo"].payoutStatus).toBe("SUCCESS");
    expect(by["worm-bin-weekly.demo"].payoutStatus).toBe("SUCCESS");
    const wh = h.db.prepare(`SELECT COUNT(*) n FROM webhook_events`).get() as any;
    expect(wh.n).toBeGreaterThanOrEqual(2);
  });

  it("webhook endpoint is idempotent and rejects junk", async () => {
    const ev = { id: "WH-TEST-1", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_item_id: "nope", payout_item: { sender_item_id: "nope" } } };
    expect((await h.api("/api/webhooks/paypal", { method: "POST", json: ev })).json).toMatchObject({ ok: true, applied: false });
    expect((await h.api("/api/webhooks/paypal", { method: "POST", json: ev })).json).toMatchObject({ duplicate: true });
    expect((await h.api("/api/webhooks/paypal", { method: "POST", body: "nope" })).status).toBe(400);
  });

  it("creator dashboard shows earnings and citing answers", async () => {
    const c = (await h.api("/api/creators/compost-diaries.demo")).json;
    expect(c.earnedCents).toBeGreaterThan(0);
    expect(c.answers[0]).toMatchObject({ answerId: first.id });
    expect(c.payouts[0].status).toBe("SUCCESS");
    const g = (await h.api("/api/creators/garden-gnome-gazette.demo")).json;
    expect(g).toMatchObject({ claimable: true, payeeMethod: "none" });
    expect(g.escrowCents).toBeGreaterThan(0);
    const board = (await h.api("/api/creators")).json;
    expect(board.length).toBeGreaterThanOrEqual(6);
  });

  it("claim fails honestly when the domain has no declaration", async () => {
    const r = await h.api("/api/claim", { method: "POST", json: { domain: "garden-gnome-gazette.demo" } });
    expect(r.json.ok).toBe(false);
    expect(r.json.message).toMatch(/footnote:paypal/);
  });

  it("excludes the asker's own domain (self-citation)", async () => {
    const r = await h.api("/api/ask", { method: "POST", json: { question: "Bokashi or worms for a tiny kitchen?", feeCents: 25, ownDomain: "compost-diaries.demo" } });
    const v = await waitDone(h.api, r.json.answerId);
    const own = v.sources.find((s: any) => s.domain === "compost-diaries.demo");
    expect(own.dropped).toBe(true);
    expect(own.dropReason).toMatch(/self-citation/);
    expect(v.sources.filter((s: any) => !s.dropped).reduce((a: number, s: any) => a + s.shareCents, 0)).toBe(25);
  });

  it("settle-now pays payees that crossed the minimum since", async () => {
    const r = await h.api("/api/settle", { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty("message");
  });

  it("sweeps expired escrow back to the asker", async () => {
    const before = (await h.api("/api/me")).json.user.balanceCents;
    const r = await h.api("/api/escrow/sweep", { method: "POST", json: { ttlDays: 0 } });
    expect(r.json.refundedCents).toBeGreaterThan(0);
    expect((await h.api("/api/me")).json.user.balanceCents).toBe(before + r.json.refundedCents);
    const L = (await h.api("/api/ledger")).json;
    expect(L.refundedCents).toBe(r.json.refundedCents);
    expect(L.escrowCents).toBe(0);
  });

  it("serves demo sites incl. dotfile paths and blocks traversal", async () => {
    expect((await h.api("/demo-sites/worm-bin-weekly/.well-known/footnote.json")).json.version).toBe(1);
    expect((await h.api("/demo-sites/open-compost-toolkit/.github/FUNDING.yml")).text).toContain("paypal.me/opencompost");
    expect((await h.api("/demo-sites/%2e%2e/%2e%2e/package.json")).status).toBe(404);
  });
});
