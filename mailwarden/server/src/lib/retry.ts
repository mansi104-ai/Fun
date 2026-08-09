/**
 * Retry with exponential backoff and jitter, for Gmail API calls.
 *
 * Gmail returns 429 (rate limit / quota) and 5xx under normal operation on
 * large mailboxes. Without this, a 40,000-message sync fails partway through
 * for a reason that has nothing to do with the user.
 *
 * Only idempotent-under-retry failures are retried. A 403 for insufficient
 * scope, or a 404, will never succeed on retry and must surface immediately.
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface GoogleishError {
  code?: number;
  status?: number;
  response?: { status?: number };
  errors?: { reason?: string }[];
}

function statusOf(err: unknown): number | undefined {
  const e = err as GoogleishError;
  return e?.code ?? e?.status ?? e?.response?.status;
}

/**
 * `userRateLimitExceeded` and `rateLimitExceeded` arrive as 403, not 429.
 * Treating every 403 as retryable would mask genuine scope errors, so we
 * discriminate on the reason string.
 */
function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;

  if (status === 403) {
    const reasons = (err as GoogleishError)?.errors?.map((e) => e.reason) ?? [];
    return reasons.some(
      (r) => r === "rateLimitExceeded" || r === "userRateLimitExceeded" || r === "backendError",
    );
  }

  const code = (err as { code?: string })?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 20_000;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) throw err;

      // Full jitter: avoids a thundering herd when many chunks fail together.
      const ceiling = Math.min(max, base * 2 ** attempt);
      const delay = Math.random() * ceiling;
      if (opts.label) {
        console.warn(
          `[retry] ${opts.label} failed (${statusOf(err) ?? "network"}), ` +
            `attempt ${attempt + 1}/${attempts}, retrying in ${Math.round(delay)}ms`,
        );
      }
      await sleep(delay);
    }
  }
  throw lastError;
}
