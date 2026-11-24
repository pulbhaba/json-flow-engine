import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSucceeded,
  createEngine,
  defineWorkflow,
  loadUserIntegrations,
  requireStep,
  type EngineOptions,
  type ExecutionEvent,
  type FetchLike,
  type IntegrationManifest,
  type JsonValue,
  type LoadedIntegration,
} from "../src/index.js";
import { workflowWith } from "./helpers.js";

const SECRET = "sk-super-secret-token-123";

function manifest(extra: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    provider: "acme",
    baseUrl: "https://api.acme.test/v1",
    allowedHosts: ["api.acme.test"],
    auth: { type: "bearer" },
    actions: {
      "create-contact": {
        inputSchema: {
          type: "object",
          properties: {
            email: { type: "string" },
            tag: { type: "string" },
            id: { type: "string" },
          },
          required: ["email"],
          additionalProperties: false,
        },
        request: {
          method: "POST",
          path: '/contacts/{{input.id ?? "new"}}',
          query: { tag: "{{input.tag ?? null}}" },
          headers: { "x-source": "flow" },
          body: { email: "{{input.email}}" },
        },
        response: {
          output: { id: "{{input.body.id}}", status: "{{input.status}}" },
        },
      },
      ping: { inputSchema: { type: "object" }, request: { method: "GET", path: "/ping" } },
    },
    ...extra,
  };
}

function loaded(m: IntegrationManifest): LoadedIntegration {
  return {
    source: "user",
    provider: m.provider,
    file: `user/${m.provider}/integration.json`,
    manifest: m,
    overrides: false,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response = () => json({ id: "c-1" }, 201)) {
  const captured: Captured[] = [];
  const fetch: FetchLike = (url, init) => {
    captured.push({ url, init });
    return Promise.resolve(respond());
  };
  return { fetch, captured };
}

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function call(config: Record<string, JsonValue>) {
  return defineWorkflow(
    workflowWith([{ id: "c", type: "integration.call", config: { provider: "acme", ...config } }]),
  );
}

function engineWith(
  fetch: FetchLike,
  m: IntegrationManifest = manifest(),
  extra: Partial<EngineOptions> = {},
) {
  return createEngine({
    mode: "live",
    http: { fetch },
    integrations: { user: [loaded(m)], credentials: { token: SECRET } },
    ...extra,
  });
}

describe("integration.call", () => {
  it("expands templates into an http request and maps the response", async () => {
    const { fetch, captured } = fakeFetch();
    const wf = call({
      action: "create-contact",
      credentials: "token",
      input: { email: "a@b.c", tag: "vip", id: "x y" },
    });
    const result = await engineWith(fetch).execute(wf, {});
    assertSucceeded(result);
    expect(requireStep(result, "c").output).toEqual({ id: "c-1", status: 201 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.acme.test/v1/contacts/x%20y?tag=vip");
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(headers.get("x-source")).toBe("flow");
    expect(captured[0]?.init.body).toBe(JSON.stringify({ email: "a@b.c" }));
    expect(captured[0]?.init.redirect).toBe("manual");
  });

  it("returns the response body when the action has no output mapping and drops null query values", async () => {
    const { fetch, captured } = fakeFetch(() => json({ pong: true }));
    const result = await engineWith(fetch).execute(
      call({ action: "ping", credentials: "token" }),
      {},
    );
    assertSucceeded(result);
    expect(requireStep(result, "c").output).toEqual({ pong: true });
    expect(captured[0]?.url).toBe("https://api.acme.test/v1/ping");
  });

  it("supports header, query and basic auth", async () => {
    for (const [auth, check] of [
      [
        { type: "header", name: "X-Api-Key" },
        (c: Captured) => new Headers(c.init.headers).get("x-api-key") === SECRET,
      ],
      [{ type: "query", name: "key" }, (c: Captured) => c.url.endsWith(`/ping?key=${SECRET}`)],
      [
        { type: "basic" },
        (c: Captured) =>
          new Headers(c.init.headers).get("authorization") ===
          `Basic ${Buffer.from(SECRET).toString("base64")}`,
      ],
    ] as const) {
      const { fetch, captured } = fakeFetch(() => json({}));
      const m = manifest({ auth });
      const result = await engineWith(fetch, m).execute(
        call({ action: "ping", credentials: "token" }),
        {},
      );
      assertSucceeded(result);
      expect(captured[0] !== undefined && check(captured[0])).toBe(true);
    }
  });

  it("rejects invalid input against the action inputSchema without calling out", async () => {
    const { fetch, captured } = fakeFetch();
    const result = await engineWith(fetch).execute(
      call({ action: "create-contact", credentials: "token", input: { email: 5 } }),
      {},
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INTEGRATION_INPUT_INVALID");
    expect(captured).toHaveLength(0);
  });

  it("fails on unknown provider and unknown action", async () => {
    const { fetch } = fakeFetch();
    const engine = engineWith(fetch);
    const a = await engine.execute(
      defineWorkflow(
        workflowWith([
          { id: "c", type: "integration.call", config: { provider: "nope", action: "x" } },
        ]),
      ),
      {},
    );
    expect(a.error?.code).toBe("INTEGRATION_UNKNOWN");
    const b = await engine.execute(call({ action: "nope", credentials: "token" }), {});
    expect(b.error?.code).toBe("INTEGRATION_UNKNOWN");
  });

  it("resolves credentials from the environment and fails closed when missing", async () => {
    const { fetch, captured } = fakeFetch(() => json({}));
    const env = { JSON_FLOW_CREDENTIAL_MY_TOKEN: "from-env" };
    const engine = createEngine({
      mode: "live",
      http: { fetch },
      integrations: { user: [loaded(manifest())], env },
    });
    const ok = await engine.execute(call({ action: "ping", credentials: "my-token" }), {});
    assertSucceeded(ok);
    expect(new Headers(captured[0]?.init.headers).get("authorization")).toBe("Bearer from-env");

    const missing = await engine.execute(call({ action: "ping", credentials: "other" }), {});
    expect(missing.error?.code).toBe("INTEGRATION_CREDENTIAL_MISSING");
    const none = await engine.execute(call({ action: "ping" }), {});
    expect(none.error?.code).toBe("INTEGRATION_CREDENTIAL_MISSING");
    expect(captured).toHaveLength(1);
  });

  it("does not let a credential name read arbitrary environment variables", async () => {
    const { fetch, captured } = fakeFetch();
    const engine = createEngine({
      mode: "live",
      http: { fetch },
      integrations: { user: [loaded(manifest())], env: { PATH: "/usr/bin", HOME: "/root" } },
    });
    const result = await engine.execute(call({ action: "ping", credentials: "PATH" }), {});
    expect(result.error?.code).toBe("INTEGRATION_CREDENTIAL_MISSING");
    expect(captured).toHaveLength(0);
  });

  describe("security boundary", () => {
    it("refuses a host outside the manifest allowedHosts", async () => {
      const { fetch, captured } = fakeFetch();
      const bad = manifest({ allowedHosts: ["other.acme.test"] });
      const result = await engineWith(fetch, bad).execute(
        call({ action: "ping", credentials: "token" }),
        {},
      );
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("INTEGRATION_REQUEST_INVALID");
      expect(captured).toHaveLength(0);
    });

    it("cannot be steered to another host, query or dot segment through input", async () => {
      const m = manifest();
      m.actions["ping"] = {
        inputSchema: { type: "object" },
        request: { method: "GET", path: "/items/{{input.id}}" },
      };
      for (const id of ["..", "//evil.test", "a?x=1", "a#b", "@evil.test"]) {
        const { fetch, captured } = fakeFetch(() => json({}));
        const result = await engineWith(fetch, m).execute(
          call({ action: "ping", credentials: "token", input: { id } }),
          {},
        );
        if (captured.length > 0) {
          const url = new URL(captured[0]?.url ?? "");
          expect(url.host).toBe("api.acme.test");
          expect(url.search).toBe("");
          expect(url.hash).toBe("");
          expect(url.pathname.split("/")).not.toContain("..");
        } else {
          expect(result.status).toBe("failed");
        }
      }
    });

    it("still applies the engine URL policy (private hosts are refused)", async () => {
      const { fetch, captured } = fakeFetch();
      const local = manifest({ baseUrl: "https://localhost:8443", allowedHosts: ["localhost"] });
      const result = await engineWith(fetch, local).execute(
        call({ action: "ping", credentials: "token" }),
        {},
      );
      expect(result.error?.code).toBe("HTTP_URL_FORBIDDEN");
      expect(captured).toHaveLength(0);
    });

    it("never exposes the credential in results, events, logs or errors", async () => {
      const events: ExecutionEvent[] = [];
      const logs: string[] = [];
      const logger = {
        debug: (m: string, f?: object) => logs.push(m + JSON.stringify(f)),
        info: (m: string, f?: object) => logs.push(m + JSON.stringify(f)),
        warn: (m: string, f?: object) => logs.push(m + JSON.stringify(f)),
        error: (m: string, f?: object) => logs.push(m + JSON.stringify(f)),
      };
      const options: Partial<EngineOptions> = { logger, onEvent: (e) => events.push(e) };

      // Success whose body echoes the credential.
      const echo = fakeFetch(() => json({ id: `echo-${SECRET}`, nested: [SECRET] }, 201));
      const ok = await engineWith(echo.fetch, manifest(), options).execute(
        call({ action: "create-contact", credentials: "token", input: { email: "a@b.c" } }),
        {},
      );
      assertSucceeded(ok);

      // Failure whose error preview echoes the credential, with query auth.
      const failing = fakeFetch(() => new Response(`bad key ${SECRET}`, { status: 401 }));
      const bad = await engineWith(
        failing.fetch,
        manifest({ auth: { type: "query", name: "key" } }),
        options,
      ).execute(call({ action: "ping", credentials: "token" }), {});
      expect(bad.status).toBe("failed");
      expect(bad.error?.code).toBe("HTTP_STATUS");

      const everything = JSON.stringify([ok, bad, events, logs]);
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain(Buffer.from(SECRET).toString("base64"));
    });
  });

  describe("sandbox", () => {
    it("is refused without a mock and never touches the network", async () => {
      const { fetch, captured } = fakeFetch();
      const engine = createEngine({
        mode: "sandbox",
        http: { fetch },
        integrations: { user: [loaded(manifest())] },
      });
      const result = await engine.execute(call({ action: "ping", credentials: "token" }), {});
      expect(result.error?.code).toBe("SANDBOX_MOCK_MISSING");
      expect(captured).toHaveLength(0);
    });

    it("runs against a mock with no network and no credential available", async () => {
      const { fetch, captured } = fakeFetch();
      const engine = createEngine({
        mode: "sandbox",
        http: { fetch },
        integrations: { user: [loaded(manifest())] },
      });
      const handle = engine.mock("integration.call", { responses: [{ output: { id: "mock-1" } }] });
      const result = await engine.execute(
        call({ action: "create-contact", credentials: "token", input: { email: "a@b.c" } }),
        {},
      );
      assertSucceeded(result);
      expect(requireStep(result, "c").output).toEqual({ id: "mock-1" });
      expect(requireStep(result, "c").execution).toBe("mock");
      expect(handle.callCount).toBe(1);
      expect(captured).toHaveLength(0);
    });

    it("can be allowed live and then goes through the http machinery", async () => {
      const { fetch, captured } = fakeFetch(() => json({ ok: true }));
      const engine = createEngine({
        mode: "sandbox",
        sandbox: { allowLive: ["integration.call"] },
        http: { fetch },
        integrations: { user: [loaded(manifest())], credentials: { token: SECRET } },
      });
      const result = await engine.execute(call({ action: "ping", credentials: "token" }), {});
      assertSucceeded(result);
      expect(captured).toHaveLength(1);
    });
  });

  describe("integration sources", () => {
    it("loads user integrations from a directory with loadUserIntegrations", async () => {
      const dir = await mkdtemp(join(tmpdir(), "jfe-int-"));
      try {
        await mkdir(join(dir, "acme"));
        await writeFile(join(dir, "acme", "integration.json"), JSON.stringify(manifest()));
        const { user, errors } = await loadUserIntegrations(dir);
        expect(errors).toEqual([]);
        const { fetch } = fakeFetch(() => json({ pong: 1 }));
        const result = await engineWith(fetch, manifest(), {
          integrations: { user, credentials: { token: SECRET } },
        }).execute(call({ action: "ping", credentials: "token" }), {});
        assertSucceeded(result);
        expect((await loadUserIntegrations(join(dir, "missing"))).user).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it("validates the step config statically", () => {
    const engine = createEngine({ mode: "sandbox" });
    const bad = engine.validate(
      workflowWith([{ id: "c", type: "integration.call", config: { provider: "acme" } }]),
    );
    expect(bad.ok).toBe(false);
    const good = engine.validate(call({ action: "ping", credentials: "token" }));
    expect(good.ok).toBe(true);
  });
});
