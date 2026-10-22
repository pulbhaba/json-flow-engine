import { JsonFlowError, WorkflowValidationError, type ValidationIssue } from "../errors.js";
import {
  scanTemplates,
  type FoundReference,
  type TemplateScanIssue,
} from "../expressions/resolve.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import type { EngineLimits } from "../engine/limits.js";
import type { OperationRegistry } from "../operations/registry.js";
import {
  createAjv,
  errorsIgnoringTemplates,
  formatAjvError,
  type ValidateFunction,
} from "../schemas/ajv.js";
import { workflowSchema } from "./schema.js";
import {
  VALIDATED_WORKFLOW,
  type StepDefinition,
  type Workflow,
  type WorkflowDefinition,
} from "./types.js";

export type ValidationResult =
  | { ok: true; workflow: Workflow; issues: [] }
  | { ok: false; workflow?: undefined; issues: ValidationIssue[] };

export interface ValidateOptions {
  /** When given, operation types and config schemas are checked too. */
  registry?: OperationRegistry;
  /** When given, retry settings are checked against the engine's bounds. */
  limits?: EngineLimits;
}

const NESTED_STEP_KEYS: ReadonlySet<string> = new Set(["then", "else"]);

let structuralValidator: ValidateFunction | undefined;

function getStructuralValidator(): ValidateFunction {
  structuralValidator ??= createAjv().compile(workflowSchema);
  return structuralValidator;
}

/** Compiles an `inputSchema` on a throwaway Ajv instance to report schema errors early. */
export function compileInputSchema(schema: JsonObject): ValidateFunction {
  return createAjv().compile(schema);
}

interface WalkContext {
  issues: ValidationIssue[];
  seenIds: Map<string, string>;
  constants: JsonObject;
  inputProperties: ReadonlySet<string> | undefined;
  options: ValidateOptions;
}

function issue(
  ctx: WalkContext,
  code: ValidationIssue["code"],
  path: string,
  message: string,
): void {
  ctx.issues.push({ code, path, message });
}

function checkReferences(
  ctx: WalkContext,
  references: FoundReference[],
  visible: ReadonlySet<string>,
  describeVisible: string,
): void {
  for (const reference of references) {
    const { expression, pointer, raw } = reference;
    const first = expression.segments[0];
    switch (expression.root) {
      case "steps": {
        if (first?.kind !== "key") break; // parser guarantees this
        if (!visible.has(first.key)) {
          const known = ctx.seenIds.has(first.key);
          issue(
            ctx,
            "STEP_REFERENCE_INVALID",
            pointer,
            known
              ? `"${raw.trim()}" refers to step "${first.key}", which is not guaranteed to have run before this point (${describeVisible})`
              : `"${raw.trim()}" refers to unknown step "${first.key}"`,
          );
        }
        break;
      }
      case "constants": {
        if (first?.kind === "key" && !(first.key in ctx.constants)) {
          issue(
            ctx,
            "CONSTANT_UNKNOWN",
            pointer,
            `"${raw.trim()}" refers to constant "${first.key}", which is not defined in "constants"`,
          );
        }
        break;
      }
      case "input": {
        if (
          ctx.inputProperties !== undefined &&
          first?.kind === "key" &&
          !ctx.inputProperties.has(first.key)
        ) {
          issue(
            ctx,
            "INPUT_REFERENCE_INVALID",
            pointer,
            `"${raw.trim()}" refers to input property "${first.key}", which inputSchema does not allow`,
          );
        }
        break;
      }
      default:
        expression.root satisfies never;
    }
  }
}

function scanInto(
  value: JsonValue,
  pointer: string,
  ctx: WalkContext,
  skipKeys?: ReadonlySet<string>,
): FoundReference[] {
  const references: FoundReference[] = [];
  const scanIssues: TemplateScanIssue[] = [];
  scanTemplates(value, pointer, references, scanIssues, skipKeys);
  for (const scanIssue of scanIssues) {
    issue(ctx, "EXPRESSION_INVALID", scanIssue.pointer, scanIssue.error.message);
  }
  return references;
}

function checkRetry(ctx: WalkContext, step: StepDefinition, pointer: string): void {
  const limits = ctx.options.limits;
  if (step.retry === undefined || limits === undefined) return;
  if (step.retry.maxAttempts > limits.maxAttempts) {
    issue(
      ctx,
      "LIMIT_EXCEEDED",
      `${pointer}/retry/maxAttempts`,
      `retry.maxAttempts ${step.retry.maxAttempts} exceeds the engine limit of ${limits.maxAttempts}`,
    );
  }
  if (step.retry.maxDelayMs !== undefined && step.retry.maxDelayMs > limits.maxRetryDelayMs) {
    issue(
      ctx,
      "LIMIT_EXCEEDED",
      `${pointer}/retry/maxDelayMs`,
      `retry.maxDelayMs ${step.retry.maxDelayMs} exceeds the engine limit of ${limits.maxRetryDelayMs}`,
    );
  }
}

/** The schema already validated nested step lists; this narrows the type without a cast. */
export function isStepList(value: unknown): value is StepDefinition[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        isJsonObject(entry) &&
        typeof entry["id"] === "string" &&
        typeof entry["type"] === "string" &&
        isJsonObject(entry["config"]),
    )
  );
}

/**
 * Walks a step list. `inherited` holds ids guaranteed to have completed before the list
 * starts; a step may only reference those and its earlier siblings. Branch bodies inherit the
 * set visible to their condition step, never the sibling branch.
 */
function walkSteps(
  steps: StepDefinition[],
  pointer: string,
  inherited: ReadonlySet<string>,
  ctx: WalkContext,
): void {
  const visible = new Set(inherited);
  steps.forEach((step, index) => {
    const stepPointer = `${pointer}/${index}`;
    const previous = ctx.seenIds.get(step.id);
    if (previous !== undefined) {
      issue(
        ctx,
        "STEP_ID_DUPLICATE",
        `${stepPointer}/id`,
        `duplicate step id "${step.id}" (also at ${previous}/id)`,
      );
    } else {
      ctx.seenIds.set(step.id, stepPointer);
    }

    const registry = ctx.options.registry;
    if (registry !== undefined && !registry.has(step.type)) {
      issue(
        ctx,
        "OPERATION_UNKNOWN",
        `${stepPointer}/type`,
        `unknown operation "${step.type}"; registered operations: ${registry.types().join(", ")}`,
      );
    }
    if (registry !== undefined) {
      ctx.issues.push(
        ...registry.validateConfig(step.type, step.config, `${stepPointer}/config`, true),
      );
    }
    checkRetry(ctx, step, stepPointer);

    const isCondition = step.type === "control.condition";
    // Conditions are plain values holding templates, so they are scanned like any other config
    // value; only nested step lists are excluded here and walked as steps below.
    const references = scanInto(
      step.config,
      `${stepPointer}/config`,
      ctx,
      isCondition ? NESTED_STEP_KEYS : undefined,
    );
    if (step.idempotencyKey !== undefined) {
      references.push(...scanInto(step.idempotencyKey, `${stepPointer}/idempotencyKey`, ctx));
    }
    checkReferences(
      ctx,
      references,
      visible,
      "it is declared later, in another branch, or inside a branch",
    );

    if (isCondition) {
      if (step.retry !== undefined || step.timeoutMs !== undefined) {
        issue(
          ctx,
          "WORKFLOW_INVALID",
          stepPointer,
          "control.condition steps cannot have retry or timeoutMs; put them on the nested steps",
        );
      }
      const thenSteps = step.config["then"];
      const elseSteps = step.config["else"];
      if (isStepList(thenSteps)) walkSteps(thenSteps, `${stepPointer}/config/then`, visible, ctx);
      if (isStepList(elseSteps)) walkSteps(elseSteps, `${stepPointer}/config/else`, visible, ctx);
    }
    visible.add(step.id);
  });
}

function inputPropertiesOf(schema: JsonObject | undefined): ReadonlySet<string> | undefined {
  if (schema?.["additionalProperties"] !== false) return undefined;
  const properties = schema["properties"];
  return isJsonObject(properties) ? new Set(Object.keys(properties)) : undefined;
}

/**
 * Validates a workflow definition. Structural problems (schema), duplicate ids, expression
 * syntax, references to steps that are not guaranteed to have run, unknown constants, bad
 * `inputSchema`, and (with a registry) unknown operations and invalid configs are all reported
 * together with JSON pointers into the definition.
 */
export function validateWorkflow(
  definition: unknown,
  options: ValidateOptions = {},
): ValidationResult {
  const validate = getStructuralValidator();
  if (!validate(definition)) {
    const errors = isJsonObject(definition)
      ? errorsIgnoringTemplates(validate.errors ?? [], definition)
      : (validate.errors ?? []);
    const issues: ValidationIssue[] = errors
      .filter((error) => error.keyword !== "if")
      .map((error) => ({
        code: /^\/steps\/\d+(\/config\/(then|else)\/\d+)*\/config(\/|$)/.test(error.instancePath)
          ? "OPERATION_CONFIG_INVALID"
          : "WORKFLOW_INVALID",
        message: formatAjvError(error),
        path: error.instancePath,
      }));
    if (issues.length > 0) return { ok: false, issues: dedupe(issues) };
  }
  // The schema guarantees the shape; narrow without a cast by re-checking the object form.
  if (!isWorkflowShaped(definition)) {
    return {
      ok: false,
      issues: [{ code: "WORKFLOW_INVALID", path: "", message: "workflow must be an object" }],
    };
  }
  const ctx: WalkContext = {
    issues: [],
    seenIds: new Map(),
    constants: definition.constants ?? {},
    inputProperties: inputPropertiesOf(definition.inputSchema),
    options,
  };
  if (definition.inputSchema !== undefined) {
    try {
      compileInputSchema(definition.inputSchema);
    } catch (error) {
      issue(
        ctx,
        "SCHEMA_INVALID",
        "/inputSchema",
        `inputSchema is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const topLevel = new Set<string>();
  walkSteps(definition.steps, "/steps", topLevel, ctx);
  if (definition.output !== undefined) {
    const topLevelIds = new Set(definition.steps.map((step) => step.id));
    const references = scanInto(definition.output, "/output", ctx);
    checkReferences(ctx, references, topLevelIds, "only top-level steps are visible to output");
  }
  if (ctx.issues.length > 0) return { ok: false, issues: dedupe(ctx.issues) };
  return { ok: true, workflow: brand(definition), issues: [] };
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = `${entry.code}|${entry.path}|${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isWorkflowShaped(value: unknown): value is WorkflowDefinition {
  return isJsonObject(value) && typeof value["id"] === "string" && Array.isArray(value["steps"]);
}

function brand(definition: WorkflowDefinition): Workflow {
  return { ...definition, [VALIDATED_WORKFLOW]: true };
}

/** Validates a definition written in TypeScript or parsed from JSON. Throws on any issue. */
export function defineWorkflow(definition: WorkflowDefinition): Workflow {
  return parseWorkflow(definition);
}

/** Validates an unknown value (e.g. parsed JSON) as a workflow. Throws on any issue. */
export function parseWorkflow(definition: unknown): Workflow {
  const result = validateWorkflow(definition);
  if (!result.ok) throw new WorkflowValidationError(result.issues);
  return result.workflow;
}

export function assertValid(result: ValidationResult): Workflow {
  if (!result.ok) throw new WorkflowValidationError(result.issues);
  return result.workflow;
}

export { JsonFlowError };
