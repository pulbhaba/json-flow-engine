import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as ajvFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { containsTemplate } from "../expressions/parse.js";
import type { JsonObject, JsonValue } from "../json.js";
import { isJsonObject } from "../json.js";

export type { ErrorObject, ValidateFunction };

/**
 * ajv-formats is a CommonJS module whose only export is its default. The ESM build sees it
 * as `{ default: plugin }` and the CommonJS build as the plugin itself, so unwrap at runtime
 * instead of relying on either shape.
 */
function isFormatsPlugin(value: unknown): value is FormatsPlugin {
  return typeof value === "function";
}

function resolveFormatsPlugin(): FormatsPlugin {
  let candidate: unknown = ajvFormatsModule;
  for (let depth = 0; depth < 3 && !isFormatsPlugin(candidate); depth++) {
    candidate =
      typeof candidate === "object" && candidate !== null && "default" in candidate
        ? candidate.default
        : undefined;
  }
  if (!isFormatsPlugin(candidate)) throw new Error("ajv-formats did not export a plugin function");
  return candidate;
}

const addFormats = resolveFormatsPlugin();

export type AjvInstance = InstanceType<typeof Ajv2020>;

/**
 * Creates an Ajv instance with the options the engine relies on: all errors reported, strict
 * schema checking (unknown keywords are rejected, so typos in schemas fail early), standard
 * formats enabled.
 */
export function createAjv(): AjvInstance {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictTuples: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  return ajv;
}

export function formatAjvError(error: ErrorObject): string {
  switch (error.keyword) {
    case "additionalProperties": {
      const extra: unknown = error.params["additionalProperty"];
      return `unknown property ${JSON.stringify(extra)}`;
    }
    case "required": {
      const missing: unknown = error.params["missingProperty"];
      return `missing required property ${JSON.stringify(missing)}`;
    }
    case "enum":
      return `must be one of ${JSON.stringify(error.params["allowedValues"])}`;
    default:
      return error.message ?? error.keyword;
  }
}

/** Reads the value at an Ajv instance path (JSON pointer) inside `root`. */
export function valueAtPointer(root: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") return root;
  let current: JsonValue | undefined = root;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isJsonObject(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

/**
 * Drops schema errors raised against a string that holds a `{{ }}` template. Templates are
 * resolved at runtime, so the static check cannot know the final type; the resolved config is
 * validated again before the operation runs.
 */
export function errorsIgnoringTemplates(errors: ErrorObject[], instance: JsonValue): ErrorObject[] {
  return errors.filter((error) => {
    // `if` only says "the then/else branch failed"; the branch's own errors are reported too.
    if (error.keyword === "if") return false;
    if (error.keyword === "required" || error.keyword === "additionalProperties") return true;
    const value = valueAtPointer(instance, error.instancePath);
    return !(typeof value === "string" && containsTemplate(value));
  });
}

export function isSchemaObject(value: unknown): value is JsonObject {
  return isJsonObject(value);
}
