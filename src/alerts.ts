/**
 * Operator alerts.
 *
 * Sent via the Cloudflare send_email binding, which can only deliver to a
 * pre-verified destination address — so this path cannot be turned into a
 * relay no matter what reaches it.
 *
 * Alerts are best-effort by design: a failure to notify must never fail the
 * work that triggered it.
 */

import type { Env } from "./types.ts";

export async function sendAlert(env: Env, subject: string, body: string): Promise<void> {
  const to = env.ALERT_EMAIL;
  if (!env.SEND_EMAIL || !to) {
    console.error("ALERT_NO_EMAIL_BINDING", { subject });
    return;
  }
  try {
    const { EmailMessage } = await import("cloudflare:email");
    const from = "alerts@veritap.dev";
    const raw = [
      `From: Veritap Alerts <${from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
      "https://veritap.dev/health",
    ].join("\r\n");

    await env.SEND_EMAIL.send(new (EmailMessage as any)(from, to, raw));
    console.log("ALERT_SENT", { subject });
  } catch (err) {
    console.error("ALERT_FAILED", { subject, error: String(err) });
  }
}
