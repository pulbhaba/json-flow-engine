import { describe, expect, it } from "vitest";
import { assertSucceeded, createEngine, type InvoiceService } from "./imports.js";
import {
  createInvoiceOperation,
  createInvoiceEngine,
  invoiceWorkflow,
} from "../custom-operation.js";

describe("custom operation", () => {
  it("runs with an injected fake service and passes the idempotency key", async () => {
    const created: unknown[] = [];
    const fake: InvoiceService = {
      create: (customerId, amountCents, key) => {
        created.push([customerId, amountCents, key]);
        return Promise.resolve({ invoiceId: "inv_1" });
      },
    };
    const result = await createInvoiceEngine(fake, "sandbox").execute(invoiceWorkflow, {
      orderId: "o1",
      customerId: "c1",
      amountCents: 1999,
    });
    assertSucceeded(result);
    expect(result.output).toEqual({ invoiceId: "inv_1" });
    expect(created).toEqual([["c1", 1999, "invoice-o1"]]);
  });

  it("rejects a resolved config that violates the schema before touching the service", async () => {
    let calls = 0;
    const fake: InvoiceService = {
      create: () => {
        calls++;
        return Promise.resolve({ invoiceId: "x" });
      },
    };
    const result = await createInvoiceEngine(fake, "sandbox").execute(invoiceWorkflow, {
      orderId: "o1",
      customerId: "c1",
      amountCents: "19.99",
    });
    expect(result.error).toMatchObject({ code: "OPERATION_CONFIG_INVALID", stepId: "invoice" });
    expect(calls).toBe(0);
  });

  it("can be mocked like any other operation", async () => {
    const fake: InvoiceService = { create: () => Promise.reject(new Error("must not be called")) };
    const engine = createEngine({ mode: "sandbox", operations: [createInvoiceOperation(fake)] });
    const mock = engine.mock("billing.create-invoice", {
      responses: [{ output: { invoiceId: "inv_mock" } }],
    });
    const result = await engine.execute(invoiceWorkflow, {
      orderId: "o1",
      customerId: "c1",
      amountCents: 5,
    });
    assertSucceeded(result);
    expect(result.output).toEqual({ invoiceId: "inv_mock" });
    expect(mock.calls[0]?.config).toEqual({ customerId: "c1", amountCents: 5 });
  });
});
