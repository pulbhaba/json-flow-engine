import { parseArgs } from "node:util";
import { createEngine, type EngineOptions } from "./engine/engine.js";
import { isJsonFlowError, JsonFlowError, WorkflowValidationError } from "./errors.js";
import { loadUserIntegrations } from "./integrations/load.js";
import type { JsonValue } from "./json.js";
import { createConsoleLogger, type LogLevel } from "./logger.js";
import { formatResult } from "./testing.js";
import { loadMocksFile, loadWorkflowFile, readJsonFile } from "./workflow/load.js";

const USAGE = `json-flow: run JSON workflows from the terminal or CI.

Usage:
  json-flow validate <workflow.json>
  json-flow run <workflow.json> [--input <input.json>] [--mocks <mocks.json>] [--live] [--allow <origin>]...
  json-flow test <workflow.json> --mocks <mocks.json> [--input <input.json>]

Commands:
  validate   Check the workflow definition (schema, references, built-in configs). Exit 1 on issues.
  run        Execute the workflow. Sandbox mode by default: operations with external effects
             (http.request) must have a mock in --mocks, or the run fails closed.
             --live runs operations for real; --allow adds an origin to the URL policy,
             e.g. --allow http://localhost:3000 (plain http and private hosts are refused otherwise).
  test       Sandbox-only run with mocks required. Exit 0 if the workflow succeeded, 1 otherwise.

Options:
  --input <file>      JSON file with the workflow input (default: {}).
  --input-json <json> Inline JSON input (overrides --input).
  --mocks <file>      Mocks file: { "version": 1, "mocks": [...] }.
  --live              Live execution (run only). Never combined with --mocks.
  --allow <origin>    Allowed origin for http.request in live mode (repeatable).
  --allow-http        Allow plain http:// to any host in live mode.
  --allow-private     Allow loopback and private hosts in live mode.
  --log <level>       debug | info | warn | error | silent (default: warn).
  --json              Print the full execution result as JSON instead of a summary.
  --help              Show this help.

Custom operations cannot be loaded by the CLI; use the programmatic API for those.`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, file] = positionals;
  if (values.help === true || command === undefined) {
    io.stdout(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  if (file === undefined) {
    io.stderr(`Missing workflow file.\n\n${USAGE}`);
    return 2;
  }
  try {
    switch (command) {
      case "validate":
        return await validateCommand(file, io);
      case "run":
        return await runCommand(file, values, io, false);
      case "test":
        return await runCommand(file, values, io, true);
      default:
        io.stderr(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      io.stderr(error.message);
      return 1;
    }
    if (isJsonFlowError(error)) {
      io.stderr(`[${error.code}] ${error.message}`);
      return 1;
    }
    io.stderr(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

// Options are inlined so TypeScript infers literal types for `values` without a cast.
function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      "input-json": { type: "string" },
      mocks: { type: "string" },
      live: { type: "boolean" },
      allow: { type: "string", multiple: true },
      "allow-http": { type: "boolean" },
      "allow-private": { type: "boolean" },
      log: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

type CliValues = ReturnType<typeof parseCliArgs>["values"];

async function validateCommand(file: string, io: CliIo): Promise<number> {
  const definition = await readJsonFile(file);
  const engine = createEngine({ mode: "sandbox" });
  const result = engine.validate(definition);
  if (result.ok) {
    io.stdout(
      `${file}: valid (${result.workflow.id} v${result.workflow.version}, ${countSteps(result.workflow.steps)} steps)`,
    );
    return 0;
  }
  io.stderr(`${file}: ${result.issues.length} issue(s)`);
  for (const issue of result.issues)
    io.stderr(`  ${issue.path || "/"}: ${issue.message} [${issue.code}]`);
  return 1;
}

function countSteps(steps: { type: string; config: Record<string, JsonValue> }[]): number {
  let count = 0;
  for (const step of steps) {
    count++;
    if (step.type === "control.condition") {
      for (const key of ["then", "else"]) {
        const nested = step.config[key];
        if (Array.isArray(nested)) {
          count += countSteps(
            nested.filter(
              (entry): entry is { type: string; config: Record<string, JsonValue> } =>
                typeof entry === "object" && entry !== null && !Array.isArray(entry),
            ),
          );
        }
      }
    }
  }
  return count;
}

function parseLogLevel(value: string | undefined): LogLevel | "silent" {
  switch (value) {
    case undefined:
      return "warn";
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "silent":
      return value;
    default:
      throw new Error(`Unknown --log level "${value}"`);
  }
}

async function runCommand(
  file: string,
  values: CliValues,
  io: CliIo,
  testOnly: boolean,
): Promise<number> {
  if (testOnly && values.live === true) {
    io.stderr("json-flow test never runs live; use `json-flow run --live` deliberately.");
    return 2;
  }
  if (testOnly && values.mocks === undefined) {
    io.stderr("json-flow test requires --mocks <file>.");
    return 2;
  }
  if (values.live === true && values.mocks !== undefined) {
    io.stderr("--live and --mocks cannot be combined: mocks only apply in sandbox mode.");
    return 2;
  }
  const workflow = await loadWorkflowFile(file);
  let input: JsonValue = {};
  if (values["input-json"] !== undefined) {
    const parsedInput: unknown = JSON.parse(values["input-json"]);
    input = asJson(parsedInput);
  } else if (values.input !== undefined) {
    input = await readJsonFile(values.input);
  }

  const level = parseLogLevel(values.log);
  const options: EngineOptions = {
    mode: values.live === true ? "live" : "sandbox",
    ...(level === "silent" ? {} : { logger: createConsoleLogger(level) }),
    http: {
      urlPolicy: {
        allow: values.allow ?? [],
        ...(values["allow-http"] === true ? { allowHttp: true } : {}),
        ...(values["allow-private"] === true ? { allowPrivateNetworks: true } : {}),
      },
    },
  };
  if (values.mocks !== undefined) options.mocks = (await loadMocksFile(values.mocks)).mocks;
  const userIntegrations = await loadUserIntegrations();
  if (userIntegrations.errors.length > 0) {
    throw new JsonFlowError(
      "INTEGRATION_INVALID",
      `Invalid user integrations: ${userIntegrations.errors.map((e) => `${e.file}: ${e.message}`).join("; ")}`,
    );
  }
  options.integrations = { user: userIntegrations.user };
  const engine = createEngine(options);

  const validation = engine.validate(workflow);
  if (!validation.ok) throw new WorkflowValidationError(validation.issues);

  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await engine.execute(workflow, input, { signal: controller.signal });
    io.stdout(values.json === true ? JSON.stringify(result, null, 2) : formatResult(result));
    return result.status === "succeeded" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await engine.dispose();
  }
}

function asJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = asJson(entry);
    return out;
  }
  throw new Error("input must be JSON");
}
