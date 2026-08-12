export interface Env {
  DB: D1Database;
  PUBLIC_BASE_URL: string;
  /** A15 layer 3: Cloudflare send_email binding for the breaker alert. */
  SEND_EMAIL?: { send(message: unknown): Promise<void> };
  ALERT_EMAIL?: string;
  /** A16: ntfy.sh topic for the daily operator digest. Counts only. */
  NTFY_TOPIC?: string;
  /**
   * "true" once the automated desk verifier (addendum A1) is wired and paid
   * fulfillment is live. Until then the router must not quote a purchasable
   * price, because we could not honour it (§10).
   */
  AUTO_VERIFIER_ENABLED?: string;
}

/** How the ask reached us. See migrations/0001_init.sql for the contract. */
export type Origin =
  | "organic_request"
  | "elicited_probe"
  | "elicited_plan"
  | "elicited_followup";

/**
 * What happened to the ask. Orthogonal to Origin.
 * `fulfilled_manual` does not exist: there is no human in the fulfillment loop
 * (addendum A1). `fulfilled_auto` is the desk verifier, gated behind
 * AUTO_VERIFIER_ENABLED until that handler ships.
 */
export type Outcome =
  | "fulfilled_cache"
  | "fulfilled_auto"
  | "quoted_unpaid"
  /**
   * Catalog match we cannot answer right now (verifier off, no cache). Its own
   * value on purpose: folding it into `quoted_unpaid` would corrupt the §7
   * query-3 reading, where a stall means a pricing or trust objection rather
   * than "we were not open".
   */
  | "deferred_no_fulfiller"
  | "unsupported"
  | "refused_policy";
// `referred` is retired by A8 — no outbound referrals. Kept in the migration's
// documentation only, and never written.

export type Feasible = "yes" | "partial" | "not_yet";

export interface ClaimInput {
  claim_description: string;
  claim_type?: string;
  location?: { text?: string; lat?: number; lng?: number };
  deadline?: string;
  budget_ceiling_usd?: number;
  downstream_action?: string;
  cost_if_wrong?: string | number;
  task_context?: string;
}

export interface Evidence {
  type: string;
  url?: string;
  hash?: string;
  timestamp: string;
  geotag?: { lat: number; lng: number };
}

export interface AttestationBundle {
  claim: string;
  claim_type: string;
  result: boolean | string;
  confidence: number;
  evidence: Evidence[];
  method: string;
  verifier_id: string;
  verified_at: string;
  valid_until: string;
  /** Reserved (spec §3). Never populated in v1. */
  liability: null;
}

export interface LedgerWrite {
  tool_name: string;
  origin: Origin;
  outcome: Outcome;
  parent_event_id?: number | null;
  caller_fingerprint?: string | null;
  input: ClaimInput;
  claim_type?: string | null;
  price_quoted?: number | null;
  revenue_usd?: number | null;
  /** Full raw request as received, before any normalization. */
  raw?: unknown;
  /** Who called: components, deliberately not folded into the fingerprint. */
  client?: { name?: string; version?: string; userAgent?: string; protocol?: string };
  /**
   * Set on refused_policy rows: which gate category fired. The countable
   * remnant of a request whose text we refuse to hold (migration 0005).
   */
  refusal_category?: string | null;
  /** The claim needs someone on-site. Countable input to the flip decision. */
  physical_presence?: boolean;
  /** A15 layer 2: row written while the caller was over threshold. */
  suspect?: boolean;
  /** A15 layer 3: breaker open — count it, do not store it. */
  degraded?: boolean;
  /**
   * Write the row WITHOUT raw_input_json. Used for policy refusals, where the
   * request text is the third-party PII we are refusing to hold (§10).
   */
  redacted?: boolean;
}

/** Per-call rate assessment (A15). Never visible to the caller. */
export interface CallerAssessment {
  /** Over the per-fingerprint hourly threshold: tag rows written from here on. */
  suspect: boolean;
  /** Global daily breaker is open: answer normally, store aggregates only. */
  degraded: boolean;
}
