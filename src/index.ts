/**
 * Worker entry and MCP protocol layer.
 *
 * Stateless: `createMcpHandler` builds a fresh McpServer per request, so no
 * Durable Object binding is needed and a frozen project is genuinely $0 idle.
 * All state lives in D1.
 *
 * Not yet implemented (addendum A6): the auto desk verifier and the
 * `verify_claim` / `get_verification` pair that depend on it.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

import { catalogSummary } from "./router.ts";
import { deriveFingerprint, touchCaller } from "./ledger.ts";
import { INSTRUCTIONS, registerTools } from "./tools.ts";
import { sweepNotifications } from "./notify.ts";
import { sendAlert } from "./alerts.ts";
import { handleAdmin } from "./admin.ts";
import { dailyDigest } from "./digest.ts";
import { readClientContext, hasIdentity, type ClientContext } from "./client.ts";
import type { Env } from "./types.ts";

function createServer(
  ctx: { requestInfo?: Request },
  env: Env,
  client: ClientContext | undefined,
): McpServer {
  // §9: the server name is tool-selection signal, not just a label — models
  // read it when deciding what to call. `groundtruth-router` stays the Worker
  // and repo name; the wire identity is the brand.
  const server = new McpServer(
    // Version must track npm/server.json/lhm.plugin.json — directories
    // (Smithery, LobeHub) display what initialize reports, and a drifting
    // wire version reads as an unmaintained or mismatched listing.
    { name: "veritap", version: "0.1.3" },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, env, ctx.requestInfo, client);
  return server;
}

/**
 * Negative-space logging (spec open question 3 — answered: observable without
 * HTTP log parsing). The Worker owns the outer fetch, so it peeks the JSON-RPC
 * method off a clone of the body before delegating. Kept OUT of demand_ledger
 * so inspections cannot inflate the §12 demand metrics.
 */
async function recordInspection(
  request: Request,
  env: Env,
  client: ClientContext,
): Promise<void> {
  try {
    if (client.method !== "tools/list" && client.method !== "initialize") return;

    await env.DB.prepare(
      `INSERT INTO inspections
         (ts, method, caller_fingerprint, user_agent,
          client_name, client_version, protocol_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        new Date().toISOString(),
        client.method,
        await deriveFingerprint(request),
        client.userAgent ?? null,
        client.name ?? null,
        client.version ?? null,
        client.protocol ?? null,
      )
      .run();
  } catch {
    // Malformed or non-JSON bodies are the MCP layer's problem, not ours.
  }
}

/**
 * Retention (§7 as amended): structured rows are kept indefinitely, but
 * `raw_input_json` is nulled after 90 days. The structured columns are the
 * dataset; the raw blob is only schema-drift insurance and is the field most
 * likely to contain third-party PII.
 */
const RETENTION_PAGE = 500;
const RETENTION_MAX_PAGES = 40; // 20k rows per nightly run

/**
 * Retention (§7 as amended): structured rows kept indefinitely, raw_input_json
 * nulled after 90 days.
 *
 * Two bugs fixed here, both of which fail silently:
 *
 * 1. The UPDATE was unbounded. D1 caps a query at 30 seconds, so once the
 *    table is large enough the sweep starts timing out — and the failure is
 *    caught and logged, meaning raw payloads quietly stop being scrubbed while
 *    the terms page keeps promising a 90-day discard. Now paged.
 *
 * 2. It compared an ISO-8601 `ts` ("2026-05-14T10:00:00.000Z") against
 *    SQLite's datetime() ("2026-05-14 10:00:00"). These are string-compared,
 *    and 'T' > ' ', so the boundary was fuzzy by up to a day. strftime with
 *    the matching format makes the comparison exact — the same format trap
 *    that made the A15 hourly window silently miss rows.
 */
async function runRetention(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  let scrubbed = 0;
  let purged = 0;

  try {
    for (let page = 0; page < RETENTION_MAX_PAGES; page++) {
      const res = await env.DB.prepare(
        `UPDATE demand_ledger SET raw_input_json = NULL
          WHERE id IN (
            SELECT id FROM demand_ledger
             WHERE raw_input_json IS NOT NULL AND ts < ?1
             LIMIT ?2)`,
      )
        .bind(cutoff, RETENTION_PAGE)
        .run();
      const n = res.meta?.changes ?? 0;
      scrubbed += n;
      if (n < RETENTION_PAGE) break;
    }

    for (let page = 0; page < RETENTION_MAX_PAGES; page++) {
      const res = await env.DB.prepare(
        `DELETE FROM notify_registry
          WHERE id IN (
            SELECT id FROM notify_registry
             WHERE delivered_at IS NOT NULL AND delivered_at < ?1
             LIMIT ?2)`,
      )
        .bind(cutoff, RETENTION_PAGE)
        .run();
      const n = res.meta?.changes ?? 0;
      purged += n;
      if (n < RETENTION_PAGE) break;
    }

    const remaining = await env.DB.prepare(
      `SELECT count(*) AS n FROM demand_ledger WHERE raw_input_json IS NOT NULL AND ts < ?`,
    )
      .bind(cutoff)
      .first<{ n: number }>();

    console.log("RETENTION_SWEEP", {
      rows_scrubbed: scrubbed,
      notices_purged: purged,
      still_pending: remaining?.n ?? 0,
    });
    if ((remaining?.n ?? 0) > 0) {
      console.warn("RETENTION_BACKLOG", { pending: remaining?.n, note: "raise RETENTION_MAX_PAGES or run more often" });
    }
  } catch (err) {
    console.error("RETENTION_SWEEP_FAILED", { scrubbed, purged, error: String(err) });
  }
}


/** Free plan hard cap. Past this, Workers returns 1027 and drops traffic. */
const DAILY_REQUEST_CAP = 100_000;
const USAGE_WARN_FRACTION = 0.6;

/**
 * Hourly check: are we approaching the free-plan request cap?
 *
 * Deliberately a PROXY, and worth being honest about its limits. It counts
 * today's ledger rows plus today's inspections — the two things we already
 * record — so it undercounts: static asset hits, /health, 404s and the extra
 * requests in an MCP handshake are invisible to it. Treat the number as a
 * floor, not a measurement.
 *
 * Counting real requests would mean a D1 write per request, which would burn
 * the very budget it is trying to protect.
 *
 * Runs hourly rather than nightly because the cap resets at midnight UTC and a
 * daily check could report a breach long after the traffic was already dropped.
 */
async function checkUsage(env: Env): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM demand_ledger WHERE substr(ts,1,10) = ?1) AS calls,
         (SELECT count(*) FROM inspections   WHERE substr(ts,1,10) = ?1) AS looks,
         (SELECT COALESCE(usage_alerted,0) FROM daily_counters WHERE day = ?1) AS alerted`,
    )
      .bind(day)
      .first<{ calls: number; looks: number; alerted: number | null }>();

    const observed = (row?.calls ?? 0) + (row?.looks ?? 0);
    const threshold = DAILY_REQUEST_CAP * USAGE_WARN_FRACTION;
    if (observed < threshold || row?.alerted) return;

    await env.DB.prepare(
      `INSERT INTO daily_counters (day, usage_alerted) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET usage_alerted = 1`,
    )
      .bind(day)
      .run();

    await sendAlert(
      env,
      `Veritap approaching free-plan request cap (${day})`,
      [
        `Observed at least ${observed} requests today against a free-plan cap of ${DAILY_REQUEST_CAP}.`,
        "",
        "This is a FLOOR, not a measurement: it counts ledger rows and tool-list",
        "inspections only, so real usage is higher.",
        "",
        "On the free plan the cap does not bill you — it rejects requests with",
        "Error 1027 until midnight UTC. Rejected demand events are lost forever.",
        "",
        "Options: let it drop (costs data), or upgrade to Workers Paid",
        "($5/mo + usage) — the Billing Budget Alert is already configured.",
      ].join("\r\n"),
    );
    console.warn("USAGE_WARNING_SENT", { day, observed });
  } catch (err) {
    console.error("USAGE_CHECK_FAILED", { error: String(err) });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      // Parse identity ONCE per request and hand it down, rather than cloning
      // and re-parsing the body in each consumer.
      let client: ClientContext = {};
      if (request.method === "POST") {
        try {
          client = readClientContext(await request.clone().json(), request);
        } catch {
          client = readClientContext(undefined, request);
        }
        ctx.waitUntil(recordInspection(request, env, client));
        // A 2025-era client announces itself ONLY here, so this write is
        // awaited rather than deferred: with waitUntil, a client that calls a
        // tool immediately after initialize races the write and its first row
        // lands unattributed. initialize happens once per session, so paying
        // the write latency here buys reliable attribution from the first call.
        if (client.method === "initialize" && hasIdentity(client)) {
          try {
            await touchCaller(env, await deriveFingerprint(request), client);
          } catch {
            // Identity is best-effort; never fail a handshake over it.
          }
        }
      }
      // Built per request so `env` is captured by closure. A module-scope
      // handler would have to stash env on globalThis, which races across
      // concurrent requests sharing the isolate.
      const mcpHandler = createMcpHandler((mcpCtx) => createServer(mcpCtx, env, client), {
        route: "/mcp",
      });
      return mcpHandler(request, env, ctx);
    }

    // A16: operator observability. handleAdmin refuses without a Cloudflare
    // Access identity, so deploying this ahead of the Access policy cannot
    // leak the ledger.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "groundtruth-router",
        auto_verifier: env.AUTO_VERIFIER_ENABLED === "true",
        catalog: catalogSummary(),
      });
    }

    return Response.json(
      { error: "not_found", mcp_endpoint: new URL("/mcp", url.origin).toString() },
      { status: 404 },
    );
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Hourly: cheap usage check. Nightly: the heavy sweeps.
    if (event.cron === "0 * * * *") {
      ctx.waitUntil(checkUsage(env));
      return;
    }
    // Re-match waiting callers against the current catalog before scrubbing —
    // the notify registry is the return path now that referrals are gone (A8).
    ctx.waitUntil(
      sweepNotifications(env)
        .then(() => runRetention(env))
        .then(() => dailyDigest(env)),
    );
  },
} satisfies ExportedHandler<Env>;
