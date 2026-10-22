import { describe, expect, it } from "vitest";
import {
  assertSucceeded,
  createEngine,
  defineWorkflow,
  httpResponse,
  requireStep,
  type OperationDefinition,
} from "../src/index.js";
import { transform, workflowWith } from "./helpers.js";

const httpStep = (id: string, url = "https://api.example.com/x") => ({
  id,
  type: "http.request",
  config: { method: "GET", url },
});

describe("sandbox mode", () => {
  it("fails closed when an external operation has no mock", async () => {
    const engine = createEngine({ mode: "sandbox" });
    const result = await engine.execute(defineWorkflow(workflowWith([httpStep("call")])));
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "SANDBOX_MOCK_MISSING",
      stepId: "call",
      details: { type: "http.request" },
    });
    expect(requireStep(result, "call").attempts).toBe(1);
  });

  it("never touches the network even when a mock is missing", async () => {
    let fetched = false;
    const engine = createEngine({
      mode: "sandbox",
      http: {
        fetch: () => {
          fetched = true;
          return Promise.resolve(new Response("{}"));
        },
      },
    });
    await engine.execute(
      defineWorkflow(workflowWith([httpStep("call", "http://localhost:3000/x")])),
    );
    expect(fetched).toBe(false);
  });

  it("treats custom operations as external by default", async () => {
    const op: OperationDefinition = { type: "mail.send", execute: () => ({ sent: true }) };
    const engine = createEngine({ mode: "sandbox", operations: [op] });
    const result = await engine.execute(
      defineWorkflow(workflowWith([{ id: "m", type: "mail.send", config: {} }])),
    );
    expect(result.error?.code).toBe("SANDBOX_MOCK_MISSING");
  });

  it("serves canned responses, records calls and marks steps as mock", async () => {
    const engine = createEngine({ mode: "sandbox" });
    const http = engine.mock("http.request", {
      responses: [
        { output: httpResponse(200, { id: 7 }) },
        { output: httpResponse(200, { id: 8 }) },
      ],
    });
    const wf = defineWorkflow(
      workflowWith([
        httpStep("one"),
        httpStep("two", "https://api.example.com/{{steps.one.body.id}}"),
        httpStep("three"),
      ]),
    );
    const result = await engine.execute(wf);
    assertSucceeded(result);
    expect(requireStep(result, "two").output).toMatchObject({ body: { id: 8 } });
    expect(requireStep(result, "three").output).toMatchObject({ body: { id: 8 } }); // last response repeats
    expect(result.steps.map((step) => step.execution)).toEqual(["mock", "mock", "mock"]);
    expect(http.callCount).toBe(3);
    expect(http.calls.map((call) => [call.sequence, call.stepId, call.attempt])).toEqual([
      [1, "one", 1],
      [2, "two", 1],
      [3, "three", 1],
    ]);
    expect(http.calls[1]?.config).toEqual({ method: "GET", url: "https://api.example.com/7" });
    expect(engine.calls.map((call) => call.stepId)).toEqual(["one", "two", "three"]);
    engine.resetMocks();
    expect(engine.calls).toHaveLength(0);
    expect(http.callCount).toBe(0);
  });

  it("prefers step-scoped mocks and lets a handler compute replies", async () => {
    const engine = createEngine({ mode: "sandbox" });
    engine.mock("http.request", ({ config }) => httpResponse(200, { url: config["url"] ?? null }));
    const scoped = engine.mock("http.request", {
      steps: ["two"],
      responses: [{ output: httpResponse(404, null) }],
    });
    const wf = defineWorkflow(
      workflowWith([httpStep("one", "https://a/1"), httpStep("two", "https://a/2")]),
    );
    const result = await engine.execute(wf);
    assertSucceeded(result);
    expect(requireStep(result, "one").output).toMatchObject({ body: { url: "https://a/1" } });
    expect(requireStep(result, "two").output).toMatchObject({ status: 404 });
    expect(scoped.callCount).toBe(1);
  });

  it("simulates failures with codes and retryability", async () => {
    const engine = createEngine({
      mode: "sandbox",
      mocks: [
        {
          type: "http.request",
          responses: [
            {
              error: {
                code: "HTTP_STATUS",
                message: "boom",
                retryable: false,
                details: { status: 500 },
              },
            },
          ],
        },
      ],
    });
    const result = await engine.execute(defineWorkflow(workflowWith([httpStep("call")])));
    expect(result.error).toEqual({
      code: "HTTP_STATUS",
      message: "boom",
      retryable: false,
      details: { status: 500 },
      stepId: "call",
    });
    expect(requireStep(result, "call").execution).toBe("mock");
  });

  it("delays canned responses for timeout tests and still honours cancellation", async () => {
    const engine = createEngine({
      mode: "sandbox",
      mocks: [{ type: "http.request", delayMs: 30, responses: [{ output: httpResponse(200) }] }],
    });
    const started = Date.now();
    const ok = await engine.execute(defineWorkflow(workflowWith([httpStep("call")])));
    assertSucceeded(ok);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);

    const slow = await engine.execute(
      defineWorkflow(workflowWith([{ ...httpStep("call"), timeoutMs: 5 }])),
    );
    expect(slow.error).toMatchObject({ code: "STEP_TIMEOUT", stepId: "call" });
  });

  it("rejects mocks in live mode and refuses a mock-less engine from silently going live", () => {
    const live = createEngine({ mode: "live" });
    expect(() => live.mock("http.request", { responses: [{ output: 1 }] })).toThrow(/sandbox/);
    expect(() =>
      createEngine({ mode: "live", mocks: [{ type: "x", responses: [{ output: 1 }] }] }),
    ).toThrow(/sandbox/);
    expect(() => createEngine({ mode: "nope" as never })).toThrow(/mode/);
  });

  it("lets pure operations run for real in sandbox mode", async () => {
    const engine = createEngine({ mode: "sandbox" });
    const result = await engine.execute(
      defineWorkflow(workflowWith([transform("a", { x: "{{input.x}}" })])),
      { x: 1 },
    );
    assertSucceeded(result);
    expect(requireStep(result, "a").execution).toBe("live");
  });

  it("runs an explicitly allowed external operation live with the injected transport", async () => {
    const seen: string[] = [];
    const engine = createEngine({
      mode: "sandbox",
      sandbox: { allowLive: ["http.request"] },
      http: {
        urlPolicy: { allow: ["http://localhost:3000"] },
        fetch: (url) => {
          seen.push(url);
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), {
              headers: { "content-type": "application/json" },
            }),
          );
        },
      },
    });
    const result = await engine.execute(
      defineWorkflow(workflowWith([httpStep("local", "http://localhost:3000/health")])),
    );
    assertSucceeded(result);
    expect(seen).toEqual(["http://localhost:3000/health"]);
    expect(requireStep(result, "local")).toMatchObject({
      execution: "live",
      output: { status: 200, body: { ok: true } },
    });
  });
});
