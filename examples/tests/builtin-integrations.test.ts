/** Workflows using the built-in HubSpot and OpenAI integrations, run in the sandbox with mocks. */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSucceeded, createEngine, loadMocksFile, loadWorkflowFile } from "../../src/index.js";

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

describe("hubspot-upsert-contact", () => {
  const input = { email: "ada@example.com", firstname: "Ada" };

  it("updates the contact when the search finds one", async () => {
    const workflow = await loadWorkflowFile(here("../workflows/hubspot-upsert-contact.json"));
    const { mocks } = await loadMocksFile(here("../fixtures/hubspot-upsert-contact.mocks.json"));
    const engine = createEngine({ mode: "sandbox", mocks });
    const result = await engine.execute(workflow, input);
    assertSucceeded(result);
    expect(result.output).toEqual({ action: "updated", id: "501" });
    expect(engine.calls.map((call) => call.stepId)).toEqual(["find-contact", "update-contact"]);
    expect(engine.calls[1]?.config["input"]).toEqual({
      contactId: "501",
      properties: { firstname: "Ada" },
    });
  });

  it("creates the contact when the search finds none", async () => {
    const workflow = await loadWorkflowFile(here("../workflows/hubspot-upsert-contact.json"));
    const { mocks } = await loadMocksFile(here("../fixtures/hubspot-upsert-contact.mocks.json"));
    const engine = createEngine({ mode: "sandbox", mocks });
    engine.mock("integration.call", {
      steps: ["find-contact"],
      responses: [{ output: { total: 0, results: [] } }],
    });
    const result = await engine.execute(workflow, input);
    assertSucceeded(result);
    expect(result.output).toEqual({ action: "created", id: "777" });
  });
});

describe("openai-summarize", () => {
  it("returns the summary from the chat completion", async () => {
    const workflow = await loadWorkflowFile(here("../workflows/openai-summarize.json"));
    const { mocks } = await loadMocksFile(here("../fixtures/openai-summarize.mocks.json"));
    const engine = createEngine({ mode: "sandbox", mocks });
    const result = await engine.execute(workflow, { text: "Some long text." });
    assertSucceeded(result);
    expect(result.output).toEqual({
      summary: "It runs JSON workflows safely.",
      finishReason: "stop",
    });
    expect(engine.calls[0]?.config["input"]).toMatchObject({
      model: "gpt-4o-mini",
      temperature: 0,
    });
  });
});
