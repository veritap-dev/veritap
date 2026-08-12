/**
 * Ticket 0 — domain availability sweep (spec §9).
 *
 * RDAP-first, no API key, authoritative. We resolve each TLD to its registry's
 * own RDAP base URL via the IANA bootstrap file (data.iana.org/rdap/dns.json)
 * and query the registry directly — the shared rdap.org redirector rate-limits
 * (429) well below a 42-domain sweep.
 *     404 -> unregistered (hand-registerable)
 *     200 -> registered   (inspect nameservers for the squatter heuristic)
 *     no bootstrap entry / other -> unknown (e.g. .ai publishes no RDAP; WHOIS only)
 *
 * Run:  node scripts/domain-sweep.ts            # default candidate list
 *       node scripts/domain-sweep.ts foo bar    # ad-hoc names (reusable for
 *                                                 future claim-type microsites)
 * Flags: --json  emit machine-readable results to stdout instead of a table
 */

const DEFAULT_CANDIDATES = [
  "veritap",
  "sooth",
  "forsooth",
  "attestly",
  "truthwire",
  "factline",
  "verq",
];

/** Preferred TLDs first — .com/.dev win ties per the §9 decision rule. */
const TLDS = ["com", "dev", "io", "ai", "net", "app"] as const;
const PREFERRED = new Set(["com", "dev"]);

/** Nameserver fragments that mean "registered but parked" -> squatted, skip. */
const PARKING_NS = [
  "sedoparking",
  "parkingcrew",
  "bodis",
  "above.com",
  "dan.com",
  "afternic",
  "hugedomains",
  "namefind",
  "uniregistry",
  "undeveloped",
  "registrar-servers", // Namecheap parking default
  "sav.com",
  "voodoo.com",
  "fabulous.com",
  "dsredirection",
  "cashparking",
  "parklogic",
  "domaincntrol", // GoDaddy parked (domaincntrol.com)
];

type Status = "available" | "registered" | "squatted" | "unknown";

interface Result {
  domain: string;
  name: string;
  tld: string;
  status: Status;
  preferred: boolean;
  nameservers: string[];
  note: string;
}

const TIMEOUT_MS = 12_000;
const CONCURRENCY = 4;
const POLITE_DELAY_MS = 150;
const MAX_RETRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * TLD -> registry RDAP base URL, from the IANA bootstrap registry.
 * Cached for the process; falls back to the rdap.org redirector if the
 * bootstrap file itself is unreachable.
 */
let bootstrap: Map<string, string> | null = null;

async function loadBootstrap(): Promise<Map<string, string>> {
  if (bootstrap) return bootstrap;
  const map = new Map<string, string>();
  try {
    const res = await fetch("https://data.iana.org/rdap/dns.json", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: any = await res.json();
    for (const [tlds, urls] of body?.services ?? []) {
      const url = (urls as string[]).find((u) => u.startsWith("https://")) ?? urls[0];
      if (!url) continue;
      for (const tld of tlds as string[]) {
        map.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
      }
    }
  } catch {
    // leave the map empty — callers fall back to rdap.org
  }
  bootstrap = map;
  return map;
}

/** GET with backoff on 429/503 so a rate limit never masquerades as "unknown". */
async function fetchRdap(url: string): Promise<Response | Error> {
  let delay = 800;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/rdap+json" },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 429 && res.status !== 503) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay);
      delay *= 2;
    } catch (err) {
      if (attempt === MAX_RETRIES) return err as Error;
      await sleep(delay);
      delay *= 2;
    }
  }
  return new Error("rate limited after retries");
}

async function rdapLookup(name: string, tld: string): Promise<Result> {
  const domain = `${name}.${tld}`;
  const base: Omit<Result, "status" | "note"> = {
    domain,
    name,
    tld,
    preferred: PREFERRED.has(tld),
    nameservers: [],
  };

  const registry = (await loadBootstrap()).get(tld);
  if (!registry) {
    return {
      ...base,
      status: "unknown",
      note: `.${tld} publishes no RDAP service (IANA bootstrap) — check by WHOIS/registrar`,
    };
  }

  const out = await fetchRdap(`${registry}domain/${domain}`);
  if (out instanceof Error) {
    return { ...base, status: "unknown", note: `RDAP request failed (${out.name}) — verify by hand` };
  }
  const res = out;

  if (res.status === 404) {
    return { ...base, status: "available", note: "hand-registerable" };
  }

  if (res.status !== 200) {
    return {
      ...base,
      status: "unknown",
      note: `RDAP HTTP ${res.status} from ${new URL(registry).host} — verify by hand`,
    };
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ...base, status: "registered", note: "registered (unparseable RDAP body)" };
  }

  const nameservers: string[] = (body?.nameservers ?? [])
    .map((ns: any) => String(ns?.ldhName ?? "").toLowerCase())
    .filter(Boolean);

  const parked =
    nameservers.length === 0 ||
    nameservers.some((ns) => PARKING_NS.some((frag) => ns.includes(frag)));

  if (parked) {
    return {
      ...base,
      nameservers,
      status: "squatted",
      note: nameservers.length
        ? `parked on ${nameservers[0]} — no-ransom rule, skip`
        : "registered with no nameservers — parked/held, skip",
    };
  }

  return { ...base, nameservers, status: "registered", note: `in use (${nameservers[0]})` };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
      await sleep(POLITE_DELAY_MS);
    }
  });
  await Promise.all(workers);
  return out;
}

/** §9 decision rule: highest-ranked candidate with a hand-registerable .com or .dev. */
function pickWinner(results: Result[], candidates: string[]): Result | null {
  for (const name of candidates) {
    for (const tld of ["com", "dev"]) {
      const hit = results.find(
        (r) => r.name === name && r.tld === tld && r.status === "available",
      );
      if (hit) return hit;
    }
  }
  return null;
}

const GLYPH: Record<Status, string> = {
  available: "OPEN",
  registered: "taken",
  squatted: "SQUAT",
  unknown: "  ? ",
};

function renderTable(results: Result[], candidates: string[]) {
  const width = Math.max(...results.map((r) => r.domain.length), 10);
  for (const name of candidates) {
    const rows = results.filter((r) => r.name === name);
    const openPreferred = rows.filter((r) => r.status === "available" && r.preferred);
    console.log(
      `\n${name}${openPreferred.length ? `  <- ${openPreferred.map((r) => r.tld).join("/")} open` : ""}`,
    );
    for (const r of rows) {
      const star = r.preferred ? "*" : " ";
      console.log(
        `  ${star}${r.domain.padEnd(width)}  ${GLYPH[r.status]}  ${r.note}`,
      );
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const candidates = argv.filter((a) => !a.startsWith("--"));
  const names = candidates.length ? candidates : DEFAULT_CANDIDATES;

  const pairs = names.flatMap((name) => TLDS.map((tld) => ({ name, tld })));
  if (!asJson) {
    console.error(`Sweeping ${pairs.length} domains via RDAP (${names.length} names x ${TLDS.length} TLDs)...`);
  }

  const results = await mapLimit(pairs, CONCURRENCY, ({ name, tld }) => rdapLookup(name, tld));
  const winner = pickWinner(results, names);

  if (asJson) {
    console.log(JSON.stringify({ sweptAt: new Date().toISOString(), results, winner }, null, 2));
    return;
  }

  renderTable(results, names);

  console.log("\n" + "-".repeat(60));
  if (winner) {
    console.log(`WINNER (§9 rule): ${winner.domain}`);
    console.log(
      `Register at Cloudflare Registrar (at-cost, lands in the same account as the Worker).`,
    );
    console.log(`Target <= $15/yr. If the checkout price is above standard registration, skip to the next candidate.`);
  } else {
    console.log("No candidate has an open .com or .dev. Options: extend the candidate list,");
    console.log("or relax the decision rule to .io/.app (check the OPEN rows above).");
  }
  const open = results.filter((r) => r.status === "available");
  console.log(`\n${open.length}/${results.length} open overall.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
