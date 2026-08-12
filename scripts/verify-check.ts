/**
 * Control battery for the A1 desk verifier (src/verify.ts). Hits the real
 * source APIs, so it needs network and is a manual/pre-deploy check, not CI.
 *
 * Positive control: a major listed company must come back confirmed — a run
 * where PT Telkom shows "no evidence" means a source integration broke, not
 * that Telkom stopped existing (see every-null-result-needs-a-positive-control).
 * Negative control: a nonsense business must NOT come back confirmed.
 *
 * Run: node scripts/verify-check.ts
 */

import { CATALOG } from "../src/catalog.ts";
import { extractBusinessName, runAutoVerifier } from "../src/verify.ts";

const def = CATALOG.find((c) => c.id === "BUSINESS_EXISTS_AND_OPERATING");
if (!def) throw new Error("catalog missing BUSINESS_EXISTS_AND_OPERATING");

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

// --- extraction, offline ---
const EXTRACTION: Array<{ text: string; want: string | null }> = [
  {
    text: "Is PT Telkom Indonesia Tbk still operating as a listed company?",
    want: "PT Telkom Indonesia Tbk",
  },
  { text: "Is Mercado Latino at 2500 Nolensville Pike still in business?", want: "Mercado Latino" },
  { text: "Is Bright Star Plumbing LLC a registered business in Tennessee?", want: "Bright Star Plumbing LLC" },
  { text: "is acme holdings llc still in business", want: "acme holdings llc" },
  { text: "is the business still operating", want: null },
];

console.log("EXTRACTION");
for (const { text, want } of EXTRACTION) {
  const got = extractBusinessName(text);
  if (got !== want) fail(`extract(${JSON.stringify(text)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  else console.log(`  ok    ${JSON.stringify(got)}`);
}

// --- live sources ---
console.log("\nPOSITIVE CONTROL (major listed company must confirm)");
const pos = await runAutoVerifier(
  { claim_description: "Is Microsoft Corporation still operating?" },
  def,
);
if (!pos) fail("verifier returned null for Microsoft Corporation");
else {
  console.log(`  result=${pos.result} confidence=${pos.confidence} evidence=${pos.evidence.length}`);
  if (pos.result !== "confirmed_operating" && pos.result !== "corroborated_operating")
    fail(`expected confirmed/corroborated, got ${pos.result} — a source integration is broken`);
  else console.log("  ok");
}

console.log("\nPOSITIVE CONTROL 2 (the first real caller's actual claim)");
const telkom = await runAutoVerifier(
  { claim_description: "Is PT Telkom Indonesia Tbk still operating as a listed company?" },
  def,
);
if (!telkom) fail("verifier returned null for PT Telkom");
else {
  console.log(`  result=${telkom.result} confidence=${telkom.confidence} evidence=${telkom.evidence.length}`);
  for (const e of telkom.evidence) console.log(`    - ${e.type}: ${e.hash ?? e.url}`);
  if (telkom.evidence.length === 0) fail("no evidence for a major listed company");
  else console.log("  ok");
}

console.log("\nNEGATIVE CONTROL (nonsense must not confirm)");
const neg = await runAutoVerifier(
  { claim_description: "Is Zxqvv Blorptech Incorporated of Atlantis still operating?" },
  def,
);
if (!neg) {
  console.log("  ok    (null — no extractable/verifiable subject)");
} else {
  console.log(`  result=${neg.result} confidence=${neg.confidence}`);
  if (neg.result === "confirmed_operating" || neg.result === "corroborated_operating")
    fail("nonsense business came back confirmed — matching is too loose");
  else console.log("  ok");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall passed");
if (failures) process.exit(1);
