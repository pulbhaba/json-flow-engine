import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadIntegrations } from "../src/index.js";

function manifest(provider: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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

let root: string;
let builtinDir: string;
let userDir: string;

async function put(dir: string, name: string, content: unknown): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, "integration.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jfe-loader-"));
  builtinDir = join(root, "builtin");
  userDir = join(root, "user");
  await mkdir(builtinDir);
  await mkdir(userDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadIntegrations", () => {
  it("keeps builtin and user sources separate and labelled", async () => {
    await put(builtinDir, "alpha", manifest("alpha"));
    await put(userDir, "beta", manifest("beta"));
    const result = await loadIntegrations({ builtinDir, userDir });
    expect(result.errors).toEqual([]);
    expect(result.builtin.map((i) => [i.source, i.provider])).toEqual([["builtin", "alpha"]]);
    expect(result.user.map((i) => [i.source, i.provider])).toEqual([["user", "beta"]]);
    expect(result.user[0]?.file).toBe(join(userDir, "beta", "integration.json"));
  });

  it("treats a missing user directory as empty but reports a missing builtin directory", async () => {
    const result = await loadIntegrations({
      builtinDir: join(root, "nope"),
      userDir: join(root, "nope-user"),
    });
    expect(result.user).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.source).toBe("builtin");
  });

  it("ignores directories without integration.json and loose files", async () => {
    await mkdir(join(userDir, "empty"));
    await writeFile(join(userDir, "README.md"), "hi");
    const result = await loadIntegrations({ builtinDir, userDir });
    expect(result).toEqual({ builtin: [], user: [], errors: [] });
  });

  it("rejects a user provider that duplicates a builtin one", async () => {
    await put(builtinDir, "alpha", manifest("alpha"));
    await put(userDir, "alpha", manifest("alpha"));
    const result = await loadIntegrations({ builtinDir, userDir });
    expect(result.user).toEqual([]);
    expect(result.builtin).toHaveLength(1);
    expect(result.builtin[0]?.overriddenBy).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("overridesBuiltin");
  });

  it("allows an explicit override and records it", async () => {
    await put(builtinDir, "alpha", manifest("alpha"));
    await put(userDir, "alpha", manifest("alpha", { overridesBuiltin: true }));
    const result = await loadIntegrations({ builtinDir, userDir });
    expect(result.errors).toEqual([]);
    expect(result.user[0]?.overrides).toBe(true);
    expect(result.builtin[0]?.overriddenBy).toBe(join(userDir, "alpha", "integration.json"));
  });

  it("does not let overridesBuiltin be anything but a boolean", async () => {
    await put(userDir, "alpha", manifest("alpha", { overridesBuiltin: "yes" }));
    const result = await loadIntegrations({ builtinDir, userDir });
    expect(result.user).toEqual([]);
    expect(result.errors[0]?.issues?.length).toBeGreaterThan(0);
  });

  it("reports per-file errors without aborting other files", async () => {
    await put(userDir, "good", manifest("good"));
    await put(userDir, "badjson", "{ not json");
    await put(userDir, "invalid", { provider: "invalid" });
    await put(userDir, "mismatch", manifest("other"));
    const result = await loadIntegrations({ builtinDir, userDir });
    expect(result.user.map((i) => i.provider)).toEqual(["good"]);
    expect(result.errors.map((e) => e.file).sort()).toEqual(
      ["badjson", "invalid", "mismatch"].map((n) => join(userDir, n, "integration.json")),
    );
    const invalid = result.errors.find((e) => e.file.includes("invalid"));
    expect(invalid?.issues?.length).toBeGreaterThan(0);
    expect(result.errors.find((e) => e.file.includes("mismatch"))?.message).toContain(
      "directory name",
    );
  });

  it("does not execute manifest content", async () => {
    await put(userDir, "evil", manifest("evil", { description: "require('fs').rmSync('/')" }));
    const result = await loadIntegrations({ builtinDir, userDir });
    expect(result.user[0]?.manifest.description).toBe("require('fs').rmSync('/')");
  });

  it("defaults the user directory to ./integrations/user under the cwd", async () => {
    const previous = process.cwd();
    process.chdir(root);
    try {
      await put(join(root, "integrations", "user"), "gamma", manifest("gamma"));
      const result = await loadIntegrations({ builtinDir });
      expect(result.user.map((i) => i.provider)).toEqual(["gamma"]);
    } finally {
      process.chdir(previous);
    }
  });
});
