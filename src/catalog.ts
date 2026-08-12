/**
 * Launch claim catalog — v1.1 (addendum A2).
 *
 * Two types, both automatable. `PHONE_CONFIRMATION` was dropped: it cannot be
 * done by a desk verifier and there is no human loop to fall back to. Demand
 * for it still flows through unsupported -> referral and is still ledgered, so
 * dropping it costs no signal.
 *
 * Prices are the automated-fulfillment prices, not the retired concierge
 * prices ($10-20), and turnaround is minutes rather than 24h.
 *
 * Expansion rule: a claim type gets built only when the ledger shows >= 10 asks
 * with budget. Adding entries here without that evidence defeats the point of
 * the sensor.
 *
 * `fulfillment: "auto"` marks a type the desk verifier can answer. It does NOT
 * mean the verifier exists yet — the router gates on env.AUTO_VERIFIER_ENABLED
 * so that flipping this field early cannot make us advertise coverage we do not
 * have (§10).
 */

export type Fulfillment = "cache" | "auto";

export interface ClaimTypeDef {
  id: string;
  label: string;
  definition: string;
  evidence: string;
  price_usd: number;
  turnaround: string;
  cache_ttl_days: number;
  fulfillment: Fulfillment;
  /** Lowercase substrings that suggest this claim type in free text. */
  matchers: string[];
}

export const CATALOG: ClaimTypeDef[] = [
  {
    id: "BUSINESS_EXISTS_AND_OPERATING",
    label: "Business exists and is operating",
    definition:
      "A named business exists, is currently operating, and its contact information is valid.",
    evidence: "Registry/listing cross-check across independent sources + captured source snapshots",
    price_usd: 4,
    turnaround: "minutes",
    cache_ttl_days: 30,
    fulfillment: "auto",
    matchers: [
      "still in business",
      "still open",
      "business exists",
      "company exists",
      "real business",
      "legitimate business",
      "operating",
      "out of business",
      "permanently closed",
      "shut down",
      "storefront",
      "is this company real",
    ],
  },
  {
    id: "LISTING_IS_CONSISTENT",
    label: "Listing is internally consistent and corroborated",
    definition:
      "An online listing (product, property, or service) is internally consistent, corroborated across sources, and free of common red flags.",
    evidence: "Structured red-flag checklist + corroborating source snapshots",
    price_usd: 6,
    turnaround: "minutes",
    cache_ttl_days: 14,
    fulfillment: "auto",
    matchers: [
      "listing",
      "is this listing real",
      "scam",
      "too good to be true",
      "as described",
      "matches the description",
      "rental listing",
      "apartment listing",
      "marketplace",
      "craigslist",
      "zillow",
      "seller legit",
      "fake listing",
    ],
  },
  // PHONE_CONFIRMATION removed in v1.1 (addendum A2). It required a person to
  // place a call, and no human fulfillment loop exists. Its demand keywords are
  // deliberately NOT re-homed onto the two surviving types: mapping "is it in
  // stock" onto BUSINESS_EXISTS_AND_OPERATING would answer a question nobody
  // asked. Those asks now land as `unsupported`, which is the honest result and
  // keeps them visible in the build-next backlog.
];

const BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

export function getClaimType(id: string | undefined | null): ClaimTypeDef | undefined {
  return id ? BY_ID.get(id.trim().toUpperCase()) : undefined;
}

export interface CatalogMatch {
  def: ClaimTypeDef;
  /** 1 = caller named the type explicitly; < 1 = inferred from free text. */
  score: number;
  inferred: boolean;
}

/**
 * Map free text (plus an optional caller-supplied type) onto the catalog.
 * Deliberately generous: a wrong-but-close match still produces a useful
 * response and an honest alternatives list, whereas a miss produces nothing.
 */
export function matchClaimType(
  description: string,
  explicitType?: string,
): CatalogMatch | null {
  const explicit = getClaimType(explicitType);
  if (explicit) return { def: explicit, score: 1, inferred: false };

  const text = description.toLowerCase();
  let best: CatalogMatch | null = null;

  for (const def of CATALOG) {
    let hits = 0;
    for (const m of def.matchers) if (text.includes(m)) hits++;
    if (hits === 0) continue;
    // Normalize so a type with many matchers isn't automatically favoured.
    const score = Math.min(0.9, 0.45 + 0.15 * hits);
    if (!best || score > best.score) best = { def, score, inferred: true };
  }

  return best;
}

/** The two nearest catalog entries to whatever was asked, for `closest_alternatives`. */
export function closestAlternatives(
  description: string,
  exclude?: string,
): Array<{ claim_type: string; note: string }> {
  const text = description.toLowerCase();
  return CATALOG.filter((c) => c.id !== exclude)
    .map((c) => ({
      def: c,
      hits: c.matchers.reduce((n, m) => n + (text.includes(m) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 2)
    .map(({ def }) => ({
      claim_type: def.id,
      note: `${def.definition} $${def.price_usd}, ${def.turnaround}.`,
    }));
}
