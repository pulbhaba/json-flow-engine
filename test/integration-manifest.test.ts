import { describe, expect, it } from "vitest";
import { validateIntegrationManifest } from "../src/index.js";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "example",
    baseUrl: "https://api.example.com/v1",
    allowedHosts: ["api.example.com"],
    auth: { type: "bearer" },
    actions: {
      getItem: {
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        request: { method: "GET", path: "/items/{{input.id}}" },
        response: { output: "{{response.body}}", successStatus: [200] },
      },
    },
    ...overrides,
  };
}

function issuesOf(definition: unknown) {
  const result = validateIntegrationManifest(definition);
  return result.ok ? [] : result.issues;
}

describe("validateIntegrationManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validateIntegrationManifest(manifest());
    expect(result.ok).toBe(true);
  });

  it("accepts header auth with a name and an explicit schemaVersion", () => {
    const result = validateIntegrationManifest(
      manifest({ schemaVersion: 1, auth: { type: "header", name: "X-Api-Key" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(issuesOf("nope")[0]).toMatchObject({ code: "INTEGRATION_INVALID", path: "" });
  });

  it("reports missing required properties and unknown properties with pointers", () => {
    const issues = issuesOf({ provider: "x", extra: 1 });
    const messages = issues.map((i) => i.message);
    expect(messages).toContain('missing required property "baseUrl"');
    expect(messages).toContain('missing required property "allowedHosts"');
    expect(messages).toContain('missing required property "auth"');
    expect(messages).toContain('missing required property "actions"');
    expect(messages).toContain('unknown property "extra"');
  });

  it("rejects a bad provider id, a bad host and an empty actions map", () => {
    const issues = issuesOf(
      manifest({ provider: "Bad Id", allowedHosts: ["https://api.example.com"], actions: {} }),
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("/provider");
    expect(paths).toContain("/allowedHosts/0");
    expect(paths).toContain("/actions");
  });

  it("requires a name for header and query auth and forbids it otherwise", () => {
    expect(issuesOf(manifest({ auth: { type: "query" } })).map((i) => i.path)).toContain("/auth");
    expect(issuesOf(manifest({ auth: { type: "bearer", name: "x" } })).length).toBeGreaterThan(0);
    expect(issuesOf(manifest({ auth: { type: "oauth2" } })).length).toBeGreaterThan(0);
  });

  it("checks request shape per action", () => {
    const issues = issuesOf(
      manifest({
        actions: {
          bad: { inputSchema: {}, request: { method: "FETCH", path: "items" } },
        },
      }),
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("/actions/bad/request/method");
    expect(paths).toContain("/actions/bad/request/path");
  });

  it("requires https and no credentials, query or fragment in baseUrl", () => {
    expect(issuesOf(manifest({ baseUrl: "http://api.example.com" })).length).toBeGreaterThan(0);
    expect(
      issuesOf(manifest({ baseUrl: "https://user:pw@api.example.com" })).map((i) => i.message),
    ).toContain("baseUrl must not contain credentials, a query string or a fragment");
    expect(
      issuesOf(manifest({ baseUrl: "https://api.example.com/?a=1" })).map((i) => i.path),
    ).toContain("/baseUrl");
  });

  it("requires allowedHosts to include the baseUrl host", () => {
    const issues = issuesOf(manifest({ allowedHosts: ["other.example.com"] }));
    expect(issues).toEqual([
      {
        code: "INTEGRATION_INVALID",
        path: "/allowedHosts",
        message: 'allowedHosts must include the baseUrl host "api.example.com"',
      },
    ]);
  });

  it("reports an inputSchema that does not compile", () => {
    const issues = issuesOf(
      manifest({
        actions: {
          a: {
            inputSchema: { type: "nonsense" },
            request: { method: "GET", path: "/a" },
          },
        },
      }),
    );
    expect(issues[0]).toMatchObject({ code: "SCHEMA_INVALID", path: "/actions/a/inputSchema" });
  });
});
