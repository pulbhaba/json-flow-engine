import type { HttpMethod } from "../operations/builtin/http.js";
import type { JsonObject, JsonValue } from "../json.js";

/** The integration manifest format version this engine understands. */
export const INTEGRATION_SCHEMA_VERSION = 1;

export const INTEGRATION_AUTH_TYPES = ["none", "bearer", "basic", "header", "query"] as const;

/**
 * How a credential is attached to a request. The secret itself is never part of a manifest; the
 * workflow names a credential and the engine resolves it at call time.
 */
export type IntegrationAuth =
  | { type: "none" }
  /** `Authorization: Bearer <secret>` */
  | { type: "bearer" }
  /** `Authorization: Basic base64(<username>:<password>)` */
  | { type: "basic" }
  /** The secret is sent in the named request header. */
  | { type: "header"; name: string }
  /** The secret is sent in the named query parameter. */
  | { type: "query"; name: string };

/**
 * Request template for an action. String values may hold `{{ }}` templates resolved against the
 * action input when the action is called; the resulting URL must stay on an allowed host.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type IntegrationRequest = {
  method: HttpMethod;
  /** Path relative to `baseUrl`; must start with `/`. */
  path: string;
  query?: JsonObject;
  headers?: Record<string, string>;
  body?: JsonValue;
};

/** Maps the HTTP response to the action output. Omit it to return the response body. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type IntegrationResponse = {
  /** Template or JSON value describing the output, resolved against the HTTP response. */
  output?: JsonValue;
  /** Statuses treated as success. Default: any 2xx. */
  successStatus?: number[];
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type IntegrationAction = {
  description?: string;
  /** JSON Schema (draft 2020-12) the action input must satisfy. */
  inputSchema: JsonObject;
  request: IntegrationRequest;
  response?: IntegrationResponse;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type IntegrationManifest = {
  /** Format version. Only `1` exists; may be omitted. */
  schemaVersion?: 1;
  /** Provider id, unique across built-in and user integrations (for example `hubspot`). */
  provider: string;
  name?: string;
  description?: string;
  /** Absolute `https` URL every action path is resolved against. */
  baseUrl: string;
  /** Exact hostnames requests may reach; must include the `baseUrl` host. */
  allowedHosts: string[];
  auth: IntegrationAuth;
  /** Actions by name. */
  actions: Record<string, IntegrationAction>;
};
