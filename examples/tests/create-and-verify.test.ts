/**
 * A complete automated backend integration test: the workflow JSON and the mock replies live
 * in files, so the same scenario runs from the CLI (`json-flow test ...`) and from this test.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertSucceeded,
  createEngine,
  loadMocksFile,
  loadWorkflowFile,
  requireStep,
} from "../../src/index.js";

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

describe("create-and-verify-resource", () => {
  it("creates the resource, verifies it and reports a summary", async () => {
    const workflow = await loadWorkflowFile(here("../workflows/create-and-verify-resource.json"));
    const mocks = await loadMocksFile(here("../fixtures/create-and-verify.mocks.json"));
    const engine = createEngine({ mode: "sandbox", mocks: mocks.mocks });

    const result = await engine.execute(workflow, {
      baseUrl: "http://localhost:3000",
      resourceName: "integration-widget",
      apiToken: "t",
    });

    assertSucceeded(result);
    expect(result.output).toEqual({
      resourceId: "res_123",
      createdStatus: 201,
      name: "integration-widget",
    });
    // Which calls were made, in order, with what resolved config:
    expect(
      engine.calls.map((call) => [call.stepId, call.config["method"], call.config["url"]]),
    ).toEqual([
      ["create-resource", "POST", "http://localhost:3000/resources"],
      ["verify-resource", "GET", "http://localhost:3000/resources/res_123"],
    ]);
    expect(engine.calls[0]?.config["body"]).toEqual({
      name: "integration-widget",
      tags: ["integration-test"],
      priority: 2,
      archived: false,
    });
    expect(engine.calls[0]?.idempotencyKey).toBe("create-integration-widget");
    expect(result.steps.map((step) => [step.id, step.status, step.execution])).toEqual([
      ["create-resource", "succeeded", "mock"],
      ["verify-resource", "succeeded", "mock"],
      ["check-persisted-state", "succeeded", "live"],
      ["summary", "succeeded", "live"],
    ]);
  });

  it("retries the create call when the API answers 503 once", async () => {
    const workflow = await loadWorkflowFile(here("../workflows/create-and-verify-resource.json"));
    const mocks = await loadMocksFile(here("../fixtures/create-and-verify.flaky.mocks.json"));
    const engine = createEngine({ mode: "sandbox", mocks: mocks.mocks, random: () => 0 });
    const result = await engine.execute(workflow, {
      baseUrl: "http://localhost:3000",
      resourceName: "integration-widget",
      apiToken: "t",
    });
    assertSucceeded(result);
    expect(requireStep(result, "create-resource").attempts).toBe(2);
  });

  it("fails the assertion when the persisted state differs", async () => {
    const workflow = await loadWorkflowFile(here("../workflows/create-and-verify-resource.json"));
    const engine = createEngine({ mode: "sandbox" });
    engine.mock("http.request", {
      steps: ["create-resource"],
      responses: [
        { output: { status: 201, statusText: "", headers: {}, body: { id: "res_1" }, url: "" } },
      ],
    });
    engine.mock("http.request", {
      steps: ["verify-resource"],
      responses: [
        {
          output: {
            status: 200,
            statusText: "",
            headers: {},
            body: { id: "res_1", name: "something-else", archived: false },
            url: "",
          },
        },
      ],
    });
    const result = await engine.execute(workflow, {
      baseUrl: "http://localhost:3000",
      resourceName: "integration-widget",
      apiToken: "t",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "ASSERTION_FAILED",
      stepId: "check-persisted-state",
      message: "resource res_1 was not persisted as sent",
    });
    expect(requireStep(result, "summary").status).toBe("skipped");
  });

  it("rejects input that does not match the schema before calling anything", async () => {
    const workflow = await loadWorkflowFile(here("../workflows/create-and-verify-resource.json"));
    const engine = createEngine({ mode: "sandbox" });
    const http = engine.mock("http.request", {
      responses: [{ output: { status: 201, statusText: "", headers: {}, body: {}, url: "" } }],
    });
    const result = await engine.execute(workflow, { baseUrl: "http://localhost:3000" });
    expect(result.error?.code).toBe("INPUT_INVALID");
    expect(http.callCount).toBe(0);
  });
});

describe("notify-on-high-value-order", () => {
  it("notifies above the threshold and stays quiet below it", async () => {
    const workflow = await loadWorkflowFile(here("../workflows/notify-on-high-value-order.json"));
    const mocks = await loadMocksFile(here("../fixtures/notify.mocks.json"));
    const engine = createEngine({ mode: "sandbox", mocks: mocks.mocks });

    const high = await engine.execute(workflow, {
      baseUrl: "http://localhost:3000",
      orderId: "ord_42",
      threshold: 500,
    });
    assertSucceeded(high);
    expect(high.output).toEqual({
      orderId: "ord_42",
      decision: { notified: true, messageId: "msg_1" },
    });

    engine.resetMocks();
    const low = await engine.execute(workflow, {
      baseUrl: "http://localhost:3000",
      orderId: "ord_42",
      threshold: 5000,
    });
    assertSucceeded(low);
    expect(low.output).toEqual({ orderId: "ord_42", decision: { notified: false } });
    expect(engine.calls.map((call) => call.stepId)).toEqual(["fetch-order"]);
  });
});
