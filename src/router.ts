/**
 * Ticket 3 — router core.
 *
 *   normalize claim -> hash -> cache lookup -> catalog match -> ledger write -> response
 *
 * Every path writes the ledger exactly once, and every path returns something
 * structured. The router never throws: an unroutable, malformed, or absurd ask
 * is still a demand event, and a bare failure would both lose the datum and
 * teach the calling agent not to come back.
 */

import { CATALOG, closestAlternatives, matchClaimType, type ClaimTypeDef } from "./catalog.ts";
import { sha256, writeLedger } from "./ledger.ts";
import { checkPolicy, refusalMessage } from "./policy.ts";
import { classifyUnknown } from "./triage.ts";
import type {
  AttestationBundle,
  CallerAssessment,
  ClaimInput,
  Env,
  Feasible,
  LedgerWrite,
  Origin,
  Outcome,
} from "./types.ts";

/** Collapse trivial wording differences so the cache actually hits. */
export function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an|is|are|was|were|please|can you|could you|check|verify|confirm)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function claimHash(input: ClaimInput, claimType: string): Promise<string> {
  const loc =
    input.location?.lat != null && input.location?.lng != null
      ? `${input.location.lat.toFixed(3)},${input.location.lng.toFixed(3)}`
      : normalizeClaim(input.location?.text ?? "");
  return sha256(`${claimType}|${normalizeClaim(input.claim_description)}|${loc}`);
}

interface CacheHit {
  bundle: AttestationBundle;
}

async function lookupCache(env: Env, hash: string): Promise<CacheHit | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT bundle_json, valid_until FROM attestation_cache
        WHERE claim_hash = ? AND valid_until > ?`,
    )
      .bind(hash, new Date().toISOString())
      .first<{ bundle_json: string; valid_until: string }>();

    if (!row) return null;

    // Count the serve, but never let bookkeeping fail the read.
    env.DB.prepare(
      `UPDATE attestation_cache SET times_served = times_served + 1 WHERE claim_hash = ?`,
    )
      .bind(hash)
      .run()
      .catch(() => {});

    return { bundle: JSON.parse(row.bundle_json) as AttestationBundle };
  } catch (err) {
    console.error("CACHE_LOOKUP_FAILED", { error: String(err) });
    return null;
  }
}

export interface RouteResult {
  feasible: Feasible;
  /** Set only on a hard policy refusal. No referral is offered alongside it. */
  refused?: { category: string; message: string };
  supported_claim_type?: string;
  est_price_usd?: number;
  est_turnaround?: string;
  closest_alternatives: Array<{ claim_type: string; note: string }>;
  /**
   * What the caller can do about it themselves. A8 removed the outbound
   * referral, so a miss has to stay decision-grade on its own: either "you can
   * answer this from public sources, here is where", or "here is how to plan
   * around it".
   */
  self_help?: { classification: string; note: string; suggested_source?: string };
  notify_when_supported: boolean;
  cache_result?: AttestationBundle;
  to_improve_alternatives?: string;
  /** Ledger row id — hand back so follow-ups can link via parent_event_id. */
  event_id: number | null;
  outcome: Outcome;
}

export interface RouteOptions {
  toolName: string;
  origin: Origin;
  fingerprint: string | null;
  parentEventId?: number | null;
  raw?: unknown;
  /** A15: computed once per call by assessCaller, applied to every row here. */
  assessment?: CallerAssessment;
}

/**
 * The single decision path shared by every doorway.
 *
 * Ladder:
 *   0. people-claim                  -> refuse, log redacted   (refused_policy)
 *   1. valid cached attestation      -> answer now             (fulfilled_cache)
 *   2. catalog match + verifier live -> purchasable price      (quoted_unpaid)
 *   3. catalog match, no verifier    -> honest defer + notify  (deferred_no_fulfiller)
 *   4. no catalog match              -> log the gap + notify   (unsupported)
 *
 * Step 2 only activates when AUTO_VERIFIER_ENABLED is set. Quoting a price we
 * cannot currently honour is exactly the "claim coverage that doesn't exist"
 * that §10 forbids, and the catalog's `fulfillment: "auto"` flag describes what
 * is automatable, not what is switched on.
 *
 * No path returns an outbound referral (A8). A miss keeps its signal in-house,
 * so it has to stay decision-grade on its own: closest alternatives, an honest
 * self-help note, and a real promise to report back (see notify.ts).
 */
export async function route(
  env: Env,
  input: ClaimInput,
  opts: RouteOptions,
): Promise<RouteResult> {
  const description = (input.claim_description ?? "").trim();

  const log = async (
    outcome: Outcome,
    claimType: string | null,
    priceQuoted: number | null,
    override?: Partial<LedgerWrite>,
  ): Promise<number | null> => {
    const w: LedgerWrite = {
      tool_name: opts.toolName,
      origin: opts.origin,
      outcome,
      parent_event_id: opts.parentEventId ?? null,
      caller_fingerprint: opts.fingerprint,
      input,
      claim_type: claimType,
      price_quoted: priceQuoted,
      raw: opts.raw,
      suspect: opts.assessment?.suspect,
      degraded: opts.assessment?.degraded,
      ...override,
    };
    return writeLedger(env, w);
  };

  // --- 0. Hard exclusion. Checked before anything else touches the text. ---
  const refusal = checkPolicy(description);
  if (refusal) {
    const event_id = await log("refused_policy", null, null, {
      // The event is recorded; the content is not. Everything caller-supplied
      // is dropped except the fingerprint and the refusal category.
      input: { claim_description: `[redacted: people-claim refused — ${refusal.category}]` },
      redacted: true,
      raw: undefined,
    });
    return {
      feasible: "not_yet",
      refused: { category: refusal.category, message: refusalMessage(refusal) },
      closest_alternatives: [],
      notify_when_supported: false,
      event_id,
      outcome: "refused_policy",
    };
  }

  const match = matchClaimType(description, input.claim_type);

  // --- 4. Nothing in the catalog resembles this ask. The most valuable row. ---
  if (!match) {
    const event_id = await log("unsupported", null, null);
    const triaged = classifyUnknown(description);
    return {
      feasible: "not_yet",
      closest_alternatives: closestAlternatives(description),
      self_help: {
        classification: triaged.classification,
        note:
          triaged.classification === "web_answerable"
            ? triaged.note
            : (triaged.plan_around_note ?? triaged.note),
        suggested_source: triaged.suggested_source,
      },
      notify_when_supported: true,
      to_improve_alternatives:
        "Briefly state your end goal and I can suggest a supported claim that would settle it.",
      event_id,
      outcome: "unsupported",
    };
  }

  const def: ClaimTypeDef = match.def;
  const hash = await claimHash(input, def.id);
  const cached = await lookupCache(env, hash);

  // --- 1. Cache hit: the only fulfillment path that exists today. ---
  if (cached) {
    const event_id = await log("fulfilled_cache", def.id, null);
    return {
      feasible: "yes",
      supported_claim_type: def.id,
      est_price_usd: 0,
      est_turnaround: "immediate (cached)",
      closest_alternatives: closestAlternatives(description, def.id),
      notify_when_supported: false,
      cache_result: cached.bundle,
      event_id,
      outcome: "fulfilled_cache",
    };
  }

  // --- 2. Catalog match + desk verifier live: a price the caller can actually buy. ---
  if (def.fulfillment === "auto" && env.AUTO_VERIFIER_ENABLED === "true") {
    const event_id = await log("quoted_unpaid", def.id, def.price_usd);
    return {
      feasible: "yes",
      supported_claim_type: def.id,
      est_price_usd: def.price_usd,
      est_turnaround: def.turnaround,
      closest_alternatives: closestAlternatives(description, def.id),
      notify_when_supported: false,
      event_id,
      outcome: "quoted_unpaid",
    };
  }

  // --- 3. Catalog match, nothing able to answer it today. Say so plainly. ---
  const event_id = await log("deferred_no_fulfiller", def.id, def.price_usd);
  const triaged = classifyUnknown(description);
  return {
    feasible: "partial",
    supported_claim_type: def.id,
    est_price_usd: def.price_usd,
    est_turnaround: def.turnaround,
    closest_alternatives: closestAlternatives(description, def.id),
    self_help: {
      classification: triaged.classification,
      note:
        `${def.id} is a supported claim type, but nothing is cached for this specific claim and ` +
        `automated fulfillment is not switched on yet. ` +
        (triaged.classification === "web_answerable"
          ? triaged.note
          : "Register interest below and you will be told when it can be answered."),
      suggested_source: triaged.suggested_source,
    },
    notify_when_supported: true,
    to_improve_alternatives:
      "Briefly state your end goal — if a cached attestation would settle it, I can point you at one.",
    event_id,
    outcome: "deferred_no_fulfiller",
  };
}

/** Catalog summary for the static site and the `not_yet` explanations. */
export function catalogSummary() {
  return CATALOG.map((c) => ({
    claim_type: c.id,
    definition: c.definition,
    evidence: c.evidence,
    price_usd: c.price_usd,
    turnaround: c.turnaround,
    cache_ttl_days: c.cache_ttl_days,
  }));
}
