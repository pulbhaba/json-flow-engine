import { describe, expect, it } from "vitest";
import {
  createEngine,
  defineWorkflow,
  requireStep,
  type OperationDefinition,
} from "../src/index.js";
import { transform, workflowWith } from "./helpers.js";

/** Resolves after `config.ms`, or rejects when the signal aborts (a cooperative operation). */
const wait: OperationDefinition<{ ms: number }> = {
  type: "test.wait",
  effects: "none",
  configSchema: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
  execute: ({ config, signal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ waited: config.ms }), config.ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted by signal"));
        },
        { once: true },
      );
    }),
};

/** Ignores the signal entirely. */
const stubborn: OperationDefinition<{ ms: number }> = {
  type: "test.stubborn",
  effects: "none",
  execute: ({ config }) => new Promise((resolve) => setTimeout(() => resolve("late"), config.ms)),
};

const engine = () => createEngine({ mode: "sandbox", operations: [wait, stubborn] });

describe("timeouts and cancellation", () => {
  it("fails a step that exceeds its timeout and aborts its signal", async () => {
    const wf = defineWorkflow(
      workflowWith([
        { id: "w", type: "test.wait", config: { ms: 500 }, timeoutMs: 20 },
        transform("after", 1),
      ]),
    );
    const started = Date.now();
    const result = await engine().execute(wf);
    expect(Date.now() - started).toBeLessThan(400);
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "STEP_TIMEOUT",
      message: 'Step "w" timed out after 20ms',
      retryable: false,
      details: { stepId: "w", timeoutMs: 20 },
      stepId: "w",
    });
    expect(requireStep(result, "after").status).toBe("skipped");
  });

  it("returns on time even when the operation ignores the signal", async () => {
    const wf = defineWorkflow(
      workflowWith([{ id: "s", type: "test.stubborn", config: { ms: 300 }, timeoutMs: 20 }]),
    );
    const started = Date.now();
    const result = await engine().execute(wf);
    expect(Date.now() - started).toBeLessThan(250);
    expect(result.error?.code).toBe("STEP_TIMEOUT");
  });

  it("applies the execution timeout from execute options, the workflow, and the engine limit", async () => {
    const wf = defineWorkflow(
      workflowWith([{ id: "w", type: "test.wait", config: { ms: 300 } }, transform("after", 1)]),
    );
    const result = await engine().execute(wf, {}, { timeoutMs: 20 });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "EXECUTION_TIMEOUT", stepId: "w" });
    expect(requireStep(result, "w").status).toBe("cancelled");

    const fromWorkflow = defineWorkflow(
      workflowWith([{ id: "w", type: "test.wait", config: { ms: 300 } }], {
        execution: { timeoutMs: 20 },
      }),
    );
    expect((await engine().execute(fromWorkflow)).error?.code).toBe("EXECUTION_TIMEOUT");

    const capped = createEngine({
      mode: "sandbox",
      operations: [wait],
      limits: { maxExecutionMs: 20 },
    });
    expect((await capped.execute(wf, {}, { timeoutMs: 10_000 })).error?.code).toBe(
      "EXECUTION_TIMEOUT",
    );
  });

  it("cancels on an external signal and reports what was running", async () => {
    const wf = defineWorkflow(
      workflowWith([
        transform("a", 1),
        { id: "w", type: "test.wait", config: { ms: 300 } },
        transform("z", 1),
      ]),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);
    const result = await engine().execute(wf, {}, { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.error).toMatchObject({ code: "CANCELLED", stepId: "w" });
    expect(result.steps.map((step) => step.status)).toEqual(["succeeded", "cancelled", "skipped"]);
  });

  it("does nothing when the signal is already aborted", async () => {
    const wf = defineWorkflow(workflowWith([transform("a", 1)]));
    const result = await engine().execute(wf, {}, { signal: AbortSignal.abort() });
    expect(result.status).toBe("cancelled");
    expect(result.steps.map((step) => [step.status, step.attempts])).toEqual([["skipped", 0]]);
  });

  it("refuses execution after dispose and calls operation dispose hooks", async () => {
    let disposed = 0;
    const op: OperationDefinition = {
      type: "x.y",
      effects: "none",
      execute: () => 1,
      dispose: () => {
        disposed++;
      },
    };
    const e = createEngine({ mode: "sandbox", operations: [op] });
    await e.dispose();
    expect(disposed).toBe(1);
    await expect(e.execute(defineWorkflow(workflowWith([transform("a", 1)])))).rejects.toThrow(
      /disposed/,
    );
  });
});
