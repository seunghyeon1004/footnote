import { describe, it, expect } from "vitest";
import { PayPalClient, PayPalError } from "../src/paypal/client.js";

type Call = { url: string; init: RequestInit };
function mock(routes: Record<string, (body: any, init: RequestInit) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${new URL(url).pathname}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ name: "NOT_FOUND", key }), { status: 404 });
    const isJson = (init.headers as any)?.["content-type"] === "application/json" && typeof init.body === "string";
    const r = h(isJson ? JSON.parse(init.body as string) : init.body, init);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const token = { "POST /v1/oauth2/token": () => ({ json: { access_token: "TKN", expires_in: 3000 } }) };
const mk = (routes: any) => {
  const m = mock({ ...token, ...routes });
  return { ...m, pp: new PayPalClient({ clientId: "id", clientSecret: "sec", baseUrl: "https://api-m.sandbox.paypal.com", fetch: m.f }) };
};

describe("PayPalClient", () => {
  it("authenticates with HTTP Basic client credentials and caches the token", async () => {
    const { pp, calls } = mk({ "GET /v2/checkout/orders/X": () => ({ json: { id: "X" } }) });
    await pp.getOrder("X");
    await pp.getOrder("X");
    const auth = calls.filter((c) => c.url.endsWith("/v1/oauth2/token"));
    expect(auth).toHaveLength(1);
    expect((auth[0].init.headers as any).authorization).toBe("Basic " + Buffer.from("id:sec").toString("base64"));
    expect(auth[0].init.body).toBe("grant_type=client_credentials");
    expect((calls[1].init.headers as any).authorization).toBe("Bearer TKN");
  });

  it("creates an Orders v2 CAPTURE order with PAY_NOW redirect context and returns the payer-action link", async () => {
    let seen: any;
    const { pp } = mk({
      "POST /v2/checkout/orders": (b: any) => {
        seen = b;
        return { json: { id: "ORD1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "self", href: "s" }, { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORD1" }] } };
      },
    });
    const o = await pp.createOrder({ cents: 500, description: "d", customId: "c1", returnUrl: "http://r", cancelUrl: "http://c", requestId: "rq" });
    expect(o).toEqual({ orderId: "ORD1", status: "PAYER_ACTION_REQUIRED", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORD1" });
    expect(seen.intent).toBe("CAPTURE");
    expect(seen.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "5.00" });
    expect(seen.payment_source.paypal.experience_context).toMatchObject({ return_url: "http://r", cancel_url: "http://c", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" });
  });

  it("captures an order and reads the capture amount", async () => {
    const { pp } = mk({
      "POST /v2/checkout/orders/ORD1/capture": () => ({ json: { id: "ORD1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP9", amount: { currency_code: "USD", value: "5.00" } }] } }] } }),
    });
    expect(await pp.captureOrder("ORD1")).toEqual({ orderId: "ORD1", status: "COMPLETED", captureId: "CAP9", amountCents: 500 });
  });

  it("creates a Payouts v1 batch with EMAIL recipients and formatted USD amounts", async () => {
    let seen: any;
    const { pp } = mk({
      "POST /v1/payments/payouts": (b: any) => {
        seen = b;
        return { json: { batch_header: { payout_batch_id: "PB1", batch_status: "PENDING" } } };
      },
    });
    const r = await pp.createPayoutBatch({ senderBatchId: "sb1", emailSubject: "s", emailMessage: "m", items: [{ senderItemId: "si1", email: "a@b.co", cents: 125, note: "n" }] });
    expect(r).toEqual({ batchId: "PB1", status: "PENDING" });
    expect(seen.sender_batch_header).toMatchObject({ sender_batch_id: "sb1", email_subject: "s" });
    expect(seen.items[0]).toEqual({ recipient_type: "EMAIL", receiver: "a@b.co", amount: { value: "1.25", currency: "USD" }, note: "n", sender_item_id: "si1" });
  });

  it("parses payout batch details", async () => {
    const { pp } = mk({
      "GET /v1/payments/payouts/PB1": () => ({ json: { batch_header: { payout_batch_id: "PB1", batch_status: "SUCCESS" }, items: [{ payout_item_id: "PI1", transaction_status: "UNCLAIMED", payout_item: { receiver: "a@b.co", sender_item_id: "si1", amount: { value: "0.45", currency: "USD" } } }] } }),
    });
    expect(await pp.getPayoutBatch("PB1")).toEqual({ batchId: "PB1", status: "SUCCESS", items: [{ payoutItemId: "PI1", senderItemId: "si1", status: "UNCLAIMED", email: "a@b.co", cents: 45 }] });
  });

  it("verifies webhook signatures via verify-webhook-signature", async () => {
    let seen: any;
    const { pp } = mk({ "POST /v1/notifications/verify-webhook-signature": (b: any) => ((seen = b), { json: { verification_status: "SUCCESS" } }) });
    const ok = await pp.verifyWebhook({
      headers: { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://c", "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-01-01T00:00:00Z" },
      event: { id: "WH-1" }, webhookId: "WID",
    });
    expect(ok).toBe(true);
    expect(seen).toMatchObject({ auth_algo: "SHA256withRSA", transmission_id: "t1", webhook_id: "WID", webhook_event: { id: "WH-1" } });
  });

  it("surfaces PayPal errors", async () => {
    const { pp } = mk({ "POST /v1/payments/payouts": () => ({ status: 400, json: { name: "VALIDATION_ERROR", message: "bad" } }) });
    await expect(pp.createPayoutBatch({ senderBatchId: "x", emailSubject: "s", emailMessage: "m", items: [] })).rejects.toBeInstanceOf(PayPalError);
  });
});
