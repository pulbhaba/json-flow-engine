import { describe, expect, it } from "vitest";
import {
  assertSucceeded,
  createEngine,
  defineWorkflow,
  requireStep,
  WorkflowValidationError,
  type ExecutionEvent,
  type OperationDefinition,
} from "../src/index.js";
import { transform, workflowWith } from "./helpers.js";

const engine = () => createEngine({ mode: "sandbox" });

describe("engine.execute", () => {
  it("runs steps in order and exposes previous outputs", async () => {
    const workflow = defineWorkflow(
      workflowWith(
        [
          transform("first", { id: "{{input.userId}}", n: "{{input.n}}" }),
          transform("second", {
            fromFirst: "{{steps.first.id}}",
            doubled: "{{steps.first.n}}",
            base: "{{constants.base}}",
          }),
        ],
        {
          constants: { base: "B" },
          output: { final: "{{steps.second}}", all: "{{steps.first.n}}" },
        },
      ),
    );
    const result = await engine().execute(workflow, { userId: "u1", n: 2 });
    assertSucceeded(result);
    expect(result.output).toEqual({ final: { fromFirst: "u1", doubled: 2, base: "B" }, all: 2 });
    expect(
      result.steps.map((step) => [step.id, step.status, step.execution, step.attempts]),
    ).toEqual([
      ["first", "succeeded", "live", 1],
      ["second", "succeeded", "live", 1],
    ]);
    expect(result.workflowId).toBe("test-workflow");
    expect(result.workflowVersion).toBe(1);
    expect(result.mode).toBe("sandbox");
    expect(result.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    expect(requireStep(result, "first").durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws before running anything when the workflow is invalid for this engine", async () => {
    const workflow = defineWorkflow(
      workflowWith([{ id: "a", type: "custom.op", config: {} }, transform("b", 1)]),
    );
    await expect(engine().execute(workflow)).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it("fails with INPUT_INVALID when input violates inputSchema or is not JSON", async () => {
    const workflow = defineWorkflow(
      workflowWith([transform("a", "{{input.n}}")], {
        inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      }),
    );
    const result = await engine().execute(workflow, { n: "x" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "INPUT_INVALID" });
    expect(result.error?.message).toContain("/n");
    expect(result.steps[0]?.status).toBe("skipped");

    const notJson = await engine().execute(workflow, { n: 1, when: new Date() } as never);
    expect(notJson.error).toMatchObject({ code: "INPUT_INVALID" });
    expect(notJson.error?.message).toContain("/when");
  });

  it("stops at the first failing step and reports it", async () => {
    const workflow = defineWorkflow(
      workflowWith([transform("a", 1), transform("b", "{{input.missing}}"), transform("c", 3)]),
    );
    const result = await engine().execute(workflow, {});
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "EXPRESSION_UNRESOLVED", stepId: "b" });
    expect(result.steps.map((step) => step.status)).toEqual(["succeeded", "failed", "skipped"]);
    expect(requireStep(result, "c").skipReason).toBe("not-reached");
    expect(result.output).toBeNull();
  });

  it("continues past a failed step when onError is continue and exposes null", async () => {
    const workflow = defineWorkflow(
      workflowWith([
        transform("a", "{{input.missing}}", { onError: "continue" }),
        transform("b", '{{steps.a ?? "fallback"}}'),
      ]),
    );
    const result = await engine().execute(workflow, {});
    assertSucceeded(result);
    expect(requireStep(result, "a")).toMatchObject({
      status: "failed",
      error: { code: "EXPRESSION_UNRESOLVED" },
    });
    expect(requireStep(result, "b").output).toBe("fallback");
  });

  it("reports custom operation failures with their own codes and sanitised details", async () => {
    const op: OperationDefinition<{ fail: boolean }> = {
      type: "billing.charge",
      effects: "none",
      configSchema: {
        type: "object",
        properties: { fail: { type: "boolean" } },
        required: ["fail"],
      },
      execute({ config }) {
        if (config.fail) {
          const error = new Error("card declined");
          throw error;
        }
        return { charged: true };
      },
    };
    const e = createEngine({ mode: "sandbox", operations: [op] });
    const workflow = defineWorkflow(
      workflowWith([{ id: "charge", type: "billing.charge", config: { fail: "{{input.fail}}" } }]),
    );
    const failed = await e.execute(workflow, { fail: true });
    expect(failed.error).toEqual({
      code: "OPERATION_FAILED",
      message: "card declined",
      retryable: false,
      details: { errorName: "Error" },
      stepId: "charge",
    });
    const ok = await e.execute(workflow, { fail: false });
    expect(requireStep(ok, "charge").output).toEqual({ charged: true });
  });

  it("validates the resolved config at runtime", async () => {
    const workflow = defineWorkflow(
      workflowWith([
        {
          id: "h",
          type: "http.request",
          config: { method: "{{input.m}}", url: "https://example.com" },
        },
      ]),
    );
    const result = await engine().execute(workflow, { m: "YEET" });
    expect(result.error).toMatchObject({
      code: "OPERATION_CONFIG_INVALID",
      stepId: "h",
      path: "/steps/h/config",
    });
    expect(result.error?.message).toContain("method");
  });

  it("rejects non-JSON operation output", async () => {
    const op: OperationDefinition = {
      type: "bad.output",
      effects: "none",
      execute: () => ({ when: new Date() }) as never,
    };
    const e = createEngine({ mode: "sandbox", operations: [op] });
    const result = await e.execute(
      defineWorkflow(workflowWith([{ id: "x", type: "bad.output", config: {} }])),
    );
    expect(result.error).toMatchObject({ code: "OPERATION_OUTPUT_INVALID", stepId: "x" });
  });

  it("freezes input and step outputs so operations cannot mutate shared state", async () => {
    const op: OperationDefinition = {
      type: "mutator",
      effects: "none",
      execute({ input, steps }) {
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(steps["a"])).toBe(true);
        return 1;
      },
    };
    const e = createEngine({ mode: "sandbox", operations: [op] });
    const result = await e.execute(
      defineWorkflow(
        workflowWith([transform("a", { x: 1 }), { id: "m", type: "mutator", config: {} }]),
      ),
      { k: [1] },
    );
    assertSucceeded(result);
  });

  it("emits events and log lines without payloads", async () => {
    const events: ExecutionEvent[] = [];
    const logs: string[] = [];
    const e = createEngine({
      mode: "sandbox",
      onEvent: (event) => events.push(event),
      logger: {
        debug: () => {},
        info: (m, f) => logs.push(JSON.stringify({ m, f })),
        warn: () => {},
        error: () => {},
      },
    });
    await e.execute(defineWorkflow(workflowWith([transform("a", { secret: "hunter2" })])), {
      token: "tok",
    });
    expect(events.map((event) => event.type)).toEqual([
      "execution.started",
      "step.started",
      "step.finished",
      "execution.finished",
    ]);
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(logs.join("\n")).not.toContain("hunter2");
    expect(logs.join("\n")).not.toContain('tok"');
  });

  it("enforces maxSteps", async () => {
    const e = createEngine({ mode: "sandbox", limits: { maxSteps: 2 } });
    const result = await e.execute(
      defineWorkflow(workflowWith([transform("a", 1), transform("b", 2), transform("c", 3)])),
    );
    expect(result.error).toMatchObject({ code: "LIMIT_EXCEEDED", stepId: "c" });
  });

  it("rejects duplicate operation registration", () => {
    const e = engine();
    expect(() => e.registerOperation({ type: "http.request", execute: () => 1 })).toThrow(
      /already registered/,
    );
  });
});

describe("control.condition and control.assert", () => {
  const branching = workflowWith([
    transform("user", {
      active: "{{input.active}}",
      age: "{{input.age}}",
      email: "{{input.email ?? null}}",
    }),
    {
      id: "route",
      type: "control.condition",
      config: {
        if: {
          all: [
            "{{steps.user.active}}",
            { greaterThan: ["{{steps.user.age}}", 17] },
            { not: { defined: "{{steps.user.email}}" } },
          ],
        },
        then: [transform("adult", { kind: "adult" })],
        else: [
          transform("other", { kind: "other" }),
          transform("other2", { prev: "{{steps.other.kind}}" }),
        ],
      },
    },
    transform("after", { branch: "{{steps.route.branch}}", result: "{{steps.route.output}}" }),
  ]);

  it("takes the then branch and skips the other", async () => {
    const result = await engine().execute(defineWorkflow(branching), { active: true, age: 30 });
    assertSucceeded(result);
    expect(requireStep(result, "after").output).toEqual({
      branch: "then",
      result: { kind: "adult" },
    });
    expect(
      result.steps.map((step) => [
        step.id,
        step.status,
        step.parentId,
        step.branch,
        step.skipReason,
      ]),
    ).toEqual([
      ["user", "succeeded", undefined, undefined, undefined],
      ["route", "succeeded", undefined, undefined, undefined],
      ["adult", "succeeded", "route", "then", undefined],
      ["other", "skipped", "route", "else", "branch-not-taken"],
      ["other2", "skipped", "route", "else", "branch-not-taken"],
      ["after", "succeeded", undefined, undefined, undefined],
    ]);
  });

  it("takes the else branch", async () => {
    const result = await engine().execute(defineWorkflow(branching), {
      active: true,
      age: 30,
      email: "x@y",
    });
    assertSucceeded(result);
    expect(requireStep(result, "after").output).toEqual({
      branch: "else",
      result: { prev: "other" },
    });
  });

  it("fails the condition step when the condition is not boolean", async () => {
    const wf = defineWorkflow(
      workflowWith([
        { id: "c", type: "control.condition", config: { if: "{{input.x}}", then: [] } },
      ]),
    );
    const result = await engine().execute(wf, { x: "yes" });
    expect(result.error).toMatchObject({ code: "CONDITION_INVALID", stepId: "c" });
  });

  it("propagates a failure inside a branch to the condition step", async () => {
    const wf = defineWorkflow(
      workflowWith([
        {
          id: "c",
          type: "control.condition",
          config: { if: true, then: [transform("t", "{{input.nope}}")] },
        },
        transform("z", 1),
      ]),
    );
    const result = await engine().execute(wf, {});
    expect(result.error).toMatchObject({ code: "EXPRESSION_UNRESOLVED", stepId: "t" });
    expect(requireStep(result, "c").status).toBe("failed");
    expect(requireStep(result, "z").status).toBe("skipped");
  });

  it("supports equals with typed operands and lessThan", async () => {
    const wf = defineWorkflow(
      workflowWith([
        transform("s", { status: 201, tags: ["a"] }),
        {
          id: "ok",
          type: "control.assert",
          config: {
            condition: {
              all: [
                { equals: ["{{steps.s.status}}", 201] },
                { equals: ["{{steps.s.tags}}", ["a"]] },
                { lessThan: [1, "{{steps.s.status}}"] },
                { any: [false, true] },
              ],
            },
          },
        },
        {
          id: "bad",
          type: "control.assert",
          config: {
            condition: { equals: ["{{steps.s.status}}", "201"] },
            message: "status {{steps.s.status}} is a number",
          },
        },
      ]),
    );
    const result = await engine().execute(wf);
    expect(requireStep(result, "ok").output).toEqual({ passed: true });
    expect(result.error).toEqual({
      code: "ASSERTION_FAILED",
      message: "status 201 is a number",
      retryable: false,
      details: { condition: '{"equals":["{{steps.s.status}}","201"]}' },
      stepId: "bad",
    });
  });
});
