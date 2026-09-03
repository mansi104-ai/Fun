*Article 2 of a 5-part series on MailWarden's architecture. Written in a deliberately different register from Article 1: a reference design, not a founder story — real code, real libraries, real algorithms, generalized so the pattern outlives the product it was built for.*

# The Architecture of an AI Agent People Can Actually Trust With Their Data

Any product that lets software act on a person's real, consequential data — inbox, filesystem, calendar, transaction history — runs into the same three problems, whatever the data actually is: what should the system decide alone versus escalate to a human; how do you prove a proposed action is safe *before* it runs; and when something does go wrong, how do you keep the blast radius small and reversible instead of catastrophic.

This is a full, code-level walkthrough of one working answer, using MailWarden's **Clean tab** as the case study throughout. Stack, for context: **Fastify** (HTTP), **better-sqlite3** (storage — one file, synchronous, no ORM), **googleapis** + **google-auth-library** (Gmail), **@anthropic-ai/sdk** for the paid classification tier with a raw `fetch` against **OpenRouter's** chat-completions endpoint for the free tier, and Node's built-in `crypto` module for encryption. No queue, no vector database, no agent framework — the interesting engineering here is almost entirely in the guard logic and the tiering, not the infrastructure.

---

## Layer 1: The UI — confidence as state, not a spinner

The Clean tab is one of three sender queues — Clean, Review, Protected — built by splitting on confidence *before* rendering anything, not by filtering one feed:

```js
// web/app.js
function renderTabs() {
  const items = [
    ["overview", "Overview", null],
    ["clean", "Clean", overview.safe.messages],
    ["review", "Review", overview.review.messages],
    ["protected", "Protected", overview.protected.messages],
    ["history", "History", overview.history.cleanups || null],
  ];
  // …
}
```

Each sender card renders **evidence, not generated prose** — a hard rule stated directly in the file's own header comment:

```js
/**
 * Two rules this file follows without exception:
 *   1. No number is invented. If the API does not return it, it is not shown.
 *   2. No generated prose. Evidence comes from observed facts (`evidence[]`),
 *      never from a model writing an explanation after the fact.
 */
```

That second rule is the one worth stealing regardless of domain: an LLM-composed explanation can be fluent and wrong at the same time; a fact the backend actually computed (`94% unread`, `replied to`, `has an unsubscribe link`) cannot lie about what it is. The client never asks a model to narrate a decision — it renders the `reason` string the classifier already produced as part of making the decision, verbatim.

> **[Insert screenshot here: `mailwarden-screenshot-clean-tab.png`]**
> The real Clean tab, running against a seeded demo inbox. Every bullet under a sender's name is a fact returned by the API, not prose a model wrote — `Bulk mail — carries an unsubscribe header`, `You have never opened 98% of it`. The selection bar at top recomputes `2 senders · 4,209 emails` live as senders are checked, from the same guard logic covered in Layer 3.

The other non-negotiable: every count shown is a **live dry run of the real backend guard policy**, computed at request time — never cached, never estimated:

```js
if (next === "clean") return guarded(renderList)("safe");
// ...
const { senders } = await api(`/api/senders/state?state=safe`);
const actionable = senders.filter((s) => s.actionableCount > 0);
```

`actionableCount` on the wire is not "how many messages this sender has" — it's the output of running the guard evaluator (Layer 3, below) against the current mailbox and counting what survives. If the UI and the enforcement layer ever computed two different numbers, that gap would read to the user as the system lying, not as a rounding error.

---

## Layer 2: The classification agent — cheap first, minimal data, always

### The unit of classification

Everything downstream operates on a `SenderFacts` object, aggregated once per sender — never per message:

```ts
// classify/heuristics.ts
export interface SenderFacts {
  senderKey: string;
  displayName: string | null;
  domain: string;
  messageCount: number;
  unreadCount: number;
  totalBytes: number;
  hasUnsubscribe: boolean;
  userReplied: boolean;
  labels: string[];
  distinctSubjectHashes: number;      // template-reuse signal, no plaintext subjects
  userDecision?: "keep" | "archive" | "trash" | null;
  decisionCount?: number;
}
```

Note what's absent: no subject line, no body, no recipient. `distinctSubjectHashes` — the count of *distinct salted hashes* seen across a sender's subjects — is the one subject-derived signal that survives, because template-reuse ratio (near 0 = one blast reused many times; near 1 = every message distinct) is a strong bulk-mail signal that a hash can carry without ever storing readable content.

### Tier 1 — deterministic rules, ordered so the cheap mistake happens instead of the expensive one

```ts
// classify/heuristics.ts
export function classifyHeuristically(f: SenderFacts): Verdict | null {
  // 1. The user has written back. Nothing else outranks this.
  if (f.userReplied) {
    return protect("personal", 0.99, "You have replied to this sender before.");
  }

  // 2. Security / OTP: bulk mail almost always carries List-Unsubscribe;
  //    security mail almost never does.
  if (!f.hasUnsubscribe && includesAny(blob, SECURITY_DOMAIN_HINTS)) {
    return protect("security", 0.9, "Looks like login codes or security alerts.");
  }
  // … finance, travel, transactional protective rules, same shape …

  // Actionable rules only run after every protective rule has had a look.
  if (labels.has("CATEGORY_PROMOTIONS") && f.hasUnsubscribe) {
    const unreadRate = f.unreadCount / f.messageCount;
    if (unreadRate > 0.8 && f.messageCount >= 5) {
      return actionable("promotional", 0.92,
        `Marketing mail you almost never open — ${Math.round(unreadRate*100)}% unread.`);
    }
  }
  return null; // undecided — escalate to the model tier
}
```

Ordering here **is** the safety property: protective rules run first and win, because a false "security" costs the user nothing while a false "promotional" costs them a password reset. When two error types have asymmetric cost, order the tiers so the system defaults to the cheap mistake.

This tier is also where the one real regression in the whole classifier happened, and it's worth keeping because the fix is more instructive than the bug. `no-reply@` and `noreply@` were originally in `SECURITY_DOMAIN_HINTS`. Measured against a real mailbox, that pattern matches a huge share of *all* automated senders, not just security ones — it silently classified Google Classroom (647 messages) as `security` and locked it permanently. The fix wasn't "add more nuance," it was **delete the overbroad tokens** and keep only specific ones (`accounts.google`, `duosecurity`, `id.apple`, …). Over-protection is safer than under-protection, but it isn't free: mail the user actually wanted cleaned, that the system silently refuses to touch, is the product failing quietly.

### Tier 2 — a model, only for the ambiguous remainder, batched

```ts
// classify/llm.ts
const SENDERS_PER_REQUEST = 50; // 40,000 messages → ~300 senders → ~6 requests

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    results: { type: "array", items: {
      type: "object",
      properties: {
        sender_key: { type: "string" },
        category: { type: "string", enum: [...CATEGORIES] },
        confidence: { type: "number" },
        reason: { type: "string" },
      },
      required: ["sender_key", "category", "confidence", "reason"],
      additionalProperties: false,
    }},
  },
  required: ["results"],
} as const;
```

The **content-free projection** actually sent to the model — the entire payload, nothing more:

```ts
function toPayload(f: SenderFacts) {
  return {
    sender_key: f.senderKey,
    domain: f.domain,
    message_count: f.messageCount,
    unread_rate: Number((f.unreadCount / f.messageCount).toFixed(2)),
    total_mb: Number((f.totalBytes / 1_048_576).toFixed(1)),
    has_unsubscribe: f.hasUnsubscribe,
    subject_template_ratio: Number(ratio.toFixed(2)),
    gmail_labels: f.labels.filter((l) => l.startsWith("CATEGORY_")),
  };
}
```

Counts, ratios, booleans, domain — never a subject, a body, or a recipient. That's not a redaction step bolted on before the API call; it's the only shape `SenderFacts` is capable of producing, so there's no code path that could accidentally leak more.

**Paid tier (`@anthropic-ai/sdk`)** uses a structured-output schema plus prompt caching on the system prompt, and disables extended thinking for what is a pure classification task:

```ts
// classify/llm.ts
const params = {
  model,
  max_tokens: 8192,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  ...(thinking ? { thinking } : {}),           // { type: "disabled" } — skip adaptive thinking
  output_config: outputConfig,                 // json_schema: RESULT_SCHEMA, effort: "low"
  messages: [{ role: "user", content: userPrompt(batch) }],
} as unknown as Anthropic.MessageCreateParamsNonStreaming;

const response = await client.messages.create(params);
```

Two model-specific gotchas the code documents inline, because they cost real debugging time: `claude-sonnet-5` runs adaptive thinking by default unless `thinking` is explicitly disabled — wasted spend and latency on a task that doesn't need it — while `claude-haiku-4-5` predates the `effort` parameter entirely and **rejects the request** if you send it. Both models refuse a non-default `temperature`. None of this is discoverable except by hitting a 400 or a cost spike; it's the kind of detail worth code-commenting the moment you learn it, because the next person (including future-you) will not remember.

**Free tier (OpenRouter)** is a plain `fetch` against the chat-completions endpoint with `response_format: { type: "json_object" }`, plus a defensive JSON extractor because free models routinely wrap JSON in prose or code fences even when told not to:

```ts
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  try { return JSON.parse(candidate); }
  catch {
    const start = candidate.indexOf("{"), end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
  }
}
```

**Bounded concurrency**, shared by both providers, is a five-line worker pool rather than a library dependency:

```ts
const BATCH_CONCURRENCY = 4;

async function runBatches<T>(batches: T[], worker: (b: T, i: number) => Promise<void>) {
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
```

Measured on a real mailbox, one 46-sender batch on a free model takes roughly 70 seconds; run serially, a 300-sender mailbox becomes seven minutes of dead air for work that has no ordering requirement. Four concurrent workers pulling from a shared cursor gets the wall-clock time down without unboundedly firing requests — both providers rate-limit, and a burst of 20 parallel calls earns a 429 that costs more than the serialization it was meant to avoid.

Budget truncation is handled by pre-sorting the escalation queue **before** any request goes out:

```ts
// classify/index.ts
escalate.sort((a, b) => b.messageCount - a.messageCount);
const llm = await classifyWithLlm(escalate, paid);
```

If the daily request budget runs out mid-run, it's always the smallest, least-impactful senders that miss out — the user's biggest wins are resolved first, deterministically, not as an accident of database row order.

### Tier 0 — a verdict cache that skips re-classification entirely

```ts
// classify/index.ts
export function factsHash(f: SenderFacts): string {
  const bucket = (n: number) => (n <= 0 ? 0 : Math.floor(Math.log2(n)));
  const tenth = (n: number) => Math.round(n * 10);
  const parts = [
    f.senderKey, f.domain,
    bucket(f.messageCount),                              // log2 buckets, not raw count
    tenth(f.unreadCount / f.messageCount),                // rounded to one decimal
    tenth(f.distinctSubjectHashes / f.messageCount),
    f.hasUnsubscribe ? 1 : 0, f.userReplied ? 1 : 0,
    f.userDecision ?? "", f.decisionCount ?? 0,
    [...f.labels].filter((l) => l.startsWith("CATEGORY_")).sort().join("|"),
  ];
  return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
}
```

The `bucket`/`tenth` rounding is the whole trick. A raw message count changes on nearly every sync — hashing it directly would re-classify (and re-bill) the entire mailbox every single pass. Log2-bucketing volume and rounding rates to one decimal captures exactly the signals that actually flip a category — a sender crossing from quiet to high-volume, from read to ignored — while ignoring the noise of "one more email arrived." On a second scan, this is where nearly all the work disappears: an incremental sync typically touches a handful of senders, and the other few hundred are skipped outright rather than re-classified for an identical answer.

### Tier 3 — an honest fallback, for when the model is unreachable

The naive version of this tier marks everything `unknown` and stops. Measured on a real mailbox, that left roughly 6% of mail permanently locked for no reason other than an outage, with no explanation to the user. The actual code makes a conservative, visibly-labeled guess instead, gated on strong local evidence only:

```ts
export function fallbackClassify(f: SenderFacts): Verdict | null {
  if (!f.hasUnsubscribe || f.messageCount < 10) return null;
  const unreadRate = f.unreadCount / f.messageCount;
  if (unreadRate < 0.7) return null;
  const templateRatio = f.distinctSubjectHashes / f.messageCount;
  if (templateRatio > 0.6) return null;      // too varied to be a mail blast

  return {
    category: "newsletter", confidence: 0.55,   // above hard floor (0.4), below auto-suggest (0.7)
    reason: `Bulk mail with an unsubscribe link — ${f.messageCount} messages, ` +
            `${Math.round(unreadRate*100)}% unread. Review before cleaning.`,
    protectedSender: false, source: "heuristic",
  };
}
```

0.55 is chosen deliberately against two other constants defined once, in `safety/limits.ts`: it clears `hardConfidenceFloor` (0.4) so the mail is visible and actionable, but sits below `suggestConfidenceFloor` (0.7) so nothing auto-suggests it — the user has to deliberately choose it. A provider outage degrades the product's confidence, not its availability.

---

## Layer 3: The guardrail backend — one door, re-derived every time it opens

### Guard evaluation returns three outcomes, not two

```ts
// safety/policy.ts
export function evaluate(input: GuardInput): GuardVerdict {
  const violations: Violation[] = [];
  const exclusions: Exclusion[] = [];

  guardAction(input.action, violations);                 // NEVER_DELETE — block
  const senders = loadSenders(input.accountId, input.senderKeys);

  const blockedSenders = new Set([
    ...guardProtectedSenders(senders, input.candidates, exclusions),  // exclude
    ...guardConfidence(senders, input.candidates, exclusions),         // exclude
  ]);
  const excludedMessages = new Set([
    ...guardRecency(input.candidates, exclusions),                    // exclude
    ...guardMessageLevel(input.accountId, input.action, input.candidates, exclusions), // exclude
  ]);

  const allowed = input.candidates.filter(
    (c) => !blockedSenders.has(c.sender_key) && !excludedMessages.has(c.message_id),
  );

  guardVelocity(input.accountId, allowed.length, allowedSenders.size, violations);  // block
  guardScaleAnomaly(input.accountId, allowed.length, input.confirmed === true, violations); // confirm

  const blocking = violations.filter((v) => v.severity === "block");
  const confirming = violations.filter((v) => v.severity === "confirm");
  return {
    allowed, exclusions, violations,
    requiresConfirmation: blocking.length === 0 && confirming.length > 0,
    ok: blocking.length === 0 && confirming.length === 0,
  };
}
```

`evaluate` is pure with respect to the mailbox — it reads state and returns a verdict, and never mutates anything. That purity is what makes it safe to call three separate times in one user flow (list rendering, plan, execute) without worrying about side effects compounding. Individual guards fall into three buckets by what they protect: **sender-level** (`REPLIED_SENDER`, `USER_PINNED`, `PROTECTED_CATEGORY`, `LOW_CONFIDENCE`), **message-level** (`STARRED`, `IN_REPLIED_THREAD` absolute; `HAS_ATTACHMENT`, `GMAIL_IMPORTANT` trash-only, because archiving is reversible forever and trash starts a 30-day countdown), and **batch-level** (`BATCH_TOO_LARGE`, `TOO_MANY_SENDERS`, `DAILY_LIMIT` as hard blocks; `SCALE_ANOMALY` — ≥40% of the mailbox — as a `confirm`, not a `block`, because it's almost always intentional and only occasionally a misclick).

> **[Insert screenshot here: `mailwarden-screenshot-protected-tab.png`]**
> The real Protected tab. Each card states which guard fired, in the guard's own words — `Protected as finance`, `Protected as security`, or, for Priya Nair, `You have replied to this sender — Mailwarden never bulk-actions those`. This is the `holdReason` from `categories.ts` rendered directly, not summarized after the fact.

> **[Insert screenshot here: `mailwarden-screenshot-confirm-modal.png`]**
> The `exclude` outcome, caught mid-flow: two senders were selected for archiving (4,209 messages), and the confirm screen states exactly what the guard held back — 5 messages from the last 7 days, with the reason inline — before `assertExecutable` even runs.

### The TOCTOU rule, enforced in code, not by convention

```ts
// safety/policy.ts
export function assertExecutable(input: GuardInput): GuardVerdict {
  const verdict = evaluate({ ...input, confirmed: true });   // re-run from scratch
  const blocking = verdict.violations.filter((v) => v.severity === "block");
  if (blocking.length > 0) {
    throw new GuardError(blocking.map((v) => v.message).join(" "), blocking);
  }
  return verdict;
}
```

The interesting part isn't this function — it's what calls it. `gmail/executor.ts` re-reads message metadata **fresh from the database** rather than reconstructing it from the persisted plan, specifically because the plan can be stale by the time execution runs:

```ts
// gmail/executor.ts — inside executeBatch()
const metaById = new Map(
  db.prepare(`SELECT message_id, sender_key, labels, size_bytes, internal_date,
                     thread_id, has_attachment FROM messages_meta WHERE account_id = ?`)
    .all(accountId).map((m) => [m.message_id, m]),
);
const candidates = items.map((i) => metaById.get(i.message_id) ?? { /* fail-safe stub */ });

const verdict = assertExecutable({ accountId, action: batch.action,
  senderKeys: [...new Set(items.map((i) => i.sender_key))], candidates });

// Anything re-validation removed gets dropped from the plan, not force-run:
const stillAllowed = new Set(verdict.allowed.map((c) => c.message_id));
const revoked = items.filter((i) => !stillAllowed.has(i.message_id));
```

A message the system no longer has fresh metadata for doesn't get silently included — it falls back to a stub with `internal_date: 0`, which makes it *look* ancient enough that the recency guard won't rescue it, and every other guard still runs against it normally. Fail toward exclusion, never toward inclusion.

There's a second, easy-to-miss correctness detail right next to the TOCTOU check: `prior_labels` — the state undo restores — gets refreshed to current values immediately before mutation, not left at whatever they were when the plan was built minutes earlier:

```ts
// gmail/executor.ts
for (const i of items) {
  const current = metaById.get(i.message_id);
  if (current && current.labels !== i.prior_labels) {
    refresh.run(current.labels, batchId, i.message_id);   // update prior_labels
  }
}
```

If a message got starred, or Gmail re-categorized it, in the gap between plan and execute, undo without this step would restore the *stale plan-time* labels and silently discard that intervening change. The guarantee the product makes is "back to how it was right before this action," not "back to how it was when you clicked preview" — a subtle difference that only shows up as a bug report from a real user, months after the demo looked perfect.

### Mutation itself: chunked, retried, and mirrored locally in the same transaction

```ts
// gmail/executor.ts
const mod = batch.action === "archive"
  ? { removeLabelIds: ["INBOX"] }
  : { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] };

for (const ids of chunk(pending, LIMITS.gmailBatchModifyLimit)) {   // Gmail caps at 1000 ids/call
  await withRetry(
    () => gmail.users.messages.batchModify({ userId: "me", requestBody: { ids, ...mod } }),
    { label: `batchModify(${ids.length})` },
  );
  db.transaction(() => {
    // mark applied = 1 AND mirror the label change into messages_meta,
    // in the SAME transaction — see why below
  })();
}
```

The comment in the real source explains why the local mirror and the `applied` flag are written inside one transaction, and it's worth quoting because it's a bug the team actually shipped and caught: *"Without this the app tells Gmail to move 2,400 messages, Gmail does it, and every count in the UI is then recomputed from metadata that still says they are sitting in the inbox — so nothing appears to happen, and the same messages get offered for the same action again. Observed in production."* `batchModify` returning success means Gmail accepted the request, not that the app's own view of the world is now correct — and if those two things can disagree, they eventually will, exactly when a user is mid-batch and watching a screen that hasn't caught up.

---

## The full request lifecycle, traced against real function calls

1. **`GET /api/senders/state?state=safe`** → `evaluate()` dry-run → guard-accurate `actionableCount` per sender, rendered with `evidence[]`.
2. Client selects senders. Nothing persisted yet.
3. **`POST /api/batches/plan`** → `evaluate()` again, against this specific request → a blocked plan (`ok: false`) is never written to `batches` at all.
4. Confirm screen shows the real plan: what moves, what's excluded, why.
5. **`POST /api/batches/:id/execute`** → fresh `messages_meta` read → `assertExecutable()` re-derives every guard → anything newly excluded is dropped from `batch_items` → `prior_labels` refreshed → chunked `batchModify` calls, each mirrored locally in the same transaction as its `applied` flag.
6. Receipt, with undo as a primary action — a replay of recorded `prior_labels`, not a reconstruction.

Three separate calls into the same `evaluate()` logic — at list time, at plan time, and at execute time — against what is, on the surface, "the same data." The repetition looks wasteful until the one time state changes between two of those calls, which is exactly the case it exists to catch.

---

## Building this for something that isn't email

Swap senders for files, subscriptions, or pull-request diffs; swap `archive`/`trash` for whatever the domain's actions are; swap the protected categories for whatever's expensive to get wrong in that domain. What doesn't change: aggregate to the unit the user actually thinks in before classifying anything; tier classification cheapest-first with a content-minimal projection to any model, gated by a bucketed verdict-cache hash so re-classification isn't the default; give the guard layer three outcomes instead of two, so protection narrows work instead of canceling it; make the plan/execute split re-derive guards from fresh state rather than trusting a stale plan; and record undo state immediately before mutation, in the same transaction as the mutation's own bookkeeping.

The one sentence worth keeping: **the UI's job is to show exactly what the backend is actually enforcing — never more confident, never less honest.** Every algorithm and every guard above is just a different way of keeping that promise true under real, concurrent, adversarial-by-accident use.

---

*Next in the series: the sync strategy — full vs. incremental, the reply-ratio bug that once locked a third of a real mailbox, and the numbers behind 218.6s → 0.7s.*

*Following the series as it's written: [@seeker_1010](https://twitter.com/seeker_1010) on X.*
