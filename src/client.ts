/**
 * Who is calling.
 *
 * Three independent signals, none of which is an installation id:
 *
 *   clientInfo  {name, version} — the MCP client software. Best signal, but
 *               only present where the protocol carries it (see below).
 *   user-agent  the HTTP runtime: node, python-httpx, Deno/SupabaseEdgeRuntime,
 *               veritap-mcp-shim. Always present, coarser.
 *   protocol    2025-06-18 vs 2026-07-28 — SDK vintage, a decent proxy for how
 *               modern the calling stack is.
 *
 * Protocol nuance that decides the design: under 2026-07-28 clientInfo rides on
 * EVERY request in `_meta`, so a tool call carries it. Under the 2025 era it
 * appears only in the `initialize` params — and this server is stateless, so
 * there is no session to hang it on. Hence the `callers` row: capture at
 * initialize, inherit by fingerprint on later calls.
 */

const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";

export interface ClientContext {
  method?: string;
  name?: string;
  version?: string;
  protocol?: string;
  userAgent?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined;

/**
 * Parse identity out of one JSON-RPC request body. Never throws: an
 * unparseable body is the MCP layer's problem, and losing identity must never
 * cost us the call.
 */
export function readClientContext(body: unknown, request: Request): ClientContext {
  const ctx: ClientContext = {
    userAgent: str(request.headers.get("user-agent")) ?? undefined,
    protocol: str(request.headers.get("mcp-protocol-version")) ?? undefined,
  };

  const b = body as
    | {
        method?: string;
        params?: {
          clientInfo?: { name?: string; version?: string };
          protocolVersion?: string;
          _meta?: Record<string, unknown>;
        };
        _meta?: Record<string, unknown>;
      }
    | undefined;
  if (!b || typeof b !== "object") return ctx;

  ctx.method = str(b.method);

  // 2026-07-28 puts request metadata in `params._meta` — NOT at the JSON-RPC
  // root. Verified the hard way: the SDK rejects a root-level `_meta` outright
  // with "not a valid JSON-RPC message". Root is checked too, defensively,
  // since it costs nothing and clients get this wrong.
  const meta = (b.params?._meta ?? b._meta) as Record<string, unknown> | undefined;
  const metaClient = meta?.[CLIENT_INFO_META] as { name?: string; version?: string } | undefined;
  if (metaClient) {
    ctx.name = str(metaClient.name);
    ctx.version = str(metaClient.version);
  }
  ctx.protocol = str(meta?.[PROTOCOL_META]) ?? ctx.protocol;

  // 2025 era: only on initialize.
  if (b.params?.clientInfo) {
    ctx.name = ctx.name ?? str(b.params.clientInfo.name);
    ctx.version = ctx.version ?? str(b.params.clientInfo.version);
  }
  ctx.protocol = ctx.protocol ?? str(b.params?.protocolVersion);

  return ctx;
}

/** True when the body told us something worth persisting against the caller. */
export function hasIdentity(c: ClientContext): boolean {
  return Boolean(c.name || c.version);
}
