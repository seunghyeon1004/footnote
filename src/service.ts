import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { now, rid } from "./db.js";
import type { PayPalClient } from "./paypal/client.js";
import type { LLM, PageRecord, ResearchCtx } from "./llm/types.js";
import type { Fetcher } from "./fetcher.js";
import { htmlToCleanText, stripInjection, isHostile } from "./sanitize.js";
import { allocate, type ScoredSource } from "./attribution.js";
import { resolvePayee, siteOf, type Payee, NONE } from "./payee.js";
import { recordAccrual, listSettleable, createPayoutBatch, SettlementError, type PayoutStatus, type BatchResult } from "./ledger.js";
import { DEMO_SITES } from "./demo.js";

export interface Ctx {
  cfg: Config;
  db: DB;
  paypal: PayPalClient;
  llm: LLM;
  fetcher: Fetcher;
  settleLock: Promise<unknown>;
}

const MAX_SOURCES = 8;

export function addEvent(db: DB, answerId: string, stage: string, message: string) {
  db.prepare(`INSERT INTO events(answer_id,t,stage,message) VALUES (?,?,?,?)`).run(answerId, now(), stage, message);
}
const setStatus = (db: DB, id: string, status: string, error?: string) =>
  db.prepare(`UPDATE answers SET status=?, error=? WHERE id=?`).run(status, error ?? null, id);

export function makePageFetcher(ctx: Ctx, budget = 14) {
  const cache = new Map<string, Promise<PageRecord>>();
  return (url: string): Promise<PageRecord> => {
    const abs = new URL(url, ctx.cfg.publicUrl).toString();
    let p = cache.get(abs);
    if (!p) {
      if (cache.size >= budget) return Promise.reject(new Error("page budget exhausted"));
      p = (async () => {
        const r = await ctx.fetcher(abs);
        if (/json|text\/plain/i.test(r.contentType) && !/html/i.test(r.contentType)) {
          const c = stripInjection(r.body);
          return { url: r.url, status: r.status, title: abs, text: c.text, flags: c.flags, html: r.body, metaTags: {} };
        }
        const t = htmlToCleanText(r.body);
        return { url: r.url, status: r.status, title: t.title, text: t.text, flags: t.flags, html: r.body, metaTags: t.metaTags };
      })();
      cache.set(abs, p);
    }
    return p;
  };
}

/** Reserve the fee up front. Returns false when the user cannot afford it. */
export function reserveFee(db: DB, userId: string, cents: number): boolean {
  return db.prepare(`UPDATE users SET balance_cents = balance_cents - ? WHERE id=? AND balance_cents >= ?`).run(cents, userId, cents).changes === 1;
}
const refundFee = (db: DB, userId: string, cents: number) => db.prepare(`UPDATE users SET balance_cents = balance_cents + ? WHERE id=?`).run(cents, userId);

export async function runAnswer(ctx: Ctx, answerId: string): Promise<void> {
  const { db, llm, cfg } = ctx;
  const a = db.prepare(`SELECT * FROM answers WHERE id=?`).get(answerId) as any;
  const ev = (stage: string, msg: string) => addEvent(db, answerId, stage, msg);
  const fetchPage = makePageFetcher(ctx);
  try {
    // 1. research -----------------------------------------------------------------------------
    setStatus(db, answerId, "researching");
    ev("researching", `${llm.fixture ? "Fixture" : llm.provider} research agent started`);
    const library = DEMO_SITES.map((s) => ({ url: new URL(s.url, cfg.publicUrl).toString(), title: s.topic ? `${s.title} (${s.topic})` : s.title }));
    const rctx: ResearchCtx = { fetchPage, log: ev, library };
    const research = await llm.research(a.question, rctx);
    const seen = new Set<string>();
    const cited = research.sources.filter((s) => !seen.has(s.url) && !seen.has(String(s.n)) && (seen.add(s.url), seen.add(String(s.n)), true)).slice(0, MAX_SOURCES);
    if (!cited.length) throw new Error("the research agent returned no sources");
    db.prepare(`UPDATE answers SET answer_md=?, llm_json=? WHERE id=?`).run(research.answerMarkdown, JSON.stringify({ provider: llm.provider, model: llm.model, fixture: llm.fixture }), answerId);
    ev("researching", `Answer drafted with ${cited.length} cited source${cited.length > 1 ? "s" : ""}`);

    // 2. attribution --------------------------------------------------------------------------
    setStatus(db, answerId, "attributing");
    const pages = new Map<number, PageRecord | null>();
    for (const s of cited) pages.set(s.n, await fetchPage(s.url).catch(() => null));
    const readable = cited.filter((s) => pages.get(s.n));
    const scores = await llm.attribute({
      question: a.question,
      answerMarkdown: research.answerMarkdown,
      sources: readable.map((s) => ({ n: s.n, url: s.url, title: s.title, excerpt: pages.get(s.n)!.text.slice(0, 3500), meta: pages.get(s.n)!.metaTags })),
    });
    const byN = new Map(scores.map((x) => [x.n, x]));
    const scored: ScoredSource[] = cited.map((s) => {
      const pg = pages.get(s.n);
      const sc = byN.get(s.n);
      return {
        n: s.n,
        score: pg ? sc?.score ?? 0 : 0,
        justification: pg ? sc?.justification ?? "no score returned" : "page could not be read",
        domain: siteOf(s.url, cfg.publicUrl).key,
        flagged: !!pg && isHostile(pg.flags),
      };
    });
    const alloc = allocate(scored, { feeCents: a.fee_cents, minScore: cfg.minScore, injectionPenalty: cfg.injectionPenalty, ownDomain: a.own_domain });
    for (const x of alloc) {
      const s = scored.find((q) => q.n === x.n)!;
      const pg = pages.get(x.n);
      if (s.flagged) ev("attributing", `Prompt injection detected on ${s.domain}: stripped, score x${cfg.injectionPenalty}`);
      if (!pg) { x.dropped = true; x.dropReason = "page could not be read"; }
    }
    const kept = alloc.filter((x) => !x.dropped);
    ev("attributing", `${kept.length} of ${cited.length} sources earn a share; ${cited.length - kept.length} dropped`);

    // 3. payee resolution ---------------------------------------------------------------------
    setStatus(db, answerId, "resolving");
    const payees = new Map<string, Payee>();
    const insert = db.prepare(`INSERT INTO sources(answer_id,n,url,title,domain,raw_score,justification,share_pct,share_cents,dropped,drop_reason,flags_json,payee_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const srcIds = new Map<number, number>();
    for (const s of cited) {
      const sc = scored.find((q) => q.n === s.n)!;
      const al = alloc.find((q) => q.n === s.n)!;
      const pg = pages.get(s.n);
      const site = siteOf(s.url, cfg.publicUrl);
      let payee: Payee | null = null;
      if (!al.dropped && pg) {
        payee = payees.get(site.key) ?? (await resolvePayee(pg.url, site, ctx.fetcher, pg.html).catch(() => NONE));
        payees.set(site.key, payee);
        ev("resolving", `${site.key}: ${payee.method === "none" ? "no payee declared, funds go to escrow" : `payee via ${payee.label}`}`);
        db.prepare(
          `INSERT INTO creators(domain,label,root,payee_method,email,paypal_me,evidence_url,updated_at) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(domain) DO UPDATE SET label=excluded.label, root=excluded.root, payee_method=excluded.payee_method, email=excluded.email, paypal_me=excluded.paypal_me, evidence_url=excluded.evidence_url, updated_at=excluded.updated_at`
        ).run(site.key, pg.title || s.title || site.key, site.root, payee.method, payee.email, payee.paypalMe, payee.evidenceUrl, now());
      }
      const info = insert.run(answerId, s.n, s.url, pg?.title || s.title, site.key, sc.score, sc.justification, al.sharePct, al.shareCents, al.dropped ? 1 : 0, al.dropReason, JSON.stringify(pg?.flags ?? []), payee ? JSON.stringify(payee) : null);
      srcIds.set(s.n, Number(info.lastInsertRowid));
    }

    // 4. ledger + payment ---------------------------------------------------------------------
    setStatus(db, answerId, "paying");
    if (!kept.length) {
      refundFee(db, a.user_id, a.fee_cents);
      ev("paying", "No source earned a share: the knowledge fee was refunded in full");
    } else {
      for (const x of kept) {
        const s = cited.find((q) => q.n === x.n)!;
        const site = siteOf(s.url, cfg.publicUrl);
        const payee = payees.get(site.key)!;
        const st = recordAccrual(db, { sourceId: srcIds.get(x.n)!, answerId, domain: site.key, cents: x.shareCents, payee });
        ev("paying", `${site.key}: ${x.shareCents}c ${st === "ACCRUED" ? "accrued toward payout" : st === "ESCROW" ? "held in escrow" : "held (paypal.me link only)"}`);
      }
      const res = await settleNow(ctx, (m) => ev("paying", m));
      if (!res.batches.length) ev("paying", `No payee has reached the ${cfg.minPayoutCents}c minimum yet; royalties keep accruing`);
    }
    setStatus(db, answerId, "done");
    ev("done", "Royalty receipt ready");
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const row = db.prepare(`SELECT status FROM answers WHERE id=?`).get(answerId) as { status: string };
    if (!db.prepare(`SELECT 1 FROM accruals WHERE answer_id=?`).get(answerId)) refundFee(db, a.user_id, a.fee_cents);
    addEvent(db, answerId, "error", msg);
    setStatus(db, answerId, "error", row.status === "error" ? msg : msg);
  }
}

/** Pay everyone at/above the minimum. The LLM agent drives the PayPal tools when a real model is configured. */
export async function settleNow(ctx: Ctx, log: (m: string) => void = () => {}): Promise<{ settledBy: "agent" | "deterministic" | null; batches: BatchResult[]; message: string }> {
  const run = async () => {
    const { db, cfg, llm } = ctx;
    const deps = { db, paypal: ctx.paypal, minPayoutCents: cfg.minPayoutCents, maxBatchCents: cfg.maxBatchCents };
    if (!listSettleable(db, cfg.minPayoutCents).length) return { settledBy: null, batches: [] as BatchResult[], message: "Nothing to settle: no payee has reached the minimum payout." };
    const batches: BatchResult[] = [];
    let settledBy: "agent" | "deterministic" = "deterministic";
    if (!llm.fixture) {
      settledBy = "agent";
      try {
        log(`Settlement agent started: ${llm.model} drives the PayPal Payouts tools`);
        await llm.settle({
          minPayoutCents: cfg.minPayoutCents,
          listSettleable: () => listSettleable(db, cfg.minPayoutCents),
          createBatch: async (items) => {
            const b = await createPayoutBatch(deps, items, "agent");
            batches.push(b);
            log(`Agent created PayPal payout batch ${b.batchId} (${b.itemCount} payee${b.itemCount > 1 ? "s" : ""}, ${b.totalCents}c)`);
            return b;
          },
          log,
        });
      } catch (e) {
        log(`Settlement agent failed (${(e as Error).message}); ledger falls back to deterministic settlement`);
      }
    }
    const rest = listSettleable(db, cfg.minPayoutCents);
    if (rest.length) {
      if (settledBy === "agent") log("Agent left payees unpaid; deterministic settlement finishes the job");
      const b = await createPayoutBatch(deps, rest.map((p) => ({ email: p.email, cents: p.cents })), "deterministic");
      batches.push(b);
      log(`Created PayPal payout batch ${b.batchId} (${b.itemCount} payee${b.itemCount > 1 ? "s" : ""}, ${b.totalCents}c)`);
      if (!batches.slice(0, -1).length) settledBy = "deterministic";
    }
    return { settledBy, batches, message: `Paid ${batches.reduce((s, b) => s + b.itemCount, 0)} payee(s) in ${batches.length} batch(es).` };
  };
  const next = ctx.settleLock.then(run, run);
  ctx.settleLock = next.catch(() => {});
  return next;
}

export type { PayoutStatus };

// ---- Views ----------------------------------------------------------------------------------

export function answerView(ctx: Ctx, id: string, userId?: string) {
  const { db } = ctx;
  const a = db.prepare(`SELECT * FROM answers WHERE id=?`).get(id) as any;
  if (!a || (userId && a.user_id !== userId)) return null;
  const events = db.prepare(`SELECT t,stage,message FROM events WHERE answer_id=? ORDER BY id`).all(id);
  const rows = db
    .prepare(
      `SELECT s.*, ac.status AS pstatus, i.payout_item_id AS payout_item_id, i.batch_id AS batch_id, ac.cents AS ac_cents
       FROM sources s LEFT JOIN accruals ac ON ac.source_id=s.id LEFT JOIN payout_items i ON i.sender_item_id=ac.item_sid
       WHERE s.answer_id=? ORDER BY s.n`
    )
    .all(id) as any[];
  const sources = rows.map((r) => {
    const payee = r.payee_json ? (JSON.parse(r.payee_json) as Payee) : null;
    return {
      n: r.n, url: r.url, title: r.title, domain: r.domain, rawScore: r.raw_score, justification: r.justification,
      sharePct: r.share_pct, shareCents: r.share_cents, dropped: !!r.dropped, dropReason: r.drop_reason,
      flagged: JSON.parse(r.flags_json).some((f: any) => f.kind === "prompt_injection"), flags: JSON.parse(r.flags_json),
      payee: payee ? { method: payee.method, label: payee.label, email: payee.email, paypalMe: payee.paypalMe, evidenceUrl: payee.evidenceUrl } : null,
      payoutStatus: (r.pstatus as PayoutStatus | null) ?? null,
      payoutBatchId: r.batch_id ?? null, payoutItemId: r.payout_item_id ?? null,
    };
  });
  const sum = (f: (s: (typeof sources)[number]) => boolean) => sources.filter(f).reduce((t, s) => t + s.shareCents, 0);
  const refundedAcc = sum((s) => s.payoutStatus === "REFUNDED");
  const allocated = sum((s) => !s.dropped);
  const batches = db
    .prepare(`SELECT DISTINCT b.batch_id AS batchId, b.status, b.settled_by AS settledBy FROM accruals ac JOIN payout_items i ON i.sender_item_id=ac.item_sid JOIN payout_batches b ON b.batch_id=i.batch_id WHERE ac.answer_id=?`)
    .all(id) as { batchId: string; status: string; settledBy: string }[];
  const bal = (ctx.db.prepare(`SELECT balance_cents FROM users WHERE id=?`).get(a.user_id) as any)?.balance_cents ?? 0;
  const done = a.status === "done";
  return {
    id: a.id, question: a.question, feeCents: a.fee_cents, status: a.status, error: a.error, createdAt: a.created_at, events,
    answerMarkdown: a.answer_md, llm: a.llm_json ? JSON.parse(a.llm_json) : null, sources,
    receipt: done ? {
      totalCents: a.fee_cents, paidToSourcesCents: allocated - refundedAcc, refundedCents: a.fee_cents - allocated + refundedAcc,
      settledBy: batches[0]?.settledBy ?? null, batches: batches.map((b) => ({ batchId: b.batchId, status: b.status })),
    } : null,
    balanceCents: bal,
  };
}

export function creatorView(ctx: Ctx, domain: string) {
  const { db } = ctx;
  const c = db.prepare(`SELECT * FROM creators WHERE domain=?`).get(domain) as any;
  if (!c) return null;
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status IN ('SUCCESS','PENDING','UNCLAIMED') THEN cents END),0) AS earned,
              COALESCE(SUM(CASE WHEN status='ACCRUED' THEN cents END),0) AS pending,
              COALESCE(SUM(CASE WHEN status IN ('ESCROW','LINK_ONLY') THEN cents END),0) AS escrow FROM accruals WHERE domain=?`
    )
    .get(domain) as any;
  const answers = db
    .prepare(
      `SELECT ac.answer_id AS answerId, a.question, ac.cents AS shareCents, s.share_pct AS sharePct, s.justification, a.created_at AS createdAt, ac.status AS payoutStatus
       FROM accruals ac JOIN answers a ON a.id=ac.answer_id JOIN sources s ON s.id=ac.source_id WHERE ac.domain=? ORDER BY ac.id DESC LIMIT 100`
    )
    .all(domain);
  const payouts = c.email
    ? db.prepare(`SELECT batch_id AS batchId, payout_item_id AS itemId, status, cents AS amountCents, created_at AS createdAt FROM payout_items WHERE email=? ORDER BY created_at DESC`).all(c.email)
    : [];
  return {
    domain, label: c.label ?? domain, payeeMethod: c.payee_method, email: c.email, paypalMe: c.paypal_me,
    earnedCents: agg.earned, pendingCents: agg.pending, escrowCents: agg.escrow, claimable: agg.escrow > 0, answers, payouts,
  };
}

/** Domain claim: re-check the payee declaration on the live site, release escrow to ACCRUED, pay out immediately. */
export async function claimDomain(ctx: Ctx, domain: string) {
  const { db, cfg } = ctx;
  const c = db.prepare(`SELECT * FROM creators WHERE domain=?`).get(domain) as any;
  if (!c) return { ok: false, status: 404, message: `Unknown creator domain ${domain}.` };
  const held = db.prepare(`SELECT COALESCE(SUM(cents),0) AS s FROM accruals WHERE domain=? AND status IN ('ESCROW','LINK_ONLY')`).get(domain) as { s: number };
  if (!held.s) return { ok: false, status: 200, message: `No escrowed royalties are waiting for ${domain}.` };
  const site = { key: domain, root: c.root as string };
  const payee = await resolvePayee(c.root, site, ctx.fetcher).catch(() => NONE);
  // Only proof of domain control counts for a claim: meta tag or /.well-known/footnote.json on the domain itself.
  const verified = (payee.method === "meta_tag" || payee.method === "footnote_json") && payee.email;
  if (!verified) {
    return { ok: false, status: 200, message: `No payee declaration found on ${domain}. Add: <meta name="footnote:paypal" content="you@example.com"> to the site's home page (or publish /.well-known/footnote.json), then verify again.` };
  }
  db.transaction(() => {
    db.prepare(`UPDATE creators SET payee_method=?, email=?, paypal_me=NULL, evidence_url=?, updated_at=? WHERE domain=?`).run(payee.method, payee.email, payee.evidenceUrl, now(), domain);
    db.prepare(`UPDATE accruals SET status='ACCRUED', email=?, updated_at=? WHERE domain=? AND status IN ('ESCROW','LINK_ONLY')`).run(payee.email, now(), domain);
  })();
  const deps = { db, paypal: ctx.paypal, minPayoutCents: cfg.minPayoutCents, maxBatchCents: cfg.maxBatchCents };
  const mine = listSettleable(db, 1).find((p) => p.email === payee.email)!;
  try {
    const b = await createPayoutBatch(deps, [{ email: mine.email, cents: mine.cents }], "deterministic", { ignoreMin: true });
    return { ok: true, status: 200, message: `Verified ${payee.email} via ${payee.label}. Released ${mine.cents}c to PayPal.`, verifiedEmail: payee.email, releasedCents: mine.cents, payout: { batchId: b.batchId, status: b.status } };
  } catch (e) {
    return { ok: false, status: 502, message: e instanceof SettlementError ? e.message : (e as Error).message };
  }
}

export { rid };
