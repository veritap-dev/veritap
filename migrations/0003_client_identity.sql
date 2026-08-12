-- Capture WHAT is calling, without pretending we can identify a unique install.
--
-- MCP has no session, cookie, or installation id. The fingerprint
-- sha256(ip|user-agent) mis-counts in both directions: two agents behind one
-- NAT collapse into one identity, and one agent behind rotating cloud egress
-- splits into many. Both are visible in the first week of real traffic.
--
-- So: do NOT bake a new guess into the hash. Store the components and let the
-- denominator be chosen at query time — by client_name for "which software",
-- by fingerprint for "roughly how many", by both for a tighter estimate.
-- Components can always be re-hashed; a hash can never be decomposed.

ALTER TABLE demand_ledger ADD COLUMN client_name      TEXT;
ALTER TABLE demand_ledger ADD COLUMN client_version   TEXT;
ALTER TABLE demand_ledger ADD COLUMN client_ua        TEXT;
ALTER TABLE demand_ledger ADD COLUMN protocol_version TEXT;

-- Sticky per caller: legacy-era (2025) clients only send clientInfo at
-- initialize, so tool calls inherit it from here by fingerprint.
ALTER TABLE callers ADD COLUMN client_name      TEXT;
ALTER TABLE callers ADD COLUMN client_version   TEXT;
ALTER TABLE callers ADD COLUMN user_agent       TEXT;
ALTER TABLE callers ADD COLUMN protocol_version TEXT;

ALTER TABLE inspections ADD COLUMN client_name      TEXT;
ALTER TABLE inspections ADD COLUMN client_version   TEXT;
ALTER TABLE inspections ADD COLUMN protocol_version TEXT;

CREATE INDEX IF NOT EXISTS idx_ledger_client ON demand_ledger (client_name, ts);
