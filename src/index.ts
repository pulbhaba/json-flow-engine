/**
 * json-flow-engine public API. Everything exported here follows semantic versioning; internal
 * modules are not part of the contract.
 */

export {
  createEngine,
  Engine,
  type EngineOptions,
  type ExecuteOptions,
  type SandboxOptions,
} from "./engine/engine.js";
export { DEFAULT_LIMITS, type EngineLimits } from "./engine/limits.js";
export {
  getStepResult,
  type ExecutionEvent,
  type ExecutionResult,
  type ExecutionStatus,
  type StepExecutionKind,
  type StepResult,
  type StepStatus,
} from "./engine/result.js";

export {
  defineWorkflow,
  parseWorkflow,
  validateWorkflow,
  assertValid,
  type ValidateOptions,
  type ValidationResult,
} from "./workflow/validate.js";
export { loadWorkflowFile, loadMocksFile, readJsonFile } from "./workflow/load.js";
export { workflowSchema, WORKFLOW_SCHEMA_ID } from "./workflow/schema.js";
export {
  WORKFLOW_SCHEMA_VERSION,
  type AssertStepConfig,
  type Condition,
  type ConditionStepConfig,
  type RetryPolicy,
  type StepDefinition,
  type StepErrorAction,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowExecutionConfig,
} from "./workflow/types.js";

export {
  validateIntegrationManifest,
  type IntegrationValidationResult,
} from "./integrations/validate.js";
export {
  loadIntegrations,
  DEFAULT_USER_INTEGRATIONS_DIR,
  type IntegrationLoadError,
  type IntegrationLoadResult,
  type IntegrationSource,
  type LoadedIntegration,
  type LoadIntegrationsOptions,
} from "./integrations/load.js";
export { integrationSchema, INTEGRATION_SCHEMA_ID } from "./integrations/schema.js";
export {
  INTEGRATION_AUTH_TYPES,
  INTEGRATION_SCHEMA_VERSION,
  type IntegrationAction,
  type IntegrationAuth,
  type IntegrationManifest,
  type IntegrationRequest,
  type IntegrationResponse,
} from "./integrations/types.js";

export type {
  ExecutionMode,
  OperationContext,
  OperationDefinition,
  OperationEffects,
} from "./operations/types.js";
export {
  createHttpRequestOperation,
  httpResponse,
  HTTP_METHODS,
  type FetchLike,
  type HttpMethod,
  type HttpOperationOptions,
  type HttpRequestConfig,
  type HttpResponseOutput,
} from "./operations/builtin/http.js";
export { type TransformConfig } from "./operations/builtin/transform.js";
export { evaluateCondition } from "./operations/builtin/control.js";
export { isPrivateHost, type UrlPolicy } from "./http/url-policy.js";

export type {
  MockCall,
  MockDefinition,
  MockHandle,
  MockHandler,
  MockResponse,
  MockSpec,
  MocksFile,
} from "./sandbox/mocks.js";

export {
  ERROR_CODES,
  JsonFlowError,
  WorkflowValidationError,
  isJsonFlowError,
  type ErrorCode,
  type ErrorCodeLike,
  type ExecutionError,
  type JsonFlowErrorOptions,
  type ValidationIssue,
} from "./errors.js";
export {
  checkJsonValue,
  isJsonObject,
  isJsonValue,
  jsonEquals,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from "./json.js";
export { createConsoleLogger, silentLogger, type Logger, type LogLevel } from "./logger.js";
export type { ExpressionScope } from "./expressions/resolve.js";
export {
  parseExpression,
  parseTemplate,
  type Expression,
  type ParsedTemplate,
} from "./expressions/parse.js";
export { assertSucceeded, assertFailed, requireStep, formatResult } from "./testing.js";
