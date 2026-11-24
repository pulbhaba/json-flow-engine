import { randomUUID } from "node:crypto";
import {
  JsonFlowError,
  WorkflowValidationError,
  toExecutionError,
  toJsonFlowError,
  type ValidationIssue,
} from "../errors.js";
import {
  resolveObjectExcept,
  resolveString,
  resolveValue,
  type ExpressionScope,
} from "../expressions/resolve.js";
import {
  checkJsonValue,
  deepFreeze,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../json.js";
import { silentLogger, type Logger } from "../logger.js";
import {
  ASSERT_RAW_KEYS,
  CONDITION_RAW_KEYS,
  assertOperation,
  conditionOperation,
  evaluateCondition,
} from "../operations/builtin/control.js";
import { createHttpRequestOperation, type FetchLike } from "../operations/builtin/http.js";
import {
  createIntegrationCallOperation,
  type CredentialSource,
} from "../operations/builtin/integration.js";
import { combineIntegrations } from "../integrations/builtin.js";
import type { LoadedIntegration } from "../integrations/load.js";
import { transformOperation } from "../operations/builtin/transform.js";
import { OperationRegistry, type RegisteredOperation } from "../operations/registry.js";
import type { ExecutionMode, OperationContext, OperationDefinition } from "../operations/types.js";
import {
  MockStore,
  type MockCall,
  type MockDefinition,
  type MockHandle,
  type MockSpec,
} from "../sandbox/mocks.js";
import { formatAjvError } from "../schemas/ajv.js";
import type { UrlPolicy } from "../http/url-policy.js";
import {
  compileInputSchema,
  isStepList,
  validateWorkflow,
  type ValidationResult,
} from "../workflow/validate.js";
import type { StepDefinition, Workflow } from "../workflow/types.js";
import { DEFAULT_LIMITS, resolveLimits, type EngineLimits } from "./limits.js";
import type { ExecutionEvent, ExecutionResult, StepExecutionKind, StepResult } from "./result.js";
import { backoffDelayMs, resolveRetryPolicy, shouldRetry, sleep } from "./retry.js";

export interface SandboxOptions {
  /**
   * Operation types with external effects that may run for real even in sandbox mode, e.g.
   * `["http.request"]` to hit a local service. Combine with an `http.urlPolicy` allow list.
   */
  allowLive?: string[];
}

export interface EngineOptions {
  /**
   * `sandbox`: external operations must be mocked (fail closed). `live`: operations run for
   * real and mocks are rejected. There is no default; choose explicitly.
   */
  mode: ExecutionMode;
  /** Custom operations to register. Any config type is accepted; `configSchema` guards it at runtime. */
  operations?: OperationDefinition<unknown>[];
  /** Mocks to register up front (sandbox mode only). */
  mocks?: MockDefinition[];
  sandbox?: SandboxOptions;
  http?: { fetch?: FetchLike; urlPolicy?: UrlPolicy };
  /**
   * Integrations for `integration.call`. Built-in integrations are always available; `user`
   * adds user integrations, typically `(await loadUserIntegrations()).user`. A user provider
   * that collides with a built-in one without `overridesBuiltin` throws `INTEGRATION_INVALID`.
   */
  integrations?: {
    user?: readonly LoadedIntegration[];
    /**
     * Credential lookup by name (the run context). Falls back to the environment variable
     * `JSON_FLOW_CREDENTIAL_<NAME>`. Secrets never belong in manifests or workflows.
     */
    credentials?: CredentialSource;
    /** Environment used for the fallback lookup. Default `process.env`. */
    env?: Readonly<Record<string, string | undefined>>;
  };
  limits?: Partial<EngineLimits>;
  logger?: Logger;
  onEvent?: (event: ExecutionEvent) => void;
  /** Source of randomness for retry jitter; inject a constant for deterministic tests. */
  random?: () => number;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  /** Overrides the workflow's `execution.timeoutMs` (still capped by `limits.maxExecutionMs`). */
  timeoutMs?: number;
}

class CancelledError extends JsonFlowError {
  constructor() {
    super("CANCELLED", "Execution cancelled");
  }
}

class ExecutionTimeoutError extends JsonFlowError {
  constructor(timeoutMs: number) {
    super("EXECUTION_TIMEOUT", `Execution exceeded ${timeoutMs}ms`, { details: { timeoutMs } });
  }
}

/** Thrown internally to unwind nested step lists when a step fails with `onError: fail`. */
class StepFailure extends Error {
  constructor(
    readonly stepId: string,
    readonly error: JsonFlowError,
  ) {
    super(error.message);
  }
}

interface ExecutionState {
  readonly executionId: string;
  readonly workflow: Workflow;
  readonly signal: AbortSignal;
  readonly records: Map<string, StepResult>;
  readonly outputs: Record<string, JsonValue>;
  readonly scope: ExpressionScope;
  readonly maxSteps: number;
  attemptsUsed: number;
  /** Set when the execution signal fires, so the result reports the right status. */
  terminal: CancelledError | ExecutionTimeoutError | undefined;
}

export class Engine {
  readonly mode: ExecutionMode;
  readonly limits: EngineLimits;
  private readonly registry = new OperationRegistry();
  private readonly mocks = new MockStore();
  private readonly logger: Logger;
  private readonly onEvent: ((event: ExecutionEvent) => void) | undefined;
  private readonly random: () => number;
  private readonly allowLive: ReadonlySet<string>;
  private readonly validationCache = new WeakMap<Workflow, ValidationResult>();
  private disposed = false;

  constructor(options: EngineOptions) {
    // Checked at runtime as well as in types, for callers without TypeScript.
    const mode: unknown = options.mode;
    if (mode !== "live" && mode !== "sandbox") {
      throw new JsonFlowError("MODE_MISMATCH", 'createEngine requires mode: "live" or "sandbox"');
    }
    this.mode = mode;
    this.limits = resolveLimits(options.limits);
    this.logger = options.logger ?? silentLogger;
    this.onEvent = options.onEvent;
    this.random = options.random ?? Math.random;
    this.allowLive = new Set(options.sandbox?.allowLive ?? []);

    this.registry.register(transformOperation);
    this.registry.register(conditionOperation, CONDITION_RAW_KEYS);
    this.registry.register(assertOperation, ASSERT_RAW_KEYS);
    this.registry.register(createHttpRequestOperation(options.http ?? {}));
    const combined = combineIntegrations(options.integrations?.user ?? []);
    if (combined.errors.length > 0) {
      throw new JsonFlowError(
        "INTEGRATION_INVALID",
        `Integrations are invalid: ${combined.errors.map((e) => `${e.file}: ${e.message}`).join("; ")}`,
        { details: { files: combined.errors.map((e) => e.file) } },
      );
    }
    this.registry.register(
      createIntegrationCallOperation({
        integrations: combined.integrations,
        ...(options.integrations?.credentials === undefined
          ? {}
          : { credentials: options.integrations.credentials }),
        ...(options.integrations?.env === undefined ? {} : { env: options.integrations.env }),
        ...(options.http?.fetch === undefined ? {} : { fetch: options.http.fetch }),
        ...(options.http?.urlPolicy === undefined ? {} : { urlPolicy: options.http.urlPolicy }),
      }),
    );
    for (const operation of options.operations ?? []) this.registerOperation(operation);
    for (const mock of options.mocks ?? []) this.mock(mock.type, mock);
  }

  registerOperation<TConfig, TOutput extends JsonValue>(
    definition: OperationDefinition<TConfig, TOutput>,
  ): void {
    this.registry.register(definition);
  }

  /** Registered operation types, including built-ins. */
  operationTypes(): string[] {
    return this.registry.types();
  }

  /** Registers a mock (sandbox mode only). Returns a handle exposing the calls it received. */
  mock(type: string, spec: MockSpec): MockHandle {
    if (this.mode !== "sandbox") {
      throw new JsonFlowError(
        "MODE_MISMATCH",
        `Mocks can only be registered in sandbox mode (engine is in ${this.mode} mode)`,
        {
          details: { type },
        },
      );
    }
    return this.mocks.register(type, spec);
  }

  /** Every mock invocation in order, across all mocks. */
  get calls(): readonly MockCall[] {
    return this.mocks.calls;
  }

  /** Clears recorded calls and rewinds canned responses; registered mocks stay. */
  resetMocks(): void {
    this.mocks.reset();
  }

  /** Full validation: structure, references, known operations, config schemas, retry bounds. */
  validate(definition: unknown): ValidationResult {
    return validateWorkflow(definition, { registry: this.registry, limits: this.limits });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.registry.dispose();
  }

  async execute(
    workflow: Workflow,
    input: JsonValue = {},
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult> {
    if (this.disposed) throw new JsonFlowError("OPERATION_FAILED", "Engine has been disposed");
    const validation = this.validateCached(workflow);
    if (!validation.ok) throw new WorkflowValidationError(validation.issues);

    const executionId = randomUUID();
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const records = new Map<string, StepResult>();
    collectRecords(workflow.steps, records, undefined, undefined);

    const finish = (
      status: ExecutionResult["status"],
      output: JsonValue,
      error?: JsonFlowError,
      failingStepId?: string,
    ): ExecutionResult => {
      const completedAtMs = Date.now();
      for (const record of records.values()) {
        if (record.status === "pending") {
          record.status = "skipped";
          record.skipReason ??= "not-reached";
        }
      }
      const result: ExecutionResult = {
        executionId,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        mode: this.mode,
        status,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        steps: [...records.values()],
        output,
      };
      if (error !== undefined) result.error = toExecutionError(error, failingStepId);
      this.emit({
        type: "execution.finished",
        executionId,
        workflowId: workflow.id,
        status,
        durationMs: result.durationMs,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
      this.logger.info("execution finished", {
        executionId,
        workflowId: workflow.id,
        status,
        durationMs: result.durationMs,
        ...(result.error === undefined
          ? {}
          : { errorCode: result.error.code, failedStepId: failingStepId ?? null }),
      });
      return result;
    };

    const inputError = this.checkInput(workflow, input);
    if (inputError !== undefined) return finish("failed", null, inputError);

    const timeoutMs = Math.min(
      options.timeoutMs ?? workflow.execution?.timeoutMs ?? this.limits.maxExecutionMs,
      this.limits.maxExecutionMs,
    );
    const controller = new AbortController();
    const outputs: Record<string, JsonValue> = {};
    const state: ExecutionState = {
      executionId,
      workflow,
      signal: controller.signal,
      records,
      outputs,
      scope: {
        input: deepFreeze(structuredClone(input)),
        steps: outputs,
        constants: workflow.constants ?? {},
      },
      maxSteps: Math.min(
        workflow.execution?.maxSteps ?? this.limits.maxSteps,
        this.limits.maxSteps,
      ),
      attemptsUsed: 0,
      terminal: undefined,
    };

    const timer = setTimeout(() => {
      state.terminal = new ExecutionTimeoutError(timeoutMs);
      controller.abort(state.terminal);
    }, timeoutMs);
    const onExternalAbort = (): void => {
      state.terminal = new CancelledError();
      controller.abort(state.terminal);
    };
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    this.emit({
      type: "execution.started",
      executionId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      mode: this.mode,
      at: startedAt,
    });
    this.logger.info("execution started", {
      executionId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      mode: this.mode,
    });

    try {
      await this.runSteps(workflow.steps, state);
      let output: JsonValue = null;
      if (workflow.output !== undefined) {
        try {
          output = resolveValue(workflow.output, state.scope);
        } catch (error) {
          const flowError = toJsonFlowError(error);
          return finish(
            "failed",
            null,
            new JsonFlowError(flowError.code, `output: ${flowError.message}`, {
              details: flowError.details,
              path: "/output",
              cause: error,
            }),
          );
        }
      }
      return finish("succeeded", output);
    } catch (error) {
      if (state.terminal !== undefined) {
        return finish(
          state.terminal instanceof CancelledError ? "cancelled" : "failed",
          null,
          state.terminal,
          error instanceof StepFailure ? error.stepId : undefined,
        );
      }
      if (error instanceof StepFailure) return finish("failed", null, error.error, error.stepId);
      return finish("failed", null, toJsonFlowError(error));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private validateCached(workflow: Workflow): ValidationResult {
    let cached = this.validationCache.get(workflow);
    if (cached === undefined) {
      cached = this.validate(workflow);
      this.validationCache.set(workflow, cached);
    }
    return cached;
  }

  private checkInput(workflow: Workflow, input: JsonValue): JsonFlowError | undefined {
    const check = checkJsonValue(input);
    if (!check.ok) {
      return new JsonFlowError(
        "INPUT_INVALID",
        `Input is not plain JSON at ${check.path || "/"}: ${check.reason}`,
        {
          details: { path: check.path, reason: check.reason },
        },
      );
    }
    if (workflow.inputSchema === undefined) return undefined;
    const validate = compileInputSchema(workflow.inputSchema);
    if (validate(input)) return undefined;
    const issues: ValidationIssue[] = (validate.errors ?? []).map((error) => ({
      code: "INPUT_INVALID",
      path: error.instancePath,
      message: formatAjvError(error),
    }));
    const summary = issues.map((issue) => `${issue.path || "/"}: ${issue.message}`).join("; ");
    return new JsonFlowError("INPUT_INVALID", `Input does not match inputSchema: ${summary}`, {
      details: { issues: issues.map((issue) => ({ ...issue })) },
    });
  }

  private async runSteps(steps: StepDefinition[], state: ExecutionState): Promise<void> {
    for (const step of steps) {
      if (state.signal.aborted) throw state.terminal ?? new CancelledError();
      const record = state.records.get(step.id);
      if (record === undefined) throw new Error(`missing record for step ${step.id}`);
      if (step.type === "control.condition") await this.runCondition(step, record, state);
      else await this.runStep(step, record, state);
    }
  }

  private async runCondition(
    step: StepDefinition,
    record: StepResult,
    state: ExecutionState,
  ): Promise<void> {
    const started = Date.now();
    record.status = "running";
    record.attempts = 1;
    record.execution = "live";
    record.startedAt = new Date(started).toISOString();
    this.emit({
      type: "step.started",
      executionId: state.executionId,
      stepId: step.id,
      stepType: step.type,
      attempt: 1,
      at: record.startedAt,
    });

    const thenSteps = step.config["then"];
    const elseSteps = step.config["else"];
    const branches = {
      then: isStepList(thenSteps) ? thenSteps : [],
      else: isStepList(elseSteps) ? elseSteps : [],
    };
    let branch: "then" | "else";
    try {
      branch = evaluateCondition(step.config["if"] ?? null, state.scope) ? "then" : "else";
    } catch (error) {
      const flowError = toJsonFlowError(error);
      this.completeStep(record, "failed", started, state, flowError, step);
      throw new StepFailure(step.id, flowError);
    }
    const skipped = branch === "then" ? branches.else : branches.then;
    markSkipped(skipped, state.records);

    try {
      await this.runSteps(branches[branch], state);
    } catch (error) {
      const flowError = error instanceof StepFailure ? error.error : toJsonFlowError(error);
      this.completeStep(
        record,
        state.terminal === undefined ? "failed" : "cancelled",
        started,
        state,
        flowError,
        step,
      );
      throw error;
    }
    const taken = branches[branch];
    const last = taken[taken.length - 1];
    const output: JsonValue = {
      branch,
      output: last === undefined ? null : (state.outputs[last.id] ?? null),
    };
    state.outputs[step.id] = deepFreeze(output);
    record.output = output;
    this.completeStep(record, "succeeded", started, state, undefined, step);
  }

  private async runStep(
    step: StepDefinition,
    record: StepResult,
    state: ExecutionState,
  ): Promise<void> {
    const registered = this.registry.get(step.type);
    if (registered === undefined) {
      throw new StepFailure(
        step.id,
        new JsonFlowError("OPERATION_UNKNOWN", `Unknown operation "${step.type}"`),
      );
    }
    const policy = resolveRetryPolicy(step.retry, this.limits);
    const started = Date.now();
    record.status = "running";
    record.startedAt = new Date(started).toISOString();

    for (let attempt = 1; ; attempt++) {
      if (state.attemptsUsed >= state.maxSteps) {
        const error = new JsonFlowError(
          "LIMIT_EXCEEDED",
          `Execution exceeded maxSteps (${state.maxSteps}) step attempts`,
          {
            details: { maxSteps: state.maxSteps },
          },
        );
        this.completeStep(record, "failed", started, state, error, step);
        throw new StepFailure(step.id, error);
      }
      state.attemptsUsed++;
      record.attempts = attempt;
      this.emit({
        type: "step.started",
        executionId: state.executionId,
        stepId: step.id,
        stepType: step.type,
        attempt,
        at: new Date().toISOString(),
      });

      const outcome = await this.attempt(step, registered, attempt, state);
      if (outcome.ok) {
        record.execution = outcome.execution;
        record.output = outcome.output;
        state.outputs[step.id] = deepFreeze(outcome.output);
        this.completeStep(record, "succeeded", started, state, undefined, step);
        return;
      }
      if (outcome.execution !== undefined) record.execution = outcome.execution;
      const error = outcome.error;
      if (state.signal.aborted) {
        const terminal = currentTerminal(state) ?? new CancelledError();
        this.completeStep(record, "cancelled", started, state, terminal, step);
        throw new StepFailure(step.id, terminal);
      }
      if (shouldRetry(policy, attempt, error)) {
        const delayMs = backoffDelayMs(policy, attempt, this.random);
        this.emit({
          type: "step.retrying",
          executionId: state.executionId,
          stepId: step.id,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          error: toExecutionError(error, step.id),
        });
        this.logger.warn("step retrying", {
          executionId: state.executionId,
          stepId: step.id,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          errorCode: error.code,
        });
        try {
          await sleep(delayMs, state.signal);
        } catch {
          const terminal = currentTerminal(state) ?? new CancelledError();
          this.completeStep(record, "cancelled", started, state, terminal, step);
          throw new StepFailure(step.id, terminal);
        }
        continue;
      }
      this.completeStep(record, "failed", started, state, error, step);
      if (step.onError === "continue") {
        state.outputs[step.id] = null;
        return;
      }
      throw new StepFailure(step.id, error);
    }
  }

  private async attempt(
    step: StepDefinition,
    registered: RegisteredOperation,
    attempt: number,
    state: ExecutionState,
  ): Promise<
    | { ok: true; output: JsonValue; execution: StepExecutionKind }
    | { ok: false; error: JsonFlowError; execution: StepExecutionKind | undefined }
  > {
    const mock = this.mode === "sandbox" ? this.mocks.find(step.type, step.id) : undefined;
    const execution: StepExecutionKind = mock === undefined ? "live" : "mock";
    const pointer = `/steps/${step.id}`;
    const timeoutController = new AbortController();
    try {
      // 1. Resolve templates and validate the resolved config.
      const config = resolveObjectExcept(step.config, state.scope, registered.rawConfigKeys);
      const configIssues = this.registry.validateConfig(
        step.type,
        config,
        `${pointer}/config`,
        false,
      );
      if (configIssues.length > 0) {
        const summary = configIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
        throw new JsonFlowError(
          "OPERATION_CONFIG_INVALID",
          `Resolved config is invalid: ${summary}`,
          {
            details: { issues: configIssues.map((issue) => ({ ...issue })) },
            path: `${pointer}/config`,
          },
        );
      }
      let idempotencyKey: string | undefined;
      if (step.idempotencyKey !== undefined) {
        const resolved = resolveString(step.idempotencyKey, state.scope);
        if (typeof resolved !== "string" || resolved === "") {
          throw new JsonFlowError(
            "EXPRESSION_TYPE",
            "idempotencyKey must resolve to a non-empty string",
            { path: `${pointer}/idempotencyKey` },
          );
        }
        idempotencyKey = resolved;
      }

      // 2. Decide how to run it: mock, live, or refuse (sandbox without mock).
      if (
        mock === undefined &&
        this.mode === "sandbox" &&
        registered.effects === "external" &&
        !this.allowLive.has(step.type)
      ) {
        throw new JsonFlowError(
          "SANDBOX_MOCK_MISSING",
          `No mock registered for "${step.type}" (step "${step.id}") and the engine is in sandbox mode. Register a mock, or allow it explicitly with sandbox.allowLive.`,
          { details: { type: step.type, stepId: step.id } },
        );
      }

      // 3. Run with a per-attempt timeout.
      const signal = AbortSignal.any([state.signal, timeoutController.signal]);
      const context: OperationContext = {
        config,
        stepId: step.id,
        type: step.type,
        attempt,
        executionId: state.executionId,
        workflowId: state.workflow.id,
        workflowVersion: state.workflow.version,
        mode: this.mode,
        input: state.scope.input,
        steps: state.scope.steps,
        constants: state.scope.constants,
        signal,
        logger: this.logger,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
      const run =
        mock === undefined
          ? Promise.resolve(registered.definition.execute(context))
          : this.mocks.invoke(mock, context);
      const output = await withTimeout(run, step.timeoutMs, timeoutController, step.id);

      // 4. Only plain JSON may flow to later steps.
      const check = checkJsonValue(output);
      if (!check.ok) {
        throw new JsonFlowError(
          "OPERATION_OUTPUT_INVALID",
          `Operation "${step.type}" returned a non-JSON value at ${check.path || "/"}: ${check.reason}`,
          {
            details: { type: step.type, path: check.path, reason: check.reason },
          },
        );
      }
      return { ok: true, output, execution };
    } catch (error) {
      if (state.signal.aborted) {
        return { ok: false, error: currentTerminal(state) ?? new CancelledError(), execution };
      }
      // A step timeout aborts the operation's signal; report the timeout even if the operation
      // surfaced its own abort error first.
      const timedOut: unknown = timeoutController.signal.aborted
        ? timeoutController.signal.reason
        : undefined;
      if (timedOut instanceof JsonFlowError) return { ok: false, error: timedOut, execution };
      return { ok: false, error: toJsonFlowError(error), execution };
    }
  }

  private completeStep(
    record: StepResult,
    status: StepResult["status"],
    startedMs: number,
    state: ExecutionState,
    error: JsonFlowError | undefined,
    step: StepDefinition,
  ): void {
    const completed = Date.now();
    record.status = status;
    record.completedAt = new Date(completed).toISOString();
    record.durationMs = completed - startedMs;
    if (error !== undefined) record.error = toExecutionError(error, step.id);
    const event: ExecutionEvent = {
      type: "step.finished",
      executionId: state.executionId,
      stepId: step.id,
      stepType: step.type,
      status,
      attempts: record.attempts,
      durationMs: record.durationMs,
      ...(record.execution === undefined ? {} : { execution: record.execution }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
    this.emit(event);
    const fields: JsonObject = {
      executionId: state.executionId,
      stepId: step.id,
      stepType: step.type,
      status,
      attempts: record.attempts,
      durationMs: record.durationMs,
      execution: record.execution ?? null,
    };
    if (record.error !== undefined) {
      fields["errorCode"] = record.error.code;
      this.logger.error("step failed", fields);
    } else {
      this.logger.info("step finished", fields);
    }
  }

  private emit(event: ExecutionEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      this.logger.warn("onEvent handler threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function withTimeout<T>(
  run: Promise<T>,
  timeoutMs: number | undefined,
  controller: AbortController,
  stepId: string,
): Promise<T> {
  if (timeoutMs === undefined) return run;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new JsonFlowError(
        "STEP_TIMEOUT",
        `Step "${stepId}" timed out after ${timeoutMs}ms`,
        {
          details: { stepId, timeoutMs },
        },
      );
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** `state.terminal` is set asynchronously by abort handlers; read it through a call so the
 * type checker does not assume an earlier narrowing still holds after an `await`. */
function currentTerminal(
  state: ExecutionState,
): CancelledError | ExecutionTimeoutError | undefined {
  return state.terminal;
}

function collectRecords(
  steps: StepDefinition[],
  records: Map<string, StepResult>,
  parentId: string | undefined,
  branch: "then" | "else" | undefined,
): void {
  for (const step of steps) {
    const record: StepResult = { id: step.id, type: step.type, status: "pending", attempts: 0 };
    if (parentId !== undefined) record.parentId = parentId;
    if (branch !== undefined) record.branch = branch;
    records.set(step.id, record);
    if (step.type === "control.condition") {
      const thenSteps = step.config["then"];
      const elseSteps = step.config["else"];
      if (isStepList(thenSteps)) collectRecords(thenSteps, records, step.id, "then");
      if (isStepList(elseSteps)) collectRecords(elseSteps, records, step.id, "else");
    }
  }
}

function markSkipped(steps: StepDefinition[], records: Map<string, StepResult>): void {
  for (const step of steps) {
    const record = records.get(step.id);
    if (record?.status === "pending") {
      record.status = "skipped";
      record.skipReason = "branch-not-taken";
    }
    if (step.type === "control.condition") {
      const thenSteps = step.config["then"];
      const elseSteps = step.config["else"];
      if (isStepList(thenSteps)) markSkipped(thenSteps, records);
      if (isStepList(elseSteps)) markSkipped(elseSteps, records);
    }
  }
}

export function createEngine(options: EngineOptions): Engine {
  return new Engine(options);
}

export { DEFAULT_LIMITS, isJsonObject };
