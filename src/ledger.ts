/**
 * Ticket 3 — ledger writes. Every tool invocation lands a row here: fulfilled,
 * quoted, referred, or unsupported alike. There is no "we only log misses" path.
 *
 * Failure policy: a ledger write must never turn into a failed tool call. If D1
 * is unavailable we swallow the error and still answer the agent (spec goal 2:
 * >=95% useful responses). We surface the loss in the Worker log so a silent
 * gap in the dataset is at least a loud gap in observability.
 */

import type { CallerAssessment, Env, LedgerWrite } from "./types.ts";

/** A15 layer 2: calls/hour per fingerprint above which rows get tagged. */
const SUSPECT_CALLS_PER_HOUR = 120;
/** A15 layer 3: daily written rows above which the breaker opens. */
const DAILY_WRITE_BREAKER = 20_000;

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * Assess a caller ONCE per tool call, not once per row — triage_unknowns can
 * write up to 50 rows and must not run 50 rate queries.
 *
 * Neither outcome changes what the caller sees. Layer 2 tags, layer 3 stops
 * storing detail. A15 is explicit that refusal is the wrong response for a
 * sensor: throttling the speculative calls we invite costs more than junk rows.
 */
export async function assessCaller(
  env: Env,
  fingerprint: string | null,
): Promise<CallerAssessment> {
  const assessment: CallerAssessment = { suspect: false, degraded: false };

  try {
    const day = await env.DB.prepare(`SELECT writes FROM daily_counters WHERE day = ?`)
      .bind(utcDay())
      .first<{ writes: number }>();
    if ((day?.writes ?? 0) >= DAILY_WRITE_BREAKER) assessment.degraded = true;
  } catch (err) {
    console.error("BREAKER_CHECK_FAILED", { error: String(err) });
  }

  if (!fingerprint) return assessment;

  try {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const row = await env.DB.prepare(
      `SELECT count(*) AS n FROM demand_ledger
        WHERE caller_fingerprint = ? AND ts > ?`,
    )
      .bind(fingerprint, since)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= SUSPECT_CALLS_PER_HOUR) assessment.suspect = true;
  } catch (err) {
    console.error("SUSPECT_CHECK_FAILED", { error: String(err) });
  }

  return assessment;
}

/** Returns true the first time the breaker opens today, so we alert once. */
async function bumpCounters(
  env: Env,
  opts: { wrote: boolean; suspect: boolean },
): Promise<boolean> {
  try {
    await env.DB.prepare(
      `INSERT INTO daily_counters (day, writes, degraded_writes, suspect_writes)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(day) DO UPDATE SET
         writes = writes + ?2,
         degraded_writes = degraded_writes + ?3,
         suspect_writes = suspect_writes + ?4`,
    )
      .bind(utcDay(), opts.wrote ? 1 : 0, opts.wrote ? 0 : 1, opts.suspect ? 1 : 0)
      .run();

    const row = await env.DB.prepare(
      `SELECT writes, alerted FROM daily_counters WHERE day = ?`,
    )
      .bind(utcDay())
      .first<{ writes: number; alerted: number }>();

    if (row && row.writes >= DAILY_WRITE_BREAKER && row.alerted === 0) {
      await env.DB.prepare(`UPDATE daily_counters SET alerted = 1 WHERE day = ?`)
        .bind(utcDay())
        .run();
      return true;
    }
  } catch (err) {
    console.error("COUNTER_BUMP_FAILED", { error: String(err) });
  }
  return false;
}

/**
 * A15 layer 3: the alert matters as much as the breaker. If this trips it is
 * either an attack or the sensor suddenly working far better than projected,
 * and which one it is needs answering the same day — not at the weekly review.
 *
 * Sent via the Cloudflare send_email binding, which can only deliver to a
 * pre-verified destination, so this cannot be turned into a spam relay.
 */
async function alertBreaker(env: Env): Promise<void> {
  const to = env.ALERT_EMAIL;
  if (!env.SEND_EMAIL || !to) {
    console.error("BREAKER_OPEN_NO_EMAIL_BINDING", { day: utcDay() });
    return;
  }
  try {
    const { EmailMessage } = await import("cloudflare:email");
    const from = "alerts@veritap.dev";
    const raw = [
      `From: Veritap Alerts <${from}>`,
      `To: <${to}>`,
      `Subject: Veritap circuit breaker OPEN (${utcDay()})`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Daily ledger writes passed ${DAILY_WRITE_BREAKER} on ${utcDay()}.`,
      "",
      "The endpoint is still answering tool calls normally. Detailed rows are",
      "no longer being stored; only aggregate counters are moving.",
      "",
      "This is either an attack or the sensor working far better than projected.",
      "Worth knowing which today rather than at the weekly review.",
      "",
      "  SELECT * FROM daily_counters ORDER BY day DESC LIMIT 7;",
      "  SELECT caller_fingerprint, count(*) FROM demand_ledger",
      "   WHERE ts > datetime('now','-1 day') GROUP BY 1 ORDER BY 2 DESC LIMIT 10;",
      "",
      "https://veritap.dev/health",
    ].join("\r\n");

    await env.SEND_EMAIL.send(new (EmailMessage as any)(from, to, raw));
    console.log("BREAKER_ALERT_SENT", { day: utcDay() });
  } catch (err) {
    console.error("BREAKER_ALERT_FAILED", { error: String(err) });
  }
}

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

  // Breaker open: keep answering the caller normally, but stop storing detail.
  // The counter still moves, so the flood remains visible in aggregate.
  if (w.degraded) {
    if (await bumpCounters(env, { wrote: false, suspect: false })) await alertBreaker(env);
    return null;
  }

  try {
    const row = await env.DB.prepare(
      `INSERT INTO demand_ledger (
         ts, tool_name, origin, parent_event_id, caller_fingerprint,
         claim_description, claim_type, location_text, lat, lng,
         budget_ceiling_usd, deadline, downstream_action, cost_if_wrong, task_context,
         outcome, price_quoted, revenue_usd, raw_input_json, suspect,
         client_name, client_version, client_ua, protocol_version
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        w.suspect ? 1 : 0,
        w.client?.name ?? null,
        w.client?.version ?? null,
        w.client?.userAgent ?? null,
        w.client?.protocol ?? null,
      )
      .first<{ id: number }>();

    if (await bumpCounters(env, { wrote: true, suspect: Boolean(w.suspect) }))
      await alertBreaker(env);

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

/**
 * Upsert the caller row and remember what software it is.
 *
 * COALESCE on update, never overwrite-with-null: legacy-era clients announce
 * themselves once at initialize and are anonymous on every subsequent call, so
 * a naive UPDATE would erase the one moment they told us who they were.
 *
 * Returns the caller's known identity so tool calls that carry none can
 * inherit it.
 */
export async function touchCaller(
  env: Env,
  fingerprint: string,
  client?: { name?: string; version?: string; userAgent?: string; protocol?: string },
): Promise<{ name?: string; version?: string; userAgent?: string; protocol?: string }> {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO callers
         (fingerprint, first_seen, last_seen, call_count,
          client_name, client_version, user_agent, protocol_version)
       VALUES (?1, ?2, ?2, 1, ?3, ?4, ?5, ?6)
       ON CONFLICT(fingerprint) DO UPDATE SET
         last_seen = ?2,
         call_count = call_count + 1,
         client_name      = COALESCE(?3, client_name),
         client_version   = COALESCE(?4, client_version),
         user_agent       = COALESCE(?5, user_agent),
         protocol_version = COALESCE(?6, protocol_version)`,
    )
      .bind(
        fingerprint,
        now,
        client?.name ?? null,
        client?.version ?? null,
        client?.userAgent ?? null,
        client?.protocol ?? null,
      )
      .run();

    const row = await env.DB.prepare(
      `SELECT client_name, client_version, user_agent, protocol_version
         FROM callers WHERE fingerprint = ?`,
    )
      .bind(fingerprint)
      .first<{
        client_name: string | null;
        client_version: string | null;
        user_agent: string | null;
        protocol_version: string | null;
      }>();

    return {
      name: client?.name ?? row?.client_name ?? undefined,
      version: client?.version ?? row?.client_version ?? undefined,
      userAgent: client?.userAgent ?? row?.user_agent ?? undefined,
      protocol: client?.protocol ?? row?.protocol_version ?? undefined,
    };
  } catch (err) {
    console.error("CALLER_TOUCH_FAILED", { error: String(err) });
    return client ?? {};
  }
}
