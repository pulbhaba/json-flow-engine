import type { IntegrationLoadError, LoadedIntegration } from "./load.js";
import { builtinManifests } from "./generated/builtin.js";
import type { IntegrationManifest } from "./types.js";

/** Built-in integration manifests compiled into the package (no runtime file reads). */
export function getBuiltinManifests(): readonly IntegrationManifest[] {
  return builtinManifests;
}

export interface CombinedIntegrations {
  /** Active integrations: built-ins not replaced by a user override, then user integrations. */
  integrations: LoadedIntegration[];
  errors: IntegrationLoadError[];
}

/**
 * Combines the compiled-in built-ins with user integrations (for example `loadIntegrations(...).user`)
 * using the loader's rules: a user provider that is also built in is an error unless its manifest
 * sets `overridesBuiltin: true`, in which case it replaces the built-in one.
 */
export function combineIntegrations(
  user: readonly LoadedIntegration[],
  builtin: readonly IntegrationManifest[] = builtinManifests,
): CombinedIntegrations {
  const errors: IntegrationLoadError[] = [];
  const builtinIds = new Set(builtin.map((manifest) => manifest.provider));
  const accepted: LoadedIntegration[] = [];
  const overridden = new Set<string>();
  for (const item of user) {
    if (!builtinIds.has(item.provider)) {
      accepted.push(item);
    } else if (item.manifest.overridesBuiltin === true) {
      overridden.add(item.provider);
      accepted.push({ ...item, overrides: true });
    } else {
      errors.push({
        source: "user",
        file: item.file,
        message: `provider "${item.provider}" is already built in; set "overridesBuiltin": true to replace it`,
      });
    }
  }
  const integrations: LoadedIntegration[] = [];
  for (const manifest of builtin) {
    if (overridden.has(manifest.provider)) continue;
    integrations.push({
      source: "builtin",
      provider: manifest.provider,
      file: `integrations/builtin/${manifest.provider}/integration.json`,
      manifest,
      overrides: false,
    });
  }
  integrations.push(...accepted);
  return { integrations, errors };
}
