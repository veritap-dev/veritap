-- Ticket 2 — GroundTruth Router initial schema (spec §7).
--
-- Design rule for this file: the ledger is the product, and an unrecorded day
-- is lost forever. So the demand_ledger table carries NO CHECK constraints and
-- almost no NOT NULLs — a rejected INSERT is a destroyed demand event, which is
-- strictly worse than a row with a weird value in it. Enum values are
-- documented here and enforced (loosely) in TypeScript, not by the database.
-- raw_input_json is the backstop: if a column is wrong, the truth is still there.

CREATE TABLE IF NOT EXISTS demand_ledger (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 TEXT NOT NULL,           -- ISO8601 UTC
  tool_name          TEXT NOT NULL,           -- which doorway was called

  -- how the ask reached us:
  --   organic_request   agent called verify_claim of its own accord
  --   elicited_probe    via check_feasibility / aliases / triage_unknowns
  --   elicited_plan     surfaced inside a plan_verification chain
  --   elicited_followup agent answered an end-goal hook from a prior response
  origin             TEXT NOT NULL,

  -- links follow-ups and escalations back to the event that elicited them,
  -- which is what makes probe->request conversion measurable (§7 query 2).
  parent_event_id    INTEGER REFERENCES demand_ledger(id),

  caller_fingerprint TEXT,                    -- hashed key or stable anon id

  claim_description  TEXT,
  claim_type         TEXT,                    -- NULL = uncatalogued (the gold)
  location_text      TEXT,
  lat                REAL,
  lng                REAL,
  budget_ceiling_usd REAL,
  deadline           TEXT,
  downstream_action  TEXT,
  cost_if_wrong      TEXT,
  task_context       TEXT,

  -- what happened to it (orthogonal to origin):
  --   fulfilled_cache   served from a valid cached attestation
  --   fulfilled_auto    served by an automated desk verifier   [reserved]
  --   quoted_unpaid     priced, caller did not proceed
  --   referred          handed to an external fulfiller
  --   unsupported       no claim type matched; logged for the backlog
  -- NOTE: `fulfilled_manual` from spec §7 is intentionally absent — there is no
  -- operator-routed fulfillment path in this build (see docs/decisions.md).
  outcome            TEXT NOT NULL,

  price_quoted       REAL,
  revenue_usd        REAL,

  raw_input_json     TEXT                     -- full request; schema-drift insurance
);

-- Weekly operator queries (§7). Kept narrow on purpose: writes must stay cheap.
CREATE INDEX IF NOT EXISTS idx_ledger_ts          ON demand_ledger (ts);
CREATE INDEX IF NOT EXISTS idx_ledger_origin_ts   ON demand_ledger (origin, ts);
CREATE INDEX IF NOT EXISTS idx_ledger_outcome_ts  ON demand_ledger (outcome, ts);
CREATE INDEX IF NOT EXISTS idx_ledger_parent      ON demand_ledger (parent_event_id);
CREATE INDEX IF NOT EXISTS idx_ledger_caller      ON demand_ledger (caller_fingerprint);
-- Query 1, the build-next backlog: uncatalogued claims only.
CREATE INDEX IF NOT EXISTS idx_ledger_uncatalogued
  ON demand_ledger (ts) WHERE claim_type IS NULL;

CREATE TABLE IF NOT EXISTS attestation_cache (
  claim_hash   TEXT PRIMARY KEY,              -- sha256(normalized claim + type + location)
  bundle_json  TEXT NOT NULL,                 -- serialized AttestationBundle
  valid_until  TEXT NOT NULL,                 -- ISO8601; past = miss, row kept for stats
  times_served INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_valid_until ON attestation_cache (valid_until);

CREATE TABLE IF NOT EXISTS callers (
  fingerprint  TEXT PRIMARY KEY,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  call_count   INTEGER NOT NULL DEFAULT 0,
  api_key_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_callers_last_seen ON callers (last_seen);

-- Retention hook (§7 as amended): `waiting on a claim type we do not have yet`.
-- Promoted from decorative to load-bearing by A8 — with no outbound referral,
-- this registry IS the return path. A caller who hits a gap must actually hear
-- back when we close it, or the "they come back to us" half of the flywheel
-- does not exist.
CREATE TABLE IF NOT EXISTS notify_registry (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at         TEXT NOT NULL,
  caller_fingerprint TEXT,
  event_id           INTEGER REFERENCES demand_ledger(id),
  claim_description  TEXT NOT NULL,
  normalized         TEXT NOT NULL,     -- normalizeClaim() output, for re-matching
  callback_url       TEXT,              -- POSTed on ready, when supplied
  ready_at           TEXT,              -- set when a catalog type can now answer it
  delivered_at       TEXT,              -- set once the caller has been told
  delivery_method    TEXT               -- 'callback' | 'next_call'
);

CREATE INDEX IF NOT EXISTS idx_notify_pending
  ON notify_registry (caller_fingerprint) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notify_unready
  ON notify_registry (created_at) WHERE ready_at IS NULL;

-- Negative space: clients that inspect the tool list and never call anything.
-- Deliberately a SEPARATE table rather than a demand_ledger row — an inspection
-- is not a demand event, and mixing them would inflate every §12 metric.
-- (Beyond the three tables in spec §7; see docs/decisions.md.)
CREATE TABLE IF NOT EXISTS inspections (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 TEXT NOT NULL,
  method             TEXT NOT NULL,           -- 'tools/list' today
  caller_fingerprint TEXT,
  user_agent         TEXT
);

CREATE INDEX IF NOT EXISTS idx_inspections_ts     ON inspections (ts);
CREATE INDEX IF NOT EXISTS idx_inspections_caller ON inspections (caller_fingerprint);
