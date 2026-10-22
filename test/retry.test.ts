import { describe, expect, it } from "vitest";
import { backoffDelayMs, resolveRetryPolicy } from "../src/engine/retry.js";
import { DEFAULT_LIMITS } from "../src/engine/limits.js";
import {
  assertSucceeded,
  createEngine,
  defineWorkflow,
  httpResponse,
  requireStep,
  type ExecutionEvent,
  type MockResponse,
  type OperationDefinition,
} from "../src/index.js";
import { workflowWith } from "./helpers.js";

const retryable: MockResponse = { error: { code: "HTTP_STATUS", message: "503", retryable: true } };
const fatal: MockResponse = { error: { code: "HTTP_STATUS", message: "400", retryable: false } };
const ok: MockResponse = { output: httpResponse(200, { done: true }) };
const call = (retry: {
  maxAttempts: number;
  retryOn?: "retryable" | "any";
  initialDelayMs?: number;
  jitter?: boolean;
}) =>
  defineWorkflow(
    workflowWith([
      {
        id: "call",
        type: "http.request",
        config: { method: "GET", url: "https://api.example.com" },
        retry: { initialDelayMs: 1, ...retry },
      },
    ]),
  );

function sandbox(responses: MockResponse[], onEvent?: (event: ExecutionEvent) => void) {
  const engine = createEngine({
    mode: "sandbox",
    random: () => 0,
    ...(onEvent === undefined ? {} : { onEvent }),
  });
  const mock = engine.mock("http.request", { responses });
  return { engine, mock };
}

describe("backoff", () => {
  it("grows exponentially, caps at maxDelayMs and applies full jitter", () => {
    const policy = resolveRetryPolicy(
      { maxAttempts: 5, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 350, jitter: false },
      DEFAULT_LIMITS,
    );
    expect([1, 2, 3, 4].map((attempt) => backoffDelayMs(policy, attempt, () => 1))).toEqual([
      100, 200, 350, 350,
    ]);
    const jittered = resolveRetryPolicy({ maxAttempts: 5, initialDelayMs: 100 }, DEFAULT_LIMITS);
    expect(backoffDelayMs(jittered, 2, () => 0.5)).toBe(100);
    expect(backoffDelayMs(jittered, 2, () => 0)).toBe(0);
  });

  it("is bounded by the engine limits", () => {
    const policy = resolveRetryPolicy(
      { maxAttempts: 99, maxDelayMs: 10_000_000 },
      { ...DEFAULT_LIMITS, maxAttempts: 3, maxRetryDelayMs: 500 },
    );
    expect(policy).toMatchObject({ maxAttempts: 3, maxDelayMs: 500 });
    expect(resolveRetryPolicy(undefined, DEFAULT_LIMITS).maxAttempts).toBe(1);
  });
});

describe("retries", () => {
  it("retries retryable errors up to maxAttempts and reports every attempt", async () => {
    const events: ExecutionEvent[] = [];
    const { engine, mock } = sandbox([retryable, retryable, ok], (event) => events.push(event));
    const result = await engine.execute(call({ maxAttempts: 3 }));
    assertSucceeded(result);
    expect(requireStep(result, "call")).toMatchObject({
      attempts: 3,
      execution: "mock",
      output: { body: { done: true } },
    });
    expect(mock.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
    const retrying = events.flatMap((event) =>
      event.type === "step.retrying" ? [[event.attempt, event.nextAttempt, event.error.code]] : [],
    );
    expect(retrying).toEqual([
      [1, 2, "HTTP_STATUS"],
      [2, 3, "HTTP_STATUS"],
    ]);
    expect(events.filter((event) => event.type === "step.started")).toHaveLength(3);
  });

  it("gives up after maxAttempts with the last error", async () => {
    const { engine, mock } = sandbox([retryable]);
    const result = await engine.execute(call({ maxAttempts: 3 }));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "HTTP_STATUS",
      message: "503",
      retryable: true,
      stepId: "call",
    });
    expect(requireStep(result, "call").attempts).toBe(3);
    expect(mock.callCount).toBe(3);
  });

  it("does not retry without a retry policy or when the error is not retryable", async () => {
    const noPolicy = createEngine({
      mode: "sandbox",
      mocks: [{ type: "http.request", responses: [retryable, ok] }],
    });
    const wf = defineWorkflow(
      workflowWith([
        {
          id: "call",
          type: "http.request",
          config: { method: "GET", url: "https://api.example.com" },
        },
      ]),
    );
    expect(requireStep(await noPolicy.execute(wf), "call").attempts).toBe(1);

    const { engine, mock } = sandbox([fatal, ok]);
    const result = await engine.execute(call({ maxAttempts: 3 }));
    expect(result.status).toBe("failed");
    expect(mock.callCount).toBe(1);
  });

  it("retries any error when retryOn is any", async () => {
    const { engine } = sandbox([fatal, ok]);
    const result = await engine.execute(call({ maxAttempts: 2, retryOn: "any" }));
    assertSucceeded(result);
    expect(requireStep(result, "call").attempts).toBe(2);
  });

  it("counts attempts against maxSteps", async () => {
    const engine = createEngine({
      mode: "sandbox",
      random: () => 0,
      limits: { maxSteps: 2 },
      mocks: [{ type: "http.request", responses: [retryable] }],
    });
    const result = await engine.execute(call({ maxAttempts: 5 }));
    expect(result.error).toMatchObject({ code: "LIMIT_EXCEEDED", stepId: "call" });
    expect(requireStep(result, "call").attempts).toBe(2);
  });

  it("stops retrying when cancelled during backoff", async () => {
    const engine = createEngine({
      mode: "sandbox",
      mocks: [{ type: "http.request", responses: [retryable] }],
    });
    const controller = new AbortController();
    const wf = defineWorkflow(
      workflowWith([
        {
          id: "call",
          type: "http.request",
          config: { method: "GET", url: "https://a" },
          retry: { maxAttempts: 5, initialDelayMs: 5000, jitter: false },
        },
        { id: "later", type: "data.transform", config: { value: 1 } },
      ]),
    );
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const result = await engine.execute(wf, {}, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.status).toBe("cancelled");
    expect(result.error).toMatchObject({ code: "CANCELLED", stepId: "call" });
    expect(requireStep(result, "call")).toMatchObject({ status: "cancelled", attempts: 1 });
    expect(requireStep(result, "later").status).toBe("skipped");
  });

  it("does not retry a step timeout unless retryOn is any", async () => {
    let calls = 0;
    const slow: OperationDefinition = {
      type: "slow.op",
      effects: "none",
      execute: ({ signal }) =>
        new Promise((resolve, reject) => {
          calls++;
          const timer = setTimeout(() => resolve(calls), calls === 1 ? 50 : 0);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    };
    const engine = createEngine({ mode: "sandbox", operations: [slow], random: () => 0 });
    const step = { id: "s", type: "slow.op", config: {}, timeoutMs: 10 };
    const noRetry = await engine.execute(
      defineWorkflow(workflowWith([{ ...step, retry: { maxAttempts: 3, initialDelayMs: 0 } }])),
    );
    expect(noRetry.error).toMatchObject({ code: "STEP_TIMEOUT", stepId: "s" });
    expect(calls).toBe(1);
    calls = 0;
    const withRetry = await engine.execute(
      defineWorkflow(
        workflowWith([{ ...step, retry: { maxAttempts: 3, initialDelayMs: 0, retryOn: "any" } }]),
      ),
    );
    assertSucceeded(withRetry);
    expect(requireStep(withRetry, "s")).toMatchObject({ attempts: 2, output: 2 });
  });
});
