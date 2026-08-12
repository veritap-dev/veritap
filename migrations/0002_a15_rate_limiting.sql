-- A15 layer 2 + 3 — quarantine and circuit breaker.
--
-- The governing idea: this is a sensor, so the answer to suspected flooding is
-- to TAG, not to refuse. A wrongly-throttled legitimate agent prunes us from
-- its tool rotation permanently; a wrongly-tagged row costs nothing and can be
-- un-flagged later. Dropped rows cannot be recovered.

-- suspect = written while the caller's fingerprint was over threshold.
-- NOT retroactive: an agent with 40 clean calls that then goes weird keeps
-- those 40 rows clean. Only rows written during the hot window are marked.
ALTER TABLE demand_ledger ADD COLUMN suspect INTEGER NOT NULL DEFAULT 0;

-- §7 weekly queries filter on this, so it leads the index.
CREATE INDEX IF NOT EXISTS idx_ledger_suspect_ts ON demand_ledger (suspect, ts);

-- Circuit breaker state. Counting rows in demand_ledger per request would be a
-- full scan on the hot path; a counter row is one upsert.
CREATE TABLE IF NOT EXISTS daily_counters (
  day             TEXT PRIMARY KEY,   -- YYYY-MM-DD UTC
  writes          INTEGER NOT NULL DEFAULT 0,  -- rows actually written
  degraded_writes INTEGER NOT NULL DEFAULT 0,  -- suppressed while breaker open
  suspect_writes  INTEGER NOT NULL DEFAULT 0,
  alerted         INTEGER NOT NULL DEFAULT 0   -- breaker email sent for this day
);
