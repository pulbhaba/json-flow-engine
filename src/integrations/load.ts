import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ValidationIssue } from "../errors.js";
import { validateIntegrationManifest } from "./validate.js";
import type { IntegrationManifest } from "./types.js";

export type IntegrationSource = "builtin" | "user";

/** Default user integrations directory, relative to the current working directory. */
export const DEFAULT_USER_INTEGRATIONS_DIR = "./integrations/user";

export interface LoadedIntegration {
  source: IntegrationSource;
  provider: string;
  /** Path of the `integration.json` the manifest was read from. */
  file: string;
  manifest: IntegrationManifest;
  /** User integrations only: true when it replaces a built-in one via `overridesBuiltin`. */
  overrides: boolean;
  /** Built-in integrations only: true when a user integration replaces it. */
  overriddenBy?: string;
}

export interface IntegrationLoadError {
  source: IntegrationSource;
  /** The file (or directory) the error belongs to. */
  file: string;
  message: string;
  issues?: ValidationIssue[];
}

export interface IntegrationLoadResult {
  builtin: LoadedIntegration[];
  user: LoadedIntegration[];
  errors: IntegrationLoadError[];
}

export interface LoadIntegrationsOptions {
  /** Directory holding built-in `<provider>/integration.json` files. */
  builtinDir: string;
  /** Directory holding user `<provider>/integration.json` files. Default `./integrations/user`. */
  userDir?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function loadSource(
  source: IntegrationSource,
  dir: string,
  missingIsError: boolean,
  errors: IntegrationLoadError[],
): Promise<LoadedIntegration[]> {
  const loaded: LoadedIntegration[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!(isNotFound(error) && !missingIsError)) {
      errors.push({ source, file: dir, message: `cannot read directory: ${errorMessage(error)}` });
    }
    return loaded;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "integration.json");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        errors.push({ source, file, message: `cannot read file: ${errorMessage(error)}` });
      }
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      errors.push({ source, file, message: `invalid JSON: ${errorMessage(error)}` });
      continue;
    }
    const result = validateIntegrationManifest(data);
    if (!result.ok) {
      errors.push({
        source,
        file,
        message: "manifest is invalid",
        issues: result.issues,
      });
      continue;
    }
    const manifest = result.manifest;
    if (manifest.provider !== entry.name) {
      errors.push({
        source,
        file,
        message: `provider "${manifest.provider}" must match its directory name "${entry.name}"`,
      });
      continue;
    }
    loaded.push({ source, provider: manifest.provider, file, manifest, overrides: false });
  }
  return loaded;
}

/**
 * Discovers and validates integration manifests under a built-in and a user directory. Sources
 * stay separate in the result. A user provider id that is also built in is an error unless the
 * user manifest sets `overridesBuiltin: true`. Per-file problems are collected in `errors` and
 * never stop other files; manifests are only parsed, never executed.
 */
export async function loadIntegrations(
  options: LoadIntegrationsOptions,
): Promise<IntegrationLoadResult> {
  const errors: IntegrationLoadError[] = [];
  const builtin = await loadSource("builtin", resolve(options.builtinDir), true, errors);
  const user = await loadSource(
    "user",
    resolve(options.userDir ?? DEFAULT_USER_INTEGRATIONS_DIR),
    false,
    errors,
  );

  const builtinById = new Map<string, LoadedIntegration>();
  for (const item of builtin) builtinById.set(item.provider, item);

  const acceptedUser: LoadedIntegration[] = [];
  for (const item of user) {
    const base = builtinById.get(item.provider);
    if (base === undefined) {
      acceptedUser.push(item);
    } else if (item.manifest.overridesBuiltin === true) {
      item.overrides = true;
      base.overriddenBy = item.file;
      acceptedUser.push(item);
    } else {
      errors.push({
        source: "user",
        file: item.file,
        message: `provider "${item.provider}" is already built in; set "overridesBuiltin": true to replace it`,
      });
    }
  }

  return { builtin, user: acceptedUser, errors };
}

/**
 * Loads only the user integrations directory (default `./integrations/user`), for passing to
 * `createEngine({ integrations: { user } })`. Built-ins are compiled in and added by the engine.
 */
export async function loadUserIntegrations(
  userDir: string = DEFAULT_USER_INTEGRATIONS_DIR,
): Promise<{ user: LoadedIntegration[]; errors: IntegrationLoadError[] }> {
  const errors: IntegrationLoadError[] = [];
  const user = await loadSource("user", resolve(userDir), false, errors);
  return { user, errors };
}
