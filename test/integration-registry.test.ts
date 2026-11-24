import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  combineIntegrations,
  getBuiltinManifests,
  type IntegrationManifest,
  type LoadedIntegration,
} from "../src/index.js";

function manifest(provider: string, extra: Record<string, unknown> = {}): IntegrationManifest {
  return {
    provider,
    baseUrl: "https://api.example.com",
    allowedHosts: ["api.example.com"],
    auth: { type: "none" },
    actions: {
      ping: { inputSchema: { type: "object" }, request: { method: "GET", path: "/ping" } },
    },
    ...extra,
  };
}

function user(provider: string, extra: Record<string, unknown> = {}): LoadedIntegration {
  return {
    source: "user",
    provider,
    file: `user/${provider}/integration.json`,
    manifest: manifest(provider, extra),
    overrides: false,
  };
}

describe("built-in registry", () => {
  it("exposes the compiled manifests", () => {
    expect(Array.isArray(getBuiltinManifests())).toBe(true);
  });

  it("combines built-ins with user integrations", () => {
    const result = combineIntegrations([user("mine")], [manifest("base")]);
    expect(result.errors).toEqual([]);
    expect(result.integrations.map((i) => `${i.source}:${i.provider}`)).toEqual([
      "builtin:base",
      "user:mine",
    ]);
  });

  it("rejects a user provider that shadows a built-in one without overridesBuiltin", () => {
    const result = combineIntegrations([user("base")], [manifest("base")]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("overridesBuiltin");
    expect(result.integrations.map((i) => i.source)).toEqual(["builtin"]);
  });

  it("lets an explicit override replace the built-in integration", () => {
    const result = combineIntegrations(
      [user("base", { overridesBuiltin: true })],
      [manifest("base"), manifest("other")],
    );
    expect(result.errors).toEqual([]);
    expect(result.integrations.map((i) => `${i.source}:${i.provider}`)).toEqual([
      "builtin:other",
      "user:base",
    ]);
    expect(result.integrations[1]?.overrides).toBe(true);
  });
});

describe("scripts/write-registry.js", { timeout: 60_000 }, () => {
  let dir: string;
  let out: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jfe-registry-"));
    out = join(dir, "out", "builtin.ts");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(...extra: string[]): string {
    // Low priority so the compile step does not starve timing-sensitive tests in other files.
    return execFileSync(
      "nice",
      [
        "-n",
        "19",
        process.execPath,
        "scripts/write-registry.js",
        "--builtin-dir",
        join(dir, "builtin"),
        "--out",
        out,
        ...extra,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
  }

  async function put(name: string, content: unknown): Promise<void> {
    await mkdir(join(dir, "builtin", name), { recursive: true });
    await writeFile(join(dir, "builtin", name, "integration.json"), JSON.stringify(content));
  }

  it("embeds valid manifests and detects a stale file", async () => {
    await put("acme", manifest("acme"));
    run();
    expect(await readFile(out, "utf8")).toContain('"provider": "acme"');
    expect(run("--check")).toContain("up to date");
    await put("acme", manifest("acme", { baseUrl: "https://api.example.com/v2" }));
    expect(() => run("--check")).toThrow(/out of date/);
  });

  it("fails on an invalid manifest", async () => {
    await put("bad", { provider: "bad" });
    expect(() => run()).toThrow(/invalid built-in integrations/);
  });
});
