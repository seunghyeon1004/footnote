/**
 * Local PayPal *sandbox simulator*. Mirrors the subset of PayPal's REST surface Footnote uses
 * (same paths, same JSON shapes) so the whole product runs end-to-end without credentials.
 * It is enabled automatically when PAYPAL_CLIENT_ID/SECRET are absent and is labeled "simulator" in the UI.
 *   - emails starting with "unclaimed" end as UNCLAIMED, "blocked" as BLOCKED, everything else SUCCESS
 *   - items are PENDING at creation; ~1.2s later the simulator POSTs a PAYMENT.PAYOUTS-ITEM.* webhook to the app
 */
import { Hono } from "hono";

interface SimOrder { id: string; cents: number; status: string; returnUrl: string; cancelUrl: string; customId: string }
interface SimItem { payout_item_id: string; sender_item_id: string; receiver: string; value: string; final: string; status: string }
interface SimBatch { id: string; sender_batch_id: string; status: string; items: SimItem[]; created: string }

const rnd = (n: number) => Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("");

export function simApp(publicUrl: string, webhookTarget: string) {
  const app = new Hono();
  const orders = new Map<string, SimOrder>();
  const batches = new Map<string, SimBatch>();
  const senderIds = new Map<string, string>();
  const base = `${publicUrl}/_sim/paypal`;

  app.post("/v1/oauth2/token", (c) => c.json({ access_token: "SIM-" + rnd(24), token_type: "Bearer", expires_in: 32000, app_id: "SIM" }));

  app.post("/v2/checkout/orders", async (c) => {
    const b = await c.req.json();
    const pu = b.purchase_units?.[0];
    const value = pu?.amount?.value;
    if (b.intent !== "CAPTURE" || !value || pu?.amount?.currency_code !== "USD") return c.json({ name: "INVALID_REQUEST", message: "bad order" }, 400);
    const ctx = b.payment_source?.paypal?.experience_context ?? {};
    const id = rnd(17);
    orders.set(id, { id, cents: Math.round(parseFloat(value) * 100), status: "PAYER_ACTION_REQUIRED", returnUrl: ctx.return_url, cancelUrl: ctx.cancel_url, customId: pu.custom_id ?? "" });
    return c.json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "self", href: `${base}/v2/checkout/orders/${id}`, method: "GET" }, { rel: "payer-action", href: `${base}/checkoutnow?token=${id}`, method: "GET" }] }, 201);
  });

  app.get("/checkoutnow", (c) => {
    const o = orders.get(c.req.query("token") ?? "");
    if (!o) return c.text("unknown order", 404);
    return c.html(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>PayPal Sandbox Simulator</title>
<body style="font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 20px;color:#0b2540">
<p style="background:#fff4d6;border:1px solid #e8c766;padding:8px 12px;border-radius:8px;font-size:13px">PayPal <b>sandbox simulator</b> — no real PayPal involved. Set PAYPAL_CLIENT_ID/SECRET for the real sandbox.</p>
<h2>Pay $${(o.cents / 100).toFixed(2)} to Footnote</h2>
<form method=get action="${o.returnUrl}"><input type=hidden name=token value="${o.id}"><input type=hidden name=PayerID value="SIMPAYER">
<button style="background:#0070e0;color:#fff;border:0;border-radius:999px;padding:12px 26px;font-size:16px;cursor:pointer">Approve &amp; pay</button>
<a href="${o.cancelUrl}" style="margin-left:14px;color:#456">Cancel</a></form></body>`);
  });

  app.get("/v2/checkout/orders/:id", (c) => {
    const o = orders.get(c.req.param("id"));
    return o ? c.json({ id: o.id, status: o.status }) : c.json({ name: "RESOURCE_NOT_FOUND" }, 404);
  });

  app.post("/v2/checkout/orders/:id/capture", (c) => {
    const o = orders.get(c.req.param("id"));
    if (!o) return c.json({ name: "RESOURCE_NOT_FOUND" }, 404);
    if (o.status === "COMPLETED") return c.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }, 422);
    o.status = "COMPLETED";
    return c.json({ id: o.id, status: "COMPLETED", purchase_units: [{ custom_id: o.customId, payments: { captures: [{ id: "CAP" + rnd(14), status: "COMPLETED", amount: { currency_code: "USD", value: (o.cents / 100).toFixed(2) } }] } }] });
  });

  app.post("/v1/payments/payouts", async (c) => {
    const b = await c.req.json();
    const sbid: string = b.sender_batch_header?.sender_batch_id;
    if (!sbid || !Array.isArray(b.items) || !b.items.length) return c.json({ name: "MALFORMED_REQUEST", message: "bad payout" }, 400);
    if (senderIds.has(sbid)) return c.json({ name: "USER_BUSINESS_ERROR", message: "Batch with given sender_batch_id already exists" }, 400);
    const id = "SIMB" + rnd(11);
    senderIds.set(sbid, id);
    const items: SimItem[] = b.items.map((i: any) => {
      const local = String(i.receiver).split("@")[0].toLowerCase();
      return {
        payout_item_id: "SIMI" + rnd(10), sender_item_id: i.sender_item_id, receiver: i.receiver, value: i.amount.value,
        final: local.startsWith("unclaimed") ? "UNCLAIMED" : local.startsWith("blocked") ? "BLOCKED" : "SUCCESS", status: "PENDING",
      };
    });
    const batch: SimBatch = { id, sender_batch_id: sbid, status: "PENDING", items, created: new Date().toISOString() };
    batches.set(id, batch);
    // asynchronous settlement + webhook, like the real thing
    setTimeout(async () => {
      for (const it of batch.items) {
        it.status = it.final;
        try {
          await fetch(webhookTarget, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: "WH-" + rnd(16), event_version: "1.0", create_time: new Date().toISOString(), resource_type: "payouts_item",
              event_type: `PAYMENT.PAYOUTS-ITEM.${it.final === "SUCCESS" ? "SUCCEEDED" : it.final}`,
              resource: { payout_item_id: it.payout_item_id, payout_batch_id: id, transaction_status: it.final, payout_item: { receiver: it.receiver, sender_item_id: it.sender_item_id, amount: { value: it.value, currency: "USD" } } },
            }),
          });
        } catch { /* app may be down */ }
      }
      batch.status = "SUCCESS";
    }, 1200);
    return c.json({ batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: b.sender_batch_header }, links: [] }, 201);
  });

  app.get("/v1/payments/payouts/:id", (c) => {
    const b = batches.get(c.req.param("id"));
    if (!b) return c.json({ name: "RESOURCE_NOT_FOUND" }, 404);
    return c.json({
      batch_header: { payout_batch_id: b.id, batch_status: b.status, sender_batch_header: { sender_batch_id: b.sender_batch_id } },
      items: b.items.map((i) => ({ payout_item_id: i.payout_item_id, transaction_status: i.status, payout_batch_id: b.id, payout_item: { receiver: i.receiver, sender_item_id: i.sender_item_id, amount: { value: i.value, currency: "USD" } } })),
    });
  });

  return app;
}
