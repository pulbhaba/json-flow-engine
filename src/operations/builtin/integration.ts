import { JsonFlowError } from "../../errors.js";
import { evaluateExpression, getParsedTemplate, resolveValue } from "../../expressions/resolve.js";
import type { ExpressionScope } from "../../expressions/resolve.js";
import { containsTemplate } from "../../expressions/parse.js";
import type { UrlPolicy } from "../../http/url-policy.js";
import type { LoadedIntegration } from "../../integrations/load.js";
import type { IntegrationAction, IntegrationManifest } from "../../integrations/types.js";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../../json.js";
import { createAjv, formatAjvError, type ValidateFunction } from "../../schemas/ajv.js";
import type { OperationDefinition } from "../types.js";
import { createHttpRequestOperation, type FetchLike, type HttpRequestConfig } from "./http.js";

export const INTEGRATION_CALL_CONFIG_SCHEMA_ID =
  "https://json-flow-engine.dev/schemas/v1/integration.call.json";

export const CREDENTIAL_NAME_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,63}$";
/** Environment variable prefix; credential `my-token` is read from `JSON_FLOW_CREDENTIAL_MY_TOKEN`. */
export const CREDENTIAL_ENV_PREFIX = "JSON_FLOW_CREDENTIAL_";

export const integrationCallConfigSchema: JsonObject = {
  $id: INTEGRATION_CALL_CONFIG_SCHEMA_ID,
  type: "object",
  properties: {
    provider: { type: "string", minLength: 1 },
    action: { type: "string", minLength: 1 },
    input: { description: "Action input; validated against the action's inputSchema." },
    credentials: {
      type: "string",
      pattern: CREDENTIAL_NAME_PATTERN,
      description:
        "Name of a credential (never the secret). Resolved from the engine's credential source or the environment.",
    },
  },
  required: ["provider", "action"],
  additionalProperties: false,
};

export interface IntegrationCallConfig {
  provider: string;
  action: string;
  input?: JsonValue;
  credentials?: string;
}

/** Host-provided credential lookup (the "run context"). Return `undefined` when unknown. */
export type CredentialSource =
  Readonly<Record<string, string>> | ((name: string) => string | undefined);

export interface IntegrationCallOptions {
  integrations: readonly LoadedIntegration[];
  credentials?: CredentialSource;
  /** Environment to read `JSON_FLOW_CREDENTIAL_*` from. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
  urlPolicy?: UrlPolicy;
}

const SECRET_PLACEHOLDER = "[redacted]";

function invalid(message: string, details: JsonObject = {}): JsonFlowError {
  return new JsonFlowError("INTEGRATION_REQUEST_INVALID", message, { details });
}

function lookupCredential(options: IntegrationCallOptions, name: string): string | undefined {
  const source = options.credentials;
  let value: string | undefined;
  if (typeof source === "function") value = source(name);
  else if (source !== undefined && Object.prototype.hasOwnProperty.call(source, name)) {
    value = source[name];
  }
  if (value === undefined || value === "") {
    const env = options.env ?? process.env;
    value = env[`${CREDENTIAL_ENV_PREFIX}${name.toUpperCase().replace(/-/g, "_")}`];
  }
  return value === undefined || value === "" ? undefined : value;
}

/** Replaces every occurrence of a secret inside a JSON value (defence in depth for echoes). */
function scrubValue(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (secrets.length === 0) return value;
  let text = JSON.stringify(value);
  for (const secret of secrets) {
    text = text.split(JSON.stringify(secret).slice(1, -1)).join(SECRET_PLACEHOLDER);
  }
  const parsed: unknown = JSON.parse(text);
  return isJsonValue(parsed) ? parsed : null;
}

function scrubString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(SECRET_PLACEHOLDER);
  return out;
}

function scrubError(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof JsonFlowError)) {
    return new JsonFlowError("OPERATION_FAILED", "integration call failed", {});
  }
  const details = scrubValue(error.details, secrets);
  return new JsonFlowError(error.code, scrubString(error.message, secrets), {
    retryable: error.retryable,
    details: isJsonObject(details) ? details : {},
    ...(error.path === undefined ? {} : { path: error.path }),
  });
}

function scalarToString(value: JsonValue, what: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw invalid(`${what} must resolve to a string, number or boolean`);
}

/**
 * Resolves the request path. Interpolated values are percent-encoded so input can never add
 * path separators, a query string or a fragment.
 */
function resolvePath(path: string, scope: ExpressionScope): string {
  if (!containsTemplate(path)) return path;
  let out = "";
  for (const part of getParsedTemplate(path).parts) {
    if (part.kind === "text") out += part.text;
    else {
      const value = evaluateExpression(part.expression, scope, part.raw);
      out += encodeURIComponent(scalarToString(value, `path expression "${part.raw.trim()}"`));
    }
  }
  return out;
}

function buildHttpConfig(
  manifest: IntegrationManifest,
  action: IntegrationAction,
  input: JsonValue,
  secret: string | undefined,
): HttpRequestConfig {
  // Request scope: `input` is the validated action input; workflow steps and constants are
  // deliberately not visible to manifests.
  const scope: ExpressionScope = { input, steps: {}, constants: {} };
  const request = action.request;

  const base = new URL(manifest.baseUrl);
  const path = resolvePath(request.path, scope);
  const url = new URL(`${base.origin}${base.pathname.replace(/\/$/, "")}${path}`);
  const dotSegment = url.pathname.split("/").some((s) => s === "." || s === "..");
  if (
    url.origin !== base.origin ||
    !manifest.allowedHosts.includes(url.hostname) ||
    url.search !== "" ||
    url.hash !== "" ||
    path.includes("?") ||
    path.includes("#") ||
    dotSegment ||
    !path.startsWith("/")
  ) {
    throw invalid(`Resolved request path for "${manifest.provider}" is not allowed`, {
      provider: manifest.provider,
    });
  }

  const query: Record<string, string | number | boolean | (string | number | boolean)[]> = {};
  if (request.query !== undefined) {
    const resolved = resolveValue(request.query, scope);
    if (isJsonObject(resolved)) {
      for (const [key, value] of Object.entries(resolved)) {
        if (value === null) continue;
        if (Array.isArray(value)) {
          query[key] = value.map((entry) => {
            if (entry === null || typeof entry === "object") {
              throw invalid(`query parameter "${key}" must hold scalar values`);
            }
            return entry;
          });
        } else if (typeof value === "object") {
          throw invalid(`query parameter "${key}" must be a scalar or an array of scalars`);
        } else query[key] = value;
      }
    }
  }

  let headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(request.headers ?? {})) {
    const value = resolveValue(template, scope);
    if (value === null) continue;
    const text = scalarToString(value, `header "${name}"`);
    if (/[\r\n\0]/.test(text)) throw invalid(`header "${name}" contains control characters`);
    headers[name] = text;
  }

  const auth = manifest.auth;
  if (auth.type !== "none") {
    if (secret === undefined) throw invalid("credential missing");
    if (/[\r\n\0]/.test(secret)) throw invalid("credential contains control characters");
    const setHeader = (name: string, value: string): void => {
      const lower = name.toLowerCase();
      headers = Object.fromEntries(
        Object.entries(headers).filter(([key]) => key.toLowerCase() !== lower),
      );
      headers[name] = value;
    };
    switch (auth.type) {
      case "bearer":
        setHeader("authorization", `Bearer ${secret}`);
        break;
      case "basic":
        setHeader("authorization", `Basic ${Buffer.from(secret, "utf8").toString("base64")}`);
        break;
      case "header":
        setHeader(auth.name, secret);
        break;
      case "query":
        query[auth.name] = secret;
        break;
      default:
        auth satisfies never;
    }
  }

  const config: HttpRequestConfig = {
    method: request.method,
    url: url.toString(),
    expectStatus: action.response?.successStatus ?? "2xx",
  };
  if (Object.keys(query).length > 0) config.query = query;
  if (Object.keys(headers).length > 0) config.headers = headers;
  if (request.body !== undefined) config.body = resolveValue(request.body, scope);
  return config;
}

export function createIntegrationCallOperation(
  options: IntegrationCallOptions,
): OperationDefinition<IntegrationCallConfig> {
  const providers = new Map<string, IntegrationManifest>();
  for (const item of options.integrations) providers.set(item.provider, item.manifest);
  const validators = new Map<string, ValidateFunction>();
  const http = createHttpRequestOperation({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.urlPolicy === undefined ? {} : { urlPolicy: options.urlPolicy }),
  });

  function inputValidator(
    manifest: IntegrationManifest,
    name: string,
    action: IntegrationAction,
  ): ValidateFunction {
    const key = `${manifest.provider}\u0000${name}`;
    let validate = validators.get(key);
    if (validate === undefined) {
      validate = createAjv().compile(action.inputSchema);
      validators.set(key, validate);
    }
    return validate;
  }

  return {
    type: "integration.call",
    description:
      "Calls an action of a built-in or user integration through the http.request machinery.",
    configSchema: integrationCallConfigSchema,
    effects: "external",
    async execute(context) {
      const { provider, action: actionName } = context.config;
      const manifest = providers.get(provider);
      if (manifest === undefined) {
        throw new JsonFlowError(
          "INTEGRATION_UNKNOWN",
          `Unknown integration provider "${provider}"`,
          {
            details: { provider, known: [...providers.keys()].sort() },
          },
        );
      }
      const action = Object.prototype.hasOwnProperty.call(manifest.actions, actionName)
        ? manifest.actions[actionName]
        : undefined;
      if (action === undefined) {
        throw new JsonFlowError(
          "INTEGRATION_UNKNOWN",
          `Integration "${provider}" has no action "${actionName}"`,
          {
            details: { provider, action: actionName, known: Object.keys(manifest.actions).sort() },
          },
        );
      }

      const input: JsonValue = context.config.input ?? {};
      const validate = inputValidator(manifest, actionName, action);
      if (!validate(input)) {
        const issues = (validate.errors ?? []).map(
          (error) => `${error.instancePath || "/"}: ${formatAjvError(error)}`,
        );
        throw new JsonFlowError(
          "INTEGRATION_INPUT_INVALID",
          `Input for ${provider}.${actionName} is invalid: ${issues.join("; ")}`,
          { details: { provider, action: actionName, issues } },
        );
      }

      let secret: string | undefined;
      const credentialName = context.config.credentials;
      if (manifest.auth.type === "none") {
        if (credentialName !== undefined) {
          throw invalid(`Integration "${provider}" does not use credentials`, { provider });
        }
      } else {
        if (credentialName === undefined) {
          throw new JsonFlowError(
            "INTEGRATION_CREDENTIAL_MISSING",
            `Integration "${provider}" requires a "credentials" name`,
            { details: { provider } },
          );
        }
        secret = lookupCredential(options, credentialName);
        if (secret === undefined) {
          throw new JsonFlowError(
            "INTEGRATION_CREDENTIAL_MISSING",
            `Credential "${credentialName}" is not available: provide it to the engine or set ${CREDENTIAL_ENV_PREFIX}${credentialName.toUpperCase().replace(/-/g, "_")}`,
            { details: { provider, credential: credentialName } },
          );
        }
      }
      const secrets = secret === undefined ? [] : [secret];
      if (secret !== undefined && manifest.auth.type === "basic") {
        secrets.push(Buffer.from(secret, "utf8").toString("base64"));
      }

      try {
        const httpConfig = buildHttpConfig(manifest, action, input, secret);
        const response = await http.execute({
          ...context,
          type: "http.request",
          config: httpConfig,
        });
        let output: JsonValue = response.body;
        const mapping = action.response?.output;
        if (mapping !== undefined) {
          // Response scope: `input` is `{ status, headers, body }` of the HTTP response.
          output = resolveValue(mapping, {
            input: { status: response.status, headers: response.headers, body: response.body },
            steps: {},
            constants: {},
          });
        }
        return scrubValue(output, secrets);
      } catch (error) {
        throw scrubError(error, secrets);
      }
    },
  };
}
