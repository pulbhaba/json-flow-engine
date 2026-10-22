import { JsonFlowError } from "../errors.js";
import { isJsonObject, jsonTypeName, type JsonObject, type JsonValue } from "../json.js";
import {
  containsTemplate,
  formatReference,
  parseTemplate,
  type ParsedTemplate,
  type PathSegment,
  type ReferenceExpression,
  type Expression,
} from "./parse.js";

/** The data an expression can read. */
export interface ExpressionScope {
  input: JsonValue;
  steps: Readonly<Record<string, JsonValue>>;
  constants: JsonObject;
}

export type LookupResult = { found: true; value: JsonValue } | { found: false; missingAt: string };

/** Walks a reference path. `found: false` means a segment was absent or passed through null. */
export function lookupReference(
  expression: ReferenceExpression,
  scope: ExpressionScope,
): LookupResult {
  let current: JsonValue | undefined;
  switch (expression.root) {
    case "input":
      current = scope.input;
      break;
    case "steps":
      current = null;
      break;
    case "constants":
      current = scope.constants;
      break;
    default:
      expression.root satisfies never;
      throw new Error("Unhandled reference root");
  }
  const walked: PathSegment[] = [];
  for (const [i, segment] of expression.segments.entries()) {
    if (expression.root === "steps" && i === 0) {
      if (segment.kind !== "key") return { found: false, missingAt: "steps" };
      const output = scope.steps[segment.key];
      if (output === undefined) {
        return { found: false, missingAt: formatReference("steps", [segment]) };
      }
      current = output;
      walked.push(segment);
      continue;
    }
    const next = step(current, segment);
    if (next === undefined) {
      return { found: false, missingAt: formatReference(expression.root, walked) };
    }
    current = next;
    walked.push(segment);
  }
  return { found: true, value: current };
}

function step(current: JsonValue | undefined, segment: PathSegment): JsonValue | undefined {
  if (current === undefined || current === null) return undefined;
  if (segment.kind === "index") {
    return Array.isArray(current) ? current[segment.index] : undefined;
  }
  if (!isJsonObject(current)) return undefined;
  return Object.prototype.hasOwnProperty.call(current, segment.key)
    ? current[segment.key]
    : undefined;
}

export function evaluateExpression(
  expression: Expression,
  scope: ExpressionScope,
  raw: string,
): JsonValue {
  if (expression.kind === "literal") return expression.value;
  const result = lookupReference(expression, scope);
  if (result.found && result.value !== null) return result.value;
  if (expression.fallback !== undefined) return expression.fallback;
  if (result.found) return null;
  throw new JsonFlowError(
    "EXPRESSION_UNRESOLVED",
    `Cannot resolve "${raw.trim()}": "${result.missingAt}" has no value. Add "?? <default>" to provide a fallback.`,
    { details: { expression: raw.trim(), missingAt: result.missingAt } },
  );
}

const templateCache = new Map<string, ParsedTemplate>();

export function getParsedTemplate(text: string): ParsedTemplate {
  let parsed = templateCache.get(text);
  if (parsed === undefined) {
    parsed = parseTemplate(text);
    if (templateCache.size > 10_000) templateCache.clear();
    templateCache.set(text, parsed);
  }
  return parsed;
}

/**
 * Resolves one string. A string that is exactly one expression yields the referenced JSON
 * value with its type intact; any other string is interpolated and may only embed strings,
 * numbers and booleans.
 */
export function resolveString(text: string, scope: ExpressionScope): JsonValue {
  if (!containsTemplate(text)) return text;
  const parsed = getParsedTemplate(text);
  const first = parsed.parts[0];
  if (parsed.single && first?.kind === "expression") {
    return evaluateExpression(first.expression, scope, first.raw);
  }
  let out = "";
  for (const part of parsed.parts) {
    if (part.kind === "text") {
      out += part.text;
      continue;
    }
    const value = evaluateExpression(part.expression, scope, part.raw);
    if (typeof value === "string") out += value;
    else if (typeof value === "number" || typeof value === "boolean") out += String(value);
    else {
      throw new JsonFlowError(
        "EXPRESSION_TYPE",
        `Cannot interpolate ${jsonTypeName(value)} value of "${part.raw.trim()}" into "${text}": only strings, numbers and booleans can be embedded in text`,
        {
          details: { expression: part.raw.trim(), template: text, valueType: jsonTypeName(value) },
        },
      );
    }
  }
  return out;
}

/** Resolves every string inside a JSON value. Object keys are never templated. */
export function resolveValue(value: JsonValue, scope: ExpressionScope): JsonValue {
  if (typeof value === "string") return resolveString(value, scope);
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, scope));
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, scope);
    return out;
  }
  return value;
}

/** Like resolveValue but leaves the listed top-level keys untouched (used for nested step lists). */
export function resolveObjectExcept(
  value: JsonObject,
  scope: ExpressionScope,
  rawKeys: ReadonlySet<string>,
): JsonObject {
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = rawKeys.has(key) ? entry : resolveValue(entry, scope);
  }
  return out;
}

export interface FoundReference {
  expression: ReferenceExpression;
  raw: string;
  /** JSON pointer (relative to the walked value) of the string holding the expression. */
  pointer: string;
}

export interface TemplateScanIssue {
  pointer: string;
  error: JsonFlowError;
}

/**
 * Statically walks a JSON value, parsing every template. Returns the references it found and
 * the syntax errors it hit, so validation can report all problems at once.
 */
export function scanTemplates(
  value: JsonValue,
  pointer: string,
  references: FoundReference[],
  issues: TemplateScanIssue[],
  skipKeys: ReadonlySet<string> = new Set(),
): void {
  if (typeof value === "string") {
    if (!containsTemplate(value)) return;
    try {
      const parsed = getParsedTemplate(value);
      for (const part of parsed.parts) {
        if (part.kind === "expression" && part.expression.kind === "reference") {
          references.push({ expression: part.expression, raw: part.raw, pointer });
        }
      }
    } catch (error) {
      if (error instanceof JsonFlowError) issues.push({ pointer, error });
      else throw error;
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => {
      scanTemplates(entry, `${pointer}/${i}`, references, issues);
    });
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (skipKeys.has(key)) continue;
      scanTemplates(
        entry,
        `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        references,
        issues,
      );
    }
  }
}
