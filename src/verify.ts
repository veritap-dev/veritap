/**
 * A1 — the automated desk verifier. First claim type: BUSINESS_EXISTS_AND_OPERATING.
 *
 * Free at launch, narrow on purpose. Under the sensor thesis this is a
 * retention mechanism, not the product: the tool has to pay off often enough
 * that agents keep calling, because a caller that never gets unblocked stops
 * selecting the tool and the ledger dries up. Gold-plating fulfillment would
 * spend sensor time on the wrong asset.
 *
 * Source stack — all free, keyless, and fetchable from a Worker:
 *   GLEIF     LEI records; authoritative ACTIVE/INACTIVE for legal entities
 *   SEC EDGAR company search; recent filings = operating evidence (US filers)
 *   Wikidata  existence/description corroboration; weak alone, honest about it
 *   liveness  the business website answering, when the claim contains a URL
 *
 * The bundle reports observed evidence with dates and sources, per the terms
 * page: "the LEI record showed status ACTIVE as of <date>" — never "this
 * business is legitimate". Confidence reflects how well sources actually
 * agree, and absence-of-evidence is stated as exactly that: a small local
 * business appears in none of these registries while being entirely real.
 *
 * Returns null when no business name can be extracted — the router then falls
 * through to the honest defer rather than verifying a guess.
 */

import type { ClaimTypeDef } from "./catalog.ts";
import type { AttestationBundle, ClaimInput, Evidence } from "./types.ts";

/** The claim types this verifier can actually answer. Router gates on this. */
export function canAutoVerify(claimTypeId: string): boolean {
  return claimTypeId === "BUSINESS_EXISTS_AND_OPERATING";
}

const FETCH_TIMEOUT_MS = 4_000;

/** Legal-form suffixes, used both to spot names and to loosen token matching. */
const LEGAL_SUFFIX =
  /^(llc|inc|incorporated|ltd|limited|corp|corporation|co|company|gmbh|tbk|pt|pte|plc|sa|ag|bv|nv|oy|ab|spa|srl|llp|lp|kk|oyj|as|aps)\.?$/i;

/** Leading tokens that are question scaffolding, not part of a name. */
const SCAFFOLD =
  /^(is|are|was|were|does|do|did|the|a|an|verify|confirm|check|whether|if|that|this|what|has|have|can|could|please)$/i;

/**
 * Pull a plausible business name out of free text. Capitalized-run heuristic:
 * the longest run of TitleCase/ALLCAPS tokens (connectors allowed inside),
 * preferring runs that contain a legal-form suffix. Lowercase-only text gets
 * one fallback: tokens immediately preceding a legal suffix.
 */
export function extractBusinessName(text: string): string | null {
  const tokens = text.replace(/[?!.,;:()"]/g, " ").split(/\s+/).filter(Boolean);

  const isNamey = (t: string) => /^[A-Z0-9][\w&'’.-]*$/.test(t);
  const isConnector = (t: string) => /^(of|and|the|de|la|del|van|von|da|do|dos|&|en)$/i.test(t);

  const runs: string[][] = [];
  let run: string[] = [];
  for (const t of tokens) {
    if (isNamey(t) || (run.length > 0 && isConnector(t))) {
      run.push(t);
    } else {
      if (run.length) runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  const cleaned = runs
    .map((r) => {
      while (r.length && (SCAFFOLD.test(r[0] ?? "") || /^\d+$/.test(r[0] ?? ""))) r = r.slice(1);
      while (r.length && isConnector(r[r.length - 1] ?? "")) r = r.slice(0, -1);
      return r;
    })
    .filter((r) => r.length >= 1 && r.join(" ").length >= 3)
    // Pure-number runs ("2500") are addresses, not names.
    .filter((r) => r.some((t) => /[A-Za-z]{2,}/.test(t)));

  if (cleaned.length) {
    const withSuffix = cleaned.filter((r) => r.some((t) => LEGAL_SUFFIX.test(t)));
    const pool = withSuffix.length ? withSuffix : cleaned;
    pool.sort((a, b) => b.length - a.length);
    return pool[0]?.join(" ") ?? null;
  }

  // Lowercase fallback: "... acme holdings llc ..."
  const m = text
    .toLowerCase()
    .match(
      /([a-z][\w&'’-]*(?:\s+[a-z][\w&'’-]*){0,4})\s+(llc|inc|ltd|limited|corp|corporation|gmbh|tbk|pte|plc)\b/,
    );
  if (m) {
    const words = (m[1] ?? "").split(/\s+/).filter((w) => !SCAFFOLD.test(w));
    if (words.length) return `${words.join(" ")} ${m[2]}`;
  }
  return null;
}

const significantTokens = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !LEGAL_SUFFIX.test(t) && !SCAFFOLD.test(t));

/** Loose-but-honest name agreement: most significant query tokens appear. */
function namesAgree(query: string, candidate: string): boolean {
  const q = significantTokens(query);
  const c = new Set(significantTokens(candidate));
  if (!q.length || !c.size) return false;
  const hits = q.filter((t) => c.has(t)).length;
  return hits >= Math.max(1, Math.ceil(q.length * 0.6));
}

async function timedFetch(url: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
}

interface SourceFinding {
  evidence?: Evidence;
  /** strong = authoritative registry; weak = corroboration only. */
  strength: "strong" | "weak";
  /** ACTIVE-style positive, INACTIVE-style negative, or nothing found. */
  signal: "operating" | "not_operating" | "none";
}

async function checkGleif(name: string, now: string): Promise<SourceFinding> {
  const url = `https://api.gleif.org/api/v1/lei-records?filter[fulltext]=${encodeURIComponent(name)}&page[size]=10`;
  const res = await timedFetch(url, { Accept: "application/vnd.api+json" });
  if (!res.ok) return { strength: "strong", signal: "none" };
  const body = (await res.json()) as {
    data?: Array<{
      attributes?: {
        lei?: string;
        entity?: { legalName?: { name?: string }; status?: string };
        registration?: { status?: string };
      };
    }>;
  };
  // Fulltext search surfaces relatives first (the 401(k) plan, the Irish
  // subsidiary, someone's Microsoft ETF) — take the matching record with the
  // FEWEST extra name tokens, which is the entity itself when present.
  let best: { rec: NonNullable<typeof body.data>[number]; extra: number } | null = null;
  for (const rec of body.data ?? []) {
    const legal = rec.attributes?.entity?.legalName?.name ?? "";
    if (!namesAgree(name, legal)) continue;
    const extra = significantTokens(legal).length - significantTokens(name).length;
    if (!best || extra < best.extra) best = { rec, extra };
  }
  if (best) {
    const rec = best.rec;
    const legal = rec.attributes?.entity?.legalName?.name ?? "";
    const status = (rec.attributes?.entity?.status ?? "").toUpperCase();
    return {
      strength: "strong",
      signal: status === "ACTIVE" ? "operating" : status ? "not_operating" : "none",
      evidence: {
        type: "gleif_lei_record",
        url: `https://search.gleif.org/#/record/${rec.attributes?.lei ?? ""}`,
        timestamp: now,
        hash: `legalName=${legal}; entityStatus=${status || "?"}; registrationStatus=${rec.attributes?.registration?.status ?? "?"}`,
      },
    };
  }
  return { strength: "strong", signal: "none" };
}

async function checkEdgar(name: string, now: string): Promise<SourceFinding> {
  // SEC asks for a UA identifying the requester. The JSON full-text search is
  // used because the older atom company search renders entity names as
  // ARRAY(0x...) — broken upstream. A filing whose display_name matches the
  // subject (not merely a filing that MENTIONS it) is the operating evidence.
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${name}"`)}`;
  const res = await timedFetch(url, {
    "User-Agent": "veritap.dev desk verifier (hello@veritap.dev)",
  });
  if (!res.ok) return { strength: "weak", signal: "none" };
  const body = (await res.json()) as {
    hits?: { hits?: Array<{ _source?: { display_names?: string[]; file_date?: string } }> };
  };
  for (const hit of body.hits?.hits ?? []) {
    for (const dn of hit._source?.display_names ?? []) {
      // display_names look like "MICROSOFT CORP  (MSFT)  (CIK 0000789019)".
      const clean = dn.replace(/\s*\(.*$/, "");
      if (clean && namesAgree(name, clean)) {
        return {
          strength: "weak",
          signal: "operating",
          evidence: {
            type: "sec_edgar_filing",
            url: `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${name}"`)}`,
            timestamp: now,
            hash: `filer=${clean.trim()}; file_date=${hit._source?.file_date ?? "?"}`,
          },
        };
      }
    }
  }
  return { strength: "weak", signal: "none" };
}

async function checkWikidata(name: string, now: string): Promise<SourceFinding> {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&limit=5`;
  const res = await timedFetch(url, {
    "User-Agent": "veritap.dev desk verifier (hello@veritap.dev)",
  });
  if (!res.ok) return { strength: "weak", signal: "none" };
  const body = (await res.json()) as {
    search?: Array<{ id?: string; label?: string; description?: string }>;
  };
  for (const hit of body.search ?? []) {
    const label = hit.label ?? "";
    const desc = (hit.description ?? "").toLowerCase();
    const looksCorporate = /compan|corporat|business|enterprise|conglomerate|manufactur|retail|bank|airline|operator/.test(
      desc,
    );
    if (namesAgree(name, label) && looksCorporate) {
      return {
        strength: "weak",
        signal: "operating",
        evidence: {
          type: "wikidata_entity",
          url: `https://www.wikidata.org/wiki/${hit.id ?? ""}`,
          timestamp: now,
          hash: `label=${label}; description=${hit.description ?? ""}`,
        },
      };
    }
  }
  return { strength: "weak", signal: "none" };
}

async function checkWebsite(input: ClaimInput, now: string): Promise<SourceFinding | null> {
  const text = `${input.claim_description} ${input.location?.text ?? ""}`;
  const m = text.match(/https?:\/\/[^\s"'<>)]+/i);
  if (!m) return null;
  try {
    const res = await timedFetch(m[0]);
    return {
      strength: "weak",
      signal: res.ok ? "operating" : "none",
      evidence: {
        type: "website_liveness",
        url: m[0],
        timestamp: now,
        hash: `httpStatus=${res.status}`,
      },
    };
  } catch {
    return { strength: "weak", signal: "none" };
  }
}

/**
 * Run the desk check. Never throws — a source that errors is a source that
 * contributed nothing, stated as such in the method line.
 */
export async function runAutoVerifier(
  input: ClaimInput,
  def: ClaimTypeDef,
): Promise<AttestationBundle | null> {
  if (!canAutoVerify(def.id)) return null;

  const name = extractBusinessName(input.claim_description);
  if (!name) return null;

  const now = new Date().toISOString();
  const settled = await Promise.allSettled([
    checkGleif(name, now),
    checkEdgar(name, now),
    checkWikidata(name, now),
    checkWebsite(input, now),
  ]);
  const sourceNames = ["GLEIF", "SEC EDGAR", "Wikidata", "website"] as const;

  const findings: SourceFinding[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled" && s.value) findings.push(s.value);
    else if (s.status === "rejected") failed.push(sourceNames[i] ?? "source");
  });

  const evidence = findings.map((f) => f.evidence).filter((e): e is Evidence => Boolean(e));
  const strongOperating = findings.some((f) => f.strength === "strong" && f.signal === "operating");
  const strongInactive = findings.some(
    (f) => f.strength === "strong" && f.signal === "not_operating",
  );
  const weakOperating = findings.filter(
    (f) => f.strength === "weak" && f.signal === "operating",
  ).length;

  let result: string;
  let confidence: number;
  if (strongInactive) {
    result = "registry_shows_inactive";
    confidence = Math.min(0.85, 0.6 + 0.1 * weakOperating);
  } else if (strongOperating) {
    result = "confirmed_operating";
    confidence = Math.min(0.9, 0.55 + 0.12 * weakOperating);
  } else if (weakOperating >= 2) {
    result = "corroborated_operating";
    confidence = 0.45 + 0.1 * (weakOperating - 2);
  } else if (weakOperating === 1) {
    result = "weakly_corroborated";
    confidence = 0.3;
  } else {
    result = "no_registry_evidence";
    // Honest floor: absence in global registries is weak evidence of absence
    // for small local businesses.
    confidence = 0.15;
  }

  const ttlDays = result === "no_registry_evidence" ? 3 : def.cache_ttl_days;
  const validUntil = new Date(Date.now() + ttlDays * 86_400_000).toISOString();

  return {
    claim: input.claim_description,
    claim_type: def.id,
    result,
    confidence,
    evidence,
    method:
      `Automated desk check for "${name}": GLEIF LEI registry, SEC EDGAR company search, ` +
      `Wikidata, and website liveness where a URL was supplied. Reports what public ` +
      `sources showed at the stated time; a no-evidence result is weak for small local ` +
      `businesses, which may appear in none of these sources while operating normally.` +
      (failed.length ? ` Sources unavailable this run: ${failed.join(", ")}.` : ""),
    verifier_id: "veritap-desk-auto/v1",
    verified_at: now,
    valid_until: validUntil,
    liability: null,
  };
}
