import { describe, expect, it } from "vitest";
import {
  assertSucceeded,
  createEngine,
  defineWorkflow,
  requireStep,
  type EngineOptions,
  type FetchLike,
  type JsonValue,
} from "../src/index.js";
import { workflowWith } from "./helpers.js";

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  respond: (captured: Captured) => Response | Promise<Response>,
  captured: Captured[] = [],
): { fetch: FetchLike; captured: Captured[] } {
  return {
    captured,
    fetch: (url, init) => {
      const entry = { url, init };
      captured.push(entry);
      return Promise.resolve(respond(entry));
    },
  };
}

function json(body: JsonValue, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function live(fetch: FetchLike, extra: Partial<EngineOptions["http"]> = {}) {
  return createEngine({
    mode: "live",
    http: {
      fetch,
      urlPolicy: { allow: ["http://localhost:*", "https://api.example.com"] },
      ...extra,
    },
  });
}

const step = (config: Record<string, JsonValue>, extra: Record<string, JsonValue> = {}) =>
  defineWorkflow(
    workflowWith([
      {
        id: "req",
        type: "http.request",
        config: { method: "GET", url: "https://api.example.com/items", ...config },
        ...extra,
      },
    ]),
  );

describe("http.request", () => {
  it("sends query, headers and a JSON body with typed values, and parses the JSON response", async () => {
    const { fetch, captured } = fakeFetch(() =>
      json({ id: 7 }, 201, { "set-cookie": "session=secret", "x-request-id": "r1" }),
    );
    const wf = step({
      method: "POST",
      url: "https://api.example.com/items",
      query: { page: 2, tags: ["a", "b"], flag: true },
      headers: { authorization: "Bearer tok", "x-custom": "{{input.custom}}" },
      body: {
        name: "{{input.name}}",
        count: "{{input.count}}",
        nested: { ok: true },
        list: [1, "{{input.name}}"],
      },
    });
    const result = await live(fetch).execute(wf, { name: "widget", count: 3, custom: "c" });
    assertSucceeded(result);
    expect(captured[0]?.url).toBe("https://api.example.com/items?page=2&tags=a&tags=b&flag=true");
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("x-custom")).toBe("c");
    expect(captured[0]?.init.method).toBe("POST");
    expect(captured[0]?.init.redirect).toBe("manual");
    const sentBody = captured[0]?.init.body;
    expect(typeof sentBody).toBe("string");
    expect(JSON.parse(typeof sentBody === "string" ? sentBody : "null")).toEqual({
      name: "widget",
      count: 3,
      nested: { ok: true },
      list: [1, "widget"],
    });
    expect(requireStep(result, "req").output).toEqual({
      status: 201,
      statusText: "",
      headers: {
        "content-type": "application/json",
        "set-cookie": "[redacted]",
        "x-request-id": "r1",
      },
      body: { id: 7 },
      url: "https://api.example.com/items",
    });
  });

  it("sends text bodies and returns text responses", async () => {
    const { fetch, captured } = fakeFetch(
      () => new Response("plain", { headers: { "content-type": "text/plain" } }),
    );
    const result = await live(fetch).execute(
      step({ method: "PUT", body: "raw text", bodyFormat: "text" }),
    );
    assertSucceeded(result);
    expect(captured[0]?.init.body).toBe("raw text");
    expect(new Headers(captured[0]?.init.headers).get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(requireStep(result, "req").output).toMatchObject({ body: "plain" });
    const forced = await live(fakeFetch(() => json({ a: 1 })).fetch).execute(
      step({ responseType: "text" }),
    );
    expect(requireStep(forced, "req").output).toMatchObject({ body: '{"a":1}' });
    const none = await live(fakeFetch(() => json({ a: 1 })).fetch).execute(
      step({ responseType: "none" }),
    );
    expect(requireStep(none, "req").output).toMatchObject({ body: null });
  });

  it("fails on non-2xx by default with a sanitised error, honouring expectStatus", async () => {
    const { fetch } = fakeFetch(() => json({ error: "nope" }, 404));
    const failed = await live(fetch).execute(
      step({ headers: { authorization: "Bearer supersecret" } }),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({
      code: "HTTP_STATUS",
      message: "GET https://api.example.com/items responded with 404",
      retryable: false,
      details: {
        method: "GET",
        url: "https://api.example.com/items",
        requestHeaderNames: ["authorization"],
        status: 404,
        responseBodyPreview: '{"error":"nope"}',
      },
      stepId: "req",
    });
    expect(JSON.stringify(failed)).not.toContain("supersecret");
    assertSucceeded(await live(fetch).execute(step({ expectStatus: [404] })));
    assertSucceeded(await live(fetch).execute(step({ expectStatus: "any" })));
  });

  it("marks 5xx retryable only for idempotent requests, or with an idempotency key", async () => {
    const { fetch, captured } = fakeFetch(() => json(null, 503));
    expect((await live(fetch).execute(step({ method: "GET" }))).error?.retryable).toBe(true);
    expect((await live(fetch).execute(step({ method: "DELETE" }))).error?.retryable).toBe(true);
    expect((await live(fetch).execute(step({ method: "POST" }))).error?.retryable).toBe(false);
    expect(
      (await live(fetch).execute(step({ method: "POST", idempotent: true }))).error?.retryable,
    ).toBe(true);
    const keyed = await live(fetch).execute(
      step({ method: "POST" }, { idempotencyKey: "order-{{input.id}}" }),
      { id: 9 },
    );
    expect(keyed.error?.retryable).toBe(true);
    expect(new Headers(captured[captured.length - 1]?.init.headers).get("idempotency-key")).toBe(
      "order-9",
    );
    expect(
      (await live(fetch).execute(step({ method: "GET", expectStatus: [200] }))).error?.retryable,
    ).toBe(true);
    expect(
      (await live(fakeFetch(() => json(null, 400)).fetch).execute(step({ method: "GET" }))).error
        ?.retryable,
    ).toBe(false);
  });

  it("bounds the response size", async () => {
    const { fetch } = fakeFetch(
      () => new Response("x".repeat(2000), { headers: { "content-type": "text/plain" } }),
    );
    const result = await live(fetch).execute(step({ maxResponseBytes: 1000 }));
    expect(result.error).toMatchObject({
      code: "HTTP_RESPONSE_TOO_LARGE",
      details: { maxResponseBytes: 1000 },
    });
  });

  it("rejects malformed JSON when JSON was declared", async () => {
    const { fetch } = fakeFetch(
      () => new Response("{oops", { headers: { "content-type": "application/json" } }),
    );
    expect((await live(fetch).execute(step({}))).error?.code).toBe("HTTP_RESPONSE_INVALID");
    const empty = await live(
      fakeFetch(() => new Response("", { headers: { "content-type": "application/json" } })).fetch,
    ).execute(step({}));
    expect(requireStep(empty, "req").output).toMatchObject({ body: null });
  });

  it("does not follow redirects", async () => {
    const { fetch } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    );
    expect((await live(fetch).execute(step({}))).error).toMatchObject({
      code: "HTTP_STATUS",
      details: { status: 302 },
    });
  });

  it("times out, respecting the configured request timeout and retryability rules", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const started = Date.now();
    const result = await live(fetch).execute(step({ timeoutMs: 20 }));
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.error).toMatchObject({
      code: "HTTP_TIMEOUT",
      retryable: true,
      details: { timeoutMs: 20 },
    });
    expect(
      (await live(fetch).execute(step({ method: "POST", timeoutMs: 20 }))).error?.retryable,
    ).toBe(false);
  });

  it("reports cancellation while a request is in flight", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await live(fetch).execute(step({}), {}, { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(requireStep(result, "req").status).toBe("cancelled");
  });

  it("maps network failures to HTTP_NETWORK without leaking the URL query", async () => {
    const fetch: FetchLike = () =>
      Promise.reject(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }));
    const result = await live(fetch).execute(
      step({ url: "https://api.example.com/items?token=abc" }),
    );
    expect(result.error).toMatchObject({
      code: "HTTP_NETWORK",
      retryable: true,
      details: { url: "https://api.example.com/items", errorMessage: "ECONNREFUSED" },
    });
    expect(JSON.stringify(result)).not.toContain("token=abc");
  });

  it("refuses private hosts, plain http and credentials unless the policy allows them", async () => {
    const { fetch, captured } = fakeFetch(() => json({}));
    const strict = createEngine({ mode: "live", http: { fetch } });
    for (const url of [
      "http://localhost:3000/x",
      "https://127.0.0.1/x",
      "https://10.0.0.1/x",
      "https://169.254.169.254/latest",
      "http://api.example.com/x",
      "https://user:pw@api.example.com/x",
      "https://metadata.google.internal/x",
      "https://[::1]/x",
    ]) {
      const result = await strict.execute(step({ url }));
      expect(result.error?.code, url).toBe("HTTP_URL_FORBIDDEN");
    }
    expect(captured).toHaveLength(0);
    assertSucceeded(await strict.execute(step({ url: "https://api.example.com/x" })));
    assertSucceeded(await live(fetch).execute(step({ url: "http://localhost:4000/x" })));
    const relaxed = createEngine({
      mode: "live",
      http: { fetch, urlPolicy: { allowHttp: true, allowPrivateNetworks: true } },
    });
    assertSucceeded(await relaxed.execute(step({ url: "http://10.0.0.1/x" })));
    expect((await relaxed.execute(step({ url: "ftp://10.0.0.1/x" }))).error?.code).toBe(
      "HTTP_URL_FORBIDDEN",
    );
    expect((await relaxed.execute(step({ url: "not a url" }))).error?.code).toBe(
      "HTTP_URL_INVALID",
    );
  });

  it("rejects an invalid URL policy at engine creation", () => {
    expect(() =>
      createEngine({ mode: "live", http: { urlPolicy: { allow: ["api.example.com"] } } }),
    ).toThrow(/URL policy pattern/);
  });
});
