import type { JsonFlowError } from "../errors.js";
import type { RetryPolicy } from "../workflow/types.js";
import type { EngineLimits } from "./limits.js";

export interface ResolvedRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryOn: "retryable" | "any";
}

const NO_RETRY: ResolvedRetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 1,
  jitter: false,
  retryOn: "retryable",
};

export function resolveRetryPolicy(
  policy: RetryPolicy | undefined,
  limits: EngineLimits,
): ResolvedRetryPolicy {
  if (policy === undefined) return NO_RETRY;
  return {
    maxAttempts: Math.min(policy.maxAttempts, limits.maxAttempts),
    initialDelayMs: policy.initialDelayMs ?? 200,
    maxDelayMs: Math.min(policy.maxDelayMs ?? 10_000, limits.maxRetryDelayMs),
    backoffMultiplier: policy.backoffMultiplier ?? 2,
    jitter: policy.jitter ?? true,
    retryOn: policy.retryOn ?? "retryable",
  };
}

export function shouldRetry(
  policy: ResolvedRetryPolicy,
  attempt: number,
  error: JsonFlowError,
): boolean {
  if (attempt >= policy.maxAttempts) return false;
  if (error.code === "CANCELLED" || error.code === "EXECUTION_TIMEOUT") return false;
  return policy.retryOn === "any" || error.retryable;
}

/**
 * Exponential backoff: `initial * multiplier^(attempt-1)` capped at `maxDelayMs`. With jitter
 * the delay is uniform in [0, computed] ("full jitter"), which spreads retries from many
 * concurrent executions.
 */
export function backoffDelayMs(
  policy: ResolvedRetryPolicy,
  attempt: number,
  random: () => number,
): number {
  const exponential = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (!policy.jitter) return Math.round(capped);
  return Math.round(capped * random());
}

/** Resolves after `ms`, or rejects with the signal's reason if aborted first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("aborted");
}
