import type { JsonObject } from "../json.js";
import { HTTP_METHODS } from "../operations/builtin/http.js";
import { INTEGRATION_AUTH_TYPES } from "./types.js";

/**
 * JSON Schema (draft 2020-12) for integration manifests, version 1. `scripts/write-schema.js`
 * writes it to `schemas/integration.schema.json` so editors and AI agents can use it directly.
 */

export const INTEGRATION_SCHEMA_ID = "https://json-flow-engine.dev/schemas/v1/integration.json";
export const PROVIDER_PATTERN = "^[a-z0-9][a-z0-9_-]*$";
export const ACTION_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]*$";
export const HOSTNAME_PATTERN =
  "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$";

const authSchema: JsonObject = {
  type: "object",
  properties: {
    type: { enum: [...INTEGRATION_AUTH_TYPES] },
    name: { type: "string", minLength: 1 },
  },
  required: ["type"],
  if: { properties: { type: { enum: ["header", "query"] } }, required: ["type"] },
  then: { properties: { name: { type: "string" } }, required: ["name"] },
  else: { properties: { name: false } },
  additionalProperties: false,
};

const requestSchema: JsonObject = {
  type: "object",
  properties: {
    method: { enum: [...HTTP_METHODS] },
    path: { type: "string", pattern: "^/" },
    query: { type: "object" },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: {},
  },
  required: ["method", "path"],
  additionalProperties: false,
};

const responseSchema: JsonObject = {
  type: "object",
  properties: {
    output: {},
    successStatus: {
      type: "array",
      items: { type: "integer", minimum: 100, maximum: 599 },
      minItems: 1,
      uniqueItems: true,
    },
  },
  additionalProperties: false,
};

const actionSchema: JsonObject = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
    request: requestSchema,
    response: responseSchema,
  },
  required: ["inputSchema", "request"],
  additionalProperties: false,
};

export const integrationSchema: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: INTEGRATION_SCHEMA_ID,
  title: "json-flow-engine integration manifest",
  type: "object",
  properties: {
    $schema: { type: "string" },
    schemaVersion: { const: 1 },
    provider: { type: "string", minLength: 1, maxLength: 64, pattern: PROVIDER_PATTERN },
    name: { type: "string" },
    description: { type: "string" },
    baseUrl: { type: "string", format: "uri", pattern: "^https://" },
    allowedHosts: {
      type: "array",
      items: { type: "string", maxLength: 253, pattern: HOSTNAME_PATTERN },
      minItems: 1,
      uniqueItems: true,
    },
    auth: authSchema,
    actions: {
      type: "object",
      propertyNames: { maxLength: 128, pattern: ACTION_NAME_PATTERN },
      additionalProperties: actionSchema,
      minProperties: 1,
    },
  },
  required: ["provider", "baseUrl", "allowedHosts", "auth", "actions"],
  additionalProperties: false,
};
