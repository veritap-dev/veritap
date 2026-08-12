/**
 * Ticket 3 — ledger writes. Every tool invocation lands a row here: fulfilled,
 * quoted, referred, or unsupported alike. There is no "we only log misses" path.
 *
 * Failure policy: a ledger write must never turn into a failed tool call. If D1
 * is unavailable we swallow the error and still answer the agent (spec goal 2:
 * >=95% useful responses). We surface the loss in the Worker log so a silent
 * gap in the dataset is at least a loud gap in observability.
 */

import type { Env, LedgerWrite } from "./types.ts";

/**
 * Stable-ish caller identity without auth (spec open question 5).
 * MCP SDK v2 stateless mode mints a new session per request, so the session id
 * is useless as an identity. We hash IP + user-agent + declared client name,
 * which is stable for a given agent deployment and carries no raw PII into D1.
 */
export async function deriveFingerprint(
  request: Request,
  clientName?: string,
): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown-ip";
  const ua = request.headers.get("user-agent") ?? "unknown-ua";
  return (await sha256(`${ip}|${ua}|${clientName ?? ""}`)).slice(0, 32);
}

export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Append one demand event. Returns the row id so follow-ups and escalations can
 * link back via parent_event_id (this is what makes probe->request conversion
 * measurable), or null if the write was lost.
 */
export async function writeLedger(env: Env, w: LedgerWrite): Promise<number | null> {
  const now = new Date().toISOString();
  const loc = w.input.location;

  try {
    const row = await env.DB.prepare(
      `INSERT INTO demand_ledger (
         ts, tool_name, origin, parent_event_id, caller_fingerprint,
         claim_description, claim_type, location_text, lat, lng,
         budget_ceiling_usd, deadline, downstream_action, cost_if_wrong, task_context,
         outcome, price_quoted, revenue_usd, raw_input_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       RETURNING id`,
    )
      .bind(
        now,
        w.tool_name,
        w.origin,
        w.parent_event_id ?? null,
        w.caller_fingerprint ?? null,
        w.input.claim_description ?? null,
        w.claim_type ?? null,
        loc?.text ?? null,
        loc?.lat ?? null,
        loc?.lng ?? null,
        w.input.budget_ceiling_usd ?? null,
        w.input.deadline ?? null,
        w.input.downstream_action ?? null,
        w.input.cost_if_wrong != null ? String(w.input.cost_if_wrong) : null,
        w.input.task_context ?? null,
        w.outcome,
        w.price_quoted ?? null,
        w.revenue_usd ?? null,
        // Refusals are recorded as events, never as content.
        w.redacted ? null : JSON.stringify(w.raw ?? w.input),
      )
      .first<{ id: number }>();

    return row?.id ?? null;
  } catch (err) {
    console.error("LEDGER_WRITE_LOST", {
      tool: w.tool_name,
      origin: w.origin,
      outcome: w.outcome,
      error: String(err),
    });
    return null;
  }
}

/** Upsert the caller row. Best-effort; never blocks a response. */
export async function touchCaller(env: Env, fingerprint: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO callers (fingerprint, first_seen, last_seen, call_count)
       VALUES (?1, ?2, ?2, 1)
       ON CONFLICT(fingerprint) DO UPDATE SET
         last_seen = ?2,
         call_count = call_count + 1`,
    )
      .bind(fingerprint, now)
      .run();
  } catch (err) {
    console.error("CALLER_TOUCH_FAILED", { error: String(err) });
  }
}
