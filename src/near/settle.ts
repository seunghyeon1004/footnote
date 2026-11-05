import crypto from "node:crypto";
import type { DB } from "../db.js";
import { now, rid } from "../db.js";
import { SettlementError } from "../ledger.js";
import { isNearAccountId } from "./account.js";
import type { NearClient } from "./client.js";
import { centsToYocto, type RateProvider } from "./rate.js";

export interface NearSettleable {
  account: string;
  cents: number;
  domains: string[];
  accrualIds: number[];
}
export interface NearItem {
  account: string;
  cents: number;
}
export interface NearPayoutResult {
  id: string;
  account: string;
  cents: number;
  yocto: string;
  status: "SUCCESS" | "FAILED";
  txHash: string | null;
  receiptTx: string | null;
  receiptStatus: string;
  error: string | null;
}
export interface NearDeps {
  db: DB;
  near: NearClient;
  rate: RateProvider;
  minPayoutCents: number;
  maxPayoutCents: number;
  /** Refuse to move real money on mainnet unless explicitly allowed. */
  allowMainnet: boolean;
}

/** ACCRUED micro-royalties on the NEAR rail, aggregated per NEAR account. */
export function listSettleableNear(db: DB, minCents: number): NearSettleable[] {
  const rows = db
    .prepare(`SELECT id,near_account,domain,cents FROM accruals WHERE status='ACCRUED' AND rail='near' AND near_account IS NOT NULL ORDER BY id`)
    .all() as { id: number; near_account: string; domain: string; cents: number }[];
  const by = new Map<string, NearSettleable>();
  for (const r of rows) {
    const p = by.get(r.near_account) ?? { account: r.near_account, cents: 0, domains: [], accrualIds: [] };
    p.cents += r.cents;
    if (!p.domains.includes(r.domain)) p.domains.push(r.domain);
    p.accrualIds.push(r.id);
    by.set(r.near_account, p);
  }
  return [...by.values()].filter((p) => p.cents >= minCents).sort((a, b) => b.cents - a.cents);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Guardrailed NEAR payout. Same contract as the PayPal path: the caller (agent or deterministic code) chooses WHO,
 * the ledger decides WHETHER. Each item must be a valid NEAR account with a settleable balance, amount must equal the
 * whole outstanding balance, per-payout cap applies. Accruals are reserved (ACCRUED -> PENDING) before any money moves,
 * and released again if the chain rejects the transfer, so a failure never loses or double-pays a royalty.
 * After a successful transfer an on-chain receipt is logged (best effort, retried later if it fails).
 */
export async function createNearPayouts(
  deps: NearDeps,
  items: NearItem[],
  settledBy: "agent" | "deterministic",
  opts: { ignoreMin?: boolean } = {}
): Promise<NearPayoutResult[]> {
  const { db, near } = deps;
  if (near.network === "mainnet" && !deps.allowMainnet) throw new SettlementError("NEAR mainnet payouts are disabled (set NEAR_ALLOW_MAINNET=1 to enable)");
  if (!items.length) throw new SettlementError("no items");
  const settleable = new Map(listSettleableNear(db, opts.ignoreMin ? 1 : deps.minPayoutCents).map((p) => [p.account, p]));
  const seen = new Set<string>();
  const chosen: NearSettleable[] = [];
  for (const it of items) {
    const account = String(it.account ?? "").trim().toLowerCase();
    if (!isNearAccountId(account)) throw new SettlementError(`${JSON.stringify(it.account)} is not a valid NEAR account id`);
    if (seen.has(account)) throw new SettlementError(`duplicate payee ${account}`);
    seen.add(account);
    const p = settleable.get(account);
    if (!p) throw new SettlementError(`${account} has no settleable NEAR balance (unknown payee or below the ${deps.minPayoutCents}c minimum)`);
    if (it.cents !== p.cents) throw new SettlementError(`amount for ${account} must equal the full outstanding balance of ${p.cents}c (got ${it.cents}c)`);
    if (p.cents > deps.maxPayoutCents) throw new SettlementError(`payout of ${p.cents}c to ${account} exceeds the per-payout cap of ${deps.maxPayoutCents}c`);
    chosen.push(p);
  }
  const q = await deps.rate.quote(); // throws if no trustworthy price: nothing is reserved or paid

  const out: NearPayoutResult[] = [];
  for (const p of chosen) {
    const id = rid("nfp");
    const yocto = centsToYocto(p.cents, q.usdPerNear);
    const t = now();
    const accr = db.prepare(`SELECT id,answer_id,domain,cents FROM accruals WHERE id IN (${p.accrualIds.map(() => "?").join(",")}) ORDER BY id`).all(...p.accrualIds) as { id: number; answer_id: string; domain: string; cents: number }[];
    const answerIds = [...new Set(accr.map((a) => a.answer_id))];
    const splitHash = sha256(JSON.stringify(accr.map((a) => [a.answer_id, a.domain, a.cents])));
    const base = { id, account: p.account, cents: p.cents, yocto: yocto.toString() };

    if (!(await near.accountExists(p.account).catch(() => false))) {
      out.push({ ...base, status: "FAILED", txHash: null, receiptTx: null, receiptStatus: "NONE", error: `NEAR account ${p.account} does not exist on ${near.network}; royalty stays accrued` });
      continue;
    }
    // Reserve first (ACCRUED -> PENDING) so a concurrent settle cannot pay the same royalty twice.
    const reserved = db.transaction(() => {
      const ch = db.prepare(`UPDATE accruals SET status='PENDING', item_sid=?, updated_at=? WHERE id IN (${p.accrualIds.map(() => "?").join(",")}) AND status='ACCRUED'`).run(id, t, ...p.accrualIds).changes;
      if (ch !== p.accrualIds.length) throw new Error("accruals changed while settling");
      db.prepare(`INSERT INTO near_payouts(id,near_account,cents,yocto,usd_per_near,rate_source,network,status,split_hash,answer_ids,settled_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, p.account, p.cents, base.yocto, q.usdPerNear, q.source, near.network, "PENDING", splitHash, JSON.stringify(answerIds), settledBy, t, t);
    });
    try { reserved(); } catch (e) { out.push({ ...base, status: "FAILED", txHash: null, receiptTx: null, receiptStatus: "NONE", error: (e as Error).message }); continue; }

    try {
      const { txHash } = await near.transfer(p.account, yocto);
      db.transaction(() => {
        db.prepare(`UPDATE near_payouts SET status='SUCCESS', tx_hash=?, updated_at=? WHERE id=?`).run(txHash, now(), id);
        db.prepare(`UPDATE accruals SET status='SUCCESS', updated_at=? WHERE item_sid=?`).run(now(), id);
      })();
      const r = await logReceiptFor(deps, id);
      out.push({ ...base, status: "SUCCESS", txHash, receiptTx: r.tx, receiptStatus: r.status, error: null });
    } catch (e) {
      db.transaction(() => {
        db.prepare(`UPDATE accruals SET status='ACCRUED', item_sid=NULL, updated_at=? WHERE item_sid=?`).run(now(), id);
        db.prepare(`UPDATE near_payouts SET status='FAILED', error=?, updated_at=? WHERE id=?`).run((e as Error).message.slice(0, 500), now(), id);
      })();
      out.push({ ...base, status: "FAILED", txHash: null, receiptTx: null, receiptStatus: "NONE", error: (e as Error).message });
    }
  }
  return out;
}

/** Write the on-chain receipt for one successful payout. Never throws: the payout already happened. */
export async function logReceiptFor(deps: Pick<NearDeps, "db" | "near">, payoutId: string): Promise<{ status: string; tx: string | null }> {
  const { db, near } = deps;
  const row = db.prepare(`SELECT * FROM near_payouts WHERE id=?`).get(payoutId) as any;
  if (!row || row.status !== "SUCCESS" || !row.tx_hash) return { status: "NONE", tx: null };
  if (!near.receiptContract) {
    db.prepare(`UPDATE near_payouts SET receipt_status='SKIPPED', updated_at=? WHERE id=?`).run(now(), payoutId);
    return { status: "SKIPPED", tx: null };
  }
  try {
    const ids: string[] = JSON.parse(row.answer_ids ?? "[]");
    const joined = ids.join(",");
    const answerId = joined.length <= 256 ? joined : `${ids[0]}+${ids.length - 1}`;
    const { txHash } = await near.logReceipt({ payee: row.near_account, answerId, usdCents: row.cents, yocto: BigInt(row.yocto), payoutTx: row.tx_hash, splitHash: row.split_hash });
    db.prepare(`UPDATE near_payouts SET receipt_status='LOGGED', receipt_tx=?, updated_at=? WHERE id=?`).run(txHash, now(), payoutId);
    return { status: "LOGGED", tx: txHash };
  } catch (e) {
    db.prepare(`UPDATE near_payouts SET receipt_status='FAILED', error=?, updated_at=? WHERE id=?`).run(`receipt: ${(e as Error).message}`.slice(0, 500), now(), payoutId);
    return { status: "FAILED", tx: null };
  }
}

/** Retry on-chain receipts that failed earlier (call at the start of a settlement run). Returns how many were logged. */
export async function retryPendingReceipts(deps: Pick<NearDeps, "db" | "near">): Promise<number> {
  const rows = deps.db.prepare(`SELECT id FROM near_payouts WHERE status='SUCCESS' AND receipt_status='FAILED' ORDER BY created_at LIMIT 20`).all() as { id: string }[];
  let n = 0;
  for (const r of rows) if ((await logReceiptFor(deps, r.id)).status === "LOGGED") n++;
  return n;
}
