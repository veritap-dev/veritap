/**
 * MCP tool surface. Every doorway shares the router in router.ts.
 *
 * Copy rule (addendum A3): nothing here may say "human verification network".
 * There is no human in the fulfillment loop and there is not going to be one,
 * so the phrase would be exactly the false coverage §10 forbids — and §10
 * applies to our own marketing before it applies to anything else.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { route } from "./router.ts";
import { assessCaller, deriveFingerprint, touchCaller, writeLedger } from "./ledger.ts";
import { matchClaimType } from "./catalog.ts";
import { classifyUnknown, summarize } from "./triage.ts";
import { drainPending, registerNotify } from "./notify.ts";
import type { CallerAssessment, ClaimInput, Env } from "./types.ts";

export const INSTRUCTIONS = `This server verifies real-world facts about businesses, listings, objects, and places. Verification is multi-source desk research returning an evidence bundle — captured sources, a stated method, and an honest confidence — never a bare verdict.

Scope limit, stated up front: it does not answer questions about individual people (identity, employment, tenancy, background, whereabouts). Those are refused as a matter of policy, not queued.

Before acting on a plan, list the real-world facts you are uncertain about and triage them with triage_unknowns — free, instant, read-only; a recommended first step, not a last resort. It will tell you honestly which unknowns you can settle yourself from public sources.

If a step depends on a physical-world fact you cannot confirm — availability, condition, existence, authenticity, completion — call check_feasibility, even speculatively; it never fails. Unsupported requests are logged and drive what gets supported next. For multi-step tasks, plan_verification maps which steps can be grounded.`;

const CLAIM_INPUT = {
  claim_description: z
    .string()
    .min(1)
    // Bounds exist to protect the ledger, not the parser. Every call writes a
    // row, so an unbounded field is an unbounded write.
    .max(2000)
    .describe("Free text. The real-world fact you need settled. Required."),
  claim_type: z
    .string()
    .max(120)
    .optional()
    .describe("Optional. A claim type id from the published catalog, if you know it."),
  location: z
    .object({
      text: z.string().max(500).optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    })
    .optional()
    .describe("Where the fact must be checked."),
  deadline: z.string().max(64).optional().describe("ISO8601. When the answer stops being useful."),
  budget_ceiling_usd: z
    .number()
    .optional()
    .describe("Most you would pay for this answer. Directly drives what gets built next."),
  downstream_action: z
    .string()
    .max(1000)
    .optional()
    .describe("What you will do with the answer once you have it."),
  cost_if_wrong: z
    .union([z.string().max(500), z.number()])
    .optional()
    .describe("What it costs your task if this fact turns out to be wrong."),
  task_context: z.string().max(2000).optional().describe("The wider task this step belongs to."),
  callback_url: z
    .string()
    .url()
    .max(2048)
    .optional()
    .describe(
      "Optional. If this claim is not supported yet, POST here when it becomes supported. Otherwise you are told on your next call.",
    ),
};

const FREE_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

/**
 * The alias doorways (§5.6). Same handler, different framings, so we learn
 * which framing agents actually reach for. `tool_name` on the ledger row is
 * the entire experiment.
 */
const DOORWAYS: Array<{ name: string; title: string; description: string }> = [
  {
    name: "check_feasibility",
    title: "Check whether a real-world fact can be verified",
    description: `Check whether a real-world fact can be verified before committing to a paid request. Free, no auth, read-only, no side effects — call liberally during planning.

Use speculatively: if any step of your task depends on a physical-world fact you cannot confirm (in stock, exists at location, condition, document authenticity, work completed), check here first. Covers businesses, listings, objects, and places. Unsupported claims are logged and prioritized for future support. Never errors.`,
  },
  {
    name: "confirm_before_purchase",
    title: "Confirm a listing or seller is real before spending money",
    description: `Check whether a listing, item, or business can be corroborated before an agent commits money. Free, read-only, no side effects.

Use before any irreversible spend where the counterparty or the goods have only been seen online. Returns what can be corroborated from sources, what cannot, and — when it cannot — whether you could settle it yourself and how to proceed if not.`,
  },
  {
    // Renamed from `request_human_check`, which promised dispatch we do not do
    // and directly contradicted our own published terms. Nothing here sends a
    // person anywhere. Names freeze permanently at npm publish.
    name: "check_before_relying",
    title: "Check a fact before relying on it",
    description: `Check whether a fact can be corroborated before your task depends on it. Free, read-only, no side effects.

Use when a step rests on something you have only inferred from text and being wrong would be expensive. Returns whether it can be corroborated from sources today, what evidence would come back, and an honest answer when it cannot.`,
  },
  {
    name: "check_physical_condition",
    title: "Check the condition or grading of a physical item",
    description: `Check the stated condition, damage, or grading of a physical item or property. Free, read-only, no side effects.

Use when a decision depends on an item being in the condition a listing claims. Returns what can be corroborated from sources today, and says plainly when physical inspection is what is actually required — nobody is sent to look.`,
  },
];

/**
 * Identify + rate-assess in one pass, ONCE per tool call (A15). Doing this
 * per-row would mean up to 50 rate queries for a single triage_unknowns call.
 */
async function identify(
  env: Env,
  request: Request | undefined,
): Promise<{ fingerprint: string | null; assessment: CallerAssessment }> {
  let fingerprint: string | null = null;
  try {
    if (request) {
      fingerprint = await deriveFingerprint(request);
      await touchCaller(env, fingerprint);
    }
  } catch (err) {
    console.error("FINGERPRINT_FAILED", { error: String(err) });
  }
  const assessment = await assessCaller(env, fingerprint);
  return { fingerprint, assessment };
}

const asText = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload as Record<string, unknown>,
});

/**
 * Piggyback any "the gap you hit is now closed" news onto whatever the caller
 * asked for. Agents are not long-lived processes, so their next call is often
 * the only delivery window we will ever get.
 */
async function noticesFor(env: Env, fingerprint: string | null) {
  const pending = await drainPending(env, fingerprint);
  if (!pending.length) return {};
  return {
    now_supported: pending.map((p) => ({
      claim_description: p.claim_description,
      claim_type: p.claim_type,
      note: "You asked about this earlier when it was not supported. It is now.",
    })),
  };
}

export function registerTools(server: McpServer, env: Env, request: Request | undefined) {
  // --- §5.1 + §5.6: the sensor and its alias framings ---
  for (const doorway of DOORWAYS) {
    server.registerTool(
      doorway.name,
      {
        title: doorway.title,
        description: doorway.description,
        annotations: FREE_ANNOTATIONS,
        inputSchema: z.object(CLAIM_INPUT),
      },
      async (args) => {
        const input = args as ClaimInput & { callback_url?: string };
        const { fingerprint, assessment } = await identify(env, request);
        const result = await route(env, input, {
          toolName: doorway.name,
          origin: "elicited_probe",
          fingerprint,
          raw: args,
          assessment,
        });

        // A8: the miss stays ours, so the promise to report back has to be real.
        if (result.notify_when_supported) {
          await registerNotify(env, {
            fingerprint,
            eventId: result.event_id,
            claimDescription: input.claim_description,
            callbackUrl: input.callback_url,
          });
        }

        const { event_id, outcome, ...payload } = result;
        return asText({ ...payload, ...(await noticesFor(env, fingerprint)) });
      },
    );
  }

  // --- §5.4: chain capture ---
  server.registerTool(
    "plan_verification",
    {
      title: "Map which steps of a plan depend on unverified real-world facts",
      description: `Map a multi-step plan against what can be grounded in the real world. Free, no auth, read-only, no side effects — call liberally during planning.

Pass your whole plan, including steps you have not decomposed into questions yet. Returns, per step, whether it rests on a checkable real-world fact, which claim type would settle it, and what to do about the steps that cannot be grounded.`,
      annotations: FREE_ANNOTATIONS,
      inputSchema: z.object({
        goal: z.string().max(2000).describe("What the overall plan is trying to achieve."),
        steps: z
          .array(
            z.object({
              description: z.string().max(1000).describe("What this step does."),
              depends_on_real_world_fact: z
                .string()
                .max(1000)
                .optional()
                .describe("The physical-world fact this step assumes, if any."),
            }),
          )
          .min(1)
          .max(50)
          .describe("The plan, in order."),
      }),
    },
    async (args) => {
      const { goal, steps } = args as {
        goal: string;
        steps: Array<{ description: string; depends_on_real_world_fact?: string }>;
      };
      const { fingerprint, assessment } = await identify(env, request);

      const per_step = [];
      for (const [index, step] of steps.entries()) {
        const claimText = step.depends_on_real_world_fact ?? step.description;
        const declared = Boolean(step.depends_on_real_world_fact);
        const match = matchClaimType(claimText);

        // Only steps that actually rest on a real-world fact become demand
        // events. Logging "send the confirmation email" as verification demand
        // would poison every §12 metric.
        if (!declared && !match) {
          per_step.push({
            step_index: index,
            groundable: false,
            note: "No real-world dependency detected in this step.",
          });
          continue;
        }

        const result = await route(
          env,
          { claim_description: claimText, task_context: goal },
          {
            toolName: "plan_verification",
            origin: "elicited_plan",
            fingerprint,
            raw: { goal, step, step_index: index },
            assessment,
          },
        );

        if (result.notify_when_supported) {
          await registerNotify(env, {
            fingerprint,
            eventId: result.event_id,
            claimDescription: claimText,
          });
        }

        per_step.push({
          step_index: index,
          groundable: result.feasible !== "not_yet",
          claim_type: result.supported_claim_type,
          est_price: result.est_price_usd,
          est_turnaround: result.est_turnaround,
          alternative: result.closest_alternatives[0]?.claim_type,
          refused: result.refused?.message,
          note: result.refused
            ? "Out of scope as a matter of policy."
            : result.feasible === "not_yet"
              ? "Not currently grounded here — logged, and you will be told if that changes."
              : "Rests on a checkable fact.",
        });
      }

      const groundable = per_step.filter((s) => s.groundable).length;
      return asText({
        per_step,
        plan_note: `${groundable} of ${steps.length} step${steps.length === 1 ? "" : "s"} rest on facts that can be grounded. Steps that cannot be grounded are logged and drive what gets supported next.`,
        ...(await noticesFor(env, fingerprint)),
      });
    },
  );

  // --- §5.5: deliberation capture, before an ask is even formed ---
  server.registerTool(
    "triage_unknowns",
    {
      title: "Triage a batch of uncertainties into answerable, verifiable, or neither",
      description: `Triage everything you are uncertain about in one call. Free, instant, read-only, no side effects — call liberally during planning.

Dump every uncertainty at once, mid-reasoning, before deciding which are worth chasing. Each is classified as answerable by you from public sources (with a suggested source), verifiable here (with price and turnaround), or not determinable (with advice on planning around it). Items you can settle yourself are honestly routed away rather than sold to you.`,
      annotations: FREE_ANNOTATIONS,
      inputSchema: z.object({
        unknowns: z
          // Each unknown becomes its own ledger row, so this array length is a
          // direct write multiplier. 50 is far above real batch sizes.
          .array(z.string().max(1000))
          .min(1)
          .max(50)
          .describe("Every uncertainty in the task. Batch them — this is one call."),
        task_context: z.string().max(2000).optional().describe("What you are trying to accomplish."),
        downstream_action: z
          .string()
          .max(1000)
          .optional()
          .describe("What resolving these would let you do."),
      }),
    },
    async (args) => {
      const { unknowns, task_context, downstream_action } = args as {
        unknowns: string[];
        task_context?: string;
        downstream_action?: string;
      };
      const { fingerprint, assessment } = await identify(env, request);
      const triage = unknowns.map(classifyUnknown);

      // Every unknown is a demand event, including the ones we route away.
      for (const item of triage) {
        const refused = Boolean(item.refused_category);
        await writeLedger(env, {
          tool_name: "triage_unknowns",
          origin: "elicited_probe",
          outcome: refused
            ? "refused_policy"
            : item.classification === "human_verifiable"
              ? "deferred_no_fulfiller"
              : "unsupported",
          caller_fingerprint: fingerprint,
          claim_type: item.claim_type ?? null,
          price_quoted: item.est_price_usd ?? null,
          suspect: assessment.suspect,
          degraded: assessment.degraded,
          redacted: refused,
          raw: refused ? undefined : { item, task_context, downstream_action },
          input: refused
            ? {
                claim_description: `[redacted: people-claim refused — ${item.refused_category}]`,
              }
            : {
                claim_description: item.unknown,
                task_context,
                downstream_action,
              },
        });

        // Uncatalogued, non-refused unknowns are exactly the gaps A8 says we
        // keep in-house — so they get the same report-back promise.
        if (!refused && item.classification === "not_determinable") {
          await registerNotify(env, {
            fingerprint,
            eventId: null,
            claimDescription: item.unknown,
          });
        }
      }

      return asText({
        triage,
        summary: summarize(triage),
        ...(await noticesFor(env, fingerprint)),
      });
    },
  );
}
