import { JsonFlowError, type ValidationIssue } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import {
  createAjv,
  errorsIgnoringTemplates,
  formatAjvError,
  type AjvInstance,
  type ValidateFunction,
} from "../schemas/ajv.js";
import { conditionSchema } from "../schemas/condition.js";
import type { OperationDefinition, OperationEffects } from "./types.js";

export interface RegisteredOperation {
  readonly definition: OperationDefinition<unknown>;
  readonly effects: OperationEffects;
  /** Top-level config keys that are resolved lazily by the operation (nested steps, conditions). */
  readonly rawConfigKeys: ReadonlySet<string>;
  readonly validate: ValidateFunction | undefined;
}

const TYPE_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * Holds the operations an engine can run and compiles their config schemas once. Each engine
 * owns one registry; registration after the first execution is allowed but not recommended.
 */
export class OperationRegistry {
  private readonly operations = new Map<string, RegisteredOperation>();
  private readonly ajv: AjvInstance = createAjv();

  constructor() {
    this.ajv.addSchema(conditionSchema);
  }

  register<TConfig, TOutput extends JsonValue>(
    definition: OperationDefinition<TConfig, TOutput>,
    rawConfigKeys: ReadonlySet<string> = new Set(),
  ): void {
    if (!TYPE_PATTERN.test(definition.type)) {
      throw new JsonFlowError(
        "OPERATION_CONFIG_INVALID",
        `Operation type "${definition.type}" must be dotted segments of letters, digits, "_" or "-"`,
        { details: { type: definition.type } },
      );
    }
    if (this.operations.has(definition.type)) {
      throw new JsonFlowError(
        "OPERATION_DUPLICATE",
        `Operation "${definition.type}" is already registered. Use a mock to replace it in sandbox mode.`,
        { details: { type: definition.type } },
      );
    }
    let validate: ValidateFunction | undefined;
    if (definition.configSchema !== undefined) {
      try {
        validate = this.ajv.compile(definition.configSchema);
      } catch (error) {
        throw new JsonFlowError(
          "OPERATION_CONFIG_INVALID",
          `configSchema of operation "${definition.type}" is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
          { details: { type: definition.type }, cause: error },
        );
      }
    }
    // The registry stores the widest config type; `configSchema` is the runtime guard.
    const widened: OperationDefinition<unknown> = definition;
    this.operations.set(definition.type, {
      definition: widened,
      effects: definition.effects ?? "external",
      rawConfigKeys,
      validate,
    });
  }

  get(type: string): RegisteredOperation | undefined {
    return this.operations.get(type);
  }

  has(type: string): boolean {
    return this.operations.has(type);
  }

  types(): string[] {
    return [...this.operations.keys()];
  }

  /**
   * Validates a config against the operation's schema. With `ignoreTemplates`, errors on
   * template strings are dropped (static validation before expressions are resolved).
   */
  validateConfig(
    type: string,
    config: JsonObject,
    pointer: string,
    ignoreTemplates: boolean,
  ): ValidationIssue[] {
    const registered = this.operations.get(type);
    if (registered?.validate === undefined) return [];
    if (registered.validate(config)) return [];
    const errors = registered.validate.errors ?? [];
    const kept = ignoreTemplates ? errorsIgnoringTemplates(errors, config) : errors;
    return kept.map((error) => ({
      code: "OPERATION_CONFIG_INVALID",
      message: `config for ${type}: ${formatAjvError(error)}`,
      path: `${pointer}${error.instancePath}`,
    }));
  }

  async dispose(): Promise<void> {
    for (const { definition } of this.operations.values()) {
      await definition.dispose?.();
    }
  }
}
