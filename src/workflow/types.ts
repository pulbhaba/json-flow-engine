import type { JsonObject, JsonValue } from "../json.js";

/** The workflow format version this engine understands. */
export const WORKFLOW_SCHEMA_VERSION = 1;

// Type aliases (not interfaces) so these definitions are assignable to `JsonObject`, which is
// what lets `control.condition` nest `StepDefinition[]` inside `config.then` in TypeScript.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type RetryPolicy = {
  /** Total attempts including the first (1 = no retry). Bounded by the engine's `limits.maxAttempts`. */
  maxAttempts: number;
  /** Delay before the second attempt. Default 200. */
  initialDelayMs?: number;
  /** Upper bound for any single delay. Default 10000, bounded by `limits.maxRetryDelayMs`. */
  maxDelayMs?: number;
  /** Exponential growth factor. Default 2. */
  backoffMultiplier?: number;
  /** Full jitter: each delay is uniformly random in [0, computed]. Default true. */
  jitter?: boolean;
  /** `retryable` (default) retries only errors marked retryable; `any` retries every failure. */
  retryOn?: "retryable" | "any";
};

export type StepErrorAction = "fail" | "continue";

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type StepDefinition = {
  id: string;
  type: string;
  description?: string;
  config: JsonObject;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  retry?: RetryPolicy;
  /** `fail` (default) stops the workflow; `continue` records the failure and moves on with output `null`. */
  onError?: StepErrorAction;
  /** Template resolved before execution and passed to the operation (e.g. an `Idempotency-Key`). */
  idempotencyKey?: string;
};

export interface WorkflowExecutionConfig {
  /** Wall-clock limit for the whole execution. */
  timeoutMs?: number;
  /** Maximum number of step attempts the execution may make. */
  maxSteps?: number;
}

export interface WorkflowDefinition {
  $schema?: string;
  schemaVersion?: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  version: number;
  description?: string;
  /** JSON Schema (draft 2020-12) the input must satisfy. */
  inputSchema?: JsonObject;
  /** Values available as `{{constants.<name>}}`. */
  constants?: JsonObject;
  execution?: WorkflowExecutionConfig;
  /** Template producing `result.output`; may reference `input`, `constants` and top-level steps. */
  output?: JsonValue;
  steps: StepDefinition[];
}

/** Symbol-keyed brand set on validated definitions. Ignored by JSON.stringify and Object.keys. */
export const VALIDATED_WORKFLOW: unique symbol = Symbol.for("json-flow-engine.validated");

/** A workflow definition that passed structural validation. Produced by `defineWorkflow`. */
export interface Workflow extends WorkflowDefinition {
  readonly [VALIDATED_WORKFLOW]: true;
}

/** Config of the built-in `control.condition` step. */
export interface ConditionStepConfig {
  if: Condition;
  then: StepDefinition[];
  else?: StepDefinition[];
}

/** Config of the built-in `control.assert` step. */
export interface AssertStepConfig {
  condition: Condition;
  message?: string;
}

/**
 * Structured conditions. Operands are JSON values that may contain expressions. There is no
 * free-form expression language: every operator is a JSON object with one key.
 */
export type Condition =
  | boolean
  | string
  | { equals: [JsonValue, JsonValue] }
  | { not: Condition }
  | { all: Condition[] }
  | { any: Condition[] }
  | { defined: string }
  | { greaterThan: [JsonValue, JsonValue] }
  | { lessThan: [JsonValue, JsonValue] };
