import { describe, expect, it } from "vitest";
import {
  assertSucceeded,
  createEngine,
  defineWorkflow,
  getBuiltinManifests,
  requireStep,
  type FetchLike,
  type JsonValue,
} from "../src/index.js";
import { workflowWith } from "./helpers.js";

const SECRET = "pat-na1-super-secret";

interface Captured {
  url: string;
  init: RequestInit;
}

function bodyOf(request: Captured | undefined): unknown {
  const body = request?.init.body;
  return JSON.parse(typeof body === "string" ? body : "null");
}

/** Sandbox engine that allows integration.call live but only against this fake fetch (no network). */
function setup(responseBody: JsonValue, status = 200) {
  const captured: Captured[] = [];
  const fetch: FetchLike = (url, init) => {
    captured.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const engine = createEngine({
    mode: "sandbox",
    sandbox: { allowLive: ["integration.call"] },
    http: { fetch },
    integrations: { credentials: { token: SECRET } },
  });
  return { engine, captured };
}

async function run(
  engine: ReturnType<typeof setup>["engine"],
  provider: string,
  action: string,
  input: JsonValue,
) {
  const result = await engine.execute(
    defineWorkflow(
      workflowWith([
        {
          id: "c",
          type: "integration.call",
          config: { provider, action, credentials: "token", input },
        },
      ]),
    ),
    {},
  );
  return result;
}

describe("built-in integrations", () => {
  it("ships hubspot and openai", () => {
    expect(getBuiltinManifests().map((m) => m.provider)).toEqual(["hubspot", "openai"]);
  });

  describe("hubspot", () => {
    it("create-contact", async () => {
      const { engine, captured } = setup(
        { id: "1", properties: { email: "a@b.c" }, createdAt: "c", updatedAt: "u" },
        201,
      );
      const result = await run(engine, "hubspot", "create-contact", {
        properties: { email: "a@b.c", firstname: "Ada" },
      });
      assertSucceeded(result);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts");
      expect(captured[0]?.init.method).toBe("POST");
      expect(new Headers(captured[0]?.init.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
      expect(bodyOf(captured[0])).toEqual({
        properties: { email: "a@b.c", firstname: "Ada" },
      });
      expect(requireStep(result, "c").output).toEqual({
        id: "1",
        properties: { email: "a@b.c" },
        createdAt: "c",
        updatedAt: "u",
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("update-contact encodes the id into the path", async () => {
      const { engine, captured } = setup({ id: "5/x", properties: {}, updatedAt: "u" });
      const result = await run(engine, "hubspot", "update-contact", {
        contactId: "5/x",
        properties: { phone: "123" },
      });
      assertSucceeded(result);
      expect(captured[0]?.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts/5%2Fx");
      expect(captured[0]?.init.method).toBe("PATCH");
      expect(bodyOf(captured[0])).toEqual({ properties: { phone: "123" } });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("search-contacts defaults the limit and maps results", async () => {
      const { engine, captured } = setup({ total: 1, results: [{ id: "9" }] });
      const result = await run(engine, "hubspot", "search-contacts", { query: "ada" });
      assertSucceeded(result);
      expect(captured[0]?.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts/search");
      expect(captured[0]?.init.method).toBe("POST");
      expect(bodyOf(captured[0])).toEqual({ query: "ada", limit: 10 });
      expect(requireStep(result, "c").output).toEqual({ total: 1, results: [{ id: "9" }] });
    });

    it("rejects invalid input before any request", async () => {
      const { engine, captured } = setup({});
      for (const [action, input] of [
        ["create-contact", { properties: {} }],
        ["update-contact", { properties: { a: "b" } }],
        ["search-contacts", { query: "x", limit: 500 }],
      ] as const) {
        const result = await run(engine, "hubspot", action, input);
        expect(result.error?.code).toBe("INTEGRATION_INPUT_INVALID");
      }
      expect(captured).toHaveLength(0);
    });
  });

  describe("openai", () => {
    it("chat-completion", async () => {
      const { engine, captured } = setup({
        id: "chatcmpl-1",
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { total_tokens: 3 },
      });
      const result = await run(engine, "openai", "chat-completion", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      });
      assertSucceeded(result);
      expect(captured[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
      expect(captured[0]?.init.method).toBe("POST");
      expect(new Headers(captured[0]?.init.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
      expect(bodyOf(captured[0])).toEqual({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
        temperature: 1,
      });
      expect(requireStep(result, "c").output).toEqual({
        id: "chatcmpl-1",
        model: "gpt-4o-mini",
        content: "hi",
        finishReason: "stop",
        usage: { total_tokens: 3 },
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("rejects an unknown role and is refused without a mock in sandbox", async () => {
      const { engine, captured } = setup({});
      const bad = await run(engine, "openai", "chat-completion", {
        model: "m",
        messages: [{ role: "robot", content: "x" }],
      });
      expect(bad.error?.code).toBe("INTEGRATION_INPUT_INVALID");
      const strict = createEngine({ mode: "sandbox" });
      const refused = await run(strict, "openai", "chat-completion", {
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });
      expect(refused.error?.code).toBe("SANDBOX_MOCK_MISSING");
      expect(captured).toHaveLength(0);
    });
  });
});
