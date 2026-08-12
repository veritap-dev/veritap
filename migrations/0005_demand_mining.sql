-- Demand-mining columns, added after the first real external traffic showed
-- what the ledger could not answer.
--
-- refusal_category: WHICH people-claim category fired, set at refuse time in
-- TypeScript from the gate pattern that matched — never derived from stored
-- text, which is nulled for refusals. "Employment-shaped refusals: N/week" is
-- market signal for the demand we permanently decline; the subject's identity
-- is the PII we refuse to hold. Before this column the category was only
-- recoverable by LIKE-parsing the redaction placeholder string.
--
-- physical_presence: the claim needs someone on-site (inspection, visit,
-- walk-through). No fulfillment path can ever serve it under the no-humans
-- policy — which is exactly why it must be countable: it is the input to the
-- marketplace-flip decision (see docs/thesis-metrics.md), and the demand class
-- the original rent-a-human thesis targets.

ALTER TABLE demand_ledger ADD COLUMN refusal_category  TEXT;
ALTER TABLE demand_ledger ADD COLUMN physical_presence INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ledger_refusal
  ON demand_ledger (refusal_category, ts) WHERE refusal_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_physical
  ON demand_ledger (ts) WHERE physical_presence = 1;
