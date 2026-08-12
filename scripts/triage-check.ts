/**
 * Control battery for triage classification (src/triage.ts), starting with the
 * physical-presence detector added in migration 0005.
 *
 * Same reasoning as policy-check.ts: a detector that flags nothing and a
 * detector that is switched off look identical from the outside, so the
 * negative controls are as load-bearing as the positive ones. A false positive
 * here quietly inflates the marketplace-flip metric; a false negative
 * undercounts the demand class the original thesis targets.
 *
 * Run: node scripts/triage-check.ts
 */

import { classifyUnknown, needsPhysicalPresence } from "../src/triage.ts";

const MUST_FLAG_PHYSICAL: string[] = [
  "Someone needs to go to the storefront and check it is actually open",
  "Can you send someone to look at the apartment before I wire the deposit",
  "I need an in-person inspection of the vehicle before purchase",
  "On-site verification that the solar panels were actually installed",
  "Have a person walk through the warehouse and count the pallets",
  "Physically check that the machine at this address exists",
  "Visit the property and confirm the roof condition",
  "Need someone to meet the seller and confirm the item is real",
];

const MUST_NOT_FLAG_PHYSICAL: string[] = [
  // Desk-checkable claims that merely concern physical things.
  "Is Mercado Latino at 2500 Nolensville Pike still in business?",
  "Is this Craigslist listing for a 2015 Subaru Outback real and as described?",
  "Verify the listing photos match the actual property condition",
  "Is the business address on this invoice a real commercial premises?",
  // "inspect"/"check"/"visit" in non-physical senses.
  "Inspect the API response for a rate-limit header",
  "Check the changelog to see when the feature shipped",
  "How many people visit the website each month",
  "Does the vendor's documentation say they support SSO?",
];

// Physical items must still land in a countable, non-refused classification.
const CLASSIFICATION_CHECKS: Array<{ text: string; physical: boolean }> = [
  { text: "Send someone to check whether the restaurant is still operating", physical: true },
  { text: "Is the restaurant still operating", physical: false },
];

let failures = 0;

console.log("MUST_FLAG_PHYSICAL (a miss undercounts the flip-trigger metric)");
for (const s of MUST_FLAG_PHYSICAL) {
  if (!needsPhysicalPresence(s)) {
    failures++;
    console.log(`  FAIL  not flagged: ${s}`);
  } else {
    console.log(`  ok    ${s.slice(0, 66)}`);
  }
}

console.log("\nMUST_NOT_FLAG_PHYSICAL (a hit inflates the flip-trigger metric)");
for (const s of MUST_NOT_FLAG_PHYSICAL) {
  if (needsPhysicalPresence(s)) {
    failures++;
    console.log(`  FAIL  wrongly flagged: ${s}`);
  } else {
    console.log(`  ok    ${s.slice(0, 66)}`);
  }
}

console.log("\nCLASSIFICATION (flag must ride through classifyUnknown)");
for (const { text, physical } of CLASSIFICATION_CHECKS) {
  const item = classifyUnknown(text);
  const got = Boolean(item.requires_physical_presence);
  if (got !== physical) {
    failures++;
    console.log(`  FAIL  physical=${got}, expected ${physical}: ${text}`);
  } else {
    console.log(`  ok    physical=${got} ${item.classification.padEnd(18)} ${text.slice(0, 48)}`);
  }
}

const total =
  MUST_FLAG_PHYSICAL.length + MUST_NOT_FLAG_PHYSICAL.length + CLASSIFICATION_CHECKS.length;
console.log(`\n${total - failures}/${total} passed`);
if (failures) process.exit(1);
