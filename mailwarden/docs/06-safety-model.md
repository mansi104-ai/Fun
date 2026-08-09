# The Safety Model

Everything in this document is enforced in code and covered by tests in
`server/src/smoke.ts`. If you change a guard, the test suite must change with
it — that coupling is deliberate.

---

## 1. The single chokepoint

There is exactly one path from a user's click to a change in their mailbox:

```
UI  →  POST /api/batches/plan     →  planBatch()      →  evaluate()          (dry run, nothing moves)
UI  →  POST /api/batches/:id/exec →  executeBatch()   →  assertExecutable()  (re-validated, then Gmail)
```

`gmail.users.messages.batchModify` is called from **one file only**
(`gmail/executor.ts`), and that file cannot reach it without passing
`assertExecutable`. A test asserts both facts by scanning the source, so a
future edit that adds a second mutation path fails the build rather than
quietly shipping.

## 2. Block vs confirm vs exclude

Three distinct outcomes, because collapsing them produces either a nagging
product or an unsafe one:

| Outcome | Effect | Example |
|---|---|---|
| **exclude** | Silently drops specific senders or messages, reports why, the rest proceeds | A protected sender inside a 40-sender batch |
| **confirm** | Batch is legal but unusual; needs a second explicit approval | A batch touching 60% of the mailbox |
| **block** | Batch cannot run at all. Fail closed | An unrecognised action verb |

Protection **narrows** a batch; it does not cancel it. A user who selects 40
senders and hits three protected ones should get 37 cleaned and a clear note
about the other three — not an error.

## 3. The guards

| Code | Severity | Rule |
|---|---|---|
| `NEVER_DELETE` | block | Action must be `archive` or `trash`. Nothing else is executable, ever. |
| `UNKNOWN_SENDER` | block | A requested sender missing from the account means a stale client. Fail closed. |
| `BATCH_TOO_LARGE` | block | > 25,000 messages in one batch. |
| `TOO_MANY_SENDERS` | block | > 500 senders in one batch. |
| `DAILY_LIMIT` | block | > 50,000 messages actioned in a rolling 24h. |
| `SCALE_ANOMALY` | confirm | Batch covers ≥ 40% of the mailbox. |
| `REPLIED_SENDER` | exclude | You have written back to this sender. **Cannot be overridden.** |
| `USER_PINNED` | exclude | You pinned the sender as protected. |
| `PROTECTED_CATEGORY` | exclude | Classified `security`, `transactional`, `finance`, `travel`, or `personal`. |
| `LOW_CONFIDENCE` | exclude | Classifier confidence < 0.40. If we don't understand a sender, we don't touch it. |
| `TOO_RECENT` | exclude | Message is < 7 days old, whatever its category. |

Thresholds live in `server/src/safety/limits.ts`. `GET /api/safety/limits`
returns them, so the UI explains the policy rather than guessing at it.

### Why the recency shield exists

No classifier can know that the shipping notice from Tuesday still matters.
Time does that job instead: recent mail is disproportionately likely to be
live, and the cost of keeping 40 recent emails is nil against the cost of
archiving one that was needed.

### Why "replied to" cannot be released

A user can release automatic protection on a sender they disagree with
(`user_protected = -1`). That override is honoured for every category —
**except** a sender they have replied to. Writing back is the strongest signal
a mailbox contains, and no UI affordance should be able to defeat it. Enforced
in `guardProtectedSenders`, tested explicitly.

## 4. The TOCTOU rule

**A clean plan is not an authorisation to execute.**

Between planning and executing, a sender can be reclassified by a re-scan,
pinned by the user in another tab, or become replied-to. Acting on the plan's
verdict would then act on a stale reading — the exact shape of bug that loses
someone a boarding pass.

`executeBatch` therefore re-derives every block guard from current state and
fails closed on violation. If re-validation *narrows* the batch, the removed
messages are deleted from `batch_items` so undo continues to mirror reality.

## 5. Undo is deliberately unguarded

Guards apply to mutation, never to restoration. Restoring mail to where it was
cannot harm the user, and a guard that blocked a restore would be strictly
worse than no guard at all.

Undo reports partial failure honestly (`{restored, failed}`) rather than
claiming success — a batch is only marked `undone` when every message came
back.

## 6. Data minimisation as a safety property

Not just a compliance posture — it bounds the blast radius of any breach.

- No message bodies are ever fetched. Sync uses `format: "metadata"` with an
  explicit header allowlist.
- No plaintext subjects. Only a salted hash, used to detect template reuse.
- No recipient addresses.
- Refresh tokens are AES-256-GCM encrypted at rest.
- What reaches a third-party model is aggregate, content-free sender statistics
  only — never a subject, body, or address.

## 7. Failure posture

| Failure | Behaviour |
|---|---|
| LLM budget exhausted | Degrade to heuristics-only. Users get a usable result, not an error. |
| LLM returns unparseable output | Sender falls back to `unknown`, protected, untouched. |
| Gmail 429 / 5xx | Exponential backoff with full jitter, 5 attempts. |
| Gmail 403 insufficient scope | Surfaces immediately — retrying can never fix it. |
| Crash mid-execution | `applied` flags persist; re-running resumes rather than repeating. |
| Refresh token expired | Account marked `needs_reconnect`, user prompted. No silent failure. |
| Guard violation at execute | Batch marked `failed`, audit entry written, nothing touched. |

Every one of these resolves toward *doing less*, never toward doing more.

## 8. Test coverage

`pnpm exec tsx src/smoke.ts` — 48 checks, no network or API keys required:

- Protective heuristics (OTP, airline-in-Promotions, bank, receipt, replied-to)
- Every guard above, in both the triggering and non-triggering direction
- Override semantics, including the un-releasable replied-to rule
- Plan persistence (a blocked plan is never written to the database)
- The TOCTOU re-validation path
- Entitlement gating
- Source scan for `messages.delete`, `batchDelete`, `mail.google.com`,
  `gmail.readonly`, and for any second caller of `batchModify`

Run it before every commit that touches `classify/`, `safety/`, or `gmail/`.
