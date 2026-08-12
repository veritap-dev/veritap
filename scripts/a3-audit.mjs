#!/usr/bin/env node
/**
 * A3 honesty audit (extended by A12).
 *
 * Everything an agent or a person can read — tool descriptions, server
 * instructions, site copy, npm README — must not claim a capability we do not
 * have. Three classes of violation, all of which we have actually shipped at
 * least once and had to walk back:
 *
 *   1. Human dispatch. A1 says there is no human in the loop, ever, and
 *      /terms says nobody is dispatched. `request_human_check` contradicted
 *      both and survived a full deploy.
 *   2. Outbound referral. A8 removed referrals, but three alias descriptions
 *      still offered to send callers elsewhere.
 *   3. Purchasability. A12 cancelled the paid tier, so no surface may imply
 *      payment can be taken today.
 *
 * Run: node scripts/a3-audit.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGET_DIRS = ["public", "src", "shim"];
const EXTS = [".html", ".txt", ".json", ".ts", ".md", ".yaml"];

/**
 * `allow` marks the honest NEGATION of a banned phrase — "nobody is
 * dispatched" must not be flagged as promising dispatch.
 */
const RULES = [
  {
    id: "human-dispatch",
    why: "A1: no human in the fulfillment loop, ever. /terms promises nobody is dispatched.",
    bad: [
      /human verification network/i,
      /\brequest_human_check\b/,
      /\bdispatch(ed|es|ing)?\b/i,
      /\bsend (a|our) (person|verifier|someone)\b/i,
      /\bboots on the ground\b/i,
      /\bin[- ]person (visit|inspection)\b/i,
    ],
    allow: [
      /(nobody|no one|not|never|neither)[^.]{0,60}dispatch/i,
      /dispatch a (customer )?booking/i, // example copy: the caller's own action
    ],
  },
  {
    id: "outbound-referral",
    why: "A8: no outbound referrals. A miss keeps its signal in-house.",
    bad: [
      /\breferral\b/i,
      /\brefer (you|them|it) (out|to)\b/i,
      /\bbounty\b/i,
      /rentahuman/i,
      /humanping/i,
      /\bwhere to get it checked\b/i,
    ],
    allow: [],
  },
  {
    id: "purchasable-today",
    why: "A12: paid tier cancelled. Nothing may imply payment can be taken today.",
    bad: [
      /\bbuy now\b/i,
      /\bcheckout\b/i,
      /\bpayment link\b/i,
      /\bstripe\b/i,
      /\bper verification\b/i,
    ],
    allow: [],
  },
];

/** Any bare price in reader-facing copy must be marked indicative. */
const PRICE_RE = /(?<!indicative[^\n]{0,40})\$\s?\d/i;
const PRICE_OK = /(indicative|~\$|not open|no payment|when fulfillment opens|not an offer)/i;
const PRICE_SCOPE = [".html", ".txt", ".md"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const files = TARGET_DIRS.flatMap((d) => {
  try {
    return walk(join(ROOT, d));
  } catch {
    return [];
  }
});

let violations = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  // The audit script itself necessarily contains every banned phrase.
  if (rel.includes("a3-audit")) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  const isCode = file.endsWith(".ts") || file.endsWith(".mjs");

  lines.forEach((line, i) => {
    // Source comments explain these very rules, so auditing them only produces
    // noise — and noise is how a real violation gets scrolled past. String
    // literals in the same files are still audited, which is what catches
    // reader-facing copy embedded in code.
    const trimmed = line.trim();
    if (isCode && (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"))) {
      return;
    }

    for (const rule of RULES) {
      if (rule.allow.some((a) => a.test(line))) continue;
      for (const bad of rule.bad) {
        if (!bad.test(line)) continue;
        violations++;
        console.log(`\n  ${rel}:${i + 1}  [${rule.id}]`);
        console.log(`    ${line.trim().slice(0, 130)}`);
        console.log(`    why: ${rule.why}`);
      }
    }

    if (PRICE_SCOPE.some((e) => file.endsWith(e)) && PRICE_RE.test(line) && !PRICE_OK.test(line)) {
      violations++;
      console.log(`\n  ${rel}:${i + 1}  [unqualified-price]`);
      console.log(`    ${line.trim().slice(0, 130)}`);
      console.log(`    why: A12 — a price must read as indicative, not purchasable.`);
    }
  });
}

console.log(
  violations
    ? `\nA3 AUDIT FAILED — ${violations} violation${violations === 1 ? "" : "s"} across ${files.length} files\n`
    : `\nA3 audit clean — ${files.length} files, 0 violations\n`,
);
process.exit(violations ? 1 : 0);
