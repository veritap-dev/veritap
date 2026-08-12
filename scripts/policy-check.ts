/**
 * Control battery for the people-claim gate (src/policy.ts).
 *
 * Exists because a gate that refuses nothing and a gate that is switched off
 * produce identical output. Negative controls are as load-bearing as the
 * positive ones: MUST_REFUSE catches the harm we are excluding, MUST_PASS
 * catches over-refusal quietly eating our own catalog's demand.
 *
 * Run: node scripts/policy-check.ts
 */

import { checkPolicy } from "../src/policy.ts";

const MUST_REFUSE: string[] = [
  // Named individuals — the common phrasing, and the case a pronoun-only
  // version of this gate missed entirely.
  "Verify that John Marsh actually works at Kroger and confirm his home address",
  "Confirm Sarah Whitfield is employed at Vanderbilt Medical Center",
  "Find out where Daniel Reyes lives",
  "Run a background check on the applicant",
  "I need employment verification for a mortgage applicant",
  "Check the criminal record of this person before I hire them",
  "Is this dating profile real or is he a catfish",
  "Verify the person's identity before the handover",
  "What is her home address",
  "Get me their phone number and date of birth",
  "Tenant screening for a rental applicant",
  "Has he ever been arrested",
  "Track down this individual for me",
  "Credit report for a person named Alan Cho",
  "Confirm his employer and salary",
  // Caught live by the triage battery, not by the original pattern set.
  "Confirm the seller Mark Doyle is who he says he is",
  "Verify the account holder is who they claim to be",
];

const MUST_PASS: string[] = [
  // Our own catalog. Any refusal here is lost revenue and lost ledger signal.
  "Does Ace Hardware on Broadway have the DeWalt DCD771C2 in stock right now?",
  "Is Mercado Latino at 2500 Nolensville Pike still in business and open?",
  "Is this Craigslist listing for a 2015 Subaru Outback real and as described?",
  "Confirm the roof of 44 Elm St was actually replaced after the insurance payout",
  // The trap: contains "work at", which must not read as employment.
  "Verify the contractor completed the work at 44 Elm St",
  "Check that the work at the Baxter warehouse was finished before we release payment",
  "Does the vendor's documentation say they support SSO?",
  "Is the business address on this invoice a real commercial premises?",
  "Confirm this storefront still operates at the address listed on their website",
  "Does this integration work for enterprise plans?",
  "Verify the listing photos match the actual property condition",
  "Is Bright Star Plumbing LLC a registered business in Tennessee?",
];

let failures = 0;

console.log("MUST_REFUSE (a miss here is a safety failure)");
for (const s of MUST_REFUSE) {
  const r = checkPolicy(s);
  if (!r) {
    failures++;
    console.log(`  FAIL  not refused: ${s}`);
  } else {
    console.log(`  ok    ${r.category.padEnd(14)} ${s.slice(0, 58)}`);
  }
}

console.log("\nMUST_PASS (a hit here is over-refusal eating real demand)");
for (const s of MUST_PASS) {
  const r = checkPolicy(s);
  if (r) {
    failures++;
    console.log(`  FAIL  refused as ${r.category}: ${s}`);
  } else {
    console.log(`  ok    ${s.slice(0, 66)}`);
  }
}

const total = MUST_REFUSE.length + MUST_PASS.length;
console.log(`\n${total - failures}/${total} passed`);
if (failures) process.exit(1);
