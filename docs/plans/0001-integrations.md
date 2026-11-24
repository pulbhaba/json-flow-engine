# Plan 0001: Integration system

Status: implementation complete, merging pending. Every task has an open pull request, stacked
in task order (#8 -> #9 -> #10 -> #11 -> #12 -> the #7 pull request); the plan is not done until
the stack is merged. Design: `docs/decisions/0001-integrations.md`.

Outcome: users call HubSpot, OpenAI and similar services by name from a
workflow, with built-in and user-defined integrations loaded without extra
configuration, and a documented path for an AI agent to add new ones.

## Tasks

Each task is one issue and one small pull request, delivered in this order as a
stack. Issue numbers are filled in as they are created.

| #   | Task                                                              | Type | Blocked by | Issue |
| --- | ----------------------------------------------------------------- | ---- | ---------- | ----- |
| 1   | Integration manifest format, JSON Schema and validator            | feat | -          | #2    |
| 2   | Loader for `integrations/builtin` and `integrations/user`         | feat | 1          | #3    |
| 3   | Build-time generation of the built-in registry                    | feat | 2          | #4    |
| 4   | `integration.call` operation with credentials, sandbox and policy | feat | 3          | #5    |
| 5   | Built-in integrations: HubSpot and OpenAI                         | feat | 4          | #6    |
| 6   | CLI `integration list/validate/scaffold` and AI authoring guide   | feat | 4          | #7    |

## Open questions

- Pagination and OAuth refresh flows are out of scope for the first version.
