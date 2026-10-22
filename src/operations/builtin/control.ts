import { JsonFlowError } from "../../errors.js";
import { parseTemplate } from "../../expressions/parse.js";
import {
  lookupReference,
  resolveString,
  resolveValue,
  type ExpressionScope,
} from "../../expressions/resolve.js";
import {
  isJsonObject,
  jsonEquals,
  jsonTypeName,
  type JsonObject,
  type JsonValue,
} from "../../json.js";
import { CONDITION_SCHEMA_ID, conditionSchema } from "../../schemas/condition.js";
import type { OperationDefinition } from "../types.js";

export const CONDITION_CONFIG_SCHEMA_ID =
  "https://json-flow-engine.dev/schemas/v1/control.condition.json";
export const ASSERT_CONFIG_SCHEMA_ID =
  "https://json-flow-engine.dev/schemas/v1/control.assert.json";

/** Config schema of `control.condition`. Nested steps are validated by the workflow walker. */
export const conditionStepConfigSchema: JsonObject = {
  $id: CONDITION_CONFIG_SCHEMA_ID,
  type: "object",
  properties: {
    if: { $ref: CONDITION_SCHEMA_ID },
    then: { type: "array", items: { type: "object" } },
    else: { type: "array", items: { type: "object" } },
  },
  required: ["if", "then"],
  additionalProperties: false,
};

/** Config schema of `control.assert`. */
export const assertStepConfigSchema: JsonObject = {
  $id: ASSERT_CONFIG_SCHEMA_ID,
  type: "object",
  properties: {
    condition: { $ref: CONDITION_SCHEMA_ID },
    message: { type: "string" },
  },
  required: ["condition"],
  additionalProperties: false,
};

/** Config keys the engine must not template-resolve up front (they are evaluated lazily). */
export const CONDITION_RAW_KEYS: ReadonlySet<string> = new Set(["if", "then", "else"]);
export const ASSERT_RAW_KEYS: ReadonlySet<string> = new Set(["condition"]);

function conditionError(message: string, condition: JsonValue): JsonFlowError {
  return new JsonFlowError("CONDITION_INVALID", message, {
    details: { condition: typeof condition === "string" ? condition : JSON.stringify(condition) },
  });
}

function operand(value: JsonValue | undefined, condition: JsonValue): JsonValue {
  if (value === undefined) throw conditionError("operator needs two operands", condition);
  return value;
}

/**
 * Evaluates a structured condition against the scope. Operands are resolved with the normal
 * template rules, so `{{steps.create.status}}` compares as a number, not a string.
 */
export function evaluateCondition(condition: JsonValue, scope: ExpressionScope): boolean {
  if (typeof condition === "boolean") return condition;
  if (typeof condition === "string") {
    const value = resolveString(condition, scope);
    if (typeof value !== "boolean") {
      throw conditionError(
        `condition "${condition}" resolved to ${jsonTypeName(value)}; a string condition must resolve to a boolean`,
        condition,
      );
    }
    return value;
  }
  if (!isJsonObject(condition)) {
    throw conditionError(
      `condition must be a boolean, a template or an operator object`,
      condition,
    );
  }
  const keys = Object.keys(condition);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) {
    throw conditionError("an operator object must have exactly one key", condition);
  }
  const argument = condition[key];
  switch (key) {
    case "not":
      return !evaluateCondition(argument ?? null, scope);
    case "all":
      if (!Array.isArray(argument)) throw conditionError("'all' needs an array", condition);
      return argument.every((entry) => evaluateCondition(entry, scope));
    case "any":
      if (!Array.isArray(argument)) throw conditionError("'any' needs an array", condition);
      return argument.some((entry) => evaluateCondition(entry, scope));
    case "equals": {
      if (!Array.isArray(argument)) throw conditionError("'equals' needs [left, right]", condition);
      const left = resolveValue(operand(argument[0], condition), scope);
      const right = resolveValue(operand(argument[1], condition), scope);
      return jsonEquals(left, right);
    }
    case "greaterThan":
    case "lessThan": {
      if (!Array.isArray(argument)) throw conditionError(`'${key}' needs [left, right]`, condition);
      const left = resolveValue(operand(argument[0], condition), scope);
      const right = resolveValue(operand(argument[1], condition), scope);
      if (typeof left !== "number" || typeof right !== "number") {
        throw conditionError(
          `'${key}' needs two numbers, got ${jsonTypeName(left)} and ${jsonTypeName(right)}`,
          condition,
        );
      }
      return key === "greaterThan" ? left > right : left < right;
    }
    case "defined": {
      if (typeof argument !== "string")
        throw conditionError("'defined' needs a reference string", condition);
      const parsed = parseTemplate(argument);
      const part = parsed.parts[0];
      if (!parsed.single || part?.kind !== "expression" || part.expression.kind !== "reference") {
        throw conditionError(
          `'defined' needs a single reference such as "{{input.optionalField}}"`,
          condition,
        );
      }
      const result = lookupReference(part.expression, scope);
      return result.found && result.value !== null;
    }
    default:
      throw conditionError(`unknown operator "${key}"`, condition);
  }
}

/**
 * `control.condition` is orchestrated by the engine (it has to run nested steps and record
 * them). The definition exists so the registry knows the type and its config schema.
 */
export const conditionOperation: OperationDefinition = {
  type: "control.condition",
  description: "Runs the `then` steps when `if` is true, otherwise the `else` steps.",
  configSchema: conditionStepConfigSchema,
  effects: "none",
  execute() {
    throw new JsonFlowError("OPERATION_FAILED", "control.condition is executed by the engine");
  },
};

export interface AssertConfig {
  condition: JsonValue;
  message?: string;
}

export const assertOperation: OperationDefinition<AssertConfig, { passed: true }> = {
  type: "control.assert",
  description: "Fails the workflow with ASSERTION_FAILED when the condition is false.",
  configSchema: assertStepConfigSchema,
  effects: "none",
  execute({ config, input, steps, constants }) {
    const passed = evaluateCondition(config.condition, { input, steps, constants });
    if (!passed) {
      throw new JsonFlowError("ASSERTION_FAILED", config.message ?? "Assertion failed", {
        details: {
          condition:
            typeof config.condition === "string"
              ? config.condition
              : JSON.stringify(config.condition),
        },
      });
    }
    return { passed: true };
  },
};

export { conditionSchema };
