# json-flow-engine

Code-first workflow engine for backend integration automation and testing. Workflows are
plain JSON files that live in your repository, get reviewed in pull requests, run in CI, and
execute locally without a visual editor or a hosted automation platform.

```bash
json-flow validate ./workflows/create-resource.json
json-flow test ./workflows/create-resource.json --input ./fixtures/input.json --mocks ./fixtures/mocks.json
json-flow run  ./workflows/create-resource.json --input ./fixtures/input.json --live --allow http://localhost:3000
```

## Why

Tools like Make.com are great for click-to-build automation, but backend teams need the same
"call this API, pass the result to that one, branch, verify" flows to be version-controlled,
testable in CI and runnable against a local stack. `json-flow-engine` covers that slice:

- Calling internal or external HTTP APIs and passing typed JSON between steps.
- Conditional branches and assertions on persisted state.
- Reproducing integration scenarios with mocked dependencies, deterministically.
- Running the same scenario against a real local service when you want to.

It is deliberately not a Make.com replacement: no UI, no scheduler, no persistence, no
hundreds of connectors. See [Current limitations](#current-limitations).

## Installation

```bash
npm install json-flow-engine
```

Requires Node.js 20.3 or later. Ships ESM and CommonJS builds with TypeScript declarations.
Runtime dependencies:

| Package       | Why                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `ajv`         | JSON Schema validation of workflow files, `inputSchema`, and every operation's `configSchema`.             |
| `ajv-formats` | Standard `format` keywords (`uri`, `email`, `date-time`, ...) so input schemas can use them without hacks. |

Everything else (HTTP via `fetch`, UUIDs, argument parsing) comes from Node.js built-ins.

## A minimal workflow

`workflows/fetch-user.json`:

```json
{
  "$schema": "node_modules/json-flow-engine/schemas/workflow.schema.json",
  "id": "fetch-user",
  "version": 1,
  "inputSchema": {
    "type": "object",
    "properties": { "baseUrl": { "type": "string" }, "userId": { "type": "string" } },
    "required": ["baseUrl", "userId"]
  },
  "steps": [
    {
      "id": "fetch-user",
      "type": "http.request",
      "config": { "method": "GET", "url": "{{input.baseUrl}}/users/{{input.userId}}" }
    },
    {
      "id": "shape",
      "type": "data.transform",
      "config": {
        "value": { "id": "{{steps.fetch-user.body.id}}", "status": "{{steps.fetch-user.status}}" }
      }
    }
  ],
  "output": "{{steps.shape}}"
}
```

Run it from code:

```ts
import { createEngine, loadWorkflowFile, assertSucceeded, httpResponse } from "json-flow-engine";

const workflow = await loadWorkflowFile("./workflows/fetch-user.json");

const engine = createEngine({ mode: "sandbox" });
engine.mock("http.request", { responses: [{ output: httpResponse(200, { id: "u-1" }) }] });

const result = await engine.execute(workflow, { baseUrl: "http://localhost:3000", userId: "u-1" });
assertSucceeded(result);
console.log(result.output); // { id: "u-1", status: 200 }
```

Or from the terminal, where sandbox mode is the default and a missing mock fails the run:

```bash
npx json-flow run ./workflows/fetch-user.json --input-json '{"baseUrl":"http://localhost:3000","userId":"u-1"}' --mocks ./mocks.json
```

## Workflow format (version 1)

The JSON Schema is published as `json-flow-engine/workflow.schema.json` for editor completion.

| Field           | Required | Description                                                                           |
| --------------- | -------- | ------------------------------------------------------------------------------------- |
| `id`            | yes      | Identifier, `[A-Za-z0-9][A-Za-z0-9._-]*`.                                             |
| `version`       | yes      | Positive integer, your own version of this definition.                                |
| `schemaVersion` | no       | Format version. Only `1` exists; omit it or set `1`.                                  |
| `description`   | no       | Free text.                                                                            |
| `inputSchema`   | no       | JSON Schema (draft 2020-12) the input must satisfy. Checked before any step runs.     |
| `constants`     | no       | Object available as `{{constants.<name>}}`.                                           |
| `execution`     | no       | `{ "timeoutMs", "maxSteps" }`, can only tighten the engine limits.                    |
| `output`        | no       | Template for `result.output`; may reference `input`, `constants` and top-level steps. |
| `steps`         | yes      | Ordered list, at least one.                                                           |

Each step:

| Field            | Required | Description                                                                                              |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `id`             | yes      | Unique across the whole workflow including nested branches, `[A-Za-z0-9][A-Za-z0-9_-]*` (no dots).       |
| `type`           | yes      | A registered operation, e.g. `http.request`, `billing.create-invoice`.                                   |
| `config`         | yes      | Operation-specific object. Strings may contain expressions.                                              |
| `timeoutMs`      | no       | Per-attempt timeout.                                                                                     |
| `retry`          | no       | `{ maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier, jitter, retryOn }`, see below.            |
| `onError`        | no       | `fail` (default) stops the workflow; `continue` records the failure and exposes `null` as the output.    |
| `idempotencyKey` | no       | Template; the resolved string is passed to the operation (`http.request` sends it as `Idempotency-Key`). |

Validation rejects, with a JSON pointer into the file: unknown fields, duplicate step ids,
unknown operation types, invalid configs, expression syntax errors, references to steps that
are declared later or inside another branch, unknown constants, input properties that
`inputSchema` forbids, invalid `inputSchema`, and retry settings over the engine limits.
Nothing executes until the whole definition passes.

## Expressions

Expressions are written as `{{ ... }}` inside any string in `config`, `idempotencyKey` and
`output`. Object keys are never templated. There is no scripting: an expression is a reference
with an optional literal fallback, or a JSON literal.

```
{{input.userId}}                        workflow input
{{steps.fetch-user.body.id}}            output of an earlier step
{{constants.baseUrl}}                   workflow constants
{{input.items[0].sku}}                  array index
{{steps.call.headers["content-type"]}}  quoted key
{{input.limit ?? 10}}                   fallback when missing or null
{{"{{"}}                                string literal, here a literal "{{"
```

Rules:

- A string that is **exactly one expression** yields the referenced value with its JSON type
  intact. `"limit": "{{input.limit}}"` stays a number; `"body": "{{steps.a.body}}"` is the object.
- Any other string is **interpolation**: embedded values must be strings, numbers or booleans.
  Objects, arrays and `null` never coerce to text (`[object Object]` cannot happen); use `??`
  to supply a default for `null`.
- A **missing** value (absent property, index out of range, path through `null`) is an error,
  `EXPRESSION_UNRESOLVED`, unless a `??` fallback is given. Fallbacks are JSON literals only.
- Only own properties are read: `{{input.constructor}}` or `{{input.tags.length}}` are "missing".
- `{{` without a matching `}}` is a syntax error. Expression syntax and step references are
  checked statically; values are resolved when the step runs.
- `steps.<id>` may only name a step that is **guaranteed** to have completed: an earlier
  sibling, or an earlier sibling of an enclosing condition. Steps inside a branch are not
  visible after the branch; read the condition step's own output instead.

How to express common values in an `http.request`:

```json
{
  "url": "{{input.baseUrl}}/orders/{{input.orderId}}",
  "query": { "limit": "{{input.limit}}" },
  "body": {
    "name": "{{input.name}}",
    "quantity": "{{input.quantity}}",
    "giftWrap": "{{input.giftWrap ?? false}}",
    "address": "{{steps.lookup.body.address}}",
    "note": "Order {{input.orderId}} for {{input.name}}"
  }
}
```

`quantity` is sent as a number, `giftWrap` as a boolean, `address` as the whole object, and
`note` as an interpolated string.

## Built-in operations

### `data.transform`

Builds a JSON value from input, constants and earlier outputs. Output is the resolved `value`.

```json
{
  "id": "shape",
  "type": "data.transform",
  "config": { "value": { "id": "{{steps.create.body.id}}" } }
}
```

### `control.condition`

Runs the `then` steps when `if` is true, otherwise the `else` steps (`then` is required,
`else` optional; either may be empty). Output is
`{ "branch": "then" | "else", "output": <output of the last step in the taken branch or null> }`.
Steps in the untaken branch are recorded as `skipped` with `skipReason: "branch-not-taken"`.

```json
{
  "id": "route",
  "type": "control.condition",
  "config": {
    "if": {
      "all": ["{{steps.user.active}}", { "greaterThan": ["{{steps.order.body.total}}", 1000] }]
    },
    "then": [
      { "id": "notify", "type": "http.request", "config": { "method": "POST", "url": "..." } }
    ],
    "else": [
      { "id": "skip", "type": "data.transform", "config": { "value": { "notified": false } } }
    ]
  }
}
```

Conditions are JSON, not code:

| Form                        | Meaning                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `true` / `false`            | Literal.                                                                                        |
| `"{{steps.x.flag}}"`        | A template that must resolve to a boolean (anything else is an error).                          |
| `{ "equals": [a, b] }`      | Deep JSON equality after resolving both operands.                                               |
| `{ "not": c }`              | Negation.                                                                                       |
| `{ "all": [c, ...] }`       | Every condition true.                                                                           |
| `{ "any": [c, ...] }`       | At least one true.                                                                              |
| `{ "defined": "{{ref}}" }`  | The reference resolves to a value other than `null` (a missing value is `false`, not an error). |
| `{ "greaterThan": [a, b] }` | Numeric `a > b` (both must be numbers).                                                         |
| `{ "lessThan": [a, b] }`    | Numeric `a < b`.                                                                                |

### `control.assert`

Fails the step with `ASSERTION_FAILED` when `condition` is false. `message` may use expressions.

```json
{
  "id": "check",
  "type": "control.assert",
  "config": {
    "condition": { "equals": ["{{steps.verify.body.name}}", "{{input.name}}"] },
    "message": "name not persisted"
  }
}
```

### `http.request`

| Config             | Default   | Notes                                                                         |
| ------------------ | --------- | ----------------------------------------------------------------------------- |
| `method`           | required  | `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`, `DELETE`.                   |
| `url`              | required  | Absolute `http(s)` URL, subject to the URL policy.                            |
| `query`            |           | Object of string/number/boolean or arrays of them, appended to the URL.       |
| `headers`          |           | Object of strings.                                                            |
| `body`             |           | Any JSON value, sent as `application/json` (typed values preserved).          |
| `bodyFormat`       | `json`    | `text` sends a string body as `text/plain`.                                   |
| `timeoutMs`        | `30000`   | Request timeout.                                                              |
| `responseType`     | `auto`    | `auto` parses JSON content types, else text; `json`, `text`, `none`.          |
| `expectStatus`     | `2xx`     | `"any"` never fails on status; `[200, 404]` accepts exactly those.            |
| `maxResponseBytes` | `1048576` | Larger bodies fail with `HTTP_RESPONSE_TOO_LARGE`.                            |
| `idempotent`       | `false`   | Marks a `POST`/`PATCH` as safe to retry (or set the step's `idempotencyKey`). |

Output: `{ status, statusText, headers, body, url }`. `headers` has `authorization`, `cookie`,
`set-cookie`, `proxy-authorization`, `x-api-key` and `x-auth-token` redacted; `url` is the origin and path
without query string or credentials. Redirects are not followed (a 3xx is a status failure).

Errors carry the method, sanitised URL, request header **names** (never values), status and a
512-character body preview. Non-2xx responses fail with `HTTP_STATUS`; 408, 425, 429 and 5xx
are `retryable` only for `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`, requests marked
`idempotent`, or steps with an `idempotencyKey`. Timeouts and network errors follow the same rule.

## Running workflows

### From code

```ts
const engine = createEngine({
  mode: "live", // or "sandbox"; there is no default
  operations: [myOperation], // custom operations
  http: { urlPolicy: { allow: ["http://localhost:3000"] } },
  limits: { maxExecutionMs: 60_000 },
  logger: createConsoleLogger("info"),
  onEvent: (event) => metrics.record(event),
});

const result = await engine.execute(workflow, input, { signal, timeoutMs: 30_000 });
```

`execute` throws `WorkflowValidationError` if the definition is invalid for this engine (unknown
operation, bad config, ...), so a broken file fails fast in tests. Everything that happens at
runtime, including invalid input, comes back as a result with `status: "failed"`.

`engine.validate(definition)` runs the full validation without executing and returns
`{ ok, issues }`. `validateWorkflow`, `parseWorkflow` and `defineWorkflow` do the
registry-independent part (structure, expressions, references).

### From the CLI

```
json-flow validate <workflow.json>
json-flow run <workflow.json> [--input f.json | --input-json '{...}'] [--mocks m.json] [--live] [--allow origin]... [--json] [--log level]
json-flow test <workflow.json> --mocks m.json [--input f.json]
```

`run` is sandbox by default. `--live` is required for real execution and cannot be combined
with `--mocks`. `test` is always sandbox and requires mocks. Exit codes: 0 succeeded, 1 failed
or invalid, 2 usage error. `--json` prints the full `ExecutionResult`. The CLI cannot load custom
operations; use the API for workflows that need them.

## The execution result

```ts
interface ExecutionResult {
  executionId: string; // UUID per run
  workflowId: string;
  workflowVersion: number;
  mode: "live" | "sandbox";
  status: "succeeded" | "failed" | "cancelled";
  startedAt: string; // ISO 8601
  completedAt: string;
  durationMs: number;
  steps: StepResult[]; // every step in document order, nested ones with parentId and branch
  output: JsonValue; // resolved `output` template, or null
  error?: ExecutionError; // { code, message, retryable, details, stepId?, path? }
}

interface StepResult {
  id: string;
  type: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  attempts: number;
  execution?: "mock" | "live"; // how the operation ran
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: JsonValue;
  error?: ExecutionError;
  parentId?: string;
  branch?: "then" | "else";
  skipReason?: "branch-not-taken" | "not-reached";
}
```

`status` is `succeeded` only if every step that is not `onError: "continue"` succeeded. The
result never contains the input, configs, request headers or raw payloads; step outputs are
included because they are what later steps saw.

Helpers: `assertSucceeded(result)` throws a readable error listing failed steps,
`assertFailed(result, code?)`, `requireStep(result, id)`, `getStepResult(result, id)`, and
`formatResult(result)` for a one-line-per-step summary.

## Sandbox mode and mocks

Sandbox mode is fail-closed:

- Operations with `effects: "external"` (`http.request` and, by default, every custom
  operation) must have a mock, or the step fails with `SANDBOX_MOCK_MISSING`. Nothing falls
  back to the real implementation.
- Operations with `effects: "none"` (`data.transform`, `control.*`) run for real.
- Mocks cannot be registered on a live engine (`MODE_MISMATCH`), so a test engine cannot be
  switched to live by accident and a live engine cannot be silently stubbed.
- Each step result says whether it ran via `mock` or `live`; the result and every event
  carry `mode`.

```ts
const engine = createEngine({ mode: "sandbox" });

// Canned responses, consumed in order; the last one repeats.
const http = engine.mock("http.request", {
  steps: ["create-resource"], // optional: restrict to step ids (step-scoped mocks win)
  delayMs: 50, // optional simulated latency, e.g. to test timeoutMs
  responses: [
    { error: { code: "HTTP_STATUS", message: "503", retryable: true, details: { status: 503 } } },
    { output: httpResponse(201, { id: "res_1" }) },
  ],
});

// Or compute the reply from the resolved config.
engine.mock("http.request", ({ config, stepId }) =>
  httpResponse(200, { echo: config.url, stepId }),
);

const result = await engine.execute(workflow, input);

http.callCount; // 2
http.calls[0]; // { sequence, stepId, type, attempt, config, idempotencyKey? }
engine.calls.map((c) => c.stepId); // every mock call in order, across all mocks
engine.resetMocks(); // clear calls and rewind responses; mocks stay registered
```

The same shape works as a JSON file for the CLI and `loadMocksFile`:

```json
{
  "version": 1,
  "mocks": [
    {
      "type": "http.request",
      "steps": ["create-resource"],
      "responses": [
        {
          "output": {
            "status": 201,
            "statusText": "",
            "headers": {},
            "body": { "id": "res_1" },
            "url": ""
          }
        }
      ]
    }
  ]
}
```

### Sandbox simulation versus a real local service

Mocks simulate dependencies, so they prove the workflow's wiring, data mapping, branching and
error handling, not the dependency itself. To exercise a real local API while keeping
everything else sandboxed, allow the operation explicitly and open the URL policy for that
origin only:

```ts
const engine = createEngine({
  mode: "sandbox",
  sandbox: { allowLive: ["http.request"] },
  http: { urlPolicy: { allow: ["http://localhost:3000"] } },
});
```

Steps then run `live` against `localhost:3000`; any other host is still refused. Treat this as an
integration test against a real service: results depend on its state.

## Custom operations

```ts
import type { OperationDefinition } from "json-flow-engine";

interface CreateInvoiceConfig {
  customerId: string;
  amountCents: number;
}

export function createInvoiceOperation(
  billing: BillingClient,
): OperationDefinition<CreateInvoiceConfig, { invoiceId: string }> {
  return {
    type: "billing.create-invoice",
    effects: "external", // default; "none" lets it run in sandbox mode
    configSchema: {
      type: "object",
      properties: { customerId: { type: "string" }, amountCents: { type: "integer", minimum: 1 } },
      required: ["customerId", "amountCents"],
      additionalProperties: false,
    },
    async execute({ config, idempotencyKey, signal, logger }) {
      signal.throwIfAborted();
      return billing.createInvoice(config, { idempotencyKey, signal });
    },
    dispose: () => billing.close(), // optional, called by engine.dispose()
  };
}

const engine = createEngine({ mode: "live", operations: [createInvoiceOperation(billing)] });
// or later: engine.registerOperation(definition)
```

The contract:

- `configSchema` is validated statically (ignoring template strings) and again against the
  **resolved** config before every attempt. It is the runtime guard for your `TConfig` type.
- `execute` receives `config`, `stepId`, `type`, `attempt`, `executionId`, `workflowId`,
  `workflowVersion`, `mode`, `input`, `steps` (outputs so far, deep-frozen), `constants`,
  `signal`, `logger`, `idempotencyKey`. Return a JSON value; anything else fails with
  `OPERATION_OUTPUT_INVALID`.
- Throw `JsonFlowError` with your own code (`UPPER_SNAKE_CASE`) and `retryable: true` when a
  retry is safe. Any other thrown error becomes a non-retryable `OPERATION_FAILED` carrying only
  the message and error name.
- Respect `signal`: it is aborted on cancellation, step timeout and execution timeout. The
  engine returns on time regardless, but an operation that ignores the signal keeps running.
- Registering a type twice throws `OPERATION_DUPLICATE`; use mocks to replace behaviour.

## Errors, retries, timeouts and idempotency

Every error has a stable `code`, a `message`, `retryable`, JSON `details`, and `stepId` and
`path` (a JSON pointer such as `/steps/create-resource/config`) when attributable.

| Code                                                                                                                                                                                                                              | Raised when                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `WORKFLOW_INVALID`, `STEP_ID_DUPLICATE`, `STEP_REFERENCE_INVALID`, `CONSTANT_UNKNOWN`, `INPUT_REFERENCE_INVALID`, `SCHEMA_INVALID`, `INTEGRATION_INVALID`, `OPERATION_UNKNOWN`, `OPERATION_CONFIG_INVALID`, `OPERATION_DUPLICATE` | Definition or registration problems, before anything runs.      |
| `INPUT_INVALID`                                                                                                                                                                                                                   | Input is not plain JSON or violates `inputSchema`.              |
| `EXPRESSION_INVALID`, `EXPRESSION_UNRESOLVED`, `EXPRESSION_TYPE`, `CONDITION_INVALID`, `ASSERTION_FAILED`                                                                                                                         | Resolving a step's expressions or conditions.                   |
| `STEP_TIMEOUT`, `EXECUTION_TIMEOUT`, `CANCELLED`, `LIMIT_EXCEEDED`                                                                                                                                                                | Execution control.                                              |
| `OPERATION_FAILED`, `OPERATION_OUTPUT_INVALID`                                                                                                                                                                                    | An operation threw a non-`JsonFlowError`, or returned non-JSON. |
| `SANDBOX_MOCK_MISSING`, `MODE_MISMATCH`, `MOCK_FAILURE`                                                                                                                                                                           | Sandbox rules.                                                  |
| `HTTP_URL_INVALID`, `HTTP_URL_FORBIDDEN`, `HTTP_NETWORK`, `HTTP_TIMEOUT`, `HTTP_STATUS`, `HTTP_RESPONSE_TOO_LARGE`, `HTTP_RESPONSE_INVALID`                                                                                       | `http.request`.                                                 |

Retry policy per step:

```json
"retry": { "maxAttempts": 3, "initialDelayMs": 200, "maxDelayMs": 10000, "backoffMultiplier": 2, "jitter": true, "retryOn": "retryable" }
```

- Delay before attempt _n+1_ is `initialDelayMs * backoffMultiplier^(n-1)`, capped at
  `maxDelayMs`; with `jitter` (default) the actual delay is uniform in `[0, computed]`.
- Only errors with `retryable: true` are retried unless `retryOn: "any"`. `STEP_TIMEOUT` is not
  retryable by default (the engine cannot know whether the timed-out work had side effects);
  `http.request`'s own `timeoutMs` produces `HTTP_TIMEOUT` with method-aware retryability.
- `maxAttempts` is capped by `limits.maxAttempts` (10), delays by `limits.maxRetryDelayMs`
  (60 s), and every attempt counts against `maxSteps` (1000). There are no unbounded retries.
- Cancellation during backoff stops immediately; the step is `cancelled`.
- `attempts` is recorded per step and every retry emits a `step.retrying` event.

Four things that are easy to conflate:

| Concern                               | What this package does                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retrying an operation                 | Yes, bounded, per the rules above.                                                                                                                                                       |
| Preventing duplicate business effects | Only by passing an `idempotencyKey` to the operation (sent as `Idempotency-Key` by `http.request`). The target must honour it. The engine does **not** guarantee exactly-once execution. |
| Persisting workflow progress          | No. State lives in memory for the duration of `execute`.                                                                                                                                 |
| Recovering after a process crash      | No. If the process dies mid-workflow, nothing resumes; re-run the workflow and rely on idempotency keys.                                                                                 |

Timeouts: `timeoutMs` on a step bounds each attempt; `execution.timeoutMs` in the workflow,
`timeoutMs` in `execute` options and `limits.maxExecutionMs` (5 min) bound the whole run, the
smallest wins. Pass an `AbortSignal` to `execute` to cancel; the result is `cancelled` and the
running step is marked `cancelled`.

## Observability

- `onEvent` receives `execution.started`, `step.started`, `step.retrying`, `step.finished` and
  `execution.finished` with ids, statuses, attempts, durations and sanitised errors.
- `logger` is a four-method interface (`debug`, `info`, `warn`, `error`) with JSON fields; pass
  pino, winston, `createConsoleLogger()` or nothing (silent by default). The engine never logs
  configs, inputs, outputs, headers or payloads, only identifiers, statuses, durations and codes.
- No monitoring vendor is required or integrated.

## Security model and limitations

- **Trusted definitions only.** Workflows are code: whoever can edit a workflow file can make
  the engine call any URL the policy allows with any headers. Do not execute workflow JSON from
  untrusted users. This package is a controlled execution environment, not an operating-system
  or process sandbox.
- **No code execution from JSON.** Expressions are parsed by a small grammar; there is no
  `eval`, `Function` or template engine. Ajv compiles schemas with code generation, which is why
  schemas (like workflows) must be trusted too.
- **URL policy for `http.request`.** By default only `https://` to public hosts is allowed.
  Plain `http://`, loopback, private ranges, link-local, CGNAT, `*.localhost`, `*.local`,
  `*.internal` and cloud metadata hosts are refused unless listed in `urlPolicy.allow`
  (`"http://localhost:3000"`, `"https://*.example.com"`, `"http://127.0.0.1:*"`) or opened with
  `allowHttp` / `allowPrivateNetworks`. URLs with credentials are refused. The check is on the
  host literal only; DNS is not resolved, so a public name pointing at a private address is
  not caught. Redirects are never followed.
- **Secrets.** Inputs can carry tokens; results and logs do not echo inputs or request headers,
  and known credential headers are redacted from response headers and error details. Error
  details do include a 512-character preview of a failed response body.
- **Sandbox defaults.** `mode` is mandatory, mocks only exist in sandbox mode, and sandbox
  never falls back to real operations. The CLI is sandbox unless `--live` is given.

## Current limitations

- Sequential execution only: no parallel steps, loops, delays or sub-workflows (in v1 these are
  deliberately left out until the model has settled).
- No persistence, scheduling, queueing, web server, UI or distributed locking. The host can
  wrap `execute` with any of these.
- No crash recovery or exactly-once guarantees (see above).
- Conditions support equality, numeric comparison, boolean logic and presence only.
- The CLI runs built-in operations only.
- `inputSchema` is JSON Schema draft 2020-12; use `$schema` of that draft or omit it.

## Versioning

Semantic versioning. The public API is what `json-flow-engine` exports from its entry point,
the workflow format (`schemaVersion: 1`), error codes, the mocks file format and the CLI. Within
a major version: codes, fields and operations are added, never renamed or removed; a new
workflow format would come with a new `schemaVersion` and the engine would keep accepting the
old one. Pre-1.0 releases may still change the API between minor versions; the changelog says
when.

## A complete automated integration test

The repository's `examples/` directory holds this scenario in full: the workflow
([`examples/workflows/create-and-verify-resource.json`](examples/workflows/create-and-verify-resource.json)),
input and mocks fixtures, and the Vitest file
([`examples/tests/create-and-verify.test.ts`](examples/tests/create-and-verify.test.ts)).
The workflow creates a resource with a `POST`, reads it back with a `GET`, asserts the
persisted state, and summarises; the same files run from the CLI:

```bash
npx json-flow test examples/workflows/create-and-verify-resource.json \
  --input examples/fixtures/create-and-verify.input.json \
  --mocks examples/fixtures/create-and-verify.mocks.json
```

and from a test:

```ts
import { createEngine, loadWorkflowFile, loadMocksFile, assertSucceeded } from "json-flow-engine";

it("creates the resource and verifies it", async () => {
  const workflow = await loadWorkflowFile("examples/workflows/create-and-verify-resource.json");
  const { mocks } = await loadMocksFile("examples/fixtures/create-and-verify.mocks.json");
  const engine = createEngine({ mode: "sandbox", mocks });

  const result = await engine.execute(workflow, {
    baseUrl: "http://localhost:3000",
    resourceName: "integration-widget",
    apiToken: "t",
  });

  assertSucceeded(result);
  expect(result.output).toEqual({
    resourceId: "res_123",
    createdStatus: 201,
    name: "integration-widget",
  });
  expect(engine.calls.map((c) => [c.stepId, c.config.method, c.config.url])).toEqual([
    ["create-resource", "POST", "http://localhost:3000/resources"],
    ["verify-resource", "GET", "http://localhost:3000/resources/res_123"],
  ]);
});
```

Swap `mocks` for `sandbox: { allowLive: ["http.request"] }` plus a URL policy to run the same
workflow against a service started in CI.

## Development

```bash
npm ci
npm run check        # typecheck, lint, test, build, consumer verification
npm test             # vitest
npm run build        # dist/esm, dist/cjs, schemas/workflow.schema.json
npm run verify:package
```

`npm run verify:package` packs the tarball, installs it in a throwaway project, and checks the
ESM import, CommonJS require, a TypeScript consumer under both `NodeNext` and `bundler`
resolution, the CLI, and that the tarball contains only `bin/`, `dist/`, `schemas/`, the
README, LICENSE, CHANGELOG and `package.json`. CI runs the same on Node 22 and 24, plus a
Node 20 consumer check.

## Releasing

Publishing is manual.

1. Update `CHANGELOG.md`, moving entries from Unreleased to the new version.
2. `npm version <patch|minor|major>` (updates `package.json` and tags).
3. `npm publish --access public` (runs `prepublishOnly`, which is `npm run check`).
4. `git push --follow-tags`.

## License

MIT.
