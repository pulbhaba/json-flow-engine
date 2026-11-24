# 0001: Integrations (proposal)

Status: proposed. Task issues should treat the points below as the working
design and record any deviation here.

## Context

Workflows currently call external APIs by hard-coding `http.request` steps.
Users want ready-made integrations (HubSpot, OpenAI/ChatGPT, and similar, in the
spirit of Make.com modules) and an easy way for anyone, including an agentic AI,
to add new ones.

## Decision

- An integration is **declarative data**, not code: a JSON manifest describing
  a provider (base URL, auth scheme, allowed hosts) and its actions (name, input
  schema, request template, response mapping). Declarative manifests are easy for
  an AI to author and can be validated and sandboxed.
- Two sources, kept separate on disk:
  - `integrations/builtin/<provider>/integration.json`: shipped with the
    package, maintained in this repository.
  - `integrations/user/<provider>/integration.json`: user defined, never
    overwritten by upgrades. A user integration with the same provider id as a
    built-in one is a load error unless it opts in to override explicitly.
- Built-in integrations are **compiled in**: a build step generates a typed
  registry module from `integrations/builtin`. User integrations are
  discovered at startup from a configured directory (default `./integrations/user`).
- Workflows call an integration through an `integration.call` operation
  (`provider`, `action`, `input`, `credentials` reference). It expands to an
  HTTP request that still passes the URL policy, sandbox mocks, limits and
  redaction.
- Credentials are referenced by name and resolved from the environment or the
  run context; they never live in manifests or workflows.

## Consequences

- No manifest can execute code. New providers need no engine change.
- Authoring guidance for AI agents (template, schema, validation CLI) is part
  of the deliverable.
