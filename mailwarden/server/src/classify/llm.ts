import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { db } from "../db.js";
import { CATEGORIES, isCategory, type Category } from "./taxonomy.js";
import { PROTECTED_CATEGORIES } from "./taxonomy.js";
import type { SenderFacts, Verdict } from "./heuristics.js";

/**
 * Senders per model call. The whole cost model rests on this number:
 * 40,000 messages collapse to ~300 senders, which is 6 requests at 50/batch.
 * That fits inside OpenRouter's 50-request/day free ceiling with room to spare.
 */
const SENDERS_PER_REQUEST = 50;

export interface LlmResult {
  verdicts: Map<string, Verdict>;
  /** Senders we could not classify — caller falls back to 'unknown'. */
  unresolved: string[];
  provider: "openrouter" | "anthropic" | "none";
  requestsUsed: number;
}

// ── Prompt ───────────────────────────────────────────────────────────────

/**
 * Stable across every request so it can be prompt-cached. Do NOT interpolate
 * dates, user IDs, or counts into this string — any byte change invalidates the
 * cache for every user. (Caching only engages above the model's minimum
 * cacheable prefix — 1024 tokens on Sonnet 5 / Haiku 4.5 — so if you trim this
 * prompt below that, expect cache_read_input_tokens to sit at zero.)
 */
const SYSTEM_PROMPT = `You classify EMAIL SENDERS for an inbox-cleanup tool.

You never see message bodies, subject lines, or recipient addresses. You see
only aggregate, content-free statistics about each sender. Classify from those
statistics alone. Do not speculate about content you cannot see.

Categories:
- promotional    marketing, deals, sales, commercial campaigns
- newsletter     editorial or content mail the user opted into
- notification   automated service/app activity ("X commented on your post")
- transactional  order confirmations, receipts, invoices, shipping, support
- security       login codes, OTPs, password resets, 2FA, account alerts
- personal       written by an individual human
- social         social network activity
- finance        banks, statements, investments, tax
- travel         bookings, itineraries, boarding passes, hotels
- unknown        genuinely cannot tell

Signals and how to read them:
- has_unsubscribe true means an RFC-8058 List-Unsubscribe header is present.
  Bulk mail almost always has it; security and transactional mail almost never
  does. Its ABSENCE is a strong signal to protect the sender.
- unread_rate near 1.0 means the user never opens this sender. Combined with
  has_unsubscribe, that is the clearest signal of unwanted marketing.
- subject_template_ratio is distinct subject templates divided by message count.
  Near 0 means one blast reused many times (bulk). Near 1 means every message
  is distinct (likely a real receipt or a human).
- gmail_labels are Gmail's own category guesses. Treat them as a weak prior
  only. Gmail routinely files receipts and boarding passes into PROMOTIONS.

Safety rule, which outranks everything above: when a sender could plausibly
carry something the user cannot afford to lose — a receipt, a boarding pass, a
login code, a bank statement — choose the protective category, even at the cost
of a lower-value classification. A wrongly-kept newsletter is a minor
annoyance. A wrongly-archived password reset is a support ticket and a refund.

Return one object per input sender, preserving the given sender_key exactly.
Set confidence between 0 and 1, reflecting your genuine certainty. Write reason
as one short sentence addressed to the user, describing the evidence you used —
it is shown to them verbatim next to an irreversible-looking button, so it must
be honest and specific, never generic.`;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sender_key: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["sender_key", "category", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

/** Content-free projection. This is the complete set of fields we transmit. */
function toPayload(f: SenderFacts) {
  const ratio = f.messageCount > 0 ? f.distinctSubjectHashes / f.messageCount : 1;
  return {
    sender_key: f.senderKey,
    display_name: f.displayName ?? null,
    domain: f.domain,
    message_count: f.messageCount,
    unread_rate: f.messageCount > 0 ? Number((f.unreadCount / f.messageCount).toFixed(2)) : 0,
    total_mb: Number((f.totalBytes / 1_048_576).toFixed(1)),
    months_active:
      f.firstSeen && f.lastSeen
        ? Math.max(1, Math.round((f.lastSeen - f.firstSeen) / 2_592_000_000))
        : 1,
    has_unsubscribe: f.hasUnsubscribe,
    subject_template_ratio: Number(ratio.toFixed(2)),
    gmail_labels: f.labels.filter((l) => l.startsWith("CATEGORY_")),
  };
}

// ── Budget accounting ────────────────────────────────────────────────────

const today = (): string => new Date().toISOString().slice(0, 10);

export function llmRequestsUsedToday(provider: string): number {
  const row = db
    .prepare(`SELECT requests FROM llm_usage WHERE day = ? AND provider = ?`)
    .get(today(), provider) as { requests: number } | undefined;
  return row?.requests ?? 0;
}

function recordUsage(provider: string, count: number): void {
  db.prepare(
    `INSERT INTO llm_usage (day, provider, requests) VALUES (?, ?, ?)
     ON CONFLICT(day, provider) DO UPDATE SET requests = requests + excluded.requests`,
  ).run(today(), provider, count);
}

// ── Response parsing ─────────────────────────────────────────────────────

interface RawResult {
  sender_key?: unknown;
  category?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

/**
 * Free models routinely wrap JSON in prose or code fences even when asked not
 * to. Recover the object rather than discarding a whole batch of work.
 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Writes verdicts into the shared map and returns the keys it actually set.
 *
 * Returning the key set rather than a count matters: batches run concurrently,
 * so "did the map grow?" attributes another batch's results to this one and
 * would mark genuinely-unresolved senders as resolved.
 */
function toVerdicts(parsed: unknown, source: string, into: Map<string, Verdict>): Set<string> {
  const written = new Set<string>();
  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return written;

  for (const raw of results as RawResult[]) {
    const key = typeof raw.sender_key === "string" ? raw.sender_key : null;
    if (!key) continue;

    const category: Category = isCategory(raw.category) ? raw.category : "unknown";
    const rawConf = typeof raw.confidence === "number" ? raw.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, rawConf));
    const reason =
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason.trim().slice(0, 240)
        : "Classified from sending patterns.";

    into.set(key, {
      category,
      confidence,
      reason,
      // The model's opinion never overrides a protective category.
      protectedSender: PROTECTED_CATEGORIES.has(category),
      source: `llm:${source}`,
    });
    written.add(key);
  }
  return written;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Batches are independent, so run them concurrently.
 *
 * Measured on a real mailbox: one 46-sender batch on a free model takes ~70
 * seconds. Run serially, a 300-sender mailbox is six of those back to back —
 * seven minutes of the user watching a spinner for work that has no ordering
 * requirement at all. Bounded rather than unbounded because both providers
 * rate-limit, and a burst of 20 parallel requests earns a 429 that costs more
 * than the serialisation saved.
 */
const BATCH_CONCURRENCY = 4;

async function runBatches<T>(
  batches: T[],
  worker: (batch: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, async () => {
      while (cursor < batches.length) {
        const i = cursor++;
        await worker(batches[i]!, i);
      }
    }),
  );
}

const userPrompt = (batch: SenderFacts[]): string =>
  `Classify these ${batch.length} senders.\n\n${JSON.stringify(batch.map(toPayload))}`;

// ── Free tier: OpenRouter ────────────────────────────────────────────────

async function classifyViaOpenRouter(batches: SenderFacts[][]): Promise<LlmResult> {
  const verdicts = new Map<string, Verdict>();
  const unresolved: string[] = [];
  let used = 0;

  const remaining = config.openrouter.dailyRequestBudget - llmRequestsUsedToday("openrouter");
  const allowed = Math.max(0, Math.min(batches.length, remaining));

  // Senders are pre-sorted most-valuable-first upstream, so when the budget
  // truncates the run it is always the smallest senders that miss out.
  await runBatches(batches, async (batch, i) => {
    if (i >= allowed) {
      // Budget exhausted. Degrade to heuristics-only rather than erroring —
      // the user still gets a usable result, just a less nuanced one.
      unresolved.push(...batch.map((f) => f.senderKey));
      return;
    }
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": config.appUrl,
          "X-Title": "Mailwarden",
        },
        body: JSON.stringify({
          model: config.openrouter.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `${userPrompt(batch)}\n\nRespond with JSON only: {"results":[{"sender_key","category","confidence","reason"}]}`,
            },
          ],
          response_format: { type: "json_object" },
          max_tokens: 4096,
        }),
      });
      used++;

      if (!res.ok) {
        // Loud, because a retired free-model slug 404s here and would
        // otherwise look identical to "the classifier had no opinion".
        const detail = await res.text().catch(() => "");
        console.error(
          `[classify] openrouter ${res.status} for model "${config.openrouter.model}": ${detail.slice(0, 200)}`,
        );
        unresolved.push(...batch.map((f) => f.senderKey));
        return;
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      // Count what THIS batch resolved. Comparing map sizes is wrong once
      // batches run concurrently — another batch's writes land in between.
      const resolved = toVerdicts(extractJson(text), config.openrouter.model, verdicts);
      const missing = batch.filter((f) => !resolved.has(f.senderKey));
      unresolved.push(...missing.map((f) => f.senderKey));
    } catch {
      unresolved.push(...batch.map((f) => f.senderKey));
    }
  });

  if (used) recordUsage("openrouter", used);
  return { verdicts, unresolved, provider: "openrouter", requestsUsed: used };
}

// ── Paid tier: Anthropic ─────────────────────────────────────────────────

/**
 * Request parameters differ meaningfully across the two models we support, and
 * getting them wrong is a 400 or a silent cost blowout:
 *
 *   claude-sonnet-5   Adaptive thinking is ON when `thinking` is omitted. For a
 *                     structured classification task that is wasted spend and
 *                     latency, so we disable it explicitly and run at low
 *                     effort.
 *   claude-haiku-4-5  Predates the effort parameter and REJECTS it. It also
 *                     uses the older budget_tokens thinking style, so omitting
 *                     `thinking` correctly means no thinking.
 *
 * Neither model accepts a non-default `temperature`, so we never send one.
 */
function anthropicParams(model: string) {
  const supportsEffort = !model.startsWith("claude-haiku-4-5");
  return {
    thinking: supportsEffort ? ({ type: "disabled" } as const) : undefined,
    outputConfig: supportsEffort
      ? { effort: "low" as const, format: { type: "json_schema" as const, schema: RESULT_SCHEMA } }
      : { format: { type: "json_schema" as const, schema: RESULT_SCHEMA } },
  };
}

async function classifyViaAnthropic(batches: SenderFacts[][]): Promise<LlmResult> {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = config.anthropic.model;
  const { thinking, outputConfig } = anthropicParams(model);

  const verdicts = new Map<string, Verdict>();
  const unresolved: string[] = [];
  let used = 0;

  await runBatches(batches, async (batch) => {
    try {
      // Built as a plain object then cast, because `thinking` and
      // `output_config` are model-conditional (see anthropicParams) and the
      // SDK's params type cannot express "present only for some models".
      // The cast targets the NonStreaming overload so `response` stays a
      // Message rather than widening to Message | Stream.
      const params = {
        model,
        max_tokens: 8192,
        // Frozen prefix — cached so repeat batches pay ~0.1x on the taxonomy.
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        ...(thinking ? { thinking } : {}),
        output_config: outputConfig,
        messages: [{ role: "user", content: userPrompt(batch) }],
      } as unknown as Anthropic.MessageCreateParamsNonStreaming;

      const response = await client.messages.create(params);
      used++;

      if (response.stop_reason === "refusal") {
        unresolved.push(...batch.map((f) => f.senderKey));
        return;
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const resolved = toVerdicts(extractJson(text), model, verdicts);
      unresolved.push(...batch.filter((f) => !resolved.has(f.senderKey)).map((f) => f.senderKey));
    } catch (err) {
      console.error("[classify] anthropic batch failed:", err);
      unresolved.push(...batch.map((f) => f.senderKey));
    }
  });

  if (used) recordUsage("anthropic", used);
  return { verdicts, unresolved, provider: "anthropic", requestsUsed: used };
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * `paid` selects the provider. Both tiers use the identical prompt, schema, and
 * batch size — the paid tier buys accuracy and headroom, not a different
 * product. That keeps free-tier output honest rather than deliberately crippled.
 */
export async function classifyWithLlm(
  senders: SenderFacts[],
  paid: boolean,
): Promise<LlmResult> {
  if (senders.length === 0) {
    return { verdicts: new Map(), unresolved: [], provider: "none", requestsUsed: 0 };
  }

  const batches = chunk(senders, SENDERS_PER_REQUEST);

  if (paid && config.anthropic.apiKey) return classifyViaAnthropic(batches);
  if (config.openrouter.apiKey) return classifyViaOpenRouter(batches);

  return {
    verdicts: new Map(),
    unresolved: senders.map((s) => s.senderKey),
    provider: "none",
    requestsUsed: 0,
  };
}
