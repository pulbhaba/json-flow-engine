import type { JsonObject } from "./json.js";

/**
 * Stable, machine-readable error codes. Treat the set as part of the public API:
 * codes are added in minor versions and never renamed within a major version.
 */
export const ERROR_CODES = [
  // Definition and input problems (detected before any operation runs)
  "WORKFLOW_INVALID",
  "INPUT_INVALID",
  "OPERATION_UNKNOWN",
  "OPERATION_CONFIG_INVALID",
  "OPERATION_DUPLICATE",
  "STEP_ID_DUPLICATE",
  "STEP_REFERENCE_INVALID",
  "CONSTANT_UNKNOWN",
  "INPUT_REFERENCE_INVALID",
  "SCHEMA_INVALID",
  "INTEGRATION_INVALID",
  // Expressions and conditions (detected at runtime while resolving a step)
  "EXPRESSION_INVALID",
  "EXPRESSION_UNRESOLVED",
  "EXPRESSION_TYPE",
  "CONDITION_INVALID",
  "ASSERTION_FAILED",
  // Execution control
  "STEP_TIMEOUT",
  "EXECUTION_TIMEOUT",
  "CANCELLED",
  "LIMIT_EXCEEDED",
  "OPERATION_FAILED",
  "OPERATION_OUTPUT_INVALID",
  // Sandbox and mocks
  "SANDBOX_MOCK_MISSING",
  "MODE_MISMATCH",
  "MOCK_FAILURE",
  // http.request
  "HTTP_URL_INVALID",
  "HTTP_URL_FORBIDDEN",
  "HTTP_NETWORK",
  "HTTP_TIMEOUT",
  "HTTP_STATUS",
  "HTTP_RESPONSE_TOO_LARGE",
  "HTTP_RESPONSE_INVALID",
  // integration.call
  "INTEGRATION_UNKNOWN",
  "INTEGRATION_INPUT_INVALID",
  "INTEGRATION_CREDENTIAL_MISSING",
  "INTEGRATION_REQUEST_INVALID",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Engine codes plus any custom code a host operation chooses (e.g. `INVOICE_DUPLICATE`).
 * Custom codes should be UPPER_SNAKE_CASE and must not collide with engine codes.
 */
export type ErrorCodeLike = ErrorCode | (string & {});

export interface JsonFlowErrorOptions {
  /** Whether a retry policy may re-run the step after this error. Defaults to `false`. */
  retryable?: boolean;
  /** Sanitised, JSON-serialisable details safe to log and to put into execution results. */
  details?: JsonObject;
  /** JSON pointer into the workflow definition the error relates to, when known. */
  path?: string;
  cause?: unknown;
}

/**
 * Base error for everything the engine raises. Operation authors may throw it (or a subclass)
 * to control the error code and whether the failure is retryable.
 */
export class JsonFlowError extends Error {
  readonly code: ErrorCodeLike;
  readonly retryable: boolean;
  readonly details: JsonObject;
  readonly path: string | undefined;

  constructor(code: ErrorCodeLike, message: string, options: JsonFlowErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JsonFlowError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
    this.path = options.path;
  }
}

export interface ValidationIssue {
  code: ErrorCode;
  message: string;
  /** JSON pointer into the workflow definition (`/steps/1/config/url`). */
  path: string;
}

export class WorkflowValidationError extends JsonFlowError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .slice(0, 5)
      .map((issue) => `  ${issue.path || "/"}: ${issue.message} [${issue.code}]`)
      .join("\n");
    const more = issues.length > 5 ? `\n  ... and ${issues.length - 5} more` : "";
    super("WORKFLOW_INVALID", `Workflow definition is invalid:\n${summary}${more}`, {
      details: { issues: issues.map((issue) => ({ ...issue })) },
    });
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

/** Sanitised error shape stored in execution results (never contains the stack or raw cause). */
export interface ExecutionError {
  code: ErrorCodeLike;
  message: string;
  retryable: boolean;
  details: JsonObject;
  /** The step that failed, when the error is attributable to one. */
  stepId?: string;
  /** JSON pointer into the workflow definition, when known. */
  path?: string;
}

export function isJsonFlowError(error: unknown): error is JsonFlowError {
  return error instanceof JsonFlowError;
}

/**
 * Converts any thrown value into a JsonFlowError without leaking non-JSON data. Unknown errors
 * become non-retryable OPERATION_FAILED errors carrying only the message and error name.
 */
export function toJsonFlowError(
  error: unknown,
  fallbackCode: ErrorCode = "OPERATION_FAILED",
): JsonFlowError {
  if (isJsonFlowError(error)) return error;
  if (error instanceof Error) {
    return new JsonFlowError(fallbackCode, error.message, {
      details: { errorName: error.name },
      cause: error,
    });
  }
  return new JsonFlowError(fallbackCode, typeof error === "string" ? error : "Unknown error", {
    cause: error,
  });
}

export function toExecutionError(error: JsonFlowError, stepId?: string): ExecutionError {
  const result: ExecutionError = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
  };
  if (stepId !== undefined) result.stepId = stepId;
  if (error.path !== undefined) result.path = error.path;
  return result;
}
