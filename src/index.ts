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
import { deriveFingerprint } from "./ledger.ts";
import { INSTRUCTIONS, registerTools } from "./tools.ts";
import { sweepNotifications } from "./notify.ts";
import type { Env } from "./types.ts";

function createServer(ctx: { requestInfo?: Request }, env: Env): McpServer {
  // §9: the server name is tool-selection signal, not just a label — models
  // read it when deciding what to call. `groundtruth-router` stays the Worker
  // and repo name; the wire identity is the brand.
  const server = new McpServer(
    { name: "veritap", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, env, ctx.requestInfo);
  return server;
}

/**
 * Negative-space logging (spec open question 3 — answered: observable without
 * HTTP log parsing). The Worker owns the outer fetch, so it peeks the JSON-RPC
 * method off a clone of the body before delegating. Kept OUT of demand_ledger
 * so inspections cannot inflate the §12 demand metrics.
 */
async function recordInspection(request: Request, env: Env): Promise<void> {
  try {
    const body = (await request.clone().json()) as { method?: string };
    if (body?.method !== "tools/list") return;

    await env.DB.prepare(
      `INSERT INTO inspections (ts, method, caller_fingerprint, user_agent)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(
        new Date().toISOString(),
        body.method,
        await deriveFingerprint(request),
        request.headers.get("user-agent") ?? null,
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
async function runRetention(env: Env): Promise<void> {
  try {
    const res = await env.DB.prepare(
      `UPDATE demand_ledger
          SET raw_input_json = NULL
        WHERE raw_input_json IS NOT NULL
          AND ts < datetime('now', '-90 days')`,
    ).run();
    // The notify registry holds caller-supplied claim text too, and a promise
    // that has been kept has no reason to be retained.
    const notices = await env.DB.prepare(
      `DELETE FROM notify_registry
        WHERE delivered_at IS NOT NULL
          AND delivered_at < datetime('now', '-90 days')`,
    ).run();

    console.log("RETENTION_SWEEP", {
      rows_scrubbed: res.meta?.changes ?? 0,
      notices_purged: notices.meta?.changes ?? 0,
    });
  } catch (err) {
    console.error("RETENTION_SWEEP_FAILED", { error: String(err) });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      if (request.method === "POST") {
        ctx.waitUntil(recordInspection(request, env));
      }
      // Built per request so `env` is captured by closure. A module-scope
      // handler would have to stash env on globalThis, which races across
      // concurrent requests sharing the isolate.
      const mcpHandler = createMcpHandler((mcpCtx) => createServer(mcpCtx, env), {
        route: "/mcp",
      });
      return mcpHandler(request, env, ctx);
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

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Re-match waiting callers against the current catalog before scrubbing —
    // the notify registry is the return path now that referrals are gone (A8).
    ctx.waitUntil(sweepNotifications(env).then(() => runRetention(env)));
  },
} satisfies ExportedHandler<Env>;
