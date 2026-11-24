# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- Built-in `hubspot` (create/update/search contacts) and `openai` (chat completion) integrations with example workflows (#6).

## [0.1.0] - 2026-10-22

Initial release.

- Workflow format v1 with JSON Schema (`schemas/workflow.schema.json`): `id`, `version`,
  `description`, `inputSchema`, `constants`, `execution`, `output`, `steps`; per-step `timeoutMs`,
  `retry`, `onError`, `idempotencyKey`.
- Expression references `{{input.*}}`, `{{steps.<id>.*}}`, `{{constants.*}}` with `?? <literal>`
  fallbacks; typed single-expression values; fail-closed on missing values.
- Sequential engine with structured results, step records, events, pluggable logger,
  cancellation, step and execution timeouts, bounded retries with full-jitter backoff, limits.
- Built-in operations `data.transform`, `control.condition`, `control.assert`, `http.request`.
- Sandbox mode with fail-closed mocks (fixed responses, simulated errors, delays, call log).
- CLI `json-flow validate | run | test`, sandbox by default.
