/**
 * A16 part 2 — the daily push.
 *
 * One summary line, plus anomaly lines only when something warrants attention.
 * Counts only: no claim text, no fingerprints, no client names. The push
 * traverses a third-party service (ntfy), so the rule is simply that nothing
 * leaving here could matter if the topic leaked — ledger contents stay behind
 * Cloudflare Access, per the A16 constraint.
 *
 * Silence is the design goal. A digest that arrives every day saying "all
 * normal" trains you to ignore it, which is how the one that matters gets
 * missed — so anomaly lines are the only thing that ever changes shape.
 */

import type { Env } from "./types.ts";

const one = async <T>(env: Env, sql: string, ...b: unknown[]): Promise<T | null> => {
  try {
    return await env.DB.prepare(sql).bind(...b).first<T>();
  } catch (err) {
    console.error("DIGEST_QUERY_FAILED", { error: String(err) });
    return null;
  }
};

export async function dailyDigest(env: Env): Promise<void> {
  const topic = env.NTFY_TOPIC;
  if (!topic) {
    console.warn("DIGEST_SKIPPED_NO_TOPIC");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();

  const t = await one<{
    calls: number; looks: number; refused: number; suspect: number;
    novel: number; callers: number; budget: number;
  }>(
    env,
    `SELECT
      (SELECT count(*) FROM demand_ledger WHERE substr(ts,1,10)=?1) calls,
      (SELECT count(*) FROM inspections   WHERE substr(ts,1,10)=?1) looks,
      (SELECT count(*) FROM demand_ledger WHERE substr(ts,1,10)=?1 AND outcome='refused_policy') refused,
      (SELECT count(*) FROM demand_ledger WHERE substr(ts,1,10)=?1 AND suspect=1) suspect,
      (SELECT count(*) FROM demand_ledger WHERE substr(ts,1,10)=?1 AND claim_type IS NULL AND outcome='unsupported') novel,
      (SELECT count(DISTINCT caller_fingerprint) FROM demand_ledger WHERE substr(ts,1,10)=?1) callers,
      (SELECT count(*) FROM demand_ledger WHERE substr(ts,1,10)=?1 AND budget_ceiling_usd IS NOT NULL) budget`,
    today,
  );

  // Baseline for "unusually quiet": mean daily calls over the trailing week.
  const base = await one<{ avg_calls: number | null }>(
    env,
    `SELECT AVG(n) avg_calls FROM (
       SELECT substr(ts,1,10) d, count(*) n FROM demand_ledger WHERE ts > ?1 GROUP BY 1)`,
    since7,
  );
  const ctr = await one<{ alerted: number; usage_alerted: number; degraded_writes: number }>(
    env, `SELECT alerted, usage_alerted, degraded_writes FROM daily_counters WHERE day = ?`, today,
  );
  const pending = await one<{ n: number }>(
    env, `SELECT count(*) n FROM notify_registry WHERE ready_at IS NULL AND delivered_at IS NULL`,
  );

  const calls = t?.calls ?? 0;
  const avg = base?.avg_calls ?? 0;

  const lines = [
    `${calls} calls · ${t?.looks ?? 0} looks · ${t?.callers ?? 0} callers · ${t?.novel ?? 0} novel · ${t?.budget ?? 0} w/ budget`,
  ];

  // Anomalies only. Each one is a thing you would want to act on today.
  if (ctr?.alerted) lines.push("BREAKER OPEN — detail rows suppressed, counters only");
  if (ctr?.usage_alerted) lines.push("Free-plan request cap warning fired — traffic may start being dropped");
  if ((ctr?.degraded_writes ?? 0) > 0) lines.push(`${ctr!.degraded_writes} rows suppressed by the breaker`);
  if ((t?.suspect ?? 0) > 0) lines.push(`${t!.suspect} rows quarantined (suspect=1)`);
  // A refusal spike is the signal that someone is probing the people-claim
  // boundary, which is exactly when the gate deserves a look.
  if ((t?.refused ?? 0) >= 3) lines.push(`${t!.refused} people-claims refused today — worth reading the gate`);
  if (avg >= 3 && calls === 0) lines.push(`no calls today against a ${avg.toFixed(1)}/day trailing average`);
  if ((pending?.n ?? 0) > 5000) lines.push(`${pending!.n} notices waiting — sweep may not be keeping up`);

  const anomalous = lines.length > 1;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        Title: `Veritap ${today}`,
        Priority: anomalous ? "high" : "low",
        Tags: anomalous ? "warning" : "chart_with_upwards_trend",
      },
      body: lines.join("\n"),
      signal: AbortSignal.timeout(10_000),
    });
    console.log("DIGEST_SENT", { calls, anomalous });
  } catch (err) {
    console.error("DIGEST_SEND_FAILED", { error: String(err) });
  }
}
