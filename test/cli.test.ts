import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const WORKFLOW = path("../examples/workflows/create-and-verify-resource.json");
const INPUT = path("../examples/fixtures/create-and-verify.input.json");
const MOCKS = path("../examples/fixtures/create-and-verify.mocks.json");
const INVALID = path("./fixtures/invalid-workflow.json");

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await runCli(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("json-flow CLI", () => {
  it("validates a good workflow", async () => {
    const result = await run(["validate", WORKFLOW]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("valid (create-and-verify-resource v1, 4 steps)");
  });

  it("lists every issue of a bad workflow", async () => {
    const result = await run(["validate", INVALID]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("3 issue(s)");
    expect(result.err).toContain("/steps/0/config/url");
    expect(result.err).toContain('unknown operation "no.such-op"');
    expect(result.err).toContain("STEP_ID_DUPLICATE");
  });

  it("runs in sandbox mode by default and fails closed without mocks", async () => {
    const result = await run(["run", WORKFLOW, "--input", INPUT, "--log", "silent"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("[sandbox] failed");
    expect(result.out).toContain("SANDBOX_MOCK_MISSING");
  });

  it("runs with mocks and prints a summary or JSON", async () => {
    const summary = await run([
      "test",
      WORKFLOW,
      "--input",
      INPUT,
      "--mocks",
      MOCKS,
      "--log",
      "silent",
    ]);
    expect(summary.code).toBe(0);
    expect(summary.out).toContain("[sandbox] succeeded");
    expect(summary.out).toContain("succeeded create-resource (http.request) via mock");

    const asJson = await run([
      "run",
      WORKFLOW,
      "--input-json",
      '{"baseUrl":"http://localhost:3000","resourceName":"integration-widget","apiToken":"t"}',
      "--mocks",
      MOCKS,
      "--json",
      "--log",
      "silent",
    ]);
    expect(asJson.code).toBe(0);
    const parsed: unknown = JSON.parse(asJson.out);
    expect(parsed).toMatchObject({
      status: "succeeded",
      mode: "sandbox",
      output: { resourceId: "res_123" },
    });
  });

  it("exits 1 when the workflow fails under mocks", async () => {
    const result = await run([
      "test",
      WORKFLOW,
      "--input-json",
      '{"baseUrl":"http://localhost:3000","resourceName":"other-name","apiToken":"t"}',
      "--mocks",
      MOCKS,
      "--log",
      "silent",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("ASSERTION_FAILED");
  });

  it("refuses unsafe or contradictory flag combinations", async () => {
    expect((await run(["test", WORKFLOW, "--live"])).code).toBe(2);
    expect((await run(["test", WORKFLOW])).code).toBe(2);
    expect((await run(["run", WORKFLOW, "--live", "--mocks", MOCKS])).code).toBe(2);
    expect((await run(["frobnicate", WORKFLOW])).code).toBe(2);
    expect((await run(["run"])).code).toBe(2);
    expect((await run(["--bogus"])).code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect((await run(["--help"])).code).toBe(0);
  });

  it("reports unreadable files cleanly", async () => {
    const result = await run(["validate", path("./fixtures/does-not-exist.json")]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Cannot read");
  });
});
