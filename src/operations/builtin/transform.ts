import type { JsonObject, JsonValue } from "../../json.js";
import type { OperationDefinition } from "../types.js";

export const TRANSFORM_CONFIG_SCHEMA_ID =
  "https://json-flow-engine.dev/schemas/v1/data.transform.json";

export const transformConfigSchema: JsonObject = {
  $id: TRANSFORM_CONFIG_SCHEMA_ID,
  type: "object",
  properties: {
    value: {
      description:
        "Any JSON value; templates inside it are resolved and the result becomes the step output.",
    },
  },
  required: ["value"],
  additionalProperties: false,
};

export interface TransformConfig {
  value: JsonValue;
}

/**
 * `data.transform` maps input and previous outputs into a new JSON value. The engine resolves
 * every template in `config` before calling it, so the operation is the identity on `value`.
 */
export const transformOperation: OperationDefinition<TransformConfig> = {
  type: "data.transform",
  description: "Builds a JSON value from the input, constants and previous step outputs.",
  configSchema: transformConfigSchema,
  effects: "none",
  execute({ config }) {
    return config.value;
  },
};
