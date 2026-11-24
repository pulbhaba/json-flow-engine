import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CliIo } from "../cli.js";
import { combineIntegrations, getBuiltinManifests } from "./builtin.js";
import { DEFAULT_USER_INTEGRATIONS_DIR, loadUserIntegrations } from "./load.js";
import type { LoadedIntegration } from "./load.js";
import { validateIntegrationManifest } from "./validate.js";

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

function actionNames(item: LoadedIntegration): string {
  return Object.keys(item.manifest.actions).join(", ");
}

function describe(item: LoadedIntegration, note = ""): string {
  const name =
    item.manifest.name === undefined || item.manifest.name === item.provider
      ? ""
      : ` (${item.manifest.name})`;
  return `  ${item.provider}${name}${note}: ${actionNames(item)}`;
}

/** `json-flow integration list`: built-in and user integrations, labelled separately. */
export async function integrationList(userDir: string | undefined, io: CliIo): Promise<number> {
  const dir = userDir ?? DEFAULT_USER_INTEGRATIONS_DIR;
  const { user, errors } = await loadUserIntegrations(dir);
  const { integrations, errors: collisions } = combineIntegrations(user);
  const overridden = new Set(user.filter((u) => u.overrides).map((u) => u.provider));
  const builtinManifests = getBuiltinManifests();

  io.stdout("Built-in integrations:");
  for (const manifest of builtinManifests) {
    const actions = Object.keys(manifest.actions).join(", ");
    const note = overridden.has(manifest.provider) ? " [overridden by user]" : "";
    const name =
      manifest.name === undefined || manifest.name === manifest.provider
        ? ""
        : ` (${manifest.name})`;
    io.stdout(`  ${manifest.provider}${name}${note}: ${actions}`);
  }
  io.stdout(`User integrations (${dir}):`);
  const active = integrations.filter((i) => i.source === "user");
  if (active.length === 0) io.stdout("  (none)");
  for (const item of active)
    io.stdout(describe(item, item.overrides ? " [overrides built-in]" : ""));

  const problems = [...errors, ...collisions];
  for (const problem of problems) {
    io.stderr(`${problem.file}: ${problem.message}`);
    for (const issue of problem.issues ?? [])
      io.stderr(`  ${issue.path || "/"}: ${issue.message} [${issue.code}]`);
  }
  return problems.length > 0 ? 1 : 0;
}

async function resolveManifestFile(path: string): Promise<string> {
  const info = await stat(path);
  return info.isDirectory() ? join(path, "integration.json") : path;
}

/** `json-flow integration validate <path>`: a manifest file or a provider directory. */
export async function integrationValidate(path: string, io: CliIo): Promise<number> {
  let file: string;
  let text: string;
  try {
    file = await resolveManifestFile(path);
    text = await readFile(file, "utf8");
  } catch (error) {
    io.stderr(
      `${path}: cannot read manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    io.stderr(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const result = validateIntegrationManifest(data);
  if (!result.ok) {
    io.stderr(`${file}: ${result.issues.length} issue(s)`);
    for (const issue of result.issues)
      io.stderr(`  ${issue.path || "/"}: ${issue.message} [${issue.code}]`);
    return 1;
  }
  const { manifest } = result;
  const problems: string[] = [];
  if (basename(file) === "integration.json") {
    const directory = basename(dirname(resolve(file)));
    if (directory !== manifest.provider)
      problems.push(
        `/provider: "${manifest.provider}" must match its directory name "${directory}"`,
      );
  }
  if (
    getBuiltinManifests().some((b) => b.provider === manifest.provider) &&
    manifest.overridesBuiltin !== true
  )
    problems.push(
      `/provider: "${manifest.provider}" is already built in; set "overridesBuiltin": true to replace it`,
    );
  if (problems.length > 0) {
    io.stderr(`${file}: ${problems.length} issue(s)`);
    for (const problem of problems) io.stderr(`  ${problem}`);
    return 1;
  }
  io.stdout(
    `${file}: valid (${manifest.provider}, ${Object.keys(manifest.actions).length} action(s))`,
  );
  return 0;
}

export function scaffoldManifest(provider: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider,
    name: provider,
    description: `TODO: describe the ${provider} integration.`,
    baseUrl: `https://api.${provider}.example.com/v1`,
    allowedHosts: [`api.${provider}.example.com`],
    auth: { type: "bearer" },
    actions: {
      "get-item": {
        description: "TODO: replace with a real action (GET /items/{id}).",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", minLength: 1 } },
          required: ["id"],
          additionalProperties: false,
        },
        request: { method: "GET", path: "/items/{{input.id}}" },
        response: { output: { id: "{{input.body.id}}", name: "{{input.body.name}}" } },
      },
    },
  };
}

/** `json-flow integration scaffold <provider>`: writes a starter manifest, never overwrites. */
export async function integrationScaffold(
  provider: string,
  userDir: string | undefined,
  io: CliIo,
): Promise<number> {
  if (!PROVIDER_ID.test(provider) || provider.length > 64) {
    io.stderr(
      `Invalid provider id "${provider}": use lowercase letters, digits and "-", starting with a letter.`,
    );
    return 2;
  }
  const file = join(userDir ?? DEFAULT_USER_INTEGRATIONS_DIR, provider, "integration.json");
  if (getBuiltinManifests().some((b) => b.provider === provider)) {
    io.stderr(
      `"${provider}" is a built-in provider. Pick another id, or write the manifest by hand with "overridesBuiltin": true to replace it deliberately.`,
    );
    return 1;
  }
  const manifest = scaffoldManifest(provider);
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      io.stderr(`${file} already exists; refusing to overwrite.`);
      return 1;
    }
    throw error;
  }
  io.stdout(
    `Created ${file}\nNext: edit it, then run \`json-flow integration validate ${dirname(file)}\`.`,
  );
  return 0;
}
