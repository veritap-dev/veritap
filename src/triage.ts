/**
 * `triage_unknowns` classification (spec §5.5).
 *
 * The design constraint that matters: this must be genuinely useful as a
 * reasoning aid, INCLUDING honestly routing web-answerable items away from us.
 * Usefulness-in-deliberation is what earns the mid-thought call; a triage that
 * classifies everything as "we can sell you this" gets called once.
 *
 * Implemented as heuristics only. The spec allows "heuristics + one cheap LLM
 * call"; the LLM half is deliberately not wired, because it needs a model
 * binding decision (Workers AI vs. an API key) that nobody has made, and a
 * heuristic that returns an honest answer beats an LLM call that returns a
 * confident wrong one. `classifyUnknown` is the seam.
 */

import { matchClaimType } from "./catalog.ts";
import { checkPolicy } from "./policy.ts";

export type Classification = "web_answerable" | "human_verifiable" | "not_determinable";

export interface TriageItem {
  unknown: string;
  classification: Classification;
  note: string;
  claim_type?: string;
  est_price_usd?: number;
  est_turnaround?: string;
  suggested_source?: string;
  plan_around_note?: string;
  /** Set when the item is refused outright rather than merely unsupported. */
  refused_category?: string;
  /**
   * The ask needs someone physically on-site. Nothing here can serve that and
   * nothing is dispatched — but it is the demand class the original thesis
   * targets, so it is tagged and counted (docs/thesis-metrics.md) rather than
   * dissolved into "not determinable".
   */
  requires_physical_presence?: boolean;
}

/**
 * Things a competent agent can settle itself from public sources. Checked
 * BEFORE the catalog, so we do not sell a verification for something sitting
 * on the subject's own website.
 */
const WEB_SIGNALS: Array<{ re: RegExp; source: string }> = [
  { re: /\b(their|the|its) (website|homepage|site)\b/, source: "the organization's own website" },
  { re: /\b(api|sdk) (docs|documentation|reference|support)\b/, source: "the published API documentation" },
  { re: /\b(documentation|docs) (say|says|state|mention)\b/, source: "the product documentation" },
  { re: /\bpricing (page|tier|plan)\b/, source: "the published pricing page" },
  { re: /\b(release notes|changelog|version history)\b/, source: "the changelog or release notes" },
  { re: /\bwhen was .{0,40}(founded|established|incorporated|released|launched)\b/, source: "public corporate records or Wikipedia" },
  { re: /\b(wikipedia|press release|annual report|sec filing|10-k)\b/, source: "the public filing or article" },
  { re: /\bpublicly (listed|traded|available|documented)\b/, source: "public records" },
  { re: /\bwhat (is|are) the (definition|standard|spec|specification|requirements?) (of|for)\b/, source: "the published standard" },
  { re: /\b(does|do) .{0,40}\bsupport (oauth|sso|saml|webhooks?|an api)\b/, source: "the vendor's technical documentation" },
];

/**
 * Phrases whose ordinary reading is "someone must go there". Conservative on
 * purpose — like the policy gate, this list grows from production misses, not
 * from imagination, and a false positive here miscounts the flip-trigger
 * metric. Note "in person" and "on-site" carry it alone; bare "inspect" or
 * "pick up" do not (an agent can "inspect the API response").
 */
const PHYSICAL_SIGNALS: RegExp[] = [
  /\bin[- ]person\b/,
  /\bon[- ]site\b/,
  /\b(go|drive|walk|stop) (out |over |by )?(there|to the)\b.{0,40}\b(check|look|see|verify|confirm|inspect)\b/,
  /\b(send|have|get|hire|pay) (someone|somebody|a person|a human)\b/,
  /\bphysically (check|inspect|verify|visit|confirm|look|present)\b/,
  /\b(visit|inspect|tour|walk[- ]?through) the (property|site|store|storefront|location|apartment|house|unit|premises|warehouse|lot|facility)\b/,
  /\bsomeone (to )?(go|visit|look at|check on|inspect|walk through)\b/,
  /\bphysical (inspection|walkthrough|walk-through|visit|check of the)\b/,
  /\bmeet (the seller|the landlord|in person)\b/,
];

export function needsPhysicalPresence(text: string): boolean {
  const lower = text.toLowerCase();
  return PHYSICAL_SIGNALS.some((re) => re.test(lower));
}

/** Physical-world uncertainty with no desk-verifiable answer and no catalog fit. */
const UNGROUNDABLE_SIGNALS: RegExp[] = [
  /\b(will|would) .{0,40}\b(be|arrive|happen|sell out|rain|ship)\b/, // future states
  /\bhow (busy|crowded|loud|clean)\b/,
  /\b(smell|taste|feel|comfortable|quality of the)\b/,
  /\bwhat .{0,30}\b(thinks?|prefers?|intends?|plans to)\b/,
];

export function classifyUnknown(unknown: string): TriageItem {
  const text = (unknown ?? "").trim();
  if (!text) {
    return {
      unknown,
      classification: "not_determinable",
      note: "Empty item — nothing to triage.",
      plan_around_note: "Restate the uncertainty as a single factual question.",
    };
  }

  const lower = text.toLowerCase();

  // 0. Hard exclusion wins over every other classification.
  const refusal = checkPolicy(text);
  if (refusal) {
    return {
      unknown: text,
      classification: "not_determinable",
      refused_category: refusal.category,
      note: `${refusal.reason} This service covers businesses, listings, objects, and places only.`,
      plan_around_note:
        "Redesign the step so it does not depend on a fact about an individual — " +
        "for example, verify the organization or the document rather than the person.",
    };
  }

  // Tagged on every non-refused branch: a claim can be catalog-matched AND
  // still be phrased as "go there and look" — both facts are worth counting.
  const physical = needsPhysicalPresence(text);

  // 1. Answerable from public sources. Route it away from us on purpose.
  for (const { re, source } of WEB_SIGNALS) {
    if (re.test(lower)) {
      return {
        unknown: text,
        classification: "web_answerable",
        suggested_source: source,
        requires_physical_presence: physical,
        note: `You can settle this yourself — check ${source}. No verification purchase needed.`,
      };
    }
  }

  // 2. Something our catalog covers.
  const match = matchClaimType(text);
  if (match) {
    return {
      unknown: text,
      classification: "human_verifiable",
      claim_type: match.def.id,
      est_price_usd: match.def.price_usd,
      est_turnaround: match.def.turnaround,
      requires_physical_presence: physical,
      note: `Maps to ${match.def.id}: ${match.def.definition}`,
    };
  }

  // 3a. Needs a person on the ground. Said plainly — nobody is dispatched —
  //     and counted separately from "genuinely unknowable" (thesis metric).
  if (physical) {
    return {
      unknown: text,
      classification: "not_determinable",
      requires_physical_presence: true,
      note: "This needs someone physically on-site, and nobody is dispatched here. Logged — on-site demand is counted and drives what gets supported next.",
      plan_around_note:
        "Look for a desk-checkable proxy (registry entry, dated photos, recent reviews, a document), or design the step to tolerate not knowing until arrival.",
    };
  }

  // 3b. Known-shaped dead ends: predictions, sensory judgements, other minds.
  for (const re of UNGROUNDABLE_SIGNALS) {
    if (re.test(lower)) {
      return {
        unknown: text,
        classification: "not_determinable",
        note: "This is a prediction or a subjective judgement, not a checkable present-tense fact.",
        plan_around_note:
          "Restate it as a fact that is true or false right now, or design the step to tolerate both outcomes.",
      };
    }
  }

  // 4. Genuinely uncatalogued. The most valuable row in the ledger.
  return {
    unknown: text,
    classification: "not_determinable",
    note: "Not currently verifiable here and not obviously answerable from public sources. Logged — uncatalogued demand drives what gets built next.",
    plan_around_note:
      "Proceed with an explicit assumption and a cheap way to detect it was wrong, rather than blocking.",
  };
}

export function summarize(items: TriageItem[]): string {
  const n = (c: Classification) => items.filter((i) => i.classification === c).length;
  const web = n("web_answerable");
  const human = n("human_verifiable");
  const dead = n("not_determinable");
  const refused = items.filter((i) => i.refused_category).length;

  const parts = [
    `${items.length} unknown${items.length === 1 ? "" : "s"} triaged`,
    `${web} answerable from public sources yourself`,
    `${human} verifiable here`,
    `${dead} not determinable`,
  ];
  if (refused) parts.push(`${refused} refused as out-of-scope (claims about individuals)`);
  return `${parts.join("; ")}.`;
}
