# Footnote HTTP API (UI contract)

All JSON. Session = cookie `fn_sid` set automatically on first `/api/me`. Money is always integer **cents** (USD).

## GET /api/me
```json
{ "user": {"id":"u_abc","name":"Guest","balanceCents":500},
  "config": {
    "packs":[{"id":"pack5","label":"$5 starter pack","cents":500}],
    "minFeeCents":25,"maxFeeCents":100,"defaultFeeCents":50,
    "minPayoutCents":100,"minSharePct":10,
    "mode":{"paypal":"sandbox"|"simulator","llm":"anthropic"|"openai"|"fixture","llmModel":"claude-sonnet-5-5"},
    "demoSites":[{"slug":"compost-diaries","title":"Compost Diaries","url":"/demo-sites/compost-diaries/","payeeMethod":"meta_tag","blurb":"..."}],
    "sampleQuestions":["How do I compost in a small apartment?"]
  } }
```
## POST /api/checkout/create  `{"packId":"pack5"}`
-> `{"orderId":"5O190127TN364715T","approveUrl":"https://www.sandbox.paypal.com/checkoutnow?token=..."}`
Browser does `location.href = approveUrl`. PayPal redirects to `/api/checkout/return?token=ORDER`, the server captures and 302s to `/#/?checkout=success&added=500` or `/#/?checkout=cancelled` / `checkout=error`.

## POST /api/ask  `{"question":"...","feeCents":50,"ownDomain":"optional.com"}`
-> `202 {"answerId":"a_123"}` (errors: 400 bad input, 402 `{"error":"insufficient_credits"}`)
Job runs async. Poll **GET /api/answers/:id** every ~700ms until `status` is `done` or `error`.

## GET /api/answers/:id
```json
{ "id":"a_123","question":"...","feeCents":50,
  "status":"queued|researching|attributing|resolving|paying|done|error","error":null,
  "createdAt":"2026-11-05T10:00:00Z",
  "events":[{"t":"2026-11-05T10:00:01Z","stage":"researching","message":"Fetched Compost Diaries"}],
  "answerMarkdown":"Bokashi ferments scraps in about two weeks [1]. ...",   // numbered citations like [1] [2]
  "llm":{"provider":"anthropic","model":"claude-sonnet-5-5","fixture":false},
  "sources":[{
     "n":1,"url":"...","title":"...","domain":"compost-diaries",
     "rawScore":0.82,"justification":"Provided the core statistic","sharePct":46,"shareCents":23,
     "dropped":false,"dropReason":null,           // dropped=true when under threshold / self-citation
     "flagged":false,"flags":[{"kind":"prompt_injection","snippet":"ignore previous instructions..."}],
     "payee":{"method":"meta_tag|footnote_json|funding_yml|paypal_me|none","label":"<meta name=footnote:paypal>","email":"a@b.c","paypalMe":null,"evidenceUrl":"..."},
     "payoutStatus":"ACCRUED|PENDING|SUCCESS|UNCLAIMED|ESCROW|FAILED|LINK_ONLY|REFUNDED",
     "payoutBatchId":null,"payoutItemId":null }],
  "receipt":{"totalCents":50,"paidToSourcesCents":45,"refundedCents":5,"settledBy":"agent|deterministic|null",
            "batches":[{"batchId":"ABC","status":"PENDING"}]},
  "balanceCents":450 }
```
Dropped sources have shareCents 0. Flagged = prompt-injection text was found and stripped on that page (show a visible warning badge and the stripped snippet).
## GET /api/answers -> `[{"id","question","feeCents","status","createdAt","sourceCount"}]` (newest first, this session)
## GET /api/creators -> `[{"domain","label","earnedCents","pendingCents","escrowCents","answers"}]` (leaderboard, all users)
## GET /api/creators/:domain
```json
{ "domain":"compost-diaries","label":"Compost Diaries","payeeMethod":"meta_tag","email":"x@y.z",
  "earnedCents":45,"pendingCents":20,"escrowCents":0,"claimable":false,
  "answers":[{"answerId":"a_1","question":"...","shareCents":23,"sharePct":46,"justification":"...","createdAt":"...","payoutStatus":"SUCCESS"}],
  "payouts":[{"batchId":"B1","itemId":"I1","status":"SUCCESS","amountCents":45,"createdAt":"..."}] }
```
## POST /api/claim `{"domain":"garden-gnome-gazette"}`
Server fetches the domain, looks for `<meta name="footnote:paypal">` or `/.well-known/footnote.json`, and if found releases escrow to a payout.
-> `{"ok":true,"message":"...","verifiedEmail":"a@b.c","releasedCents":38,"payout":{"batchId":"B","status":"PENDING"}}` or `{"ok":false,"message":"No payee declaration found on garden-gnome-gazette. Add: <meta name=\"footnote:paypal\" content=\"you@example.com\">"}`
## POST /api/settle -> `{"settledBy":"agent|deterministic","batches":[{"batchId","status","itemCount","totalCents"}],"message":"..."}`  (pays every payee at/above minPayoutCents)
## POST /api/escrow/sweep -> `{"refundedCents":12,"count":1}`
## POST /api/payouts/refresh -> `{"updated":3}` (polls PayPal for pending payout item statuses)
## GET /api/ledger
`{"totalFeesCents","paidCents","accruedCents","escrowCents","refundedCents","batches":[{"batchId","status","totalCents","createdAt","itemCount"}]}`
