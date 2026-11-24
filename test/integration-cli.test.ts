import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await runCli(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("json-flow integration CLI", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jfe-integration-cli-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists built-in and user integrations separately with actions", async () => {
    expect((await run(["integration", "scaffold", "acme", "--dir", dir])).code).toBe(0);
    const result = await run(["integration", "list", "--dir", dir]);
    expect(result.code).toBe(0);
    const builtinAt = result.out.indexOf("Built-in integrations:");
    const userAt = result.out.indexOf("User integrations");
    expect(builtinAt).toBeGreaterThanOrEqual(0);
    expect(userAt).toBeGreaterThan(builtinAt);
    expect(result.out).toContain("hubspot (HubSpot)");
    expect(result.out).toContain("create-contact");
    expect(result.out.slice(userAt)).toContain("acme: get-item");
    expect(result.out.slice(builtinAt, userAt)).not.toContain("acme");
  });

  it("shows no user integrations and reports broken ones", async () => {
    expect((await run(["integration", "list", "--dir", dir])).out).toContain("(none)");
    await mkdir(join(dir, "bad"));
    await writeFile(join(dir, "bad", "integration.json"), "{}");
    const result = await run(["integration", "list", "--dir", dir]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("manifest is invalid");
  });

  it("scaffolds a manifest that validates and refuses to overwrite", async () => {
    const made = await run(["integration", "scaffold", "acme", "--dir", dir]);
    expect(made.code).toBe(0);
    const file = join(dir, "acme", "integration.json");
    const written = JSON.parse(await readFile(file, "utf8")) as { provider: string };
    expect(written.provider).toBe("acme");
    expect((await run(["integration", "validate", file])).code).toBe(0);
    const dirResult = await run(["integration", "validate", join(dir, "acme")]);
    expect(dirResult.code).toBe(0);
    expect(dirResult.out).toContain("valid (acme, 1 action(s))");

    const again = await run(["integration", "scaffold", "acme", "--dir", dir]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("refusing to overwrite");
  });

  it("rejects bad provider ids and built-in ids when scaffolding", async () => {
    expect((await run(["integration", "scaffold", "Bad_Id", "--dir", dir])).code).toBe(2);
    const builtin = await run(["integration", "scaffold", "hubspot", "--dir", dir]);
    expect(builtin.code).toBe(1);
    expect(builtin.err).toContain("built-in");
  });

  it("reports JSON-pointer errors and exits non-zero for an invalid manifest", async () => {
    await mkdir(join(dir, "bad"));
    const file = join(dir, "bad", "integration.json");
    await writeFile(
      file,
      JSON.stringify({
        provider: "bad",
        baseUrl: "http://insecure.example.com",
        allowedHosts: ["insecure.example.com"],
        auth: { type: "header" },
        actions: {},
      }),
    );
    const result = await run(["integration", "validate", file]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("issue(s)");
    expect(result.err).toMatch(/\n {2}\/baseUrl: /);
    expect(result.err).toContain("INTEGRATION_INVALID");
  });

  it("flags unparsable files, missing paths, directory mismatch and built-in id clashes", async () => {
    await mkdir(join(dir, "x"));
    await writeFile(join(dir, "x", "integration.json"), "{nope");
    expect((await run(["integration", "validate", join(dir, "x")])).err).toContain("invalid JSON");
    expect((await run(["integration", "validate", join(dir, "missing")])).code).toBe(1);

    await run(["integration", "scaffold", "acme", "--dir", dir]);
    const manifest = JSON.parse(
      await readFile(join(dir, "acme", "integration.json"), "utf8"),
    ) as Record<string, unknown>;
    await mkdir(join(dir, "other"));
    await writeFile(join(dir, "other", "integration.json"), JSON.stringify(manifest));
    const mismatch = await run(["integration", "validate", join(dir, "other")]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain('must match its directory name "other"');

    await mkdir(join(dir, "hubspot"));
    await writeFile(
      join(dir, "hubspot", "integration.json"),
      JSON.stringify({ ...manifest, provider: "hubspot" }),
    );
    const clash = await run(["integration", "validate", join(dir, "hubspot")]);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("overridesBuiltin");
    await writeFile(
      join(dir, "hubspot", "integration.json"),
      JSON.stringify({ ...manifest, provider: "hubspot", overridesBuiltin: true }),
    );
    expect((await run(["integration", "validate", join(dir, "hubspot")])).code).toBe(0);
  });

  it("returns usage errors", async () => {
    expect((await run(["integration"])).code).toBe(2);
    expect((await run(["integration", "validate"])).code).toBe(2);
    expect((await run(["integration", "scaffold"])).code).toBe(2);
    expect((await run(["integration", "nope"])).code).toBe(2);
  });
});
