import type { ExecutionResult, StepResult } from "./engine/result.js";
import { getStepResult } from "./engine/result.js";

/**
 * Throws a readable assertion error unless the execution succeeded. Works with any test runner
 * because it only throws an `Error`.
 */
export function assertSucceeded(
  result: ExecutionResult,
): asserts result is ExecutionResult & { status: "succeeded" } {
  if (result.status === "succeeded") return;
  const failed = result.steps.filter(
    (step) => step.status === "failed" || step.status === "cancelled",
  );
  const lines = [
    `Workflow "${result.workflowId}" v${result.workflowVersion} ${result.status}` +
      (result.error === undefined ? "" : `: [${result.error.code}] ${result.error.message}`),
    ...failed.map(
      (step) =>
        `  step "${step.id}" (${step.type}) ${step.status} after ${step.attempts} attempt(s)` +
        (step.error === undefined ? "" : `: [${step.error.code}] ${step.error.message}`),
    ),
  ];
  throw new Error(lines.join("\n"));
}

/** Throws unless the execution failed (optionally with the given error code). */
export function assertFailed(
  result: ExecutionResult,
  code?: string,
): asserts result is ExecutionResult & { status: "failed" } {
  if (result.status !== "failed") {
    throw new Error(`Expected workflow "${result.workflowId}" to fail but it ${result.status}`);
  }
  if (code !== undefined && result.error?.code !== code) {
    throw new Error(
      `Expected failure code ${code} but got ${result.error?.code ?? "none"}: ${result.error?.message ?? ""}`,
    );
  }
}

/** Returns the step result or throws if the step does not exist in the result. */
export function requireStep(result: ExecutionResult, stepId: string): StepResult {
  const step = getStepResult(result, stepId);
  if (step === undefined) {
    throw new Error(
      `Step "${stepId}" is not in the result (steps: ${result.steps.map((s) => s.id).join(", ")})`,
    );
  }
  return step;
}

/** Compact one-line-per-step summary for CI logs. */
export function formatResult(result: ExecutionResult): string {
  const lines = [
    `${result.workflowId} v${result.workflowVersion} [${result.mode}] ${result.status} in ${result.durationMs}ms (${result.executionId})`,
  ];
  for (const step of result.steps) {
    const indent = step.parentId === undefined ? "  " : "    ";
    const via = step.execution === undefined ? "" : ` via ${step.execution}`;
    const timing = step.durationMs === undefined ? "" : ` ${step.durationMs}ms`;
    const attempts = step.attempts > 1 ? ` x${step.attempts}` : "";
    const error = step.error === undefined ? "" : ` [${step.error.code}] ${step.error.message}`;
    const skip = step.skipReason === undefined ? "" : ` (${step.skipReason})`;
    lines.push(
      `${indent}${step.status.padEnd(9)} ${step.id} (${step.type})${via}${timing}${attempts}${skip}${error}`,
    );
  }
  if (result.error !== undefined && result.error.stepId === undefined) {
    lines.push(`  error: [${result.error.code}] ${result.error.message}`);
  }
  return lines.join("\n");
}
