/**
 * Minimal PayPal REST client (sandbox). Shapes verified against the official OpenAPI specs
 * (github.com/paypal/paypal-rest-api-specifications): Orders v2, Payouts v1, Notifications v1.
 */
export interface PayPalOpts {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

export class PayPalError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
  }
}

export interface CreatedOrder {
  orderId: string;
  status: string;
  approveUrl: string;
}
export interface CapturedOrder {
  orderId: string;
  status: string;
  captureId: string | null;
  amountCents: number;
}
export interface PayoutItemInput {
  senderItemId: string;
  email: string;
  cents: number;
  note: string;
}
export interface PayoutBatchResult {
  batchId: string;
  status: string;
}
export interface PayoutBatchDetail {
  batchId: string;
  status: string;
  items: { payoutItemId: string; senderItemId: string; status: string; email: string; cents: number }[];
}

const usd = (cents: number) => (cents / 100).toFixed(2);

export class PayPalClient {
  private tok: { value: string; exp: number } | null = null;
  private f: typeof fetch;
  constructor(private o: PayPalOpts) {
    this.f = o.fetch ?? fetch;
  }

  async token(): Promise<string> {
    if (this.tok && this.tok.exp > Date.now() + 30_000) return this.tok.value;
    const basic = Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString("base64");
    const res = await this.f(`${this.o.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new PayPalError("PayPal auth failed", res.status, j);
    this.tok = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 300) * 1000 };
    return this.tok.value;
  }

  private async call<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await this.f(`${this.o.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
    if (!res.ok) throw new PayPalError(`PayPal ${method} ${path} -> ${res.status} ${j?.name ?? ""} ${j?.message ?? ""}`.trim(), res.status, j);
    return j as T;
  }

  // ---- Orders v2 ---------------------------------------------------------------------------
  async createOrder(a: { cents: number; description: string; customId: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<CreatedOrder> {
    const j = await this.call(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          { reference_id: a.customId, custom_id: a.customId, description: a.description, amount: { currency_code: "USD", value: usd(a.cents) } },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Footnote",
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              landing_page: "LOGIN",
              return_url: a.returnUrl,
              cancel_url: a.cancelUrl,
            },
          },
        },
      },
      { "PayPal-Request-Id": a.requestId }
    );
    const link = (j.links ?? []).find((l: any) => l.rel === "payer-action") ?? (j.links ?? []).find((l: any) => l.rel === "approve");
    if (!link?.href) throw new PayPalError("order has no approval link", 502, j);
    return { orderId: j.id, status: j.status, approveUrl: link.href };
  }

  async captureOrder(orderId: string): Promise<CapturedOrder> {
    const j = await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { "PayPal-Request-Id": `cap-${orderId}` });
    const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
    return {
      orderId: j.id,
      status: j.status,
      captureId: cap?.id ?? null,
      amountCents: cap?.amount?.value ? Math.round(parseFloat(cap.amount.value) * 100) : 0,
    };
  }

  async getOrder(orderId: string) {
    return this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  // ---- Payouts v1 --------------------------------------------------------------------------
  async createPayoutBatch(a: { senderBatchId: string; emailSubject: string; emailMessage: string; items: PayoutItemInput[] }): Promise<PayoutBatchResult> {
    const j = await this.call("POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: a.senderBatchId, email_subject: a.emailSubject, email_message: a.emailMessage, recipient_type: "EMAIL" },
      items: a.items.map((i) => ({
        recipient_type: "EMAIL",
        receiver: i.email,
        amount: { value: usd(i.cents), currency: "USD" },
        note: i.note.slice(0, 4000),
        sender_item_id: i.senderItemId,
      })),
    });
    return { batchId: j.batch_header.payout_batch_id, status: j.batch_header.batch_status };
  }

  async getPayoutBatch(batchId: string): Promise<PayoutBatchDetail> {
    const j = await this.call("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    return {
      batchId: j.batch_header.payout_batch_id,
      status: j.batch_header.batch_status,
      items: (j.items ?? []).map((it: any) => ({
        payoutItemId: it.payout_item_id,
        senderItemId: it.payout_item?.sender_item_id,
        status: it.transaction_status,
        email: it.payout_item?.receiver,
        cents: Math.round(parseFloat(it.payout_item?.amount?.value ?? "0") * 100),
      })),
    };
  }

  // ---- Webhooks ----------------------------------------------------------------------------
  /** POST /v1/notifications/verify-webhook-signature */
  async verifyWebhook(a: { headers: Record<string, string | undefined>; event: unknown; webhookId: string }): Promise<boolean> {
    const h = (k: string) => a.headers[k] ?? a.headers[k.toLowerCase()] ?? "";
    const j = await this.call("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: a.webhookId,
      webhook_event: a.event,
    });
    return j.verification_status === "SUCCESS";
  }
}
