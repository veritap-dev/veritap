/**
 * Ticket A16 — operator observability.
 *
 * Server-rendered plain HTML on the existing Worker. No framework, no client
 * state, no write endpoints, and every view readable with JavaScript off and
 * on a phone. Shares /veritap.css with the public site so the dashboard cannot
 * quietly become a different-looking product.
 *
 * SECURITY POSTURE — this path is the only place ledger CONTENTS are exposed.
 * Protection is Cloudflare Access (Jesse's Google identity), and this module
 * refuses by default: if the Access headers are absent it returns 403 rather
 * than rendering. That ordering matters — deploying /admin before Access is
 * configured must not leak the ledger, and "I'll add the policy in a minute"
 * is exactly how that happens.
 */

import type { Env } from "./types.ts";

const CAP = 50;

/** Cloudflare Access injects these on every request it lets through. */
export function accessIdentity(request: Request): string | null {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!email || !jwt) return null;
  return email;
}

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const num = (n: unknown): string =>
  typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? "0");

function page(title: string, who: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — Veritap operator</title>
<link rel="stylesheet" href="/veritap.css">
</head><body><div class="wrap wide">
<header class="site-head">
  <a class="brand" href="/admin">veritap<span>/admin</span></a>
  <nav class="top-nav">
    <a href="/admin">health</a><a href="/admin/ledger">ledger</a>
    <a href="/admin/backlog">backlog</a><a href="/admin/funnel">funnel</a>
    <a href="/">public site</a>
  </nav>
</header>
${body}
<footer class="site-foot"><p>Signed in as ${esc(who)} via Cloudflare Access. Read-only; no endpoint here writes. Ledger contents never leave this path.</p></footer>
</div></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Belt and braces: this path must never be cached or indexed.
        "cache-control": "no-store, private",
        "x-robots-tag": "noindex, nofollow",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

const q = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => {
  try {
    const { results } = await env.DB.prepare(sql).bind(...binds).all<T>();
    return results ?? [];
  } catch (err) {
    console.error("ADMIN_QUERY_FAILED", { error: String(err) });
    return [];
  }
};

const outcomeTag = (o: string) => {
  const cls = o.startsWith("fulfilled")
    ? "cache"
    : o === "refused_policy"
      ? "refused"
      : o === "deferred_no_fulfiller" || o === "quoted_unpaid"
        ? "deferred"
        : "unsupported";
  return `<span class="tag ${cls}">${esc(o)}</span>`;
};

/** Human phrasing for an outcome, so the feed reads as events not enum values. */
const OUTCOME_PHRASE: Record<string, string> = {
  fulfilled_cache: "answered from cache",
  fulfilled_auto: "answered by the desk verifier",
  quoted_unpaid: "priced, not purchased",
  deferred_no_fulfiller: "in scope, nothing could answer it yet",
  unsupported: "outside the catalogue — the gold rows",
  refused_policy: "refused: claim about a person",
};

// ─────────────────────────── d. Health ───────────────────────────
async function health(env: Env, who: string): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10);
  const [counts] = await q<{
    d1: number; d7: number; d30: number; total: number; suspect: number; refused: number;
  }>(
    env,
    `SELECT
       (SELECT count(*) FROM demand_ledger WHERE substr(ts,1,10) = ?1) d1,
       (SELECT count(*) FROM demand_ledger WHERE ts > ?2) d7,
       (SELECT count(*) FROM demand_ledger WHERE ts > ?3) d30,
       (SELECT count(*) FROM demand_ledger) total,
       (SELECT count(*) FROM demand_ledger WHERE suspect = 1) suspect,
       (SELECT count(*) FROM demand_ledger WHERE outcome = 'refused_policy') refused`,
    today,
    new Date(Date.now() - 7 * 864e5).toISOString(),
    new Date(Date.now() - 30 * 864e5).toISOString(),
  );

  const [ctr] = await q<{ writes: number; degraded_writes: number; usage_alerted: number; alerted: number }>(
    env, `SELECT writes, degraded_writes, usage_alerted, alerted FROM daily_counters WHERE day = ?`, today,
  );
  const [nq] = await q<{ pending: number; ready: number; delivered: number }>(
    env,
    `SELECT
       (SELECT count(*) FROM notify_registry WHERE ready_at IS NULL AND delivered_at IS NULL) pending,
       (SELECT count(*) FROM notify_registry WHERE ready_at IS NOT NULL AND delivered_at IS NULL) ready,
       (SELECT count(*) FROM notify_registry WHERE delivered_at IS NOT NULL) delivered`,
  );

  const writes = ctr?.writes ?? 0;
  const headroom = Math.max(0, 20000 - writes);
  const pct = Math.min(100, (writes / 20000) * 100);

  // §12 targets. Day counts, not projections — a projection this early would
  // be numerology.
  const target = (label: string, actual: number, t30: number, t90: number) => `
    <div class="card"><h3 class="card-t">${esc(label)}</h3>
      <p class="metric ${actual >= t30 ? "ok" : ""}">${num(actual)}</p>
      <p class="small">30d target ${num(t30)} · 90d target ${num(t90)}</p></div>`;

  const [callers] = await q<{ n: number }>(env, `SELECT count(DISTINCT caller_fingerprint) n FROM demand_ledger WHERE suspect = 0`);
  const [novel] = await q<{ n: number }>(env, `SELECT count(*) n FROM demand_ledger WHERE claim_type IS NULL AND outcome = 'unsupported'`);

  return page("Health", who, `
<section>
  <h2 class="sec">Ledger volume</h2>
  <div class="grid">
    <div class="card"><h3 class="card-t">Today</h3><p class="metric">${num(counts?.d1)}</p><p class="small">§12 target: 1/day at 30d, 10/day at 90d</p></div>
    <div class="card"><h3 class="card-t">Last 7 days</h3><p class="metric">${num(counts?.d7)}</p></div>
    <div class="card"><h3 class="card-t">Last 30 days</h3><p class="metric">${num(counts?.d30)}</p></div>
    <div class="card"><h3 class="card-t">All time</h3><p class="metric">${num(counts?.total)}</p></div>
  </div>
</section>
<section>
  <h2 class="sec">§12 scoreboard</h2>
  <div class="grid">
    ${target("Distinct callers", callers?.n ?? 0, 5, 25)}
    ${target("Novel (uncatalogued) claims", novel?.n ?? 0, 10, 100)}
    <div class="card"><h3 class="card-t">Refused (people-claims)</h3><p class="metric">${num(counts?.refused)}</p><p class="small">Text never stored. Excluded from the backlog by policy.</p></div>
    <div class="card"><h3 class="card-t">Quarantined rows</h3><p class="metric ${(counts?.suspect ?? 0) > 0 ? "warn" : ""}">${num(counts?.suspect)}</p><p class="small">suspect=1. Kept and labelled, never dropped (A15).</p></div>
  </div>
</section>
<section>
  <h2 class="sec">A15 breaker</h2>
  <div class="card">
    <p class="mono-line">${num(writes)} / 20,000 writes today · ${num(headroom)} headroom</p>
    <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <p class="small">${ctr?.alerted ? '<span class="bad">BREAKER OPEN — detail rows suppressed, counters only.</span>' : "Closed. Rows storing normally."}
    ${ctr?.degraded_writes ? ` ${num(ctr.degraded_writes)} suppressed today.` : ""}
    ${ctr?.usage_alerted ? ' <span class="warn">Free-plan request warning sent today.</span>' : ""}</p>
    <p class="small">20k ledger rows is roughly 60k D1 row-writes once counters and caller upserts are counted — about 60% of the free daily allowance.</p>
  </div>
</section>
<section>
  <h2 class="sec">Notify registry — the A8 return path</h2>
  <div class="grid">
    <div class="card"><h3 class="card-t">Waiting</h3><p class="metric">${num(nq?.pending)}</p><p class="small">Gap not yet closed.</p></div>
    <div class="card"><h3 class="card-t">Ready, undelivered</h3><p class="metric">${num(nq?.ready)}</p><p class="small">Told on next call, or POSTed to callback.</p></div>
    <div class="card"><h3 class="card-t">Delivered</h3><p class="metric ok">${num(nq?.delivered)}</p></div>
  </div>
  <p class="note">Sweep pages 20×500 nightly and logs NOTIFY_BACKLOG if it cannot keep up. With referrals removed (A8) this registry is the only route back to a caller whose gap we later close.</p>
</section>`);
}

// ─────────────────────────── a. Ledger feed ───────────────────────────
async function ledger(env: Env, who: string, url: URL): Promise<Response> {
  const fOrigin = url.searchParams.get("origin") ?? "";
  const fOutcome = url.searchParams.get("outcome") ?? "";
  const fType = url.searchParams.get("claim_type") ?? "";

  const rows = await q<Record<string, string | number | null>>(
    env,
    `SELECT id, ts, tool_name, origin, outcome, claim_type, claim_description,
            budget_ceiling_usd, downstream_action, client_name, client_ua, suspect
       FROM demand_ledger
      WHERE (?1 = '' OR origin = ?1)
        AND (?2 = '' OR outcome = ?2)
        AND (?3 = '' OR claim_type = ?3)
      ORDER BY id DESC LIMIT ${CAP}`,
    fOrigin, fOutcome, fType,
  );

  const facet = async (col: string) =>
    (await q<{ v: string; n: number }>(env, `SELECT ${col} v, count(*) n FROM demand_ledger WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY n DESC`))
      .map((r) => r);

  const link = (k: string, v: string, cur: string) => {
    const p = new URLSearchParams(url.search);
    if (v) p.set(k, v); else p.delete(k);
    return `<a class="${cur === v ? "on" : ""}" href="/admin/ledger?${p.toString()}">${esc(v || "all")}</a>`;
  };

  const origins = await facet("origin");
  const outcomes = await facet("outcome");
  const types = await facet("claim_type");

  const body = rows.length
    ? rows.map((r) => `
      <tr>
        <td class="id">${esc(r.id)}<br><span class="dim">${esc(String(r.ts).slice(5, 16).replace("T", " "))}</span></td>
        <td class="claimtext">${esc(r.claim_description)}
          ${r.downstream_action ? `<br><span class="dim">→ ${esc(r.downstream_action)}</span>` : ""}
          ${r.suspect ? ' <span class="tag warn">quarantined</span>' : ""}</td>
        <td>${outcomeTag(String(r.outcome))}<br><span class="dim">${esc(OUTCOME_PHRASE[String(r.outcome)] ?? "")}</span></td>
        <td class="id">${esc(r.claim_type ?? "—")}</td>
        <td class="id">${esc(r.tool_name)}<br><span class="dim">${esc(r.origin)}</span></td>
        <td class="num">${r.budget_ceiling_usd != null ? "$" + esc(r.budget_ceiling_usd) : "—"}</td>
        <td class="id dim">${esc(r.client_name ?? r.client_ua ?? "—")}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="dim">No rows match. ${fOrigin || fOutcome || fType ? '<a href="/admin/ledger">clear filters</a>' : "The ledger is empty."}</td></tr>`;

  return page("Ledger", who, `
<section>
  <h2 class="sec">Last ${CAP} demand events</h2>
  <div class="filters">${link("origin", "", fOrigin)}${origins.map((o) => link("origin", String(o.v), fOrigin)).join("")}</div>
  <div class="filters">${link("outcome", "", fOutcome)}${outcomes.map((o) => link("outcome", String(o.v), fOutcome)).join("")}</div>
  <div class="filters">${link("claim_type", "", fType)}${types.map((o) => link("claim_type", String(o.v), fType)).join("")}</div>
  <div class="tablebox"><table>
    <thead><tr><th>#</th><th>Claim</th><th>Outcome</th><th>Type</th><th>Doorway</th><th>Budget</th><th>Client</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <p class="note">Redaction markers render as stored: a refused people-claim shows its marker because the text was never written. Quarantined rows are shown, not hidden — A15 keeps and labels rather than dropping.</p>
</section>`);
}

// ─────────────────── b. §7 operator views ───────────────────
async function backlog(env: Env, who: string): Promise<Response> {
  // Build-next: uncatalogued asks ranked by count x avg budget x distinct
  // callers, suspect=0 only so a flood cannot buy its way onto the roadmap.
  const gold = await q<{ claim: string; n: number; avg_budget: number | null; callers: number }>(
    env,
    `SELECT claim_description claim, count(*) n, avg(budget_ceiling_usd) avg_budget,
            count(DISTINCT caller_fingerprint) callers
       FROM demand_ledger
      WHERE claim_type IS NULL AND outcome = 'unsupported' AND suspect = 0
      GROUP BY lower(claim_description)
      ORDER BY n * COALESCE(avg(budget_ceiling_usd),1) * count(DISTINCT caller_fingerprint) DESC
      LIMIT 40`,
  );

  const stalled = await q<{ claim_type: string; n: number; avg_price: number | null; callers: number }>(
    env,
    `SELECT claim_type, count(*) n, avg(price_quoted) avg_price, count(DISTINCT caller_fingerprint) callers
       FROM demand_ledger
      WHERE outcome IN ('quoted_unpaid','deferred_no_fulfiller') AND suspect = 0
      GROUP BY claim_type ORDER BY n DESC`,
  );

  const [wtp] = await q<{ with_budget: number; total: number; avg_budget: number | null; max_budget: number | null }>(
    env,
    `SELECT count(budget_ceiling_usd) with_budget, count(*) total,
            avg(budget_ceiling_usd) avg_budget, max(budget_ceiling_usd) max_budget
       FROM demand_ledger WHERE suspect = 0`,
  );

  // Physical-presence stratum: asks no desk verifier can ever answer. A12 says
  // this is NOT a reactivation trigger — it is the part of the dataset that
  // accrues value precisely because nobody serves it.
  const [phys] = await q<{ n: number }>(
    env,
    `SELECT count(*) n FROM demand_ledger
      WHERE suspect = 0 AND claim_type IS NULL
        AND (lower(claim_description) LIKE '%on site%' OR lower(claim_description) LIKE '%in stock%'
          OR lower(claim_description) LIKE '%actually ship%' OR lower(claim_description) LIKE '%physically%'
          OR lower(claim_description) LIKE '%go look%' OR lower(claim_description) LIKE '%inspect%'
          OR lower(claim_description) LIKE '%visit%' OR lower(claim_description) LIKE '%condition of%')`,
  );

  const goldRows = gold.length
    ? gold.map((g) => `<tr><td class="claimtext">${esc(g.claim)}</td><td class="num">${num(g.n)}</td>
        <td class="num">${g.avg_budget != null ? "$" + g.avg_budget.toFixed(0) : "—"}</td><td class="num">${num(g.callers)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="dim">No uncatalogued demand yet. This table is the roadmap when it fills.</td></tr>`;

  const stallRows = stalled.length
    ? stalled.map((s) => `<tr><td class="id">${esc(s.claim_type ?? "—")}</td><td class="num">${num(s.n)}</td>
        <td class="num">${s.avg_price != null ? "$" + s.avg_price.toFixed(0) : "—"}</td><td class="num">${num(s.callers)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="dim">Nothing quoted yet.</td></tr>`;

  const wtpPct = wtp?.total ? ((wtp.with_budget / wtp.total) * 100).toFixed(0) : "0";

  return page("Backlog", who, `
<section>
  <h2 class="sec">Build-next backlog · §7 query 1</h2>
  <p class="note">Uncatalogued asks ranked by count × average stated budget × distinct callers. Quarantined rows excluded, so a flood cannot buy its way onto the roadmap. A12: a claim type opens only on ≥10 distinct-caller budgeted asks for one desk-verifiable shape.</p>
  <div class="tablebox"><table><thead><tr><th>Claim</th><th>Asks</th><th>Avg budget</th><th>Callers</th></tr></thead><tbody>${goldRows}</tbody></table></div>
</section>
<section>
  <h2 class="sec">Priced and stalled · §7 query 3</h2>
  <p class="note">Demand that saw a price and stopped. Distinct from unsupported: this is a pricing or trust objection, or simply that fulfillment is not open.</p>
  <div class="tablebox"><table><thead><tr><th>Claim type</th><th>Events</th><th>Avg quoted</th><th>Callers</th></tr></thead><tbody>${stallRows}</tbody></table></div>
</section>
<section>
  <h2 class="sec">Willingness to pay</h2>
  <div class="grid">
    <div class="card"><h3 class="card-t">Rows carrying a budget</h3><p class="metric">${num(wtp?.with_budget)}</p><p class="small">${wtpPct}% of ${num(wtp?.total)} · A12 replacement goal: ≥10 by day 90</p></div>
    <div class="card"><h3 class="card-t">Average stated budget</h3><p class="metric">${wtp?.avg_budget != null ? "$" + wtp.avg_budget.toFixed(2) : "—"}</p></div>
    <div class="card"><h3 class="card-t">Highest stated</h3><p class="metric">${wtp?.max_budget != null ? "$" + wtp.max_budget.toFixed(2) : "—"}</p></div>
    <div class="card"><h3 class="card-t">Physical-presence stratum</h3><p class="metric">${num(phys?.n)}</p><p class="small">No desk verifier can answer these. Explicitly NOT a reactivation trigger (A12) — this is the stratum that accrues value because nobody serves it.</p></div>
  </div>
</section>`);
}

// ─────────────────── c. Funnel ───────────────────
function clientClass(ua: string | null, name: string | null): string {
  const s = `${name ?? ""} ${ua ?? ""}`.toLowerCase();
  if (!s.trim()) return "unannounced";
  if (/bot|crawl|spider|catalog|fetch|scan|index/.test(s)) return "crawler";
  if (/claude|chatgpt|openai|cursor|windsurf|cline|copilot|langchain|llamaindex|crewai/.test(s)) return "agent";
  if (/curl|wget|httpie|postman/.test(s)) return "human-probe";
  if (/node|python|deno|bun|go-http|java|ruby|php/.test(s)) return "runtime";
  return "other";
}

async function funnel(env: Env, who: string): Promise<Response> {
  const insp = await q<{ ua: string | null; client_name: string | null; fp: string; ts: string }>(
    env, `SELECT user_agent ua, client_name, caller_fingerprint fp, ts FROM inspections`,
  );
  const calls = await q<{ fp: string; ts: string; client_name: string | null; ua: string | null }>(
    env, `SELECT caller_fingerprint fp, min(ts) ts, client_name, client_ua ua FROM demand_ledger WHERE suspect = 0 GROUP BY caller_fingerprint`,
  );

  const byClass: Record<string, { looks: number; fps: Set<string> }> = {};
  for (const i of insp) {
    const c = clientClass(i.ua, i.client_name);
    (byClass[c] ??= { looks: 0, fps: new Set() }).looks++;
    if (i.fp) byClass[c].fps.add(i.fp);
  }

  const callFps = new Set(calls.map((c) => c.fp).filter(Boolean));
  const firstLook: Record<string, string> = {};
  for (const i of insp) if (i.fp && (!firstLook[i.fp] || i.ts < firstLook[i.fp]!)) firstLook[i.fp] = i.ts;

  const converted = calls.filter((c) => c.fp && firstLook[c.fp]);
  const latencies = converted
    .map((c) => (Date.parse(c.ts) - Date.parse(firstLook[c.fp]!)) / 1000)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  const medLat = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null;

  const inspFps = new Set(insp.map((i) => i.fp).filter(Boolean));
  const convPct = inspFps.size ? ((converted.length / inspFps.size) * 100).toFixed(0) : "0";

  const [reach] = await q<{ by_fp: number; by_software: number; by_both: number }>(
    env,
    `SELECT count(DISTINCT caller_fingerprint) by_fp,
            count(DISTINCT COALESCE(client_name, client_ua)) by_software,
            count(DISTINCT COALESCE(client_name,'?') || '|' || COALESCE(client_ua,'?')) by_both
       FROM demand_ledger WHERE suspect = 0`,
  );
  const [repeat] = await q<{ n: number }>(
    env, `SELECT count(*) n FROM (SELECT caller_fingerprint FROM demand_ledger WHERE suspect=0 GROUP BY 1 HAVING count(*) > 1)`,
  );

  const classRows = Object.entries(byClass)
    .sort((a, b) => b[1].looks - a[1].looks)
    .map(([c, v]) => {
      const called = [...v.fps].filter((f) => callFps.has(f)).length;
      return `<tr><td class="id">${esc(c)}</td><td class="num">${num(v.looks)}</td><td class="num">${num(v.fps.size)}</td>
        <td class="num">${num(called)}</td><td class="dim">${v.fps.size ? ((called / v.fps.size) * 100).toFixed(0) + "%" : "—"}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="dim">No inspections recorded.</td></tr>`;

  return page("Funnel", who, `
<section>
  <h2 class="sec">Looked vs called, by client class</h2>
  <p class="note">Classes are a heuristic over user-agent and MCP clientInfo, not ground truth. The question this answers: are the clients reading our tool list the kind that could ever call, and does the discovery copy convert them?</p>
  <div class="tablebox"><table>
    <thead><tr><th>Class</th><th>Tool-list fetches</th><th>Distinct</th><th>Went on to call</th><th>Conversion</th></tr></thead>
    <tbody>${classRows}</tbody></table></div>
</section>
<section>
  <h2 class="sec">Inspection → first call</h2>
  <div class="grid">
    <div class="card"><h3 class="card-t">Conversion</h3><p class="metric">${convPct}%</p><p class="small">${num(converted.length)} of ${num(inspFps.size)} inspecting fingerprints went on to call.</p></div>
    <div class="card"><h3 class="card-t">Median latency</h3><p class="metric">${medLat == null ? "—" : medLat < 120 ? medLat.toFixed(0) + "s" : (medLat / 60).toFixed(0) + "m"}</p><p class="small">Tool list read → first tool call.</p></div>
    <div class="card"><h3 class="card-t">Repeat callers</h3><p class="metric">${num(repeat?.n)}</p><p class="small">More than one demand event.</p></div>
  </div>
</section>
<section>
  <h2 class="sec">Reach — three denominators</h2>
  <p class="note">MCP has no installation identity, so "how many users" has no single honest answer. These bracket it rather than pretending to measure it.</p>
  <div class="grid">
    <div class="card"><h3 class="card-t">By fingerprint</h3><p class="metric">${num(reach?.by_fp)}</p><p class="small">Upper bound — splits when one caller's IP rotates.</p></div>
    <div class="card"><h3 class="card-t">By software</h3><p class="metric">${num(reach?.by_software)}</p><p class="small">Lower bound — collapses every user of one client.</p></div>
    <div class="card"><h3 class="card-t">Software × runtime</h3><p class="metric">${num(reach?.by_both)}</p><p class="small">The usable middle.</p></div>
  </div>
</section>`);
}

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const who = accessIdentity(request);
  if (!who) {
    // Refuse by default. If Access is not in front of this path, the ledger
    // must not render — not even once, not even briefly.
    return new Response(
      "403 — /admin is protected by Cloudflare Access and no Access identity was presented.\n" +
        "If you are seeing this while signed in, the Access application is not covering this hostname/path.\n",
      { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  const p = url.pathname.replace(/\/+$/, "");
  if (p === "/admin/ledger") return ledger(env, who, url);
  if (p === "/admin/backlog") return backlog(env, who);
  if (p === "/admin/funnel") return funnel(env, who);
  return health(env, who);
}
