import type { JsonObject } from "../json.js";

export const CONDITION_SCHEMA_ID = "https://json-flow-engine.dev/schemas/v1/condition.json";

/**
 * Structured condition schema. It carries its own `$id` so `$ref: "#"` recursion resolves to
 * the condition itself even when it is embedded in another schema's `$defs`.
 */
export const conditionSchema: JsonObject = {
  $id: CONDITION_SCHEMA_ID,
  description:
    "A boolean, a string template resolving to a boolean, or exactly one operator object: equals, not, all, any, defined, greaterThan, lessThan.",
  oneOf: [
    { type: "boolean" },
    { type: "string", minLength: 1 },
    {
      type: "object",
      properties: { equals: { type: "array", minItems: 2, maxItems: 2 } },
      required: ["equals"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { not: { $ref: "#" } },
      required: ["not"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { all: { type: "array", minItems: 1, items: { $ref: "#" } } },
      required: ["all"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { any: { type: "array", minItems: 1, items: { $ref: "#" } } },
      required: ["any"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { defined: { type: "string", minLength: 1 } },
      required: ["defined"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { greaterThan: { type: "array", minItems: 2, maxItems: 2 } },
      required: ["greaterThan"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { lessThan: { type: "array", minItems: 2, maxItems: 2 } },
      required: ["lessThan"],
      additionalProperties: false,
    },
  ],
};
