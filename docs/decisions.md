# Scale limits and the cost ceiling — 2026-08-12

## The one that mattered: 4x over a documented hard limit

Cloudflare's free plan allows **50 D1 queries per Worker invocation** and 50
subrequests per request; binding calls count. Measured from the code, a call
cost 6 fixed queries plus 4 per ledger row — so a 50-item `triage_unknowns`
issued **~206 queries**. Tested against production at 3/8/12/20/50 items: all
succeeded and every row landed, so the limit is simply not enforced today.

That is the alarming reading, not the reassuring one. `writeLedger` swallows
errors so a ledger failure never breaks a caller's response. If that limit is
ever enforced — or enforced under load — rows vanish while every response still
says "ok". Silent degradation of the one asset the project exists to build.

Fixed by batching: `writeLedgerMany` sends the whole set through `db.batch()`
and bumps the daily counter **once in aggregate** rather than per row.
A 50-row triage went from ~206 queries to ~8. Verified in production: 50 rows
written, one counter bump of 50, zero errors.

Two smaller query savings: `bumpCounters` now uses `RETURNING` instead of
upsert-then-select, and the notify sweep batches its ready-marks.

## Two more silent failures, both fixed

**Notify sweep could never drain.** A single `LIMIT 500` per nightly cron meant
that past 500 waiting rows the backlog grew faster than it cleared — and since
A8 made this registry the *only* return path, that promise would have failed
quietly and taken the flywheel with it. Now paged (20 x 500), batched, and it
logs `NOTIFY_BACKLOG` when it still cannot keep up.

**Retention UPDATE was unbounded.** D1 caps a query at 30 seconds, so on a large
table the nightly scrub starts timing out, gets caught and logged, and raw
payloads quietly stop being discarded while `/terms` keeps promising a 90-day
deletion. Now paged, with a `still_pending` count on every run.

It also compared ISO-8601 `ts` against SQLite `datetime()` — `'T' > ' '` in a
string comparison, so the 90-day boundary was fuzzy by up to a day. Third
appearance of this exact trap (after the A15 hourly window). **Any timestamp
comparison in this codebase must use the same ISO format both sides.**

## Billing: a surprise bill is structurally impossible right now

Workers plan is **Free** (confirmed in the dashboard). Free has no usage
billing at all: at 100,000 requests/day the platform returns Error 1027 and
stops serving until midnight UTC. D1 likewise stops. The only recurring cost on
this project is the domain, $12.20/yr on auto-renew.

So the failure mode is **service stops**, not **bill arrives** — which is
exactly the posture §12's kill/pivot signal wants ("freeze at zero-cost idle").

The corollary is the thing actually worth worrying about: on free, hitting the
cap means requests are **rejected**, and rejected demand events are lost
forever. For this project that is worse than a bill. The A15 breaker guards
ledger writes at 20k/day, but Workers requests — including tool-list
inspections, which are already the majority of traffic — can reach 100k
independently of it.

Exposure only begins if someone upgrades to Workers Paid ($5/mo + usage:
$0.30/million requests, $0.02/million CPU-ms). Do not upgrade without a spend
alert configured first.

## Where it breaks, in order

| # | Limit | Binds at | Status |
|---|---|---|---|
| 1 | D1 50 queries/invocation | was ~11 unknowns | **fixed** — now ~8 queries at 50 |
| 2 | A15 breaker, 20k ledger rows/day | 20k | by design, trips first |
| 3 | D1 100k rows written/day | ~33k simple calls | ~3 row-writes per ledger row |
| 4 | Workers 100k requests/day | 100k | **cap = dropped traffic = lost data** |
| 5 | D1 free max DB size 500 MB | ~330k rows | 90-day raw scrub bounds it |
| 6 | notify sweep drain rate | >10k waiting | **fixed** — paged |
| 7 | retention query duration | millions of rows | **fixed** — paged |
| 8 | D1 single-threaded, ~1000 q/s | ~100 calls/sec | not near-term |

Calibration note on the A15 breaker: 20k ledger rows/day is roughly 60k D1
rows written once counters and caller upserts are included — about 60% of the
free daily allowance, not the wide margin the number suggests.

---

# First external traffic — 2026-08-12, and the test-data purge

Purged my own smoke-test traffic from production so the §12 metrics start from
zero. Deleted **by fingerprint**, not by user-agent guesswork — only the two
identities provably mine (curl and the shim, from this machine). Backups of all
five tables were taken first, into the session scratchpad.

Result: ledger 0, callers 0, notify 0, cache 0, counters 0.

**Five inspection rows were deliberately kept, because they are not ours.**

```
07:50:30  loop-mcp-catalog-fetch/0.1.0
07:57:55  python-httpx/0.28.1
08:00:06  node
08:03:08  node
08:05:55  loop-mcp-catalog-fetch/0.1.0
```

The official registry listing published at **07:50:06Z**. The first external
`tools/list` fetch arrived **24 seconds later**, and five arrived from four
distinct fingerprints inside sixteen minutes.

Two things follow. First, registry propagation is fast and real — §8's remaining
manual submissions may matter less than assumed. Second, and more useful: every
one of those clients read the tool list and **called nothing**. That is exactly
the negative-space signal `inspections` was built to capture, and it is the
project's first genuine datum. Whether inspect-without-calling is normal
crawler behaviour or a discovery-copy problem is precisely the question the
table exists to answer — but it needs a baseline, which is why these rows
survived the purge.

Note for anyone repeating the purge: `notify_registry.event_id` is a foreign key
onto `demand_ledger(id)`, so the ledger delete fails while notify rows still
reference it. Delete notify first.

---

# A12–A14 — pure sensor. Paid tier cancelled for v1.

Tickets 5 and 6 are cancelled: no Stripe, no auto desk verifier, no
`verify_claim` / `get_verification`. The paid tier resold the agent's own
capability back to it, and the residual value was too thin to price at $4–6 on
day one.

**Reactivation is evidence-gated, not date-gated.** ≥10 distinct-caller budgeted
asks for a single desk-verifiable claim shape → flip `AUTO_VERIFIER_ENABLED` for
that type (model binding per A11: Anthropic API key, Haiku-class,
schema-constrained to evidence-only output). Physical, phone, and attestation
demand is explicitly **not** a trigger — that stratum accumulates as the
dataset's value rather than pulling us into building a network.

Kept deliberately: the `fulfillment: "auto"` seam dark, `est_price_usd` still
quoted in responses with the honest "not open" note, and `price_quoted` still
written to the ledger. Those three are the willingness-to-pay instrument, and
they only work if the price is stated.

Goal 4 (first dollar) is suspended. Replacement: ≥10 ledger rows carrying a
budget signal by day 90.

## `request_human_check` renamed to `check_before_relying`

It promised dispatch we do not do and flatly contradicted our own published
`/terms` ("Nobody is dispatched to inspect anything physically"). It shipped
live and passed a full deploy before anyone caught it. Tool names freeze
permanently at npm publish, so this was the last cheap moment to fix it.

## scripts/a3-audit.mjs

The honesty rule is now enforced by a script rather than by remembering. Three
violation classes, each of which we have actually shipped:

1. **Human dispatch** — A1 says no human, ever; `/terms` promises it.
2. **Outbound referral** — A8 removed referrals, yet three alias descriptions
   still offered to send callers elsewhere, and `plan_verification` returned
   the string "referral available" in production.
3. **Purchasability** — A12 cancelled the paid tier, so nothing may imply
   payment can be taken today. Any bare price in reader-facing copy must read
   as indicative.

Its first run found three live violations that four rounds of human review had
walked past: the stale tool name in `openapi.yaml`, unqualified prices in two
claim-page `<meta>` descriptions, and the `plan_verification` referral string.
Source comments are skipped — they explain the rules, and noise is how a real
violation gets scrolled past.

Run before every publish: `node scripts/a3-audit.mjs`

---

# Brand separation — decided against. Ticket 9 is not blocked.

`veritap.dev` (registered 2026-08-11) stays in the existing Cloudflare account
alongside `glamth.com` and `shade-vault.com`. Spec §4 wanted a dedicated account
for an eventual data sale; that is deferred, for two reasons.

**1. There is almost no privacy to buy.** Measured rather than assumed:

- RDAP for `veritap.dev` exposes no registrant data at all — name, email, phone
  and address are absent, redaction active. True today, in the shared account.
- The one live linkage is the nameserver pair: all three domains resolve to
  `ben.ns.cloudflare.com` / `katja.ns.cloudflare.com`, because Cloudflare
  assigns a pair per account. That is public via `dig`. But those pairs are
  shared across a large number of unrelated accounts, so reverse-NS returns a
  wide bucket. It confirms a suspected link; it does not discover one.
- Separating later would not undo it regardless — the association went public at
  registration and passive-DNS services archive history.
- Separation buys nothing legally. A second Cloudflare account is not a
  corporate veil; FCRA and defamation exposure follow the operator. The
  people-claim exclusion in `src/policy.ts` is the actual control.

**2. The brand is disposable.** Veritap is a data-collection sensor. If it ever
becomes the agent-to-human marketplace, it gets rebranded then — so investing in
separating a brand slated for replacement is spend on a discarded asset. At the
point a sale is real, the buyer wants the asset in *their* account anyway, and
the move happens then, with signal to justify it.

Deferring costs about an hour later (redeploy the Worker, `wrangler d1 export`
and reimport, recreate the cron) — real, but not a plan.

## What a disposable brand actually implies for the build

The rebrand is cheap **now** and expensive **after §8 distribution**, because
registries, the npm shim, and installed client configs all pin a URL. A rebrand
after listing orphans installed clients and silently kills the A8 return path —
`notify_registry`'s "tell them on their next call" delivery only works if there
is a next call to the same endpoint. Two consequences, both free to honour:

- **Keep the brand out of the interface.** Tool names stay generic
  (`check_feasibility`, never `veritap.check_feasibility`). This independently
  settles the A4 prefix question: a prefix bakes a disposable brand into the
  one surface agents actually memorise, and MCP forbids the `:` form anyway.
- **Plan to keep `veritap.dev` serving forever as an alias** after any rebrand.
  A second custom domain on the same Worker costs nothing and preserves every
  installed client and pending notification.

## Free hygiene, do regardless

Do **not** expose the `workers.dev` URL. That subdomain is per-account, so
`<worker>.<subdomain>.workers.dev` sitting beside any other public Worker on the
account is a *direct* account-level link — considerably stronger than the
nameserver pair. Serve on the custom domain only and leave the workers.dev route
unpublished.

---

# v1.1 + A8 implementation notes (2026-08-11, second pass)

## People-claim gate — a false negative was found and fixed

The first version of `src/policy.ts` only matched pronoun phrasings, so
**"Verify that John Marsh actually works at Kroger and confirm his home
address" was not refused** — it fell through to the ordinary unsupported path.
Named individuals are the common real phrasing, so the gate was failing on its
main case while looking like it worked.

Patterns now allow an arbitrary subject span between verb and person-predicate.
`scripts/policy-check.ts` is the control battery — **29/29, both directions**.
The negative controls matter as much as the positive ones: a gate that refuses
nothing and a gate that is switched off are indistinguishable from the outside.
One trap is pinned there deliberately: employment patterns require
"works/worked at", never bare "work at", so *"the contractor completed the work
at 44 Elm St"* stays a work-completion claim.

Bias is toward over-refusal: a false positive costs one refused business claim,
a false negative means we processed a request about a private individual.

Refusals are logged **without their text** (`raw_input_json` NULL,
`claim_description` replaced with a category marker) and carry no referral — a
people-claim handed onward with the text pre-filled would be laundering the
harm, not avoiding it.

## A8 — referrals removed

No outbound links anywhere. Consequences implemented:

- **New outcome `deferred_no_fulfiller`** for "catalog match, nothing can answer
  it today". Its own value on purpose — folding it into `quoted_unpaid` would
  corrupt the §7 query-3 reading, where a stall is supposed to mean a pricing or
  trust objection rather than "we were not open". `referred` is retired and
  never written.
- **`self_help` on every miss**, so the response stays decision-grade without an
  outbound link: reuses the triage classifier to say either "you can answer this
  yourself, here is the source" or "here is how to plan around it".
- **`notify_when_supported` is now a real registry** (`src/notify.ts`, table
  `notify_registry`), not a boolean. Verified end to end: gap registered → cron
  re-matches against the current catalog → marked ready → delivered on the
  caller's next call (or POSTed to `callback_url` when supplied). Deduped per
  caller per claim so a retrying agent is not spammed. Delivered notices are
  purged after 90 days.

## Internal contradiction in v1.1 worth resolving

A1 says no human in the fulfillment loop, **ever**. A3's approved framing says
"human-performed verification expanding." Those cannot both be true, and A3's
own purpose is honesty, so the copy uses only the accurate half — "multi-source
desk verification returning an evidence bundle" — plus an explicit statement of
the people-claim scope limit. Flagging rather than silently choosing.

## `veritap:` tool prefix (A4) is not viable

MCP restricts tool names to letters, digits, `_`, `-`, `.`; clients are
instructed to reject tools that violate it. `veritap.check_feasibility` or
`veritap_check_feasibility` work. Tool names are currently unprefixed — free to
change until first publish.

## Physical-presence demand

Per A8 note 2, "go look at the thing" asks are neither refused nor referred:
they land as `unsupported`, register for notification, and accumulate. Confirmed
in the live triage run — *"whether the yard actually has the unit on site
today"* classifies `not_determinable` and is ledgered. That stratum is the
dataset, working as designed.

---

# Decisions taken during Phase 0 (tickets 0–3)

Deviations from Build Spec v1, and why. Anything here that you disagree with is
cheap to reverse right now and expensive later.

## D1 — No operator-routed fulfillment ("nothing routed to me for validation")

**Change requested at handoff.** Removed from the build: the ntfy push, the
concierge queue, the authenticated fulfill form (tickets 5 and 8), the
`fulfilled_manual` outcome, and `verifier_id: "concierge-001"`.

**Consequence, stated plainly.** The three launch claim types in spec §6 were
all chosen *because* one person could fulfil them by hand. With no operator in
the loop, the fulfillment ladder collapses to:

1. valid cached attestation → answered instantly
2. everything else → referred out to a pre-filled bounty

So v1 ships as a pure sensor plus a referral desk. Knock-on effects:

- **Spec §2 goal 4 ("first dollar within 90 days")** loses its "paid manual
  fulfillment" half. Only the referral-fee half survives, and that depends on
  open question 4 (whether an affiliate mechanism even exists).
- **Spec §5.2 `verify_claim`** has nothing to queue *to*. It is not implemented
  in this pass; see D2.
- **Spec §5 ops load** drops from "≤2 hrs/week" to roughly zero.
- The catalog's role changes from "things we fulfil" to "things we can answer
  from a pre-seeded cache". Phase 1's "seed ~20 self-verifications" stops being
  a warm-up and becomes the *entire* fulfillment inventory.

**The obvious way to get fulfillment back without routing anything to you:**
two of the three claim types (`BUSINESS_EXISTS_AND_OPERATING`,
`LISTING_IS_CONSISTENT`) are described in the spec as web-desk-verifiable — an
automated verifier (LLM + web fetch, running in the Worker) could fulfil them
with no human involved. `PHONE_CONFIRMATION` genuinely cannot be automated and
would be dropped or permanently referred out.

The code is built for exactly this: `catalog.ts` carries a `fulfillment` field
(`"cache" | "auto"`), and `router.ts` has the branch point marked. Turning it on
is a claim-type flag plus one handler. **Not built, because it is a product
decision, not an implementation detail.** Recommended, but yours to call.

## D2 — Not quoting a price we cannot honour

A catalog match with a cache miss returns `feasible: "partial"` with the
catalog price as an *estimate* and an honest note that live fulfillment is not
open, rather than `status: "queued"` with an ETA. Spec §10 forbids claiming
coverage that does not exist, and a queue with no consumer is exactly that.

The ledger still records `price_quoted`, so the §7 query-3
"quoted-unpaid analysis" keeps working.

## D3 — Stateless handler, no Durable Objects

Spec §4 assumed Cloudflare's `McpAgent`, which is Durable-Object-backed.
`McpAgent` is now deprecated and feature-frozen; the supported path is
`createMcpHandler` from `agents/mcp/server` (Agents SDK v0.20.1, MCP spec
2026-07-28). It is stateless — a fresh `McpServer` per request — so the Worker
needs no DO binding at all. This is strictly better for the "zero-cost idle"
kill/pivot posture, and the DO was only in the architecture to carry the
concierge queue that D1 removed.

## D4 — A fourth table, `inspections`

Spec §7 defines three tables. Added a fourth for the negative-space logging in
§5.6 (clients that read `tools/list` and never call anything). It is kept out of
`demand_ledger` deliberately: an inspection is not a demand event, and mixing
them would inflate every §12 metric.

## D5 — No CHECK constraints on `demand_ledger`

The ledger is the product and an unrecorded event is lost forever, so a rejected
INSERT is worse than a row with a strange value. Enum values are documented in
the migration and enforced loosely in TypeScript. `raw_input_json` is the
backstop.

---

# Spec open questions now answered

**Q3 — are `tools/list` inspections observable, or does it need HTTP log
parsing?** Observable, no log parsing. The Worker owns the outer `fetch`, so it
peeks the JSON-RPC method off a clone of the request body before delegating to
the MCP handler. Implemented in `recordInspection()`.

**Q5 — caller fingerprinting without auth: MCP session id or IP hash?** Neither
as stated: `createMcpHandler` is stateless and mints a new session per request,
so the session id is useless as an identity. Using
`sha256(cf-connecting-ip | user-agent | client name)`, truncated to 32 chars —
stable per agent deployment, no raw PII in D1. Implemented in
`deriveFingerprint()`.

**Q1 — domain.** Sweep run; see below. Decision still yours.

---

# Ticket 0 result — domain sweep

Run `npm run sweep` to reproduce. Of the seven §9 candidates, **no `.com` is
hand-registerable**: taken or parked (`sooth.com` and `attestly.com` are on
Afternic/Sedo parking → "squatted, skip" per the no-ransom rule).

Open `.dev` (the other preferred TLD): `veritap.dev`, `forsooth.dev`,
`truthwire.dev`, `factline.dev`, `verq.dev`.

The §9 decision rule (highest-ranked candidate with an open `.com` or `.dev`)
selects **`veritap.dev`**. Registration is a manual click at Cloudflare
Registrar and is not scripted, per §9.

Note: `.io` returns no result because the `.io` registry publishes no RDAP
service in the IANA bootstrap — it needs a WHOIS check if you want `.io` in play.
