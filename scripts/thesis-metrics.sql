-- Thesis validation metrics. Contract and thresholds: docs/thesis-metrics.md
-- Run: wrangler d1 execute groundtruth --remote --file scripts/thesis-metrics.sql
--
-- Read alongside scripts/looks-like-eval.sql, which lists the fingerprints
-- whose traffic looks like evaluation rather than demand; the thesis bar is
-- judged with those excluded.

SELECT '— 1. organic demand (the metric that matters most) —' AS metric;
SELECT count(*)                             AS organic_rows,
       count(DISTINCT caller_fingerprint)   AS organic_callers,
       min(ts)                              AS first_organic
  FROM demand_ledger
 WHERE origin = 'organic_request' AND suspect = 0;

SELECT '— 2. repeat callers (rows on >= 2 distinct days) —' AS metric;
SELECT caller_fingerprint,
       count(DISTINCT date(ts)) AS active_days,
       count(*)                 AS total_rows,
       min(ts)                  AS first_seen,
       max(ts)                  AS last_seen
  FROM demand_ledger
 WHERE suspect = 0 AND caller_fingerprint IS NOT NULL
 GROUP BY 1
HAVING active_days >= 2
 ORDER BY active_days DESC, total_rows DESC;

SELECT '— 3. uncatalogued shapes per week (the hole-finder) —' AS metric;
SELECT strftime('%Y-W%W', ts)          AS week,
       count(*)                        AS uncatalogued_rows,
       count(DISTINCT claim_description) AS distinct_shapes
  FROM demand_ledger
 WHERE claim_type IS NULL
   AND outcome != 'refused_policy'
   AND suspect = 0
   -- liveness pings ("test" etc.) are health checks, not demand shapes
   AND NOT (length(trim(claim_description)) <= 6
            AND task_context IS NULL AND downstream_action IS NULL)
 GROUP BY 1
 ORDER BY 1 DESC;

SELECT '— sample of current uncatalogued shapes (build-next backlog) —' AS metric;
SELECT claim_description, tool_name, ts
  FROM demand_ledger
 WHERE claim_type IS NULL AND outcome != 'refused_policy' AND suspect = 0
   AND NOT (length(trim(claim_description)) <= 6
            AND task_context IS NULL AND downstream_action IS NULL)
 ORDER BY ts DESC
 LIMIT 20;

SELECT '— 4. physical-presence demand per week (flip-trigger input) —' AS metric;
SELECT strftime('%Y-W%W', ts)              AS week,
       count(*)                            AS physical_rows,
       count(DISTINCT caller_fingerprint)  AS distinct_callers
  FROM demand_ledger
 WHERE physical_presence = 1 AND suspect = 0
 GROUP BY 1
 ORDER BY 1 DESC;

SELECT '— 4b. refusal demand curve (what we decline, by category) —' AS metric;
SELECT strftime('%Y-W%W', ts) AS week,
       refusal_category,
       count(*)               AS refusals
  FROM demand_ledger
 WHERE refusal_category IS NOT NULL
 GROUP BY 1, 2
 ORDER BY 1 DESC, 3 DESC;

SELECT '— 5. return loop: notify promises kept —' AS metric;
SELECT count(*)                                        AS registered,
       sum(CASE WHEN ready_at     IS NOT NULL THEN 1 ELSE 0 END) AS became_ready,
       sum(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
       sum(CASE WHEN delivery_method = 'callback'  THEN 1 ELSE 0 END) AS via_callback,
       sum(CASE WHEN delivery_method = 'next_call' THEN 1 ELSE 0 END) AS via_next_call
  FROM notify_registry;

SELECT '— outcome mix, last 30 days (fulfillment rate at a glance) —' AS metric;
SELECT outcome, count(*) AS rows_
  FROM demand_ledger
 WHERE ts > datetime('now', '-30 days') AND suspect = 0
 GROUP BY 1
 ORDER BY 2 DESC;
