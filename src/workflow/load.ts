import { readFile } from "node:fs/promises";
import { JsonFlowError } from "../errors.js";
import { isMocksFile, type MocksFile } from "../sandbox/mocks.js";
import type { JsonValue } from "../json.js";
import { isJsonValue } from "../json.js";
import { parseWorkflow } from "./validate.js";
import type { Workflow } from "./types.js";

export async function readJsonFile(path: string): Promise<JsonValue> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new JsonFlowError(
      "WORKFLOW_INVALID",
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        details: { path },
        cause: error,
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new JsonFlowError(
      "WORKFLOW_INVALID",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        details: { path },
        cause: error,
      },
    );
  }
  if (!isJsonValue(parsed)) {
    throw new JsonFlowError("WORKFLOW_INVALID", `${path} is not plain JSON`, { details: { path } });
  }
  return parsed;
}

/** Reads and validates a workflow JSON file. Throws `WorkflowValidationError` on issues. */
export async function loadWorkflowFile(path: string): Promise<Workflow> {
  return parseWorkflow(await readJsonFile(path));
}

/** Reads a mocks file (`{ "version": 1, "mocks": [...] }`). */
export async function loadMocksFile(path: string): Promise<MocksFile> {
  const parsed = await readJsonFile(path);
  if (!isMocksFile(parsed)) {
    throw new JsonFlowError(
      "WORKFLOW_INVALID",
      `${path} is not a mocks file: expected { "version": 1, "mocks": [{ "type", "steps"?, "delayMs"?, "responses": [{ "output" } | { "error": { "message" } }] }] }`,
      { details: { path } },
    );
  }
  return parsed;
}
