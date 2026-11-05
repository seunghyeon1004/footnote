import type { DB } from "./db.js";
import { now, rid } from "./db.js";
import type { PayPalClient } from "./paypal/client.js";
import type { Payee } from "./payee.js";

export type PayoutStatus = "ACCRUED" | "PENDING" | "SUCCESS" | "UNCLAIMED" | "ESCROW" | "FAILED" | "LINK_ONLY" | "REFUNDED";

export interface AccrualInput {
  sourceId: number;
  answerId: string;
  domain: string;
  cents: number;
  payee: Payee;
  /** Payout rail chosen by the caller. "near" pays `payee.near` in NEAR; default "paypal". */
  rail?: "paypal" | "near";
}

/** Record what a source earned. Email payee -> ACCRUED; paypal.me only -> LINK_ONLY; nobody -> ESCROW. NEAR rail: declared account -> ACCRUED. */
export function recordAccrual(db: DB, a: AccrualInput): PayoutStatus {
  const near = a.rail === "near" && a.payee.near ? a.payee.near : null;
  const status: PayoutStatus = near || a.payee.email ? "ACCRUED" : a.payee.paypalMe ? "LINK_ONLY" : "ESCROW";
  const t = now();
  db.prepare(
    `INSERT INTO accruals(source_id,answer_id,domain,email,cents,status,rail,near_account,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(a.sourceId, a.answerId, a.domain, near ? null : a.payee.email, a.cents, status, near ? "near" : "paypal", near, t, t);
  return status;
}

export interface SettleablePayee {
  email: string;
  cents: number;
  domains: string[];
  accrualIds: number[];
}

/** Aggregate ACCRUED micro-royalties per payee email; only those at/above `minCents` are payable now. */
export function listSettleable(db: DB, minCents: number): SettleablePayee[] {
  const rows = db
    .prepare(`SELECT id,email,domain,cents FROM accruals WHERE status='ACCRUED' AND rail='paypal' AND email IS NOT NULL ORDER BY id`)
    .all() as { id: number; email: string; domain: string; cents: number }[];
  const by = new Map<string, SettleablePayee>();
  for (const r of rows) {
    const p = by.get(r.email) ?? { email: r.email, cents: 0, domains: [], accrualIds: [] };
    p.cents += r.cents;
    if (!p.domains.includes(r.domain)) p.domains.push(r.domain);
    p.accrualIds.push(r.id);
    by.set(r.email, p);
  }
  return [...by.values()].filter((p) => p.cents >= minCents).sort((a, b) => b.cents - a.cents);
}

export interface BatchItem {
  email: string;
  cents: number;
}
export interface BatchResult {
  batchId: string;
  status: string;
  itemCount: number;
  totalCents: number;
}
export class SettlementError extends Error {}

export interface PayoutDeps {
  db: DB;
  paypal: PayPalClient;
  minPayoutCents: number;
  maxBatchCents: number;
}

/**
 * Guardrailed batch payout. This is the ONLY code path that moves money out, and it is what the
 * settlement agent's `create_payout_batch` tool calls: the agent chooses *who*, the ledger decides *whether*.
 * Rules: email must have settleable ACCRUED balance; amount must equal that whole balance; each item >= min
 * (unless `ignoreMin`, used for domain-claims); batch total <= maxBatchCents.
 */
export async function createPayoutBatch(
  deps: PayoutDeps,
  items: BatchItem[],
  settledBy: "agent" | "deterministic",
  opts: { ignoreMin?: boolean } = {}
): Promise<BatchResult> {
  const { db, paypal } = deps;
  if (!items.length) throw new SettlementError("no items");
  const seen = new Set<string>();
  const settleable = new Map(listSettleable(db, opts.ignoreMin ? 1 : deps.minPayoutCents).map((p) => [p.email, p]));
  let total = 0;
  const chosen: SettleablePayee[] = [];
  for (const it of items) {
    const email = it.email.trim().toLowerCase();
    if (seen.has(email)) throw new SettlementError(`duplicate payee ${email}`);
    seen.add(email);
    const p = settleable.get(email);
    if (!p) throw new SettlementError(`${email} has no settleable balance (unknown payee or below the ${deps.minPayoutCents}c minimum)`);
    if (it.cents !== p.cents) throw new SettlementError(`amount for ${email} must equal the full outstanding balance of ${p.cents}c (got ${it.cents}c)`);
    total += p.cents;
    chosen.push(p);
  }
  if (total > deps.maxBatchCents) throw new SettlementError(`batch total ${total}c exceeds cap ${deps.maxBatchCents}c`);

  const senderBatchId = rid("fnb");
  const t = now();
  const itemSids = chosen.map(() => rid("fni"));
  // Reserve first (ACCRUED -> PENDING) inside one transaction so concurrent calls cannot double-pay.
  db.transaction(() => {
    chosen.forEach((p, i) => {
      db.prepare(`UPDATE accruals SET status='PENDING', item_sid=?, updated_at=? WHERE id IN (${p.accrualIds.map(() => "?").join(",")}) AND status='ACCRUED'`).run(itemSids[i], t, ...p.accrualIds);
      db.prepare(`INSERT INTO payout_items(sender_item_id,batch_id,email,cents,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(itemSids[i], senderBatchId, p.email, p.cents, "PENDING", t, t);
    });
  })();

  try {
    const res = await paypal.createPayoutBatch({
      senderBatchId,
      emailSubject: "You were cited — Footnote royalty",
      emailMessage: "An AI answer used your work as a source. Footnote paid you your share of the knowledge fee.",
      items: chosen.map((p, i) => ({ senderItemId: itemSids[i], email: p.email, cents: p.cents, note: `Footnote royalty: ${p.domains.join(", ")}` })),
    });
    db.transaction(() => {
      db.prepare(`UPDATE payout_items SET batch_id=?, updated_at=? WHERE batch_id=?`).run(res.batchId, now(), senderBatchId);
      db.prepare(`INSERT INTO payout_batches(batch_id,sender_batch_id,status,total_cents,settled_by,created_at) VALUES (?,?,?,?,?,?)`).run(res.batchId, senderBatchId, res.status, total, settledBy, t);
    })();
    return { batchId: res.batchId, status: res.status, itemCount: chosen.length, totalCents: total };
  } catch (e) {
    // PayPal rejected / network failure: release the reservation so nothing is lost or stuck.
    db.transaction(() => {
      for (const sid of itemSids) {
        db.prepare(`UPDATE accruals SET status='ACCRUED', item_sid=NULL, updated_at=? WHERE item_sid=?`).run(now(), sid);
        db.prepare(`DELETE FROM payout_items WHERE sender_item_id=?`).run(sid);
      }
    })();
    throw new SettlementError(`PayPal payout failed: ${(e as Error).message}`);
  }
}

/** PayPal transaction_status / webhook event -> our public status. */
export function mapPayPalStatus(s: string): PayoutStatus {
  switch (s.toUpperCase()) {
    case "SUCCESS": case "SUCCEEDED": return "SUCCESS";
    case "UNCLAIMED": return "UNCLAIMED";
    case "PENDING": case "ONHOLD": case "HELD": case "PROCESSING": return "PENDING";
    case "REFUNDED": case "RETURNED": case "REVERSED": return "REFUNDED";
    default: return "FAILED"; // FAILED, BLOCKED, DENIED, CANCELED
  }
}

/** Apply a payout-item status update (from webhook or polling). Idempotent. Returns true if anything changed. */
export function applyItemStatus(db: DB, ref: { senderItemId?: string; payoutItemId?: string }, paypalStatus: string, payoutItemId?: string): boolean {
  const status = mapPayPalStatus(paypalStatus);
  const item = ref.senderItemId
    ? (db.prepare(`SELECT * FROM payout_items WHERE sender_item_id=?`).get(ref.senderItemId) as any)
    : (db.prepare(`SELECT * FROM payout_items WHERE payout_item_id=?`).get(ref.payoutItemId) as any);
  if (!item) return false;
  const changed = item.status !== status || (payoutItemId && item.payout_item_id !== payoutItemId);
  const t = now();
  db.transaction(() => {
    db.prepare(`UPDATE payout_items SET status=?, payout_item_id=COALESCE(?,payout_item_id), updated_at=? WHERE sender_item_id=?`).run(status, payoutItemId ?? null, t, item.sender_item_id);
    db.prepare(`UPDATE accruals SET status=?, updated_at=? WHERE item_sid=?`).run(status, t, item.sender_item_id);
    const all = db.prepare(`SELECT status FROM payout_items WHERE batch_id=?`).all(item.batch_id) as { status: string }[];
    const done = all.every((x) => x.status !== "PENDING");
    db.prepare(`UPDATE payout_batches SET status=? WHERE batch_id=?`).run(done ? "SUCCESS" : "PENDING", item.batch_id);
  })();
  return !!changed;
}

/** Poll PayPal for every batch that still has PENDING items. */
export async function refreshPendingBatches(db: DB, paypal: PayPalClient): Promise<number> {
  const batches = db.prepare(`SELECT DISTINCT batch_id FROM payout_items WHERE status='PENDING' AND batch_id NOT LIKE 'fnb_%'`).all() as { batch_id: string }[];
  let updated = 0;
  for (const b of batches) {
    try {
      const r = await paypal.getPayoutBatch(b.batch_id);
      for (const it of r.items) {
        if (applyItemStatus(db, { senderItemId: it.senderItemId }, it.status, it.payoutItemId)) updated++;
      }
    } catch {
      /* transient; next poll */
    }
  }
  return updated;
}

/** Escrow older than the TTL goes back to the asker's credits. */
export function sweepEscrow(db: DB, ttlDays: number): { refundedCents: number; count: number } {
  const cutoff = new Date(Date.now() - ttlDays * 86400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT a.id, a.cents, ans.user_id FROM accruals a JOIN answers ans ON ans.id=a.answer_id
       WHERE a.status IN ('ESCROW','LINK_ONLY') AND a.created_at <= ?`
    )
    .all(cutoff) as { id: number; cents: number; user_id: string }[];
  let sum = 0;
  db.transaction(() => {
    for (const r of rows) {
      db.prepare(`UPDATE accruals SET status='REFUNDED', updated_at=? WHERE id=?`).run(now(), r.id);
      db.prepare(`UPDATE users SET balance_cents = balance_cents + ? WHERE id=?`).run(r.cents, r.user_id);
      sum += r.cents;
    }
  })();
  return { refundedCents: sum, count: rows.length };
}

export interface CreatorSummary {
  domain: string;
  label: string;
  earnedCents: number;
  pendingCents: number;
  escrowCents: number;
  answers: number;
}

export function creatorSummaries(db: DB): CreatorSummary[] {
  return db
    .prepare(
      `SELECT c.domain, COALESCE(c.label,c.domain) AS label,
        COALESCE(SUM(CASE WHEN a.status IN ('SUCCESS','PENDING','UNCLAIMED') THEN a.cents END),0) AS earnedCents,
        COALESCE(SUM(CASE WHEN a.status='ACCRUED' THEN a.cents END),0) AS pendingCents,
        COALESCE(SUM(CASE WHEN a.status IN ('ESCROW','LINK_ONLY') THEN a.cents END),0) AS escrowCents,
        COUNT(DISTINCT a.answer_id) AS answers
       FROM creators c LEFT JOIN accruals a ON a.domain=c.domain GROUP BY c.domain
       HAVING answers > 0 ORDER BY earnedCents+pendingCents+escrowCents DESC`
    )
    .all() as CreatorSummary[];
}

export function globalLedger(db: DB) {
  const sum = (where: string) => (db.prepare(`SELECT COALESCE(SUM(cents),0) AS s FROM accruals WHERE ${where}`).get() as { s: number }).s;
  return {
    totalFeesCents: (db.prepare(`SELECT COALESCE(SUM(fee_cents),0) AS s FROM answers WHERE status='done'`).get() as { s: number }).s,
    paidCents: sum(`status IN ('SUCCESS','PENDING','UNCLAIMED')`),
    accruedCents: sum(`status='ACCRUED'`),
    escrowCents: sum(`status IN ('ESCROW','LINK_ONLY')`),
    refundedCents: sum(`status='REFUNDED'`),
    batches: (db.prepare(`SELECT b.batch_id AS batchId, b.status, b.total_cents AS totalCents, b.created_at AS createdAt, b.settled_by AS settledBy,
        (SELECT COUNT(*) FROM payout_items i WHERE i.batch_id=b.batch_id) AS itemCount FROM payout_batches b ORDER BY b.created_at DESC LIMIT 50`).all()),
  };
}
