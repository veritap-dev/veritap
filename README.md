# Veritap

**An MCP endpoint where agents check whether a real-world fact can be verified — before acting on it.**

Live: [`https://veritap.dev/mcp`](https://veritap.dev) · npm: [`veritap-mcp`](https://www.npmjs.com/package/veritap-mcp) · MCP registry: `dev.veritap/veritap`

```json
{ "mcpServers": { "veritap": { "command": "npx", "args": ["-y", "veritap-mcp"] } } }
```

Free, no auth, read-only, and it never returns a bare failure. Covers businesses,
listings, objects and places. **Claims about individuals are refused as a matter
of policy.** Paid verification is not open; the checking layer is what works today.

## What this actually is

A **demand sensor**. The product is the ledger, not the verification.

Agents constantly hit steps that depend on facts they cannot confirm, and today
they either guess or silently drop the step — so the demand is invisible. Every
call here writes a structured row: what was asked, what it was worth to the
caller, and whether anything could answer it. Requests we *cannot* fulfil are the
most valuable rows in the database.

That dataset cannot be backfilled, which is why the endpoint went live before
fulfillment existed.

## Design decisions worth knowing

- **No human in the loop, ever.** No dispatch, no verifier network. If the copy
  ever implies otherwise, [`scripts/a3-audit.mjs`](scripts/a3-audit.mjs) fails the build.
- **No outbound referrals.** A miss keeps its signal in-house, so it must stay
  decision-grade on its own: closest alternatives, honest self-help, and a real
  promise to report back ([`src/notify.ts`](src/notify.ts)).
- **Quarantine, don't drop.** Suspected flooding tags rows rather than refusing
  them. A wrongly-throttled agent prunes us from its tool rotation permanently;
  a wrongly-tagged row costs nothing and can be un-flagged later.
- **Claims about people are refused, not deferred.** FCRA exposure and the
  obvious harassment vector. Refusals are logged *without their text*.
  [`scripts/policy-check.ts`](scripts/policy-check.ts) is a two-sided control
  battery — a gate that refuses nothing and a gate that is switched off look
  identical from the outside.
- **The fingerprint is not an identity.** MCP has no installation id, so
  components are stored separately rather than baking a guess into a hash.

## Layout

```
src/index.ts     Worker entry, MCP protocol layer, cron
src/router.ts    the core: normalize -> hash -> cache -> catalog -> ledger
src/policy.ts    people-claim exclusion (hard refusal)
src/triage.ts    unknown classification, routes web-answerable items away
src/notify.ts    the return path: report back when a gap closes
src/ledger.ts    append-only demand ledger, batched writes
src/admin.ts     operator dashboard, Cloudflare Access protected
public/          agent-legible surface: llms.txt, openapi, well-known, pages
docs/decisions.md  every deviation from spec, with reasoning
```

## Develop

```bash
npm install
npx wrangler d1 migrations apply groundtruth --local
npx wrangler dev
```

Gates that must pass before any deploy:

```bash
npx tsc --noEmit
node scripts/a3-audit.mjs      # honesty: no dispatch, no referral, no purchasability
node scripts/policy-check.ts   # people-claim gate, both directions
./scripts/history-scan.sh      # secrets across git HISTORY, before any public push
```

`history-scan.sh` exists because a working-tree audit cannot catch what a
public push actually exposes. Grepping `git ls-files` only ever sees the
current checkout — it passes happily while earlier commits, and commit
messages, still carry the thing you removed.

Secrets are never committed. `ALERT_EMAIL` and `NTFY_TOPIC` are set with
`wrangler secret put` — the ntfy topic in particular is a capability, since
anyone holding it can both read the digest and publish alerts to the operator.

## Stack

Cloudflare Workers (stateless `createMcpHandler` — no Durable Objects), D1,
`@modelcontextprotocol/server` v2. A frozen project costs $0 to leave running,
which is the point: the sensor keeps accruing whether or not anyone is watching.

MIT
