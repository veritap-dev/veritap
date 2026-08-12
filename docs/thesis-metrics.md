# Thesis validation metrics — what would prove the sensor is working

Written 2026-08-12, five external ledger rows in, so that in six weeks the
ledger gets read against a bar instead of against vibes.

The thesis: agents hold verification needs they would otherwise route to a
human (or silently guess through). An MCP tool sitting in the tool-selection
loop can capture that demand upstream of every rent-a-human-style site, and
the resulting ledger — what was asked, what we couldn't answer — is the asset.

That thesis is **validated by behavior we cannot fake**, not by row counts.
Every metric below is chosen because an evaluation harness or a curious
tester would find it expensive to counterfeit.

Run the numbers: `wrangler d1 execute groundtruth --remote --file scripts/thesis-metrics.sql`

## The five metrics

**1. Organic demand.** Count of `origin = 'organic_request'` rows — an agent
that formed its own verification intent rather than being walked into a probe
by our tool descriptions. Today: the column value is reserved and has never
been written; every row is elicited. The first organic row is a bigger event
than the hundredth elicited one.

**2. Repeat callers.** Fingerprints with ledger rows on ≥ 2 distinct days.
A caller that returns had no better alternative — this is the behavioral
willingness-to-pay signal that the null-forever `budget_ceiling_usd` field
was supposed to capture and never will.

**3. Uncatalogued shape rate.** Distinct non-refused `claim_type IS NULL`
claims per week. This is the hole-finder actually finding holes. A week where
every claim maps to the existing catalog means the sensor is confirming what
we knew, not discovering.

**4. Physical-presence demand.** `physical_presence = 1` rows per week
(column added in migration 0005). The demand class the original thesis
targets and the no-humans policy refuses to serve.

**5. Return-loop delivery.** `notify_registry` rows with `delivered_at` set,
and what the caller did next (`parent_event_id` chains). The report-back
promise is load-bearing for the flywheel; until one delivery has fired, the
"they come back" half of the thesis is unobserved.

## Thresholds

Numbers picked to be embarrassing to argue with rather than statistically
derived — the point is a pre-committed bar:

- **Sensor validated (keep investing):** ≥ 3 organic rows from ≥ 2 distinct
  non-probe callers in a rolling 30 days, OR ≥ 5 repeat callers in 30 days.
- **Catalog expansion trigger** (existing rule, restated): ≥ 10 asks with
  budget for one claim shape. With `budget_ceiling_usd` empty in practice,
  read "with budget" as: from ≥ 3 distinct fingerprints, or any repeat caller
  asking twice.
- **Marketplace-flip conversation trigger:** ≥ 10 physical-presence asks per
  week sustained for 4 consecutive weeks, from ≥ 5 distinct fingerprints.
  This does not trigger the flip — it triggers the *conversation* about
  whether the no-humans policy stays a permanent identity or was a v1
  constraint (the brand was kept disposable for exactly this fork; see the
  brand-separation note in decisions.md).
- **Sensor falsified (stop and rethink):** 90 days of traffic with zero
  organic rows, zero repeat callers, and an eval-share (below) above 80%.

## Discounting evaluation traffic

`scripts/looks-like-eval.sql` classifies fingerprints at query time by probe
signature: balanced sweep of the published catalog + a poke at the refusal
boundary, placeholder-grade context values, bare curl/no clientInfo. The
first external caller matched this signature on all three axes.

Deliberately **not** a write-time flag: consistent with migration 0003's
philosophy, we store components and choose the discriminator at query time.
A heuristic baked into the write path would age badly and could never be
revised retroactively; the same heuristic in a .sql file can be rerun against
all history every time it improves.

All five metrics should be read twice: raw, and with eval-suspect
fingerprints excluded. The thesis bar uses the excluded reading.
