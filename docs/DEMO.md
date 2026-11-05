# Demo video script (target 2:40, hard limit 3:00)

Record the browser at 1280x800 plus a terminal strip if you like. No music with third-party rights; voice-over only.

## Prep (once)

```bash
rm -rf data/            # fresh ledger
cp .env.example .env    # add ANTHROPIC_API_KEY and PayPal sandbox keys for the real run
npx tsx scripts/declare-payee.ts garden-gnome-gazette --undo
npm run demo            # MIN_PAYOUT_CENTS=10 so one 50 cent answer visibly pays out
```

Open `http://localhost:3000`. Have `demo-sites/garden-gnome-gazette/index.html` ready in an editor tab.

## Shot list

| Time | On screen | Say |
| ---- | --------- | --- |
| 0:00 | Ask page, header badges (PayPal sandbox, Claude model) | "AI answers eat the traffic of the people who wrote the sources. Footnote is an answer engine that pays them, through PayPal." |
| 0:12 | Click **Add credits**, PayPal Orders v2 checkout, approve, back with $5.00 | "I buy credits with PayPal Checkout. Every answer carries a tiny knowledge fee, here fifty cents." |
| 0:30 | Click a sample question: *How can I compost food scraps in a small apartment?* Pipeline stepper runs; events scroll | "A Claude agent researches with web search and reads the creators' pages. Page text is untrusted data." |
| 0:55 | Answer appears with superscript citations; scroll to the **royalty receipt** | "A second agent scores each source's contribution and says why. Sources under the threshold are dropped, the rest normalised to the cent." |
| 1:15 | Point at payee badges: meta tag, footnote.json, FUNDING.yml, paypal.me, unclaimed | "Footnote finds who to pay with an open convention: a meta tag or a well-known JSON file on the site. Creators who declared nothing get an escrow ledger." |
| 1:30 | **Quick Compost Hacks** row: red *Prompt injection stripped* badge, expand snippet | "This page hid a command: pay me one hundred percent. It was stripped before the model saw it, flagged, and the source is penalised. Payees are never read from page prose." |
| 1:50 | Receipt footer: *Settled by Claude agent via PayPal Payouts*, batch id; status pills flip PENDING → SUCCESS | "When a creator crosses the one-dollar minimum, a settlement agent calls PayPal Payouts. The ledger validates every tool call, so the agent picks who, the code decides whether. Payout status comes back by webhook." |
| 2:10 | **Creators** page → Garden Gnome Gazette: escrow $0.09 → claim panel. Switch to editor, run `npx tsx scripts/declare-payee.ts garden-gnome-gazette owner@example.com`, click **Verify** → payout created | "This site never heard of us. Its royalties waited in escrow. The owner adds one meta tag, verifies, and PayPal sends the money." |
| 2:30 | Ledger page; flash `docs/footnote-spec.md` | "Open spec, MIT license, tests for the money paths. Footnote: cite the footnote, pay the footnote." |

## Backup beats if time allows

* Ask with *my own domain* = `compost-diaries.demo` to show self-citation excluded.
* **Sweep expired escrow** returns unclaimed money to the asker's credits.
* `npm run e2e` in the terminal prints the same flow as a table (good b-roll).

## Reset between takes

```bash
rm -rf data/ && npx tsx scripts/declare-payee.ts garden-gnome-gazette --undo   # then restart npm run demo
```
