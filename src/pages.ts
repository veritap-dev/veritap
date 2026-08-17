/**
 * Human-facing pages for Veritap Verify (rebrand 2026-08-17), in the same
 * design system as Veritap Locker — dark #111318 / amber #f5a623, system-sans
 * landing, ui-monospace docs. Host-routed: verify.veritap.dev → landing,
 * apex veritap.dev → brand hub. Self-contained, no framework.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const OG = (baseUrl: string, title: string, desc: string) => `
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${baseUrl}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@veritaplocker">
<meta name="twitter:image" content="${baseUrl}/og.png">
<link rel="icon" type="image/png" href="/favicon.ico">`;

// ---- verify.veritap.dev landing ----
export function landingPage(baseUrl: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veritap Verify — check it before you rely on it</title>
<meta name="description" content="Free, no-auth fact-verification for AI agents. Multi-source desk research that returns an evidence bundle — sources, method, honest confidence — never a bare verdict.">
${OG(baseUrl, "Veritap Verify — check it before you rely on it", "Free, no-auth fact-verification for AI agents. Evidence bundles, not bare verdicts.")}
<style>
 :root{--bg:#111318;--panel:#171a21;--line:#262b36;--fg:#e6e9f0;--dim:#8a93a5;--amber:#f5a623;--green:#7bd88f;--blue:#6ab0f3}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
 .wrap{max-width:860px;margin:0 auto;padding:0 1.2rem}
 code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
 header{text-align:center;padding:4.5rem 0 2rem}
 header img{width:112px;height:112px;border-radius:24px}
 h1{font-size:2.6rem;margin:1.2rem 0 .3rem;letter-spacing:-.02em}
 .tag{color:var(--amber);font-size:1.35rem;font-weight:600;margin:0}
 .sub{color:var(--dim);font-size:1.1rem;max-width:34rem;margin:1rem auto 0}
 .cta{display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap;margin:2rem 0 .5rem}
 .btn{display:inline-block;padding:.65rem 1.2rem;border-radius:8px;font-weight:600;border:1px solid var(--line)}
 .btn.primary{background:var(--amber);color:#111318;border-color:var(--amber)}
 .btn.primary:hover{text-decoration:none;filter:brightness(1.08)}
 .btn.ghost:hover{text-decoration:none;border-color:var(--amber);color:var(--amber)}
 .npx{display:inline-flex;align-items:center;gap:.6rem;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.55rem .9rem;margin-top:1rem;font-size:.95rem}
 .npx .dim{color:var(--dim)}
 .free{background:linear-gradient(180deg,#1a1e27,#151821);border:1px solid var(--line);border-left:3px solid var(--green);border-radius:10px;padding:1.1rem 1.3rem;margin:2.5rem 0;font-size:1.08rem}
 .free b{color:var(--green)}
 h2{font-size:1.35rem;margin:3rem 0 1rem}
 .steps{counter-reset:s;display:grid;gap:.6rem}
 .step{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1rem 1.2rem 1rem 3.2rem;position:relative}
 .step::before{counter-increment:s;content:counter(s);position:absolute;left:1rem;top:1rem;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--amber);color:#111318;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:.9rem}
 .step code{color:var(--amber)}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
 @media(max-width:620px){.grid{grid-template-columns:1fr}h1{font-size:2rem}}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.3rem}
 .card h3{margin:.1rem 0 .4rem;font-size:1.05rem;color:var(--amber)}
 .card p{margin:0;color:var(--dim);font-size:.96rem}
 pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1.1rem;overflow-x:auto;font-size:.9rem;line-height:1.55}
 .kw{color:var(--amber)}.str{color:var(--green)}.cmt{color:var(--dim)}
 footer{border-top:1px solid var(--line);margin-top:3.5rem;padding:2rem 0 3rem;color:var(--dim);font-size:.95rem;text-align:center}
 footer a{margin:0 .5rem;white-space:nowrap}
</style></head><body>
<div class="wrap">
 <header>
  <img src="/logo.png" alt="Veritap Verify">
  <h1>Veritap Verify</h1>
  <p class="tag">Check it before you rely on it.</p>
  <p class="sub">Free, no-auth fact-verification for AI agents. Ask whether a real-world fact can be verified — and get an evidence bundle, not a bare verdict.</p>
  <div class="cta">
   <a class="btn primary" href="/docs">Read the docs</a>
   <a class="btn ghost" href="/mcp">MCP endpoint</a>
   <a class="btn ghost" href="https://veritap.dev">Veritap</a>
  </div>
  <div class="npx mono"><span class="dim">$</span> npx -y veritap-mcp</div>
 </header>

 <div class="free">
  <b>Free, no auth, read-only.</b> No signup, no API key, no wallet. Ask before you act — Verify tells you honestly which real-world facts you can settle from public sources, and returns captured sources, a stated method, and a confidence you can trust.
 </div>

 <h2>Ask before you act — three moves</h2>
 <div class="steps">
  <div class="step"><b>Triage your unknowns.</b> <code>triage_unknowns</code> — list the real-world facts a plan depends on; Verify tells you which you can settle yourself, free and instant.</div>
  <div class="step"><b>Check a specific fact.</b> <code>check_feasibility</code> — availability, condition, existence, authenticity, completion. It never fails; unsupported asks are logged and drive what gets supported next.</div>
  <div class="step"><b>Get an evidence bundle.</b> A verified answer returns the captured sources, the method used, and an honest confidence — never a bare yes/no you can't audit.</div>
 </div>

 <h2>What it covers</h2>
 <div class="grid">
  <div class="card"><h3>Businesses & places</h3><p>Does this business exist and operate? Verified on the spot with dated evidence from public registries (GLEIF, SEC EDGAR, Wikidata).</p></div>
  <div class="card"><h3>Listings & objects</h3><p>Condition, authenticity, existence, completion — the physical-world facts an agent can't confirm from a screen before it acts or buys.</p></div>
  <div class="card"><h3>Evidence, not verdicts</h3><p>Every answer is a bundle: what was checked, where, how, and how sure. Auditable by construction — no black-box confidence score.</p></div>
  <div class="card"><h3>People: refused by policy</h3><p>Questions about individuals — identity, employment, tenancy, background, whereabouts — are refused, not queued. Stated up front, logged without their text.</p></div>
 </div>

 <h2>One call, from anywhere</h2>
 <pre class="mono"><span class="cmt">// MCP (Streamable HTTP) — call from any agent, no auth</span>
POST <span class="str">"${baseUrl}/mcp"</span>
  → triage_unknowns({ unknowns: [<span class="str">"is 'Blue Bottle SF' a real, operating business?"</span>] })
  ← { settle_yourself: [...], evidence: { sources, method, confidence } }</pre>
 <p class="sub" style="text-align:left;max-width:none;margin-top:.8rem">Every request is analyzed in aggregate to decide what gets supported next. The demand ledger is the point — Verify learns what agents actually need verified.</p>

 <footer>
  <a href="/docs">Docs</a>·<a href="/mcp">MCP</a>·<a href="https://www.npmjs.com/package/veritap-mcp">npm</a>·<a href="https://veritap.dev">Veritap</a>·<a href="/privacy">Privacy</a>·<a href="/terms">Terms</a>
  <div style="margin-top:.8rem">Free · no auth · <span class="mono">verify.veritap.dev</span></div>
 </footer>
</div></body></html>`;
}

// ---- apex veritap.dev brand hub ----
export function hubPage(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veritap — verification & storage for AI agents</title>
<meta name="description" content="Veritap builds agent-native infrastructure: Verify (fact-verification) and Locker (wallet-addressed mailbox + storage).">
<link rel="icon" type="image/png" href="/favicon.ico">
<style>
 :root{--bg:#111318;--panel:#171a21;--line:#262b36;--fg:#e6e9f0;--dim:#8a93a5;--amber:#f5a623;--blue:#6ab0f3}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
 .wrap{max-width:760px;margin:0 auto;padding:0 1.2rem}
 a{color:var(--blue);text-decoration:none}
 header{text-align:center;padding:5rem 0 1.5rem}
 h1{font-size:2.4rem;letter-spacing:-.02em;margin:.2rem 0}
 .sub{color:var(--dim);font-size:1.1rem;max-width:32rem;margin:.6rem auto 0}
 .cards{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem;margin:2.5rem 0}
 @media(max-width:620px){.cards{grid-template-columns:1fr}}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:1.6rem;display:block;transition:border-color .15s}
 .card:hover{border-color:var(--amber);text-decoration:none}
 .card h2{color:var(--amber);font-size:1.25rem;margin:.2rem 0 .5rem}
 .card p{color:var(--dim);margin:0 0 .8rem;font-size:.98rem}
 .card .go{color:var(--fg);font-weight:600;font-size:.95rem}
 footer{border-top:1px solid var(--line);margin-top:2rem;padding:2rem 0 3rem;color:var(--dim);text-align:center;font-size:.9rem}
</style></head><body>
<div class="wrap">
 <header>
  <h1>Veritap</h1>
  <p class="sub">Agent-native infrastructure. Two products, one belief: agents should be able to check what's true and keep what's theirs.</p>
 </header>
 <div class="cards">
  <a class="card" href="https://verify.veritap.dev">
   <h2>Veritap Verify</h2>
   <p>Free, no-auth fact-verification for AI agents. Ask whether a real-world fact can be verified — get an evidence bundle, not a bare verdict.</p>
   <span class="go">verify.veritap.dev →</span>
  </a>
  <a class="card" href="https://locker.veritap.dev">
   <h2>Veritap Locker</h2>
   <p>Wallet-addressed mailbox + storage for agents. Pay to send (x402, USDC on Base); the holder of the wallet key reads free. Receiving costs nothing.</p>
   <span class="go">locker.veritap.dev →</span>
  </a>
 </div>
 <footer><a href="https://verify.veritap.dev">Verify</a> · <a href="https://locker.veritap.dev">Locker</a> · <a href="https://x.com/veritaplocker">@veritaplocker</a> · <span style="font-family:ui-monospace,monospace">veritap.dev</span></footer>
</div></body></html>`;
}

const LEGAL_STYLE = `<style>
 body{font:15px/1.65 ui-monospace,Menlo,monospace;background:#111318;color:#d8dbe2;max-width:820px;margin:2rem auto;padding:0 1rem}
 h1{font-size:1.35rem} h2{color:#f5a623;font-size:1.05rem;margin-top:2rem;border-bottom:1px solid #2a2f3a;padding-bottom:.3rem}
 h3{font-size:1rem;margin:1.4rem 0 .2rem} h3 a{color:#f5a623;text-decoration:none}
 a{color:#6ab0f3} code{background:#1b1e27;border-radius:4px;padding:.1rem .35rem} .dim{color:#8a93a5}
 section{scroll-margin-top:1rem} footer{border-top:1px solid #2a2f3a;margin-top:2.5rem;padding-top:1rem;color:#8a93a5;font-size:.9rem}
</style>`;

const legalFoot = `<footer><a href="/">home</a> · <a href="/docs">docs</a> · <a href="/privacy">privacy</a> · <a href="/terms">terms</a> · <a href="https://veritap.dev">Veritap</a></footer>`;

export function docsPage(baseUrl: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Veritap Verify — docs</title>${OG(baseUrl, "Veritap Verify — docs", "How to call Veritap Verify: tools, coverage, refusal policy.")}${LEGAL_STYLE}
<h1>Veritap Verify — docs</h1>
<p><b>Check whether a real-world fact can be verified before you act on it.</b> Free, no auth, read-only. MCP (Streamable HTTP) at <code>${baseUrl}/mcp</code>, or <code>npx -y veritap-mcp</code>. The demand sensor behind the Veritap brand — every ask teaches it what agents actually need verified.</p>

<h2>Start here</h2>
<pre>1. triage_unknowns({ unknowns: [...] })   — list a plan's real-world facts; free, instant
2. check_feasibility({ claim })            — a specific physical-world fact; never fails
3. (verified) → evidence bundle            — sources, method, honest confidence</pre>

<h2>Tools</h2>
<h3>triage_unknowns</h3><p>List the real-world facts a plan depends on; Verify tells you which you can settle yourself from public sources. A recommended first step, not a last resort.</p>
<h3>check_feasibility</h3><p>Check a physical-world fact you can't confirm from a screen — availability, condition, existence, authenticity, completion. Never fails; unsupported asks are logged and drive what gets supported next.</p>
<h3>check_before_relying · confirm_before_purchase · check_physical_condition</h3><p>Intent-framed entry points for the same verification, so the right tool surfaces for the moment (relying on a fact, buying, judging condition).</p>
<h3>plan_verification</h3><p>For multi-step tasks — maps which steps can be grounded in verifiable facts.</p>

<h2>What it covers</h2>
<p>Facts about <b>businesses, listings, objects, and places</b>. Business-exists-and-operating is answered on the spot with dated evidence from public registries (GLEIF, SEC EDGAR, Wikidata). Verification is multi-source desk research returning an <b>evidence bundle</b> — captured sources, a stated method, an honest confidence — never a bare verdict.</p>

<h2>Refusal policy — people</h2>
<p>Questions about <b>individuals</b> (identity, employment, tenancy, background, whereabouts) are <b>refused as a matter of policy</b>, not queued. Stated up front. Such requests are logged without their text.</p>

<h2>Privacy of your asks</h2>
<p>Every request is recorded and analyzed in aggregate to decide what gets supported next — the demand ledger is the core asset. Claims about individuals are logged without their content. Full terms: <a href="/terms">/terms</a>.</p>
${legalFoot}`;
}

export function privacyPage(baseUrl: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Veritap Verify — privacy</title>${LEGAL_STYLE}
<h1>Privacy</h1><p class="dim">Plain version. Last updated 2026-08-17.</p>
<p>Veritap Verify ("we") is a free, no-auth fact-verification service for software agents. We ask for no name, email, account, or wallet.</p>
<h2>What we store</h2>
<ul>
 <li><b>Requests</b>: the tool called, the claim/question text, structured fields (location, budget ceiling, deadline, cost-if-wrong), timestamps, and the outcome.</li>
 <li><b>Caller identity</b>: a hashed fingerprint derived from request attributes, plus any client name/version an MCP client volunteers at initialize. No accounts.</li>
 <li><b>Evidence</b>: captured public sources and the method/confidence produced for a verification.</li>
</ul>
<h2>People-claims: logged without their text</h2>
<p>We refuse questions about individuals. When one is submitted, we record that a people-claim was refused and its category — <b>not</b> the claim's text. We do not compile information about individuals.</p>
<h2>Why we keep it</h2>
<p>Requests are analyzed <b>in aggregate</b> to decide what verification to support next. The demand signal — what agents ask to verify — is the point of the service. We do not sell your queries.</p>
<h2>Retention & disclosure</h2>
<p>Operational logs are retained on a rolling basis. We may disclose stored data if required by valid legal process — but we hold no identities, and people-claim text is never stored.</p>
<h2>Contact & law</h2>
<p><a href="mailto:hello@veritap.dev">hello@veritap.dev</a>. Governed by the laws of the State of Tennessee, USA.</p>
${legalFoot}`;
}

export function termsPage(baseUrl: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Veritap Verify — terms</title>${LEGAL_STYLE}
<h1>Terms of Service</h1><p class="dim">Plain version. Last updated 2026-08-17.</p>
<h2>The service</h2>
<p>Veritap Verify checks whether real-world facts about businesses, listings, objects, and places can be verified, returning an evidence bundle — sources, method, honest confidence. Free, no auth, read-only. It is decision support, not professional, legal, or financial advice.</p>
<h2>Evidence, not guarantees</h2>
<p>Verification is multi-source desk research. A confidence is an honest estimate from the captured sources, not a warranty of truth. You are responsible for how you act on it; <b>always read the method and sources</b>, never a bare verdict.</p>
<h2>People-claims refused</h2>
<p>Questions about individuals (identity, employment, tenancy, background, whereabouts) are refused as a matter of policy. Do not use Verify to investigate a person.</p>
<h2>Acceptable use</h2>
<p>Don't use the service to harass, defraud, or build a profile of an individual, or to overwhelm it. It's free; abuse it and access may be limited.</p>
<h2>Your requests</h2>
<p>Requests are recorded and analyzed in aggregate to improve coverage (see <a href="/privacy">/privacy</a>). By using Verify you agree to that use of the demand signal. People-claim text is never stored.</p>
<h2>No warranty; limitation of liability</h2>
<p>The service is provided "as is," without warranty of any kind. To the maximum extent permitted by law, we are not liable for any decision made in reliance on a verification, nor for indirect or consequential damages.</p>
<h2>Governing law</h2>
<p>Governed by the laws of the State of Tennessee, USA. Contact: <a href="mailto:hello@veritap.dev">hello@veritap.dev</a>.</p>
${legalFoot}`;
}
