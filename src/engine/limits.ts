/** Hard bounds every execution is subject to. Workflow-level settings can only tighten them. */
export interface EngineLimits {
  /** Maximum number of step attempts (including retries) per execution. Default 1000. */
  maxSteps: number;
  /** Highest `retry.maxAttempts` a step may declare. Default 10. */
  maxAttempts: number;
  /** Longest single backoff delay in milliseconds. Default 60000. */
  maxRetryDelayMs: number;
  /** Wall-clock limit for one execution in milliseconds. Default 300000 (5 minutes). */
  maxExecutionMs: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  maxSteps: 1000,
  maxAttempts: 10,
  maxRetryDelayMs: 60_000,
  maxExecutionMs: 300_000,
};

export function resolveLimits(overrides: Partial<EngineLimits> | undefined): EngineLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`Engine limit ${key} must be a positive integer, got ${String(value)}`);
    }
  }
  return limits;
}
