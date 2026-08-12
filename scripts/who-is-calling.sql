-- Who is calling. Run with:
--   wrangler d1 execute groundtruth --remote --file scripts/who-is-calling.sql
--
-- Three denominators on purpose. There is no installation id in MCP, so
-- "unique instances" is an estimate and the honest move is to show the spread
-- rather than pick one number and call it truth.

SELECT '— tool calls by client software —' AS section;
SELECT COALESCE(client_name, '(unannounced)') AS client,
       COALESCE(client_version, '-')          AS version,
       COALESCE(client_ua, '-')               AS runtime,
       COALESCE(protocol_version, '-')        AS protocol,
       count(*)                               AS calls,
       count(DISTINCT caller_fingerprint)     AS fingerprints,
       min(ts)                                AS first_seen,
       max(ts)                                AS last_seen
  FROM demand_ledger
 WHERE suspect = 0
 GROUP BY 1,2,3,4
 ORDER BY calls DESC;

SELECT '— tool-list inspections (looked, did not call) —' AS section;
SELECT COALESCE(client_name, '(unannounced)') AS client,
       COALESCE(user_agent, '-')              AS runtime,
       method,
       count(*)                               AS fetches,
       count(DISTINCT caller_fingerprint)     AS fingerprints
  FROM inspections
 GROUP BY 1,2,3
 ORDER BY fetches DESC;

SELECT '— reach estimate, three ways —' AS section;
SELECT (SELECT count(DISTINCT caller_fingerprint) FROM demand_ledger WHERE suspect=0) AS by_fingerprint_upper,
       (SELECT count(DISTINCT COALESCE(client_name, client_ua)) FROM demand_ledger WHERE suspect=0) AS by_software_lower,
       (SELECT count(DISTINCT COALESCE(client_name,'?') || '|' || COALESCE(client_ua,'?')) FROM demand_ledger WHERE suspect=0) AS by_software_and_runtime;

SELECT '— did anyone run the npm shim? —' AS section;
SELECT count(*) AS shim_requests FROM inspections WHERE user_agent = 'veritap-mcp-shim';
