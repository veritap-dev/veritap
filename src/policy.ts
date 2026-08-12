/**
 * Hard exclusions (spec v1 §3, §10; addendum A1).
 *
 * Claims about natural persons are REFUSED, not deferred. This is not a
 * `not_yet` that demand can unlock: verifying facts about individuals risks
 * FCRA consumer-reporting-agency status and is the obvious stalking/harassment
 * vector. Businesses, listings, objects, and places only.
 *
 * Two consequences that are easy to get wrong and are enforced here:
 *
 * 1. Refused claims are NOT referred onward. Handing a people-claim to a
 *    human-task marketplace with the text pre-filled is laundering the harm,
 *    not avoiding it. Refusals return no bounty_url.
 * 2. Refused claims are logged WITHOUT their text. The claim description of a
 *    people-claim is precisely the third-party PII that §10's "scrub at write
 *    time" rule exists to keep out of the ledger. We record that a refusal
 *    happened, its category, and nothing else.
 */

export type RefusalCategory =
  | "identity"
  | "employment"
  | "tenancy"
  | "background"
  | "whereabouts"
  | "person_general";

export interface PolicyRefusal {
  category: RefusalCategory;
  reason: string;
}

/**
 * Strong signals: phrases whose ordinary reading is a claim about a person.
 *
 * These must catch NAMED individuals, not just pronouns — "verify that John
 * Marsh works at Kroger" is the common real-world phrasing and an earlier
 * pronoun-only version of this file sailed straight past it. Patterns
 * therefore allow an arbitrary short subject span between the verb and the
 * person-predicate.
 *
 * Tuned against the negative controls in scripts/policy-check.ts, which exist
 * because a gate that refuses nothing and a gate that is switched off look
 * identical from the outside. Note in particular that the employment patterns
 * require "works/worked at", never bare "work at" — "the contractor completed
 * the work at 44 Elm St" is a work-completion claim and must pass.
 *
 * Bias: on this gate a false positive costs one refused business claim, while
 * a false negative means we processed a request about a private individual.
 * Tuned toward over-refusal accordingly.
 */
const SIGNALS: Array<{ category: RefusalCategory; patterns: RegExp[] }> = [
  {
    category: "background",
    patterns: [
      /\bbackground check\b/,
      /\bcriminal (record|history|background)\b/,
      /\barrest(ed|s)? record\b/,
      /\bsex offender\b/,
      /\bcourt records? (on|for|about) (a |this )?(person|individual|someone|him|her|them)\b/,
      /\bhas (he|she|they|this person) ever been (arrested|convicted|charged|sued)\b/,
    ],
  },
  {
    category: "employment",
    patterns: [
      /\b(employment|income|salary) verification\b/,
      // Arbitrary subject span, but "works/worked at" specifically — bare
      // "work at" collides with work-completion claims.
      /\b(verify|confirm|check|find out|determine)\b.{0,60}?\b(works|worked)\s+(at|for)\b/,
      /\b(verify|confirm|check|find out|determine)\b.{0,60}?\b(is|was)\s+employed\b/,
      /\b(does|did)\s+(he|she|they|this person|the candidate|the applicant)\s+(actually\s+)?work\s+(at|for)\b/,
      /\b(his|her|their)\s+(employer|salary|income|job title|pay stub)\b/,
      /\bverify\s+(their|his|her)\s+employment\b/,
    ],
  },
  {
    category: "tenancy",
    patterns: [
      /\btenant (screening|history|reference)\b/,
      /\brental history (of|for) (a |this )?(person|applicant|tenant)\b/,
      /\bprevious landlord reference\b/,
      /\bevict(ion|ed) (record|history)\b/,
    ],
  },
  {
    category: "whereabouts",
    patterns: [
      // "home address" is a person-shaped phrase on its own; a business's is
      // just "address".
      /\b(home|residential|personal)\s+address\b/,
      /\bwhere\b.{0,40}?\b(lives|resides|is staying|is living)\b/,
      /\bwhere does\b.{0,40}?\b(live|reside)\b/,
      /\bis (he|she|they|this person) (still )?(living|staying) at\b/,
      /\btrack (down )?(a |this )?(person|individual|someone|him|her|them)\b/,
      /\blocate (a |this )?(person|individual|missing person)\b/,
      /\b(his|her|their)\s+(whereabouts|home|residence)\b/,
      /\b(his|her|their)\s+(phone number|personal email|email address|date of birth|ssn|social security)\b/,
    ],
  },
  {
    category: "identity",
    patterns: [
      /\bidentity verification\b/,
      /\bverify (the |this )?(person|individual)('s)? identity\b/,
      /\bis (this|the) (person|individual|profile|account holder) (who they|real|actually)\b/,
      /\bconfirm (the |this )?(person|individual) (is real|exists|is who)\b/,
      /\bis who (he|she|they)\s+(say|says|claim|claims)\b/,
      /\b(verify|confirm|check)\b.{0,50}?\bis who\b/,
      /\breal name (of|behind)\b/,
      /\b(catfish|impersonat(or|ing))\b/,
      /\bdating (profile|app) .{0,30}\b(real|verify|legit)\b/,
    ],
  },
  {
    category: "person_general",
    patterns: [
      /\bverify (a |this |the )?(person|individual|human being)\b/,
      /\bcheck (up )?on (a |this )?(person|individual)\b/,
      /\b(person|individual)'s (medical|health|financial|credit) (record|history|status)\b/,
      /\bcredit (report|score) (of|for) (a |this )?(person|individual)\b/,
    ],
  },
];

const REASONS: Record<RefusalCategory, string> = {
  identity:
    "Claims about the identity of a natural person are out of scope as a matter of policy.",
  employment:
    "Employment or income verification about a natural person is out of scope as a matter of policy.",
  tenancy:
    "Tenant screening and rental history about a natural person are out of scope as a matter of policy.",
  background:
    "Background, criminal, or court-record checks on a natural person are out of scope as a matter of policy.",
  whereabouts:
    "Locating a natural person or confirming where they live is out of scope as a matter of policy.",
  person_general:
    "Claims about a natural person are out of scope as a matter of policy.",
};

/** Returns a refusal when the text reads as a claim about a natural person. */
export function checkPolicy(claimDescription: string): PolicyRefusal | null {
  const text = (claimDescription ?? "").toLowerCase();
  if (!text) return null;

  for (const { category, patterns } of SIGNALS) {
    for (const p of patterns) {
      if (p.test(text)) return { category, reason: REASONS[category] };
    }
  }
  return null;
}

/** The single place the refusal wording is authored, so copy stays consistent. */
export function refusalMessage(r: PolicyRefusal): string {
  return (
    `${r.reason} This service verifies businesses, listings, objects, and places only — ` +
    `never facts about individuals. This request was not logged with its text, was not ` +
    `referred anywhere, and does not enter the roadmap backlog. Rephrasing it will not ` +
    `change the outcome.`
  );
}
