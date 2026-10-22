import type { JsonValue, StepDefinition, WorkflowDefinition } from "../src/index.js";

export function workflowWith(
  steps: StepDefinition[],
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return { id: "test-workflow", version: 1, steps, ...extra };
}

export function transform(
  id: string,
  value: JsonValue,
  extra: Partial<StepDefinition> = {},
): StepDefinition {
  return { id, type: "data.transform", config: { value }, ...extra };
}
