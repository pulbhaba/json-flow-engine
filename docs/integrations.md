# Integrations

An integration lets a workflow call a service (HubSpot, OpenAI, your own API) by name with the
`integration.call` operation instead of hand-writing `http.request` steps. Design record:
[`decisions/0001-integrations.md`](decisions/0001-integrations.md).

## Concept

An integration is **declarative data**: a JSON manifest (`integration.json`) describing a
provider (base URL, auth scheme, allowed hosts) and its actions (input schema, request template,
response mapping). A manifest cannot execute code, so adding a provider needs no engine change
and an AI agent can author one safely. `integration.call` expands an action into an
`http.request`, so the URL policy, `allowedHosts`, size and time limits, sandbox mocks and
secret redaction all still apply.

## Directory layout

```
integrations/
  builtin/<provider>/integration.json   shipped with the package, maintained in this repository
  user/<provider>/integration.json      yours; never overwritten by upgrades
```

- The directory name must equal the manifest's `provider`.
- **Built-in** manifests are compiled into the package at build time
  (`scripts/write-registry.js`); nothing is read from disk for them at runtime. Edit one in
  `integrations/builtin/`, then `npm run build` (CI runs `node scripts/write-registry.js --check`).
- **User** manifests are discovered at startup from `./integrations/user` (relative to the working
  directory; the CLI commands accept `--dir <dir>`). A missing directory is fine. From code:
  `createEngine({ integrations: { user: (await loadUserIntegrations(dir)).user } })`. The CLI `run`
  and `test` commands load the default directory.
- **Override opt-in**: a user manifest whose `provider` is also built in is a load error unless it
  sets `"overridesBuiltin": true`; then it replaces the built-in one (`json-flow integration list`
  marks both).

## CLI

```
json-flow integration list [--dir <user-dir>]
json-flow integration validate <integration.json | provider-dir>
json-flow integration scaffold <provider> [--dir <user-dir>]
```

- `list` prints built-in and user integrations in separate sections with their actions, and
  reports user manifests that fail to load (exit 1).
- `validate` checks a manifest file or a provider directory. Errors are listed as
  `<JSON pointer>: message [code]`; exit 1 on any problem, including a provider id that does not
  match its directory or clashes with a built-in without `overridesBuiltin`.
- `scaffold` writes a valid starter `integrations/user/<provider>/integration.json` (provider id:
  lowercase letters, digits, `-`, starting with a letter). It refuses to overwrite an existing
  file and refuses built-in ids (write an override by hand instead).

## Manifest reference

The JSON Schema is `schemas/integration.schema.json`; add `"$schema"` to get editor completion.

| Field                 | Required | Notes                                                                             |
| --------------------- | -------- | --------------------------------------------------------------------------------- |
| `schemaVersion`       |          | `1` (the only version).                                                           |
| `provider`            | yes      | Lowercase id, equal to the directory name.                                        |
| `name`, `description` |          | Human readable.                                                                   |
| `overridesBuiltin`    |          | `true` to replace a built-in provider with the same id.                           |
| `baseUrl`             | yes      | `https://` only; no credentials, query or fragment.                               |
| `allowedHosts`        | yes      | Exact lowercase hostnames, must include the `baseUrl` host. No wildcards.         |
| `auth`                | yes      | `{ "type": "none" \| "bearer" \| "basic" }`, or `header` / `query` with a `name`. |
| `actions`             | yes      | Map of action name to action (at least one).                                      |

Action fields: `description`; `inputSchema` (JSON Schema 2020-12, checked before any request;
prefer `additionalProperties: false`); `request` (`method`, `path` starting with `/`, optional
`query`, `headers`, `body`); optional `response` (`output` mapping, `successStatus` list,
default any 2xx).

Templates: `{{ ... }}` in `request` values sees `input` (the validated action input). Values
interpolated into `path` are percent-encoded; a path may not contain `?`, `#` or dot segments.
`null` query and header values are omitted. In `response.output`, `input` is the HTTP response
`{ status, headers, body }`. A string that is exactly one `{{ }}` keeps its type; `?? <literal>`
supplies a default.

Annotated example (JSON has no comments; the notes follow it):

```json
{
  "$schema": "../../../schemas/integration.schema.json",
  "schemaVersion": 1,
  "provider": "acme",
  "name": "Acme",
  "baseUrl": "https://api.acme.example.com/v1",
  "allowedHosts": ["api.acme.example.com"],
  "auth": { "type": "bearer" },
  "actions": {
    "create-ticket": {
      "description": "Create a ticket (POST /tickets).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "minLength": 1 },
          "priority": { "enum": ["low", "high"] }
        },
        "required": ["title"],
        "additionalProperties": false
      },
      "request": {
        "method": "POST",
        "path": "/tickets",
        "body": { "title": "{{input.title}}", "priority": "{{input.priority ?? \"low\"}}" }
      },
      "response": {
        "successStatus": [201],
        "output": { "id": "{{input.body.id}}", "url": "{{input.body.url}}" }
      }
    }
  }
}
```

- `baseUrl` + `allowedHosts`: the only place requests may go; https only.
- `auth.type: "bearer"`: the secret is attached as `Authorization: Bearer ...` at call time and
  is not in the file.
- `inputSchema`: rejects bad input with `INTEGRATION_INPUT_INVALID` before anything is sent.
- `request.body`: templates read the validated `input`.
- `response.output`: reads the HTTP response, so `input.body.id` is the response JSON `id`.

## Credentials

Manifests and workflows hold only a credential **name**, never the secret. At call time the
engine resolves it from `createEngine({ integrations: { credentials } })` (an object or a
function), then from the environment variable `JSON_FLOW_CREDENTIAL_<NAME>` (upper-cased, `-`
becomes `_`). `basic` expects `user:password`. A missing credential fails with
`INTEGRATION_CREDENTIAL_MISSING`; mocks need none. Secrets are scrubbed from outputs, logs and
errors.

## Using `integration.call` in a workflow

```json
{
  "id": "open-ticket",
  "version": 1,
  "steps": [
    {
      "id": "ticket",
      "type": "integration.call",
      "config": {
        "provider": "acme",
        "action": "create-ticket",
        "credentials": "acme",
        "input": { "title": "{{input.title}}" }
      }
    }
  ],
  "output": { "ticketId": "{{steps.ticket.id}}" }
}
```

The step output is the action's `response.output` (or the response body when none is set). See
`examples/workflows/openai-summarize.json` and `hubspot-upsert-contact.json`.

## Testing with sandbox mocks

`json-flow test` and sandbox mode never send real requests; `integration.call` must be mocked or
the run fails closed. Mock the step output (the already-mapped `response.output`):

```json
{
  "version": 1,
  "mocks": [
    {
      "type": "integration.call",
      "steps": ["ticket"],
      "responses": [{ "output": { "id": "T-1", "url": "https://acme.example.com/T-1" } }]
    }
  ]
}
```

```
json-flow test open-ticket.json --mocks open-ticket.mocks.json --input-json '{"title":"Hi"}'
```

From code, `engine.mock("integration.call", ...)` and `engine.calls` (which shows the `provider`,
`action` and resolved `input`) work the same way. Mocks do not exercise the manifest's request
template; to check it, run live against a test account with `--live`, or inspect a mock's
`calls`.

## Prompt for an AI agent

Copy this into your agent, replacing the bracketed parts.

```text
You are adding an integration to json-flow-engine. Read docs/integrations.md and
docs/decisions/0001-integrations.md first, and schemas/integration.schema.json.

Goal: [PROVIDER NAME] integration with actions: [LIST OF ACTIONS]. API docs: [URL OR PASTED TEXT].

Do exactly this:
1. Run `json-flow integration scaffold <provider>` (lowercase id, e.g. `acme`). It creates
   integrations/user/<provider>/integration.json. Edit that file; do not create other files for
   the manifest.
2. From the provider's API docs set: baseUrl, allowedHosts, auth (none, bearer, basic, or
   header/query with a name), and for each action an inputSchema (set
   "additionalProperties": false and "required"), request (method, path, query, headers,
   body using {{input.<field>}}) and response (successStatus and an output mapping using
   {{input.body.<field>}}). Remove the scaffold's TODO placeholder action.
3. Run `json-flow integration validate integrations/user/<provider>` and fix every reported
   JSON-pointer error until it exits 0. Run `json-flow integration list` and confirm the
   provider and actions appear under "User integrations".
4. Write a workflow with an `integration.call` step per action and a mocks file, then run
   `json-flow test <workflow.json> --mocks <mocks.json>` until it exits 0.

Guardrails (never break these):
- baseUrl is https:// only. Never http://.
- allowedHosts lists exact hostnames the API needs, including the baseUrl host. No wildcards,
  no hosts you do not need.
- Never put secrets (API keys, tokens, passwords, example real credentials) in the manifest,
  workflow, mocks or tests. Use `auth` plus a credential name; the user supplies the value via
  JSON_FLOW_CREDENTIAL_<NAME>.
- Never set "overridesBuiltin" unless the user asked to replace a built-in provider.
- Do not run `--live` or call the real API unless the user asks; use sandbox mocks.
- Manifests are data only. Do not add code, scripts or new dependencies.

Report: the files you created, the validate/list/test commands you ran and their results.
```
