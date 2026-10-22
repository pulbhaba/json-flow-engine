/**
 * Registering a custom operation that wraps an injected dependency. The operation declares
 * its config schema (enforced before every call) and `effects: "external"`, so in sandbox
 * mode it must be mocked unless listed in `sandbox.allowLive`.
 */
import { createEngine, defineWorkflow, type OperationDefinition } from "../src/index.js";

export interface InvoiceService {
  create(
    customerId: string,
    amountCents: number,
    idempotencyKey: string | undefined,
  ): Promise<{ invoiceId: string }>;
}

export interface CreateInvoiceConfig {
  customerId: string;
  amountCents: number;
}

export function createInvoiceOperation(
  service: InvoiceService,
): OperationDefinition<CreateInvoiceConfig, { invoiceId: string }> {
  return {
    type: "billing.create-invoice",
    description: "Creates an invoice through the billing service.",
    effects: "external",
    configSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", minLength: 1 },
        amountCents: { type: "integer", minimum: 1 },
      },
      required: ["customerId", "amountCents"],
      additionalProperties: false,
    },
    async execute({ config, idempotencyKey, signal }) {
      signal.throwIfAborted();
      return service.create(config.customerId, config.amountCents, idempotencyKey);
    },
  };
}

export const invoiceWorkflow = defineWorkflow({
  id: "invoice-customer",
  version: 1,
  steps: [
    {
      id: "invoice",
      type: "billing.create-invoice",
      idempotencyKey: "invoice-{{input.orderId}}",
      config: { customerId: "{{input.customerId}}", amountCents: "{{input.amountCents}}" },
    },
  ],
  output: { invoiceId: "{{steps.invoice.invoiceId}}" },
});

/** Wires a fake service for a test, or a real client in production (mode: "live"). */
export function createInvoiceEngine(service: InvoiceService, mode: "live" | "sandbox") {
  return createEngine({
    mode,
    operations: [createInvoiceOperation(service)],
    // In sandbox mode the fake service is the test double, so let the operation run.
    sandbox: { allowLive: ["billing.create-invoice"] },
  });
}
