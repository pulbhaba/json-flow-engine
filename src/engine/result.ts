import type { ExecutionError } from "../errors.js";
import type { JsonValue } from "../json.js";
import type { ExecutionMode } from "../operations/types.js";

export type ExecutionStatus = "succeeded" | "failed" | "cancelled";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

/** How a step's operation ran: through a registered mock or the real implementation. */
export type StepExecutionKind = "mock" | "live";

export interface StepResult {
  id: string;
  type: string;
  status: StepStatus;
  /** Attempts made (0 when the step never started). */
  attempts: number;
  execution?: StepExecutionKind;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: JsonValue;
  error?: ExecutionError;
  /** Set for steps nested in a `control.condition` branch. */
  parentId?: string;
  branch?: "then" | "else";
  skipReason?: "branch-not-taken" | "not-reached";
}

export interface ExecutionResult {
  executionId: string;
  workflowId: string;
  workflowVersion: number;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Every step of the definition, in document order, including skipped ones. */
  steps: StepResult[];
  /** The resolved workflow `output` template, or `null` when the workflow has none or failed. */
  output: JsonValue;
  /** Present when status is not `succeeded`. */
  error?: ExecutionError;
}

export type ExecutionEvent =
  | {
      type: "execution.started";
      executionId: string;
      workflowId: string;
      workflowVersion: number;
      mode: ExecutionMode;
      at: string;
    }
  | {
      type: "step.started";
      executionId: string;
      stepId: string;
      stepType: string;
      attempt: number;
      at: string;
    }
  | {
      type: "step.retrying";
      executionId: string;
      stepId: string;
      attempt: number;
      nextAttempt: number;
      delayMs: number;
      error: ExecutionError;
    }
  | {
      type: "step.finished";
      executionId: string;
      stepId: string;
      stepType: string;
      status: StepStatus;
      attempts: number;
      durationMs: number;
      execution?: StepExecutionKind;
      error?: ExecutionError;
    }
  | {
      type: "execution.finished";
      executionId: string;
      workflowId: string;
      status: ExecutionStatus;
      durationMs: number;
      error?: ExecutionError;
    };

export function getStepResult(result: ExecutionResult, stepId: string): StepResult | undefined {
  return result.steps.find((step) => step.id === stepId);
}
