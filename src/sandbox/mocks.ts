import { JsonFlowError, type ErrorCodeLike } from "../errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import type { OperationContext } from "../operations/types.js";
import { sleep } from "../engine/retry.js";

/** One canned reply. `error` simulates a failure with the given code and retryability. */
export type MockResponse =
  | { output: JsonValue; error?: undefined }
  | {
      output?: undefined;
      error: { code?: ErrorCodeLike; message: string; retryable?: boolean; details?: JsonObject };
    };

/**
 * Data-driven mock, usable from TypeScript and from a JSON mocks file. Responses are consumed
 * in order; once exhausted, the last one repeats. An empty `steps` list (or none) matches every
 * step of the type.
 */
export interface MockDefinition {
  type: string;
  /** Restrict the mock to these step ids. Step-scoped mocks win over type-wide ones. */
  steps?: string[];
  /** Simulated latency per call, for timeout tests. */
  delayMs?: number;
  responses: MockResponse[];
}

/** Programmatic mock: compute the output (or throw) per call. */
export type MockHandler = (context: OperationContext) => JsonValue | Promise<JsonValue>;

export type MockSpec = MockHandler | Omit<MockDefinition, "type">;

export interface MockCall {
  /** 1-based position across all mocks of the engine, for order assertions. */
  sequence: number;
  stepId: string;
  type: string;
  attempt: number;
  /** Resolved config the operation would have received. */
  config: JsonObject;
  idempotencyKey?: string;
}

export interface MockHandle {
  readonly type: string;
  readonly steps: readonly string[] | undefined;
  readonly calls: readonly MockCall[];
  readonly callCount: number;
}

/** JSON file format accepted by `loadMocksFile` and the CLI `--mocks` option. */
export interface MocksFile {
  version: 1;
  mocks: MockDefinition[];
}

class RegisteredMock implements MockHandle {
  readonly calls: MockCall[] = [];
  private cursor = 0;

  constructor(
    readonly type: string,
    readonly steps: readonly string[] | undefined,
    private readonly handler: MockHandler | undefined,
    private readonly definition: Omit<MockDefinition, "type"> | undefined,
  ) {}

  get callCount(): number {
    return this.calls.length;
  }

  matches(stepId: string): boolean {
    return this.steps === undefined || this.steps.length === 0 || this.steps.includes(stepId);
  }

  reset(): void {
    this.calls.length = 0;
    this.cursor = 0;
  }

  async invoke(context: OperationContext): Promise<JsonValue> {
    if (this.handler !== undefined) return this.handler(context);
    const definition = this.definition;
    if (definition === undefined) throw new Error("mock has neither handler nor definition");
    if (definition.delayMs !== undefined && definition.delayMs > 0) {
      await sleep(definition.delayMs, context.signal);
    }
    const index = Math.min(this.cursor, definition.responses.length - 1);
    this.cursor++;
    const response = definition.responses[index];
    if (response === undefined) {
      throw new JsonFlowError("MOCK_FAILURE", `mock for ${this.type} has no responses`, {
        details: { type: this.type },
      });
    }
    if (response.error !== undefined) {
      throw new JsonFlowError(response.error.code ?? "MOCK_FAILURE", response.error.message, {
        retryable: response.error.retryable ?? false,
        details: response.error.details ?? {},
      });
    }
    return response.output;
  }
}

/** Per-engine mock store: registration, lookup and the ordered call log. */
export class MockStore {
  private readonly mocks: RegisteredMock[] = [];
  private readonly log: MockCall[] = [];

  register(type: string, spec: MockSpec): MockHandle {
    const mock =
      typeof spec === "function"
        ? new RegisteredMock(type, undefined, spec, undefined)
        : new RegisteredMock(type, spec.steps, undefined, spec);
    if (typeof spec !== "function" && spec.responses.length === 0) {
      throw new JsonFlowError("MOCK_FAILURE", `mock for ${type} needs at least one response`, {
        details: { type },
      });
    }
    this.mocks.push(mock);
    return mock;
  }

  /** Most recently registered, step-scoped mock first; then most recent type-wide mock. */
  find(type: string, stepId: string): RegisteredMock | undefined {
    const candidates = this.mocks.filter((mock) => mock.type === type && mock.matches(stepId));
    const scoped = candidates.filter((mock) => mock.steps !== undefined && mock.steps.length > 0);
    const pool = scoped.length > 0 ? scoped : candidates;
    return pool[pool.length - 1];
  }

  async invoke(mock: RegisteredMock, context: OperationContext): Promise<JsonValue> {
    const call: MockCall = {
      sequence: this.log.length + 1,
      stepId: context.stepId,
      type: context.type,
      attempt: context.attempt,
      config: context.config,
    };
    if (context.idempotencyKey !== undefined) call.idempotencyKey = context.idempotencyKey;
    this.log.push(call);
    mock.calls.push(call);
    return mock.invoke(context);
  }

  get calls(): readonly MockCall[] {
    return this.log;
  }

  get size(): number {
    return this.mocks.length;
  }

  reset(): void {
    this.log.length = 0;
    for (const mock of this.mocks) mock.reset();
  }
}

export function isMocksFile(value: unknown): value is MocksFile {
  return (
    isJsonObject(value) &&
    value["version"] === 1 &&
    Array.isArray(value["mocks"]) &&
    value["mocks"].every(
      (entry) =>
        isJsonObject(entry) &&
        typeof entry["type"] === "string" &&
        Array.isArray(entry["responses"]) &&
        entry["responses"].every(
          (response) =>
            isJsonObject(response) &&
            ((response["output"] !== undefined && response["error"] === undefined) ||
              (isJsonObject(response["error"]) &&
                typeof response["error"]["message"] === "string")),
        ) &&
        (entry["steps"] === undefined ||
          (Array.isArray(entry["steps"]) && entry["steps"].every((s) => typeof s === "string"))) &&
        (entry["delayMs"] === undefined || typeof entry["delayMs"] === "number"),
    )
  );
}
