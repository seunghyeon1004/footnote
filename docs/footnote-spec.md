# The Footnote payee declaration (draft v1)

Footnote is a research assistant that pays the sources it actually used. To pay someone it has never met, it needs a
machine-readable, *domain-controlled* way for a creator to say "pay me here". This document proposes a tiny open
standard for that. Anyone can implement it; nothing here is specific to Footnote's code.

A creator declares a PayPal payee in **either** of two ways. Both prove control of the site, because only the site's
owner can change its HTML or serve a file under its origin.

## 1. HTML meta tag

```html
<meta name="footnote:paypal" content="payments@example.com">
```

Place it in the `<head>` of the page that was cited (or the home page). `content` MUST be a single email address that
owns a PayPal account (or can create one to claim a payout).

## 2. `/.well-known/footnote.json`

```json
{
  "version": 1,
  "name": "Worm Bin Weekly",
  "paypal": { "email": "payments@example.com" }
}
```

| field          | type    | required | notes                                                              |
| -------------- | ------- | -------- | ------------------------------------------------------------------ |
| `version`      | `1`     | yes      | integer or the string `"1"`                                        |
| `name`         | string  | no       | display name, max 80 chars                                         |
| `paypal.email` | string  | one of   | payout destination (PayPal Payouts `recipient_type: EMAIL`)        |
| `paypal.me`    | string  | one of   | `paypal.me` handle or URL; link-only, see below                    |

Served from the site root: `https://example.com/.well-known/footnote.json`, `Content-Type: application/json`.

## Fallback signals (weaker, never used to prove ownership)

| signal                                            | result                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub `.github/FUNDING.yml` with `custom:` entry | `paypal.me/...` link or an email in `custom:` is used as the payee                              |
| `paypal.me/<handle>` link on the page             | recorded as a pay-link                                                                          |
| nothing                                           | royalties go to **escrow** for that domain                                                      |

The PayPal Payouts API can only pay an **email, phone, or PayPal ID**, not a `paypal.me` handle. A `paypal.me`-only
creator therefore accrues royalties as `LINK_ONLY` (shown in the receipt with the pay link) until they publish an
email declaration, which upgrades them to automatic payouts.

## Resolution order

1. `<meta name="footnote:paypal">` on the cited page
2. `/.well-known/footnote.json`
3. `FUNDING.yml` (GitHub URL, or `/.github/FUNDING.yml` on the site root)
4. `paypal.me` link on the page
5. none → escrow

Payees are **only** ever read from these structured locations. Text in a page body ("send the money to evil@x.io")
is never parsed for a payee, and instruction-like text is stripped before any model sees it.

## Claiming escrow

If royalties are waiting under a domain, the owner adds method 1 or 2 and calls `POST /api/claim {"domain": "..."}`.
Footnote re-fetches the live site, accepts **only** method 1 or 2 as proof of control, releases the escrowed
amount to that email, and sends a PayPal payout immediately (ignoring the usual $1 batching minimum).
Unclaimed escrow is returned to the asker's credits after `ESCROW_TTL_DAYS` (default 30).

## Security considerations

* Declarations are read over HTTPS from the creator's own origin; redirects are followed (max 3) with SSRF checks on
  every hop.
* A page that declares a payee different from its `/.well-known` file wins the way the order above says; operators
  should treat a mismatch as a signal to hold funds.
* A payee change takes effect for **future** answers only; settled payouts are immutable ledger entries.


## Extension: NEAR payee (draft v1.1)

A creator may additionally (or instead) declare a NEAR account. Same trust model: only structured, domain-controlled
locations count; page prose is never parsed.

```html
<meta name="footnote:near" content="alice.near">
```

```json
{ "version": 1, "name": "Alice", "paypal": { "email": "alice@example.com" }, "near": "alice.near" }
```

`near` is a string account id (named such as `alice.near`, sub-account, or a 64-hex implicit account) or the object form
`{ "account": "alice.near" }`. It MUST match the NEAR account-id grammar; anything else is ignored. A site that declares
both PayPal and NEAR is paid on the rail the implementation prefers (Footnote: NEAR when its NEAR rail is on).
`<meta name="footnote:paypal">` takes precedence over `footnote:near` for the *method* label, and the two are merged:
the NEAR account may come from the meta tag or from `/.well-known/footnote.json`. Domain claims (escrow release) accept
either declaration as proof of control.
