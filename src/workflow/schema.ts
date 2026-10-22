import type { JsonObject } from "../json.js";
import { CONDITION_SCHEMA_ID, conditionSchema } from "../schemas/condition.js";
import {
  ASSERT_CONFIG_SCHEMA_ID,
  assertStepConfigSchema,
  CONDITION_CONFIG_SCHEMA_ID,
  conditionStepConfigSchema,
} from "../operations/builtin/control.js";
import {
  TRANSFORM_CONFIG_SCHEMA_ID,
  transformConfigSchema,
} from "../operations/builtin/transform.js";
import { HTTP_CONFIG_SCHEMA_ID, httpRequestConfigSchema } from "../operations/builtin/http.js";

/**
 * JSON Schema (draft 2020-12) for the workflow format, version 1. `scripts/write-schema.js`
 * writes it to `schemas/workflow.schema.json` so editors can use it directly. Built-in operation
 * configs are embedded as `$defs` resources so a JSON file gets completion for them too.
 */

export const WORKFLOW_SCHEMA_ID = "https://json-flow-engine.dev/schemas/v1/workflow.json";
export const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
export const STEP_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]*$";
export const OPERATION_TYPE_PATTERN = "^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$";

export const retrySchema: JsonObject = {
  type: "object",
  properties: {
    maxAttempts: { type: "integer", minimum: 1 },
    initialDelayMs: { type: "integer", minimum: 0 },
    maxDelayMs: { type: "integer", minimum: 0 },
    backoffMultiplier: { type: "number", minimum: 1 },
    jitter: { type: "boolean" },
    retryOn: { enum: ["retryable", "any"] },
  },
  required: ["maxAttempts"],
  additionalProperties: false,
};

function builtinConfig(type: string, schemaId: string): JsonObject {
  return {
    if: { properties: { type: { const: type } }, required: ["type"] },
    then: { properties: { config: { $ref: schemaId } } },
  };
}

export const stepSchema: JsonObject = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128, pattern: STEP_ID_PATTERN },
    type: { type: "string", minLength: 1, maxLength: 128, pattern: OPERATION_TYPE_PATTERN },
    description: { type: "string" },
    config: { type: "object" },
    timeoutMs: { type: "integer", minimum: 1 },
    retry: { $ref: "#/$defs/retry" },
    onError: { enum: ["fail", "continue"] },
    idempotencyKey: { type: "string", minLength: 1 },
  },
  required: ["id", "type", "config"],
  additionalProperties: false,
  allOf: [
    builtinConfig("control.condition", CONDITION_CONFIG_SCHEMA_ID),
    builtinConfig("control.assert", ASSERT_CONFIG_SCHEMA_ID),
    builtinConfig("data.transform", TRANSFORM_CONFIG_SCHEMA_ID),
    builtinConfig("http.request", HTTP_CONFIG_SCHEMA_ID),
  ],
};

export const workflowSchema: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: WORKFLOW_SCHEMA_ID,
  title: "json-flow-engine workflow (format version 1)",
  type: "object",
  properties: {
    $schema: { type: "string" },
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1, maxLength: 128, pattern: ID_PATTERN },
    version: { type: "integer", minimum: 1 },
    description: { type: "string" },
    inputSchema: { type: "object" },
    constants: { type: "object" },
    execution: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", minimum: 1 },
        maxSteps: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    output: {},
    steps: { type: "array", minItems: 1, items: { $ref: "#/$defs/step" } },
  },
  required: ["id", "version", "steps"],
  additionalProperties: false,
  $defs: {
    retry: retrySchema,
    step: stepSchema,
    condition: conditionSchema,
    conditionStepConfig: {
      ...conditionStepConfigSchema,
      properties: {
        if: { $ref: CONDITION_SCHEMA_ID },
        then: { type: "array", items: { $ref: `${WORKFLOW_SCHEMA_ID}#/$defs/step` } },
        else: { type: "array", items: { $ref: `${WORKFLOW_SCHEMA_ID}#/$defs/step` } },
      },
    },
    assertStepConfig: assertStepConfigSchema,
    transformConfig: transformConfigSchema,
    httpRequestConfig: httpRequestConfigSchema,
  },
};

export { CONDITION_SCHEMA_ID };
