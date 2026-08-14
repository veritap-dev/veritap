-- Which fingerprints look like evaluation/probing rather than demand?
-- Run: wrangler d1 execute groundtruth --remote --file scripts/looks-like-eval.sql
--
-- Query-time discriminator, deliberately NOT a write-time flag (see
-- docs/thesis-metrics.md and migration 0003's store-components philosophy):
-- a heuristic in the write path can never be revised retroactively; this file
-- can be rerun against all history every time the signature improves.
--
-- Probe signature, from the first real external caller (2026-08-12):
--   a. balanced sweep — touched every published claim type at least once
--   b. boundary poke — also hit the people-claim refusal
--   c. anonymous transport — no clientInfo (bare curl / scripted HTTP)
-- Each axis alone is weak; a fingerprint scoring all three in one short
-- session is far more likely evaluating the surface than stuck mid-task.
-- A real blocked agent asks lopsided variations of ONE thing.

WITH per_caller AS (
  SELECT caller_fingerprint                                        AS fp,
         count(DISTINCT claim_type)                                AS types_touched,
         (SELECT count(*) FROM demand_ledger)                      AS _unused,
         sum(CASE WHEN outcome = 'refused_policy' THEN 1 ELSE 0 END) AS refusals,
         sum(CASE WHEN client_name IS NULL THEN 1 ELSE 0 END)      AS anon_rows,
         count(*)                                                  AS total_rows,
         count(DISTINCT date(ts))                                  AS active_days,
         CAST((julianday(max(ts)) - julianday(min(ts))) * 24 * 60 AS INTEGER) AS span_minutes
    FROM demand_ledger
   WHERE caller_fingerprint IS NOT NULL
   GROUP BY 1
),
catalog_size AS (
  -- Published claim types seen anywhere in the ledger; close enough to the
  -- catalog cardinality without hardcoding it.
  SELECT count(DISTINCT claim_type) AS n FROM demand_ledger WHERE claim_type IS NOT NULL
)
SELECT fp,
       total_rows,
       active_days,
       span_minutes,
       types_touched || '/' || (SELECT n FROM catalog_size) AS catalog_sweep,
       refusals,
       anon_rows,
       CASE WHEN types_touched >= (SELECT n FROM catalog_size)
             AND refusals > 0
             AND anon_rows = total_rows
             AND active_days = 1
            THEN 'EVAL-SUSPECT'
            WHEN types_touched >= (SELECT n FROM catalog_size) AND refusals > 0
            THEN 'eval-leaning'
            ELSE 'demand-like'
       END AS verdict
  FROM per_caller
 ORDER BY verdict, total_rows DESC;

-- ── Liveness pings ──────────────────────────────────────────────────────────
-- Found in production 2026-08-13: directory census crawlers (first sighting:
-- SaSame-MCP-Audit) verify listed servers daily with the minimal valid call —
-- claim_description "test", no context, one call per visit. Touches zero
-- catalog types and zero refusals, so the probe signature above scores it
-- demand-like. This section names them separately.
SELECT '— liveness pings (directory health checks, not demand) —' AS section;
SELECT caller_fingerprint                       AS fp,
       COALESCE(client_name, client_ua, '?')    AS who,
       count(*)                                 AS pings,
       min(ts)                                  AS first_seen,
       max(ts)                                  AS last_seen
  FROM demand_ledger
 WHERE length(trim(claim_description)) <= 6
   AND task_context IS NULL AND downstream_action IS NULL
   AND claim_type IS NULL
 GROUP BY 1, 2
 ORDER BY pings DESC;
