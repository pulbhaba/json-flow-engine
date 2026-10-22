import type { JsonObject, JsonValue } from "../json.js";
import type { Logger } from "../logger.js";

export type ExecutionMode = "live" | "sandbox";

/**
 * Whether an operation touches anything outside the process. In sandbox mode operations with
 * `external` effects must be mocked; `none` operations (pure data mapping) run for real.
 */
export type OperationEffects = "none" | "external";

export interface OperationContext<TConfig = JsonObject> {
  /** Step config after expression resolution and schema validation. Treat as read-only. */
  readonly config: TConfig;
  readonly stepId: string;
  readonly type: string;
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly executionId: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly mode: ExecutionMode;
  /** Workflow input (deep-frozen). */
  readonly input: JsonValue;
  /** Outputs of steps that completed before this one (deep-frozen). */
  readonly steps: Readonly<Record<string, JsonValue>>;
  readonly constants: JsonObject;
  /** Aborted on cancellation, step timeout or execution timeout. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Resolved `idempotencyKey` of the step, when configured. */
  readonly idempotencyKey?: string;
}

/**
 * Contract for a registered operation.
 *
 * `execute` is declared as a method so a definition typed with a narrower `TConfig` can be
 * registered; the runtime guard is `configSchema`, which the engine enforces on the resolved
 * config before every call. Keep the schema and the type in step.
 */
export interface OperationDefinition<TConfig = JsonObject, TOutput extends JsonValue = JsonValue> {
  /** Dotted name such as `http.request` or `billing.create-invoice`. */
  readonly type: string;
  readonly description?: string;
  /** JSON Schema (draft 2020-12) for `config`. Strongly recommended. */
  readonly configSchema?: JsonObject;
  /** Defaults to `external` (fail closed in sandbox mode). */
  readonly effects?: OperationEffects;
  execute(context: OperationContext<TConfig>): Promise<TOutput> | TOutput;
  /** Called by `engine.dispose()` to release pooled connections or similar. */
  dispose?(): Promise<void> | void;
}
