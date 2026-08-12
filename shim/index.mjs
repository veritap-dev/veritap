#!/usr/bin/env node
/**
 * veritap-mcp — stdio → Streamable HTTP proxy for https://veritap.dev/mcp
 *
 * Deliberately a dumb passthrough: it forwards JSON-RPC frames without
 * understanding them. That means protocol revisions on the server need no
 * release here, and there is no version skew between what an installed shim
 * speaks and what the endpoint speaks.
 *
 * Zero dependencies, so `npx -y veritap-mcp` is a fast cold start.
 */

const ENDPOINT = process.env.VERITAP_ENDPOINT || "https://veritap.dev/mcp";
const TIMEOUT_MS = Number(process.env.VERITAP_TIMEOUT_MS || 60_000);

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

/** Emit a JSON-RPC error rather than dying — a hung client is worse than a failure. */
function fail(id, message, code = -32603) {
  if (id === undefined || id === null) return; // notifications get no reply
  out({ jsonrpc: "2.0", id, error: { code, message } });
}

/** The endpoint may answer as SSE or plain JSON; normalise both to frames. */
function extractFrames(contentType, body) {
  if (contentType.includes("text/event-stream")) {
    return body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
  }
  const trimmed = body.trim();
  return trimmed ? [trimmed] : [];
}

async function forward(line) {
  let id;
  try {
    id = JSON.parse(line)?.id;
  } catch {
    return fail(null, "invalid JSON from client", -32700);
  }

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "veritap-mcp-shim",
      },
      body: line,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(id, `cannot reach ${ENDPOINT}: ${err?.message ?? err}`, -32001);
  }

  // 202 with no body is the correct answer to a notification.
  if (res.status === 202) return;

  const body = await res.text();
  if (!res.ok) {
    return fail(id, `endpoint returned HTTP ${res.status}: ${body.slice(0, 300)}`, -32002);
  }

  for (const frame of extractFrames(res.headers.get("content-type") ?? "", body)) {
    try {
      out(JSON.parse(frame));
    } catch {
      // A frame we cannot parse is the server's problem; do not crash the pipe.
      process.stderr.write(`veritap-mcp: unparseable frame: ${frame.slice(0, 200)}\n`);
    }
  }
}

// Serialise requests so stdout frames never interleave mid-line.
let chain = Promise.resolve();
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) chain = chain.then(() => forward(line));
  }
});

process.stdin.on("end", () => {
  chain.then(() => process.exit(0));
});
