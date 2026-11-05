import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { now, rid } from "./db.js";
import type { Ctx } from "./service.js";
import { runAnswer, answerView, creatorView, claimDomain, settleNow, reserveFee } from "./service.js";
import { creatorSummaries, globalLedger, sweepEscrow, applyItemStatus, refreshPendingBatches } from "./ledger.js";
import { simApp } from "./paypal/sim.js";
import { DEMO_SITES, SAMPLE_QUESTIONS } from "./demo.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".yml": "text/yaml; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
};

function sendFile(base: string, rel: string): Response | null {
  const target = path.resolve(base, "." + path.posix.normalize("/" + rel));
  if (!target.startsWith(base + path.sep) && target !== base) return null;
  let file = target;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const buf = fs.readFileSync(file);
    return new Response(buf, { headers: { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" } });
  } catch {
    return null;
  }
}

export function createApp(ctx: Ctx): Hono {
  const { cfg, db } = ctx;
  const app = new Hono();

  if (cfg.paypal.simulator) app.route("/_sim/paypal", simApp(cfg.publicUrl, `${cfg.publicUrl}/api/webhooks/paypal`));

  // ---- session ----------------------------------------------------------------------------
  function userOf(c: any): { id: string; name: string; balance_cents: number } {
    let sid = getCookie(c, "fn_sid");
    let u = sid ? (db.prepare(`SELECT * FROM users WHERE id=?`).get(sid) as any) : null;
    if (!u) {
      sid = rid("u");
      db.prepare(`INSERT INTO users(id,name,balance_cents,created_at) VALUES (?,?,?,?)`).run(sid, "Guest", cfg.welcomeCents, now());
      setCookie(c, "fn_sid", sid, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
      u = db.prepare(`SELECT * FROM users WHERE id=?`).get(sid);
    }
    return u;
  }

  app.get("/api/health", (c) => c.json({ ok: true, paypal: cfg.paypal.simulator ? "simulator" : "sandbox", llm: cfg.llm.provider }));

  app.get("/api/me", (c) => {
    const u = userOf(c);
    return c.json({
      user: { id: u.id, name: u.name, balanceCents: u.balance_cents },
      config: {
        packs: cfg.packs, minFeeCents: cfg.minFeeCents, maxFeeCents: cfg.maxFeeCents, defaultFeeCents: cfg.defaultFeeCents,
        minPayoutCents: cfg.minPayoutCents, minSharePct: Math.round(cfg.minScore * 100),
        mode: { paypal: cfg.paypal.simulator ? "simulator" : "sandbox", llm: cfg.llm.provider, llmModel: cfg.llm.model },
        demoSites: DEMO_SITES, sampleQuestions: SAMPLE_QUESTIONS,
      },
    });
  });

  // ---- checkout (PayPal Orders v2) ---------------------------------------------------------
  app.post("/api/checkout/create", async (c) => {
    const u = userOf(c);
    const body = await c.req.json().catch(() => ({}));
    const pack = cfg.packs.find((p) => p.id === body.packId);
    if (!pack) return c.json({ error: "unknown_pack" }, 400);
    try {
      const ref = rid("ord");
      const o = await ctx.paypal.createOrder({
        cents: pack.cents, description: `Footnote knowledge credits (${pack.label})`, customId: ref,
        returnUrl: `${cfg.publicUrl}/api/checkout/return`, cancelUrl: `${cfg.publicUrl}/api/checkout/cancel`, requestId: ref,
      });
      db.prepare(`INSERT INTO orders(id,user_id,pack_id,cents,status,created_at) VALUES (?,?,?,?,?,?)`).run(o.orderId, u.id, pack.id, pack.cents, "CREATED", now());
      return c.json({ orderId: o.orderId, approveUrl: o.approveUrl });
    } catch (e) {
      return c.json({ error: "paypal_error", message: (e as Error).message }, 502);
    }
  });

  app.get("/api/checkout/return", async (c) => {
    const u = userOf(c);
    const token = c.req.query("token") ?? "";
    const o = db.prepare(`SELECT * FROM orders WHERE id=? AND user_id=?`).get(token, u.id) as any;
    if (!o) return c.redirect("/#/?checkout=error");
    if (o.status === "COMPLETED") return c.redirect(`/#/?checkout=success&added=${o.cents}`);
    try {
      const cap = await ctx.paypal.captureOrder(token);
      if (cap.status !== "COMPLETED" || cap.amountCents !== o.cents) throw new Error(`capture status ${cap.status}`);
      db.transaction(() => {
        const ch = db.prepare(`UPDATE orders SET status='COMPLETED', capture_id=? WHERE id=? AND status='CREATED'`).run(cap.captureId, token).changes;
        if (ch) db.prepare(`UPDATE users SET balance_cents = balance_cents + ? WHERE id=?`).run(o.cents, u.id);
      })();
      return c.redirect(`/#/?checkout=success&added=${o.cents}`);
    } catch {
      return c.redirect("/#/?checkout=error");
    }
  });
  // Test affordance (off by default): lets automated runs fund a session without a human PayPal approval.
  if (cfg.devGrant) {
    app.post("/api/dev/grant", async (c) => {
      const u = userOf(c);
      const b = await c.req.json().catch(() => ({}));
      const cents = Math.min(1000, Math.max(1, Math.floor(Number(b.cents) || 500)));
      db.prepare(`UPDATE users SET balance_cents = balance_cents + ? WHERE id=?`).run(cents, u.id);
      return c.json({ granted: cents });
    });
  }
  app.get("/api/checkout/cancel", (c) => c.redirect("/#/?checkout=cancelled"));

  // ---- ask --------------------------------------------------------------------------------
  app.post("/api/ask", async (c) => {
    const u = userOf(c);
    const b = await c.req.json().catch(() => ({}));
    const question = typeof b.question === "string" ? b.question.trim() : "";
    const fee = Number(b.feeCents ?? cfg.defaultFeeCents);
    if (question.length < 3 || question.length > 500) return c.json({ error: "bad_question" }, 400);
    if (!Number.isInteger(fee) || fee < cfg.minFeeCents || fee > cfg.maxFeeCents) return c.json({ error: "bad_fee", min: cfg.minFeeCents, max: cfg.maxFeeCents }, 400);
    const own = typeof b.ownDomain === "string" ? b.ownDomain.trim().slice(0, 253) || null : null;
    if (cfg.dailyAnswerCap > 0) {
      const since = new Date(Date.now() - 86400_000).toISOString();
      if ((db.prepare(`SELECT COUNT(*) AS n FROM answers WHERE created_at > ?`).get(since) as any).n >= cfg.dailyAnswerCap) return c.json({ error: "demo_capacity", message: "Daily demo capacity reached; try again tomorrow." }, 429);
    }
    const running = (db.prepare(`SELECT COUNT(*) AS n FROM answers WHERE user_id=? AND status NOT IN ('done','error')`).get(u.id) as any).n;
    if (running >= 2) return c.json({ error: "too_many_running" }, 429);
    const id = rid("a");
    const ok = db.transaction(() => {
      if (!reserveFee(db, u.id, fee)) return false;
      db.prepare(`INSERT INTO answers(id,user_id,question,fee_cents,own_domain,status,created_at) VALUES (?,?,?,?,?,?,?)`).run(id, u.id, question, fee, own, "queued", now());
      return true;
    })();
    if (!ok) return c.json({ error: "insufficient_credits" }, 402);
    void runAnswer(ctx, id);
    return c.json({ answerId: id }, 202);
  });

  app.get("/api/answers/:id", (c) => {
    const u = userOf(c);
    const v = answerView(ctx, c.req.param("id"), u.id);
    return v ? c.json(v) : c.json({ error: "not_found" }, 404);
  });
  app.get("/api/answers", (c) => {
    const u = userOf(c);
    return c.json(db.prepare(`SELECT a.id, a.question, a.fee_cents AS feeCents, a.status, a.created_at AS createdAt, (SELECT COUNT(*) FROM sources s WHERE s.answer_id=a.id AND s.dropped=0) AS sourceCount FROM answers a WHERE a.user_id=? ORDER BY a.created_at DESC LIMIT 50`).all(u.id));
  });

  // ---- creators / ledger -------------------------------------------------------------------
  app.get("/api/creators", (c) => c.json(creatorSummaries(db)));
  app.get("/api/creators/:domain", (c) => {
    const v = creatorView(ctx, c.req.param("domain"));
    return v ? c.json(v) : c.json({ error: "not_found" }, 404);
  });
  app.post("/api/claim", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (typeof b.domain !== "string") return c.json({ ok: false, message: "domain required" }, 400);
    const r = await claimDomain(ctx, b.domain);
    return c.json(r, r.status as 200);
  });
  app.post("/api/settle", async (c) => {
    try {
      return c.json(await settleNow(ctx));
    } catch (e) {
      return c.json({ settledBy: null, batches: [], message: (e as Error).message }, 502);
    }
  });
  app.post("/api/escrow/sweep", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const ttl = Number.isFinite(Number(b.ttlDays)) && b.ttlDays !== undefined ? Number(b.ttlDays) : cfg.escrowTtlDays;
    return c.json(sweepEscrow(db, ttl));
  });
  app.post("/api/payouts/refresh", async (c) => c.json({ updated: await refreshPendingBatches(db, ctx.paypal) }));
  app.get("/api/ledger", (c) => c.json(globalLedger(db)));

  // ---- PayPal webhooks (PAYMENT.PAYOUTS-ITEM.*) -------------------------------------------
  app.post("/api/webhooks/paypal", async (c) => {
    const raw = await c.req.text();
    let ev: any;
    try { ev = JSON.parse(raw); } catch { return c.json({ error: "bad_json" }, 400); }
    let verified = false;
    if (cfg.paypal.simulator) verified = true; // the simulator has no signing key
    else {
      if (!cfg.paypal.webhookId) return c.json({ error: "webhook_not_configured" }, 400);
      const headers = Object.fromEntries([...c.req.raw.headers.entries()]);
      verified = await ctx.paypal.verifyWebhook({ headers, event: ev, webhookId: cfg.paypal.webhookId }).catch(() => false);
    }
    if (!verified) return c.json({ error: "bad_signature" }, 401);
    if (!ev?.id || typeof ev.event_type !== "string") return c.json({ error: "bad_event" }, 400);
    if (db.prepare(`SELECT 1 FROM webhook_events WHERE id=?`).get(ev.id)) return c.json({ ok: true, duplicate: true });
    db.prepare(`INSERT INTO webhook_events(id,type,verified,received_at) VALUES (?,?,?,?)`).run(ev.id, ev.event_type, 1, now());
    let applied = false;
    const m = ev.event_type.match(/^PAYMENT\.PAYOUTS-ITEM\.(\w+)$/);
    if (m) {
      const r = ev.resource ?? {};
      applied = applyItemStatus(
        db,
        { senderItemId: r.payout_item?.sender_item_id, payoutItemId: r.payout_item_id },
        r.transaction_status || m[1],
        r.payout_item_id
      );
    }
    return c.json({ ok: true, applied });
  });

  // ---- demo creator sites (served verbatim, incl. dotfiles) ------------------------------
  app.get("/demo-sites/*", (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/demo-sites\//, ""));
    return sendFile(path.join(ROOT, "demo-sites"), rel) ?? c.text("not found", 404);
  });

  app.get("/*", (c) => {
    const p = new URL(c.req.url).pathname;
    return sendFile(path.join(ROOT, "public"), p === "/" ? "index.html" : p) ?? c.text("not found", 404);
  });

  return app;
}
