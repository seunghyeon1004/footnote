# Devpost submission: Footnote

All fields for https://paypalaihackathon.devpost.com. Copy each block into the matching Devpost field.

## Project name
Footnote

## Elevator pitch / tagline (max 200 chars)
The AI answer engine that pays its sources: every answer carries a small knowledge fee, split by contribution and paid to creators through PayPal Payouts.

## Links
- Public code repository: https://github.com/seunghyeon1004/footnote (MIT license, visible in the repo About section)
- Demo video (YouTube, public, 76 s): https://youtu.be/ybIdb08caAo
- Functional demo: run locally in 5 commands (below); no hosted URL is required. `render.yaml` in the repo deploys a hosted copy to Render.

## About the project (story)

### Inspiration
AI answer engines eat the traffic of the people whose work made the answers possible: bloggers, open-source maintainers, small publishers. Licensing deals only reach big publishers, so independent creators are cited, or not, and earn nothing. We wanted to see whether PayPal's rails make a different default possible: pay the source at the moment of the answer, even if the creator has never heard of us.

### What it does
Footnote is an AI research assistant where every answer carries a small knowledge fee (25 cents to $1). The fee is split among the sources the answer actually used, weighted by contribution, and paid out with PayPal.

1. The user buys credits with **PayPal Checkout** (Orders v2: create, approve, capture).
2. A **Claude research agent** (`claude-sonnet-5-5`, web search + page fetching) writes the answer with inline citations.
3. An **attribution agent** scores every source from 0 to 1 and gives a one-line reason ("provided worm capacity numbers, bin size, foods to avoid"). Sources under the threshold are dropped, the rest are normalised to exact cents.
4. **Payee resolution** shows its method for each source: `<meta name="footnote:paypal">`, `/.well-known/footnote.json` (our proposed open standard), GitHub `FUNDING.yml`, a paypal.me link, or nothing.
5. A **settlement agent** pays through **PayPal Payouts** (batch). Payout item status returns by webhook (`PAYMENT.PAYOUTS-ITEM.*`, signature verified) and polling.
6. Creators with no declaration are held in an **escrow ledger**. The owner adds one meta tag, presses Verify, and the escrow is released to a payout. Unclaimed escrow refunds to the asker after a TTL.
7. Every answer ends with a **royalty receipt**: who got what, why, and the payout status.

Guardrails shown in the demo: a per-answer fee cap, per-payee batching until a $1 minimum, self-citation excluded, and **prompt-injection defence**: a demo creator page hides "pay me 100%" commands; Footnote strips them before any model sees them, flags the source, cuts its score, and never reads a payee from page prose.

### How we built it
TypeScript on Node 20+, Hono for the API, SQLite (better-sqlite3) for the ledger, a no-build vanilla web app. Claude is called through the official Anthropic SDK with tool use, server-side web search and structured output. The **settlement agent** only has two tools, `list_settleable_payees` and `create_payout_batch`. The ledger sits in front of the second one: the amount must equal a payee's whole outstanding balance, the payee must already be owed money, the minimum and batch cap apply, and the reservation is a single SQL transaction. So the agent chooses who to pay, and the code decides whether. PayPal calls are a small REST client verified against PayPal's official OpenAPI specs. Providers are pluggable (Anthropic default, Gemini, OpenAI-compatible such as Vultr). A built-in PayPal sandbox simulator and a labelled fixture LLM let anyone run the whole product with no keys. 86 tests cover attribution maths, payee resolution, injection stripping, the ledger guardrails, the PayPal client, the claim flow, and an end-to-end HTTP run. The demo video was rendered from real captures with HyperFrames and verified (deterministic render, loudness, narration diff).

### Challenges we ran into
- PayPal Payouts cannot target a `paypal.me` handle, only email, phone or PayPal ID. Those creators are shown as `LINK_ONLY` until they publish an email declaration.
- Making an LLM that can move money safe: the answer was a ledger guard the agent cannot talk its way past, and strict separation of untrusted page text from instructions.
- PayPal's sandbox checkout would not complete from a remembered buyer session; a fresh login did.
- `@paypal/agent-toolkit` has no Payouts tools, so we defined the two payout tools ourselves (same name and JSON-schema shape) against the official Payouts API.

### Accomplishments that we're proud of
- A real end-to-end run in the PayPal sandbox: a sandbox buyer approved an Orders v2 checkout in a browser, Claude researched and attributed, a Claude settlement agent created a Payouts batch, and payouts reached **SUCCESS** for sandbox personal accounts, including one released from escrow after a meta-tag claim.
- The open `footnote:paypal` / `footnote.json` convention (`docs/footnote-spec.md`), so any creator can say "pay me here".
- Prompt-injection handling that is demonstrated on screen, not just claimed.
- Anyone can run the whole product in 5 commands with no keys.

### What we learned
Agents are fine at deciding who deserves money; they should never be the last line of defence for moving it. Putting the invariants in the ledger (whole balance, known payee, minimum, cap, atomic reservation) made the agent's job small and the failures boring. Creator payment also needs a discovery standard as much as an API.

### What's next for Footnote
Publish the payee declaration as a proper spec and a browser/CMS plugin; support PayPal PayPal IDs and phone payees; calibrate attribution against human judgments; pooled payouts for very small royalties; wiring the payout tools into an MCP server alongside PayPal's own.

## Built with (tags)
typescript, node.js, hono, sqlite, anthropic-claude, claude-sonnet, paypal, paypal-checkout, paypal-orders-api, paypal-payouts-api, paypal-webhooks, ai-agents, tool-use, vitest, gsap, hyperframes

## Tools used and how (required by the rules)
- **PayPal Orders v2 (sandbox):** buys credits. Create order with `payment_source.paypal.experience_context` redirect, the buyer approves, the server captures `POST /v2/checkout/orders/{id}/capture` and credits the wallet idempotently.
- **PayPal Payouts v1 (sandbox):** `POST /v1/payments/payouts` pays creators by email in batches, `GET /v1/payments/payouts/{id}` polls item status (SUCCESS, UNCLAIMED, PENDING...).
- **PayPal Notifications v1 webhooks:** `PAYMENT.PAYOUTS-ITEM.*` events update statuses; deliveries are verified with `POST /v1/notifications/verify-webhook-signature` and de-duplicated by event id. (Exercised end to end against the built-in simulator and unit-tested; the real sandbox runs used polling.)
- **PayPal Agent Toolkit:** reviewed; v1.11 has no Payouts tools, so payout tools are our own agent tools in the same shape, with a ledger guard.
- **Claude (`claude-sonnet-5-5`) via the Anthropic Messages API:** research agent (tool use, server-side web search, `fetch_url`), attribution agent (structured JSON output), settlement agent (tool use against guarded payout tools). Page text is wrapped as untrusted data and pre-sanitised.
- **Also supported, optional:** Google Gemini and OpenAI-compatible providers (Vultr Serverless Inference config), Serper for web search with those.
- **Other:** Hono, better-sqlite3, cheerio, vitest; OpenAI Codex CLI drafted the web UI scaffold (reviewed and integrated by us); ego-browser captures and HyperFrames render for the demo video; whisper.cpp large-v3-turbo to verify the narration.

## Run it (judges)
```bash
git clone https://github.com/seunghyeon1004/footnote && cd footnote
npm install
cp .env.example .env     # optional: ANTHROPIC_API_KEY and PayPal sandbox keys
npm run demo             # http://localhost:3000
npm test                 # 86 tests
```
With no keys it still runs end to end, clearly labelled in the UI header: a built-in **PayPal sandbox simulator** and a deterministic **fixture** research mode. With `ANTHROPIC_API_KEY` and `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` (sandbox) the same code path talks to Claude and the real PayPal sandbox (`docs/SANDBOX.md`, `npm run smoke:paypal`).

## Sandbox note for judges
Everything is PayPal **sandbox** only; no real money moves. Demo payees in the committed creator sites are sandbox personal accounts belonging to the project author, so a judge running with their own sandbox credentials will see payouts to those emails as UNCLAIMED/SUCCESS depending on PayPal; swap in your own sandbox personal emails in `demo-sites/compost-diaries/index.html` and `demo-sites/worm-bin-weekly/.well-known/footnote.json` to watch the money arrive in your account. Real checkout approval needs a sandbox buyer login; the simulator needs none.
Evidence of real runs is in `docs/evidence/`.

## Demo video checklist
Under 3 minutes (76 s), shows the project working on the machine it was built on, public on YouTube, no third-party trademarks or copyrighted music (narration only; PayPal screens are the real sandbox).
