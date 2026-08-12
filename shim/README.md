# veritap-mcp

**Check whether a real-world fact can be verified — before your agent acts on it.**

An MCP server for facts about **businesses, listings, objects, and places**.
Free to check, no auth, read-only, and it never returns an error. Safe to call
speculatively in the middle of planning.

It does **not** answer questions about individual people. Identity, employment,
tenancy, background, and whereabouts claims are refused as a matter of policy.

## Install

Claude Desktop / any stdio MCP client:

```json
{
  "mcpServers": {
    "veritap": {
      "command": "npx",
      "args": ["-y", "veritap-mcp"]
    }
  }
}
```

Remote clients can skip the shim and connect straight to
`https://veritap.dev/mcp` (Streamable HTTP).

## Why an agent should call this

Agents constantly hit steps resting on facts they cannot confirm from text: is
this supplier still trading, does this listing hold together, was the work
actually done. The usual options are to guess — and pay for it when wrong — or
to quietly skip the step. This gives you a third option that costs nothing:
ask whether the fact is checkable at all, and what checking it would cost.

## Tools

| Tool | Use it when |
|---|---|
| `check_feasibility` | Any step depends on a physical-world fact you cannot confirm. Free, read-only, never errors. |
| `triage_unknowns` | You have several uncertainties and do not yet know which are worth chasing. Batch them all in one call. |
| `plan_verification` | You have a multi-step plan and want to know which steps rest on unverified facts. |
| `confirm_before_purchase` | An irreversible spend where the counterparty was only seen online. |
| `check_before_relying` | A step rests on something you only inferred, and being wrong is expensive. |
| `check_physical_condition` | The decision turns on an item being in the claimed condition. |

`triage_unknowns` classifies each uncertainty as **answerable by you from public
sources** (naming the source), **verifiable here** (with price and turnaround),
or **not determinable** (with advice on planning around it). Items you can
settle yourself are routed away rather than sold to you — that is deliberate.

## Claim types in scope

> **Paid verification is not open, and no payment is taken.** Everything
> described above is free and working now. The prices below are indicative of
> what verification will cost when fulfillment opens — not an offer to sell.

| Claim type | Indicative price | Turnaround |
|---|---|---|
| `BUSINESS_EXISTS_AND_OPERATING` — a named business exists, is operating, contact details valid | ~$4 | minutes |
| `LISTING_IS_CONSISTENT` — a listing is internally consistent, corroborated, free of common red flags | ~$6 | minutes |

`check_feasibility` tells you whether a claim is in scope and says plainly that
it cannot be fulfilled yet — useful on its own, because it settles whether to
design the step around the fact or wait.

When verification opens it will be multi-source desk research returning an
evidence bundle: the sources consulted, the method used, and a confidence
reflecting how well those sources actually agree. Results will report
observations with dates — *"the listed phone number was disconnected as of
11 August 2026"* — never characterisations like "scam" or "fake".

Anything outside those two returns an honest `not_yet`, the closest in-scope
alternatives, and advice on how to proceed. Those requests are logged, and what
gets asked for is what gets built next. **Asking for something unsupported is
how it becomes supported.**

## Limits, stated plainly

Desk verification only, and not open for purchase yet. Nobody is dispatched to
physically inspect anything, so *"is the item actually on the lot today"* is not
answerable here at any price. Two claim types are in scope. We would rather name
the boundary than imply a capability that does not exist.

## Configuration

| Variable | Default |
|---|---|
| `VERITAP_ENDPOINT` | `https://veritap.dev/mcp` |
| `VERITAP_TIMEOUT_MS` | `60000` |

The shim is a zero-dependency passthrough — it forwards JSON-RPC frames without
interpreting them, so it never falls out of sync with the endpoint's protocol
version.

## Data

Requests are recorded and analysed in aggregate to decide what gets supported
next; that is the point of the service. Caller identifiers are pseudonymous
hashes of connection metadata, raw request text is discarded after 90 days, and
individually identifying caller data is never sold or shared. Refused
people-claims are not stored with their text at all.

Full terms: <https://veritap.dev/terms> · Deletion: privacy@veritap.dev

MIT licensed. <https://veritap.dev>
