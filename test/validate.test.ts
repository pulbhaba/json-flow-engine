import { describe, expect, it } from "vitest";
import {
  createEngine,
  defineWorkflow,
  validateWorkflow,
  WorkflowValidationError,
} from "../src/index.js";
import { transform, workflowWith } from "./helpers.js";

function issuesOf(definition: unknown, engine = createEngine({ mode: "sandbox" })) {
  const result = engine.validate(definition);
  return result.ok ? [] : result.issues;
}

describe("validateWorkflow", () => {
  it("accepts a minimal workflow and brands it", () => {
    const result = validateWorkflow(workflowWith([transform("a", 1)]));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(JSON.parse(JSON.stringify(result.workflow))).toEqual(
        workflowWith([transform("a", 1)]),
      );
  });

  it("reports structural problems with JSON pointers", () => {
    const issues = issuesOf({
      id: "bad id!",
      version: 0,
      steps: [{ id: "x", type: "data.transform" }],
      extra: true,
    });
    expect(issues.map((issue) => issue.path).sort()).toEqual(["", "/id", "/steps/0", "/version"]);
    expect(issues.find((issue) => issue.path === "")?.message).toContain(
      'unknown property "extra"',
    );
    expect(issues.find((issue) => issue.path === "/steps/0")?.message).toContain("config");
  });

  it("rejects non-objects, empty step lists and unsupported schema versions", () => {
    expect(issuesOf(null)).not.toHaveLength(0);
    expect(issuesOf(workflowWith([]))).toHaveLength(1);
    expect(issuesOf({ ...workflowWith([transform("a", 1)]), schemaVersion: 2 })[0]?.path).toBe(
      "/schemaVersion",
    );
  });

  it("rejects duplicate step ids, including nested ones", () => {
    const issues = issuesOf(
      workflowWith([
        transform("a", 1),
        { id: "c", type: "control.condition", config: { if: true, then: [transform("a", 2)] } },
      ]),
    );
    expect(issues).toEqual([
      {
        code: "STEP_ID_DUPLICATE",
        path: "/steps/1/config/then/0/id",
        message: 'duplicate step id "a" (also at /steps/0/id)',
      },
    ]);
  });

  it("rejects unknown operations only when a registry is present", () => {
    const definition = workflowWith([{ id: "a", type: "nope.op", config: {} }]);
    expect(validateWorkflow(definition).ok).toBe(true);
    const issues = issuesOf(definition);
    expect(issues[0]).toMatchObject({ code: "OPERATION_UNKNOWN", path: "/steps/0/type" });
    expect(issues[0]?.message).toContain("http.request");
  });

  it("rejects invalid built-in configs but tolerates templates where types differ", () => {
    const issues = issuesOf(
      workflowWith([
        {
          id: "a",
          type: "http.request",
          config: { method: "FETCH", url: "{{input.url}}", timeoutMs: "{{input.t}}", bogus: 1 },
        },
      ]),
    );
    expect(issues.map((issue) => issue.path).sort()).toEqual([
      "/steps/0/config",
      "/steps/0/config/method",
    ]);
    expect(issues.every((issue) => issue.code === "OPERATION_CONFIG_INVALID")).toBe(true);
  });

  it("reports expression syntax errors in configs", () => {
    const issues = issuesOf(workflowWith([transform("a", { x: "{{input.a +}}" })]));
    expect(issues[0]).toMatchObject({
      code: "EXPRESSION_INVALID",
      path: "/steps/0/config/value/x",
    });
  });

  it("rejects references to later steps, unknown steps and self", () => {
    const issues = issuesOf(
      workflowWith([
        transform("a", "{{steps.b.x}}"),
        transform("b", "{{steps.b.x}}"),
        transform("c", "{{steps.zzz.x}}"),
      ]),
    );
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["STEP_REFERENCE_INVALID", "/steps/0/config/value"],
      ["STEP_REFERENCE_INVALID", "/steps/1/config/value"],
      ["STEP_REFERENCE_INVALID", "/steps/2/config/value"],
    ]);
    expect(issues[2]?.message).toContain("unknown step");
  });

  it("only lets branch steps see what is guaranteed to have run", () => {
    const definition = workflowWith([
      transform("before", 1),
      {
        id: "cond",
        type: "control.condition",
        config: {
          if: "{{input.flag}}",
          then: [transform("t1", "{{steps.before}}"), transform("t2", "{{steps.t1}}")],
          else: [transform("e1", "{{steps.t1}}")],
        },
      },
      transform("after-bad", "{{steps.t2}}"),
      transform("after-ok", "{{steps.cond.output}}"),
      transform("after-ok-2", "{{steps.cond.branch}}"),
    ]);
    const issues = issuesOf(definition);
    expect(issues.map((issue) => issue.path)).toEqual([
      "/steps/1/config/else/0/config/value",
      "/steps/2/config/value",
    ]);
    expect(issues[0]?.message).toContain("not guaranteed to have run");
  });

  it("rejects unknown constants and disallowed input properties", () => {
    const issues = issuesOf(
      workflowWith(
        [
          transform("a", [
            "{{constants.missing}}",
            "{{input.nope}}",
            "{{input.ok}}",
            "{{constants.present}}",
          ]),
        ],
        {
          constants: { present: 1 },
          inputSchema: {
            type: "object",
            properties: { ok: { type: "string" } },
            additionalProperties: false,
          },
        },
      ),
    );
    expect(issues.map((issue) => issue.code)).toEqual([
      "CONSTANT_UNKNOWN",
      "INPUT_REFERENCE_INVALID",
    ]);
  });

  it("rejects an invalid inputSchema", () => {
    const issues = issuesOf(
      workflowWith([transform("a", 1)], {
        inputSchema: { type: "object", properties: { x: { type: "nonsense" } } },
      }),
    );
    expect(issues[0]).toMatchObject({ code: "SCHEMA_INVALID", path: "/inputSchema" });
  });

  it("bounds retry settings by the engine limits", () => {
    const issues = issuesOf(
      workflowWith([transform("a", 1, { retry: { maxAttempts: 50, maxDelayMs: 999_999 } })]),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      "/steps/0/retry/maxAttempts",
      "/steps/0/retry/maxDelayMs",
    ]);
  });

  it("rejects retry and timeout on condition steps", () => {
    const issues = issuesOf(
      workflowWith([
        { id: "c", type: "control.condition", timeoutMs: 5, config: { if: true, then: [] } },
      ]),
    );
    expect(issues[0]?.message).toContain("control.condition steps cannot have retry or timeoutMs");
  });

  it("checks output references against top-level steps only", () => {
    const issues = issuesOf(
      workflowWith(
        [{ id: "c", type: "control.condition", config: { if: true, then: [transform("t", 1)] } }],
        {
          output: { a: "{{steps.t}}", b: "{{steps.c.output}}" },
        },
      ),
    );
    expect(issues.map((issue) => issue.path)).toEqual(["/output/a"]);
  });

  it("defineWorkflow throws a WorkflowValidationError listing issues", () => {
    expect(() => defineWorkflow(workflowWith([transform("a", "{{steps.nope}}")]))).toThrow(
      WorkflowValidationError,
    );
    try {
      defineWorkflow(workflowWith([transform("a", "{{steps.nope}}")]));
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      if (error instanceof WorkflowValidationError) {
        expect(error.code).toBe("WORKFLOW_INVALID");
        expect(error.issues[0]?.code).toBe("STEP_REFERENCE_INVALID");
        expect(error.message).toContain("/steps/0/config/value");
      }
    }
  });
});
