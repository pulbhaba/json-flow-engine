import type { ValidationIssue } from "../errors.js";
import { isJsonObject } from "../json.js";
import { createAjv, formatAjvError, type ValidateFunction } from "../schemas/ajv.js";
import { compileInputSchema } from "../workflow/validate.js";
import { integrationSchema } from "./schema.js";
import type { IntegrationManifest } from "./types.js";

export type IntegrationValidationResult =
  | { ok: true; manifest: IntegrationManifest; issues: [] }
  | { ok: false; manifest?: undefined; issues: ValidationIssue[] };

let structuralValidator: ValidateFunction | undefined;

function getStructuralValidator(): ValidateFunction {
  structuralValidator ??= createAjv().compile(integrationSchema);
  return structuralValidator;
}

function isManifestShaped(value: unknown): value is IntegrationManifest {
  return (
    isJsonObject(value) &&
    typeof value["baseUrl"] === "string" &&
    Array.isArray(value["allowedHosts"]) &&
    isJsonObject(value["actions"])
  );
}

/**
 * Validates an integration manifest (for example parsed from `integration.json`). Structural
 * problems, a `baseUrl` that is not a plain https origin on an allowed host, and `inputSchema`s
 * that do not compile are reported together with JSON pointers into the manifest.
 */
export function validateIntegrationManifest(manifest: unknown): IntegrationValidationResult {
  const validate = getStructuralValidator();
  if (!validate(manifest)) {
    const seen = new Set<string>();
    const issues: ValidationIssue[] = [];
    for (const error of validate.errors ?? []) {
      if (error.keyword === "if") continue;
      const issue: ValidationIssue = {
        code: "INTEGRATION_INVALID",
        path: error.instancePath,
        message: formatAjvError(error),
      };
      const key = `${issue.path}|${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
    return { ok: false, issues };
  }
  if (!isManifestShaped(manifest)) {
    return {
      ok: false,
      issues: [
        { code: "INTEGRATION_INVALID", path: "", message: "manifest must be a JSON object" },
      ],
    };
  }

  const issues: ValidationIssue[] = [];
  let url: URL | undefined;
  try {
    url = new URL(manifest.baseUrl);
  } catch {
    issues.push({
      code: "INTEGRATION_INVALID",
      path: "/baseUrl",
      message: "baseUrl is not a valid URL",
    });
  }
  if (url !== undefined) {
    if (url.protocol !== "https:") {
      issues.push({
        code: "INTEGRATION_INVALID",
        path: "/baseUrl",
        message: "baseUrl must use https",
      });
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      issues.push({
        code: "INTEGRATION_INVALID",
        path: "/baseUrl",
        message: "baseUrl must not contain credentials, a query string or a fragment",
      });
    }
    if (!manifest.allowedHosts.includes(url.hostname)) {
      issues.push({
        code: "INTEGRATION_INVALID",
        path: "/allowedHosts",
        message: `allowedHosts must include the baseUrl host "${url.hostname}"`,
      });
    }
  }

  for (const [name, action] of Object.entries(manifest.actions)) {
    try {
      compileInputSchema(action.inputSchema);
    } catch (error) {
      issues.push({
        code: "SCHEMA_INVALID",
        path: `/actions/${name}/inputSchema`,
        message: `inputSchema is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest, issues: [] };
}
