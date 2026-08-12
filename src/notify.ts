/**
 * The return path (addendum A8).
 *
 * With outbound referrals removed, a miss no longer hands the agent somewhere
 * else to go — which means the ONLY thing converting a gap into a future sale
 * is telling the caller when we close it. `notify_when_supported: true` stops
 * being a flag on a response and becomes a promise the system has to keep.
 *
 * Two delivery routes, because agents are not long-lived processes:
 *   - callback_url, POSTed as soon as the gap closes, when one was supplied
 *   - otherwise piggybacked on the caller's next call, whenever that happens
 *
 * Readiness is re-evaluated on a cron rather than at write time, because the
 * whole point is that the catalog changes underneath these rows.
 */

import { matchClaimType } from "./catalog.ts";
import { normalizeClaim } from "./router.ts";
import type { Env } from "./types.ts";

export interface PendingNotice {
  id: number;
  claim_description: string;
  claim_type: string | null;
}

/**
 * Guard for the one place this service makes an outbound request to a
 * caller-supplied URL.
 *
 * Without this, anyone can register callbacks pointing at a third party and use
 * veritap.dev as a request reflector — our domain sending POSTs to a victim,
 * with our reputation attached. Cloudflare Workers cannot reach RFC1918 space,
 * so classic SSRF is limited, but the reflection and internal-hostname surface
 * is real and cheap to close.
 *
 * NOTE (durable fix, not done): the robust answer is a verification challenge
 * at registration — POST a nonce to the URL and require it echoed back before
 * the callback is ever armed. That proves the registrant controls the endpoint.
 * Until then these checks plus the per-sweep cap are the mitigation.
 */
const BLOCKED_HOST = /^(localhost$|.*\.local$|.*\.internal$|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|metadata\.)/i;

export function isSafeCallbackUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // https only: a plaintext callback would leak the claim text in transit.
  if (u.protocol !== "https:") return false;
  if (BLOCKED_HOST.test(u.hostname)) return false;
  // Bare IP literals have no legitimate use here and skip DNS-level controls.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return false;
  if (u.hostname.includes(":")) return false; // IPv6 literal
  if (!u.hostname.includes(".")) return false; // unqualified internal name
  return true;
}

/** Hard cap on outbound callbacks per sweep, so one actor cannot conscript us. */
const MAX_CALLBACKS_PER_SWEEP = 25;

/** Record that a caller wants to hear back when this gap closes. */
export async function registerNotify(
  env: Env,
  args: {
    fingerprint: string | null;
    eventId: number | null;
    claimDescription: string;
    callbackUrl?: string;
  },
): Promise<void> {
  const text = (args.claimDescription ?? "").trim();
  if (!text) return;

  try {
    // One open request per caller per distinct claim — an agent that retries a
    // failing step ten times should not get ten emails when we ship it.
    await env.DB.prepare(
      `INSERT INTO notify_registry
         (created_at, caller_fingerprint, event_id, claim_description, normalized, callback_url)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE NOT EXISTS (
          SELECT 1 FROM notify_registry
           WHERE normalized = ?5
             AND caller_fingerprint IS ?2
             AND delivered_at IS NULL
        )`,
    )
      .bind(
        new Date().toISOString(),
        args.fingerprint,
        args.eventId,
        text,
        normalizeClaim(text),
        isSafeCallbackUrl(args.callbackUrl) ? args.callbackUrl : null,
      )
      .run();
  } catch (err) {
    console.error("NOTIFY_REGISTER_FAILED", { error: String(err) });
  }
}

/**
 * Notices that are ready and undelivered for this caller. Marks them delivered
 * as it returns them, so the same news is not reported twice.
 */
export async function drainPending(
  env: Env,
  fingerprint: string | null,
): Promise<PendingNotice[]> {
  if (!fingerprint) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, claim_description FROM notify_registry
        WHERE caller_fingerprint = ?
          AND ready_at IS NOT NULL
          AND delivered_at IS NULL
        LIMIT 10`,
    )
      .bind(fingerprint)
      .all<{ id: number; claim_description: string }>();

    if (!results?.length) return [];

    const ids = results.map((r) => r.id);
    await env.DB.prepare(
      `UPDATE notify_registry
          SET delivered_at = ?, delivery_method = 'next_call'
        WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(new Date().toISOString(), ...ids)
      .run();

    return results.map((r) => ({
      id: r.id,
      claim_description: r.claim_description,
      claim_type: matchClaimType(r.claim_description)?.def.id ?? null,
    }));
  } catch (err) {
    console.error("NOTIFY_DRAIN_FAILED", { error: String(err) });
    return [];
  }
}

/**
 * Cron pass: re-match every waiting row against the current catalog, mark the
 * ones we can now answer, and fire callbacks where we have a URL.
 */
export async function sweepNotifications(env: Env): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, claim_description, callback_url FROM notify_registry
        WHERE ready_at IS NULL AND delivered_at IS NULL
        LIMIT 500`,
    ).all<{ id: number; claim_description: string; callback_url: string | null }>();

    if (!results?.length) return;

    const now = new Date().toISOString();
    let readied = 0;
    let posted = 0;

    for (const row of results) {
      const match = matchClaimType(row.claim_description);
      if (!match) continue;

      await env.DB.prepare(`UPDATE notify_registry SET ready_at = ? WHERE id = ?`)
        .bind(now, row.id)
        .run();
      readied++;

      if (!row.callback_url) continue;
      if (!isSafeCallbackUrl(row.callback_url)) {
        console.warn("NOTIFY_CALLBACK_BLOCKED", { id: row.id });
        continue;
      }
      if (posted >= MAX_CALLBACKS_PER_SWEEP) continue;
      try {
        const res = await fetch(row.callback_url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "claim_type_now_supported",
            claim_description: row.claim_description,
            claim_type: match.def.id,
            est_price_usd: match.def.price_usd,
            est_turnaround: match.def.turnaround,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          await env.DB.prepare(
            `UPDATE notify_registry
                SET delivered_at = ?, delivery_method = 'callback' WHERE id = ?`,
          )
            .bind(now, row.id)
            .run();
          posted++;
        }
      } catch {
        // Leave it ready-but-undelivered; the next-call path still covers it.
      }
    }

    console.log("NOTIFY_SWEEP", { scanned: results.length, readied, posted });
  } catch (err) {
    console.error("NOTIFY_SWEEP_FAILED", { error: String(err) });
  }
}
