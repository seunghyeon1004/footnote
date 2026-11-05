# PayPal sandbox setup (about 10 minutes)

Footnote runs without any PayPal account in **simulator** mode. To use the real PayPal sandbox:

1. Sign in at <https://developer.paypal.com/dashboard/> (a normal PayPal login works).
2. **Testing tools → Sandbox accounts.** A default *Business* and *Personal* account exist. Note the personal
   account's email/password: it is your test buyer. Use **Add account** to create a few more personal accounts if you
   want real, claimable payees (for example `compost-diaries@...`).
3. **Apps & Credentials → Sandbox → Create App.** Pick the default sandbox *business* account as the merchant.
4. Open the app, copy **Client ID** and **Secret**.
5. In the same app, under **Features**, make sure **Payouts** is enabled. (If it is missing, the sandbox business
   account may need Payouts turned on: *Sandbox accounts → your business account → ⋯ → Account settings*, or contact
   PayPal developer support. Orders v2 checkout works without it.)
6. Fund the business account if needed: *Sandbox accounts → business → ⋯ → View/Edit account → Funding*. Payouts draw
   from the merchant balance; a few hundred sandbox dollars is plenty.
7. Put credentials in `.env`:

   ```bash
   cp .env.example .env
   # PAYPAL_CLIENT_ID=...
   # PAYPAL_CLIENT_SECRET=...
   npm run demo
   ```

   The startup banner should read `PayPal: sandbox https://api-m.sandbox.paypal.com`.

## Making demo payees real

The bundled demo creator sites declare placeholder emails such as `compost-diaries@footnote-demo.test`. PayPal
sandbox accepts payouts to any email: addresses that are not sandbox accounts end up **`UNCLAIMED`** (a great demo of
the unclaimed-funds path). To see `SUCCESS`, change the emails in
`demo-sites/compost-diaries/index.html` and `demo-sites/worm-bin-weekly/.well-known/footnote.json` to the emails of
your sandbox personal accounts, then log in at <https://www.sandbox.paypal.com> as that account to see the money arrive.

## Webhooks (optional; polling works without them)

Footnote polls `GET /v1/payments/payouts/{batch_id}` every 20 s. For push updates:

1. Expose your server: `ngrok http 3000` (or Cloudflare Tunnel) and set `PUBLIC_URL=https://<your-tunnel>` in `.env`.
2. In the app's **Webhooks** section, add `https://<your-tunnel>/api/webhooks/paypal` and subscribe to
   `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `.UNCLAIMED`, `.BLOCKED`, `.FAILED`, `.DENIED`, `.CANCELED`, `.HELD`,
   `.REFUNDED`, `.RETURNED` (or simply all `PAYMENT.PAYOUTS-*` events).
3. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`. Footnote verifies every delivery with
   `POST /v1/notifications/verify-webhook-signature` and rejects anything unverifiable.

## Checkout return URL

`PUBLIC_URL` is used for the Orders v2 `return_url`/`cancel_url` (`/api/checkout/return`, `/api/checkout/cancel`), so
it must be the URL your browser uses to reach Footnote (default `http://localhost:3000`).
