import { describe, it, expect, beforeEach } from "vitest";
import { openDb, now, type DB } from "../src/db.js";
import { recordAccrual, listSettleable, createPayoutBatch, applyItemStatus, sweepEscrow, creatorSummaries, SettlementError } from "../src/ledger.js";
import type { PayPalClient } from "../src/paypal/client.js";
import type { Payee } from "../src/payee.js";

const email = (e: string): Payee => ({ method: "meta_tag", label: "m", email: e, paypalMe: null, evidenceUrl: null });
const NO: Payee = { method: "none", label: "", email: null, paypalMe: null, evidenceUrl: null };
const ME: Payee = { method: "paypal_me", label: "", email: null, paypalMe: "x", evidenceUrl: null };

let db: DB;
let calls: any[];
let fail = false;
const paypal = {
  async createPayoutBatch(a: any) {
    calls.push(a);
    if (fail) throw new Error("boom");
    return { batchId: "PB" + calls.length, status: "PENDING" };
  },
} as unknown as PayPalClient;
const deps = () => ({ db, paypal, minPayoutCents: 100, maxBatchCents: 1000 });

let sid = 0;
function accrue(domain: string, p: Payee, cents: number, answerId = "a1") {
  db.prepare(`INSERT OR IGNORE INTO creators(domain,label,root,payee_method,email,updated_at) VALUES (?,?,?,?,?,?)`).run(domain, domain, "http://x/", p.method, p.email, now());
  const info = db.prepare(`INSERT INTO sources(answer_id,n,url,title,domain,share_cents) VALUES (?,?,?,?,?,?)`).run(answerId, ++sid, "http://x", "t", domain, cents);
  return recordAccrual(db, { sourceId: Number(info.lastInsertRowid), answerId, domain, cents, payee: p });
}

beforeEach(() => {
  db = openDb(":memory:");
  calls = [];
  fail = false;
  db.prepare(`INSERT INTO users(id,name,balance_cents,created_at) VALUES ('u1','g',0,?)`).run(now());
  db.prepare(`INSERT INTO answers(id,user_id,question,fee_cents,status,created_at) VALUES ('a1','u1','q',50,'done',?)`).run(now());
});

describe("ledger aggregation", () => {
  it("routes by payee type", () => {
    expect(accrue("a.com", email("a@a.com"), 20)).toBe("ACCRUED");
    expect(accrue("b.com", NO, 10)).toBe("ESCROW");
    expect(accrue("c.com", ME, 5)).toBe("LINK_ONLY");
  });
  it("aggregates micro-amounts per payee until the $1 minimum", () => {
    for (let i = 0; i < 4; i++) accrue("a.com", email("a@a.com"), 20);
    expect(listSettleable(db, 100)).toEqual([]); // 80c < $1
    accrue("a2.com", email("a@a.com"), 25); // different domain, same payee email
    const s = listSettleable(db, 100);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ email: "a@a.com", cents: 105 });
    expect(s[0].domains.sort()).toEqual(["a.com", "a2.com"]);
  });
});

describe("createPayoutBatch guardrails", () => {
  it("pays the full balance in one batch and marks accruals PENDING", async () => {
    accrue("a.com", email("a@a.com"), 60);
    accrue("a.com", email("a@a.com"), 60);
    const r = await createPayoutBatch(deps(), [{ email: "a@a.com", cents: 120 }], "agent");
    expect(r).toMatchObject({ batchId: "PB1", itemCount: 1, totalCents: 120 });
    expect(calls[0].items[0]).toMatchObject({ email: "a@a.com", cents: 120 });
    expect(db.prepare(`SELECT DISTINCT status FROM accruals`).all()).toEqual([{ status: "PENDING" }]);
    expect(db.prepare(`SELECT settled_by FROM payout_batches`).get()).toEqual({ settled_by: "agent" });
    expect(listSettleable(db, 1)).toEqual([]); // cannot double pay
  });
  it("rejects payees that are unknown or below the minimum (agent cannot invent recipients)", async () => {
    accrue("a.com", email("a@a.com"), 50);
    await expect(createPayoutBatch(deps(), [{ email: "evil@x.co", cents: 100 }], "agent")).rejects.toBeInstanceOf(SettlementError);
    await expect(createPayoutBatch(deps(), [{ email: "a@a.com", cents: 50 }], "agent")).rejects.toThrow(/minimum/);
    expect(calls).toHaveLength(0);
  });
  it("rejects amounts that differ from the outstanding balance", async () => {
    accrue("a.com", email("a@a.com"), 150);
    await expect(createPayoutBatch(deps(), [{ email: "a@a.com", cents: 9999 }], "agent")).rejects.toThrow(/full outstanding/);
    await expect(createPayoutBatch(deps(), [{ email: "a@a.com", cents: 100 }], "agent")).rejects.toThrow(/full outstanding/);
  });
  it("enforces the batch cap and duplicates", async () => {
    accrue("a.com", email("a@a.com"), 700);
    accrue("b.com", email("b@b.com"), 700);
    await expect(createPayoutBatch(deps(), [{ email: "a@a.com", cents: 700 }, { email: "b@b.com", cents: 700 }], "agent")).rejects.toThrow(/cap/);
    await expect(createPayoutBatch(deps(), [{ email: "a@a.com", cents: 700 }, { email: "A@a.com", cents: 700 }], "agent")).rejects.toThrow(/duplicate/);
  });
  it("releases the reservation when PayPal fails", async () => {
    accrue("a.com", email("a@a.com"), 150);
    fail = true;
    await expect(createPayoutBatch(deps(), [{ email: "a@a.com", cents: 150 }], "deterministic")).rejects.toThrow(/PayPal payout failed/);
    expect(db.prepare(`SELECT status FROM accruals`).get()).toEqual({ status: "ACCRUED" });
    expect(db.prepare(`SELECT COUNT(*) n FROM payout_items`).get()).toEqual({ n: 0 });
    fail = false;
    await expect(createPayoutBatch(deps(), [{ email: "a@a.com", cents: 150 }], "deterministic")).resolves.toBeTruthy();
  });
  it("ignoreMin allows claim payouts below the minimum", async () => {
    accrue("a.com", email("a@a.com"), 30);
    await expect(createPayoutBatch(deps(), [{ email: "a@a.com", cents: 30 }], "deterministic", { ignoreMin: true })).resolves.toBeTruthy();
  });
});

describe("payout status tracking", () => {
  it("applies webhook/poll updates idempotently and rolls up the batch", async () => {
    accrue("a.com", email("a@a.com"), 100);
    accrue("b.com", email("b@b.com"), 100);
    await createPayoutBatch(deps(), [{ email: "a@a.com", cents: 100 }, { email: "b@b.com", cents: 100 }], "deterministic");
    const items = db.prepare(`SELECT sender_item_id, email FROM payout_items ORDER BY email`).all() as any[];
    expect(applyItemStatus(db, { senderItemId: items[0].sender_item_id }, "SUCCESS", "PI1")).toBe(true);
    expect(applyItemStatus(db, { senderItemId: items[0].sender_item_id }, "SUCCESS", "PI1")).toBe(false);
    expect(db.prepare(`SELECT status FROM payout_batches`).get()).toEqual({ status: "PENDING" });
    applyItemStatus(db, { payoutItemId: "PI1" }, "SUCCESS");
    applyItemStatus(db, { senderItemId: items[1].sender_item_id }, "UNCLAIMED", "PI2");
    expect(db.prepare(`SELECT status FROM payout_batches`).get()).toEqual({ status: "SUCCESS" });
    const st = db.prepare(`SELECT domain,status FROM accruals ORDER BY domain`).all();
    expect(st).toEqual([{ domain: "a.com", status: "SUCCESS" }, { domain: "b.com", status: "UNCLAIMED" }]);
  });
  it("ignores unknown items", () => {
    expect(applyItemStatus(db, { senderItemId: "nope" }, "SUCCESS")).toBe(false);
  });
});

describe("escrow", () => {
  it("sweeps expired escrow back to the asker's credits", () => {
    accrue("b.com", NO, 12);
    accrue("c.com", ME, 8);
    accrue("a.com", email("a@a.com"), 30);
    expect(sweepEscrow(db, 30)).toEqual({ refundedCents: 0, count: 0 }); // not expired
    expect(sweepEscrow(db, 0)).toEqual({ refundedCents: 20, count: 2 });
    expect(db.prepare(`SELECT balance_cents b FROM users`).get()).toEqual({ b: 20 });
    expect(db.prepare(`SELECT status FROM accruals WHERE domain='a.com'`).get()).toEqual({ status: "ACCRUED" });
  });
  it("summarizes creators", () => {
    accrue("b.com", NO, 12);
    accrue("a.com", email("a@a.com"), 30);
    const s = creatorSummaries(db);
    expect(s.find((x) => x.domain === "b.com")).toMatchObject({ escrowCents: 12, earnedCents: 0 });
    expect(s.find((x) => x.domain === "a.com")).toMatchObject({ pendingCents: 30 });
  });
});
