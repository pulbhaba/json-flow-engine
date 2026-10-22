import { JsonFlowError } from "../../errors.js";
import { CompiledUrlPolicy, type UrlPolicy } from "../../http/url-policy.js";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../../json.js";
import type { OperationDefinition } from "../types.js";

export const HTTP_CONFIG_SCHEMA_ID = "https://json-flow-engine.dev/schemas/v1/http.request.json";

export const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods whose failed attempts may be retried without an idempotency key (RFC 9110 §9.2.2). */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "DELETE",
]);
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);
const ALWAYS_REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const ERROR_BODY_PREVIEW_CHARS = 512;

export const httpRequestConfigSchema: JsonObject = {
  $id: HTTP_CONFIG_SCHEMA_ID,
  type: "object",
  properties: {
    method: { enum: [...HTTP_METHODS] },
    url: { type: "string", minLength: 1 },
    query: {
      type: "object",
      additionalProperties: {
        oneOf: [
          { type: ["string", "number", "boolean"] },
          { type: "array", items: { type: ["string", "number", "boolean"] } },
        ],
      },
    },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: { description: "JSON request body. Sent as application/json unless bodyFormat is text." },
    bodyFormat: { enum: ["json", "text"] },
    timeoutMs: { type: "integer", minimum: 1 },
    responseType: { enum: ["auto", "json", "text", "none"] },
    expectStatus: {
      oneOf: [
        { enum: ["2xx", "any"] },
        { type: "array", items: { type: "integer", minimum: 100, maximum: 599 }, minItems: 1 },
      ],
    },
    maxResponseBytes: { type: "integer", minimum: 1 },
    idempotent: {
      type: "boolean",
      description:
        "Mark a POST/PATCH as safe to retry. Alternatively set the step's idempotencyKey.",
    },
  },
  required: ["method", "url"],
  additionalProperties: false,
};

export interface HttpRequestConfig {
  method: HttpMethod;
  url: string;
  query?: Record<string, string | number | boolean | (string | number | boolean)[]>;
  headers?: Record<string, string>;
  body?: JsonValue;
  bodyFormat?: "json" | "text";
  timeoutMs?: number;
  responseType?: "auto" | "json" | "text" | "none";
  expectStatus?: "2xx" | "any" | number[];
  maxResponseBytes?: number;
  idempotent?: boolean;
}

export interface HttpResponseOutput extends JsonObject {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: JsonValue;
  url: string;
}

/** The subset of `fetch` the operation uses; inject a replacement to test against a fake server. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOperationOptions {
  fetch?: FetchLike;
  urlPolicy?: UrlPolicy;
}

/** Builds the output value a mock should return to look like a real `http.request` response. */
export function httpResponse(
  status: number,
  body: JsonValue = null,
  headers: Record<string, string> = {},
): HttpResponseOutput {
  return { status, statusText: "", headers, body, url: "" };
}

function sanitizeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function sanitizeHeaderNames(headers: Record<string, string> | undefined): string[] {
  return Object.keys(headers ?? {}).map((name) => name.toLowerCase());
}

function redactedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = ALWAYS_REDACTED_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value;
  });
  return out;
}

function isRetriableRequest(
  config: HttpRequestConfig,
  idempotencyKey: string | undefined,
): boolean {
  return (
    IDEMPOTENT_METHODS.has(config.method) ||
    config.idempotent === true ||
    idempotencyKey !== undefined
  );
}

function statusAccepted(status: number, expect: HttpRequestConfig["expectStatus"]): boolean {
  if (expect === "any") return true;
  if (Array.isArray(expect)) return expect.includes(status);
  return status >= 200 && status <= 299;
}

async function readBodyBounded(
  response: Response,
  maxBytes: number,
  url: URL,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value: unknown = next.value;
      if (!(value instanceof Uint8Array)) {
        throw new JsonFlowError(
          "HTTP_RESPONSE_INVALID",
          `Response from ${sanitizeUrl(url)} produced a non-binary chunk`,
          {
            details: { url: sanitizeUrl(url) },
          },
        );
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new JsonFlowError(
          "HTTP_RESPONSE_TOO_LARGE",
          `Response from ${sanitizeUrl(url)} exceeds maxResponseBytes (${maxBytes})`,
          { details: { url: sanitizeUrl(url), maxResponseBytes: maxBytes } },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseBody(
  bytes: Uint8Array,
  contentType: string,
  responseType: NonNullable<HttpRequestConfig["responseType"]>,
  url: URL,
): JsonValue {
  if (responseType === "none") return null;
  const text = new TextDecoder().decode(bytes);
  const looksJson = /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType);
  if (responseType === "text" || (responseType === "auto" && !looksJson)) return text;
  if (text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new JsonFlowError(
      "HTTP_RESPONSE_INVALID",
      `Response from ${sanitizeUrl(url)} is not valid JSON`,
      { details: { url: sanitizeUrl(url), contentType }, cause: error },
    );
  }
  if (!isJsonValue(parsed)) {
    throw new JsonFlowError(
      "HTTP_RESPONSE_INVALID",
      `Response from ${sanitizeUrl(url)} is not plain JSON`,
      {
        details: { url: sanitizeUrl(url), contentType },
      },
    );
  }
  return parsed;
}

export function createHttpRequestOperation(
  options: HttpOperationOptions = {},
): OperationDefinition<HttpRequestConfig, HttpResponseOutput> {
  const policy = new CompiledUrlPolicy(options.urlPolicy ?? {});
  const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  return {
    type: "http.request",
    description: "Makes an HTTP request with bounded response size and a URL policy.",
    configSchema: httpRequestConfigSchema,
    effects: "external",
    async execute({ config, signal, idempotencyKey }) {
      let url: URL;
      try {
        url = new URL(config.url);
      } catch {
        throw new JsonFlowError("HTTP_URL_INVALID", `Invalid URL "${config.url}"`, {
          details: { url: config.url },
        });
      }
      for (const [key, value] of Object.entries(config.query ?? {})) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          url.searchParams.append(key, String(entry));
        }
      }
      const decision = policy.check(url);
      if (!decision.allowed) {
        throw new JsonFlowError(
          "HTTP_URL_FORBIDDEN",
          `Request to ${sanitizeUrl(url)} refused by URL policy: ${decision.reason ?? "not allowed"}`,
          { details: { url: sanitizeUrl(url), reason: decision.reason ?? "not allowed" } },
        );
      }

      const headers = new Headers(config.headers ?? {});
      let body: string | undefined;
      if (config.body !== undefined) {
        if (config.bodyFormat === "text") {
          if (typeof config.body !== "string") {
            throw new JsonFlowError(
              "OPERATION_CONFIG_INVALID",
              'bodyFormat "text" requires a string body',
              { details: { url: sanitizeUrl(url) } },
            );
          }
          body = config.body;
          if (!headers.has("content-type"))
            headers.set("content-type", "text/plain; charset=utf-8");
        } else {
          body = JSON.stringify(config.body);
          if (!headers.has("content-type")) headers.set("content-type", "application/json");
        }
      }
      if (idempotencyKey !== undefined && !headers.has("idempotency-key")) {
        headers.set("idempotency-key", idempotencyKey);
      }
      if (!headers.has("accept"))
        headers.set("accept", "application/json, text/plain;q=0.9, */*;q=0.8");

      const retriable = isRetriableRequest(config, idempotencyKey);
      const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const requestSignal = AbortSignal.any([signal, timeoutSignal]);
      const safeDetails: JsonObject = {
        method: config.method,
        url: sanitizeUrl(url),
        requestHeaderNames: sanitizeHeaderNames(config.headers),
      };

      const init: RequestInit = {
        method: config.method,
        headers,
        signal: requestSignal,
        redirect: "manual",
      };
      if (body !== undefined) init.body = body;

      let response: Response;
      try {
        response = await doFetch(url.toString(), init);
      } catch (error) {
        if (signal.aborted) {
          throw new JsonFlowError("CANCELLED", "Request cancelled", {
            details: safeDetails,
            cause: error,
          });
        }
        if (timeoutSignal.aborted) {
          throw new JsonFlowError(
            "HTTP_TIMEOUT",
            `${config.method} ${sanitizeUrl(url)} timed out after ${timeoutMs}ms`,
            { details: { ...safeDetails, timeoutMs }, retryable: retriable, cause: error },
          );
        }
        const message = error instanceof Error ? error.message : "network error";
        const causeMessage =
          error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
        throw new JsonFlowError(
          "HTTP_NETWORK",
          `${config.method} ${sanitizeUrl(url)} failed: ${causeMessage ?? message}`,
          {
            details: { ...safeDetails, errorMessage: causeMessage ?? message },
            retryable: retriable,
            cause: error,
          },
        );
      }

      const maxBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      const bytes = await readBodyBounded(response, maxBytes, url);
      const contentType = response.headers.get("content-type") ?? "";
      const parsedBody = parseBody(bytes, contentType, config.responseType ?? "auto", url);

      if (!statusAccepted(response.status, config.expectStatus)) {
        const preview = new TextDecoder().decode(bytes).slice(0, ERROR_BODY_PREVIEW_CHARS);
        throw new JsonFlowError(
          "HTTP_STATUS",
          `${config.method} ${sanitizeUrl(url)} responded with ${response.status}`,
          {
            details: { ...safeDetails, status: response.status, responseBodyPreview: preview },
            retryable: retriable && RETRYABLE_STATUSES.has(response.status),
          },
        );
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: redactedHeaders(response.headers),
        body: parsedBody,
        url: sanitizeUrl(url),
      };
    },
  };
}

export function isHttpResponseOutput(value: JsonValue): value is HttpResponseOutput {
  return isJsonObject(value) && typeof value["status"] === "number";
}
