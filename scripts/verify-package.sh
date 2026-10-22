#!/usr/bin/env bash
# Packs the package exactly as `npm publish` would, installs the tarball into a throwaway
# consumer project, and checks that it can be imported from ESM and CommonJS, type-checks for a
# TypeScript consumer, runs a workflow, and exposes the CLI. Also lists the tarball contents so
# an unintended file fails the check.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
consumer="$root/.consumer-check"
rm -rf "$consumer"
mkdir -p "$consumer"

cd "$root"
tarball="$(npm pack --pack-destination "$consumer" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].filename))')"

echo "== tarball contents"
allowed='^package/(bin/|dist/|schemas/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)'
tar -tzf "$consumer/$tarball" | tee "$consumer/files.txt"
if grep -vE "$allowed" "$consumer/files.txt"; then
  echo "unexpected files in the package (see above)" >&2
  exit 1
fi

cd "$consumer"
cat > package.json <<'JSON'
{ "name": "consumer-check", "private": true, "version": "0.0.0" }
JSON
npm install --silent --no-audit --no-fund "./$tarball"

cat > esm.mjs <<'JS'
import { createEngine, defineWorkflow, assertSucceeded, httpResponse } from "json-flow-engine";
const workflow = defineWorkflow({
  id: "consumer-esm", version: 1,
  steps: [{ id: "call", type: "http.request", config: { method: "GET", url: "https://api.example.com/{{input.id}}" } }],
  output: "{{steps.call.body}}",
});
const engine = createEngine({ mode: "sandbox" });
engine.mock("http.request", { responses: [{ output: httpResponse(200, { ok: true }) }] });
const result = await engine.execute(workflow, { id: 1 });
assertSucceeded(result);
if (result.output?.ok !== true) throw new Error("unexpected output");
console.log("esm ok", result.status, engine.calls[0].config.url);
JS

cat > cjs.cjs <<'JS'
const { createEngine, defineWorkflow, assertSucceeded } = require("json-flow-engine");
const workflow = defineWorkflow({ id: "consumer-cjs", version: 1, steps: [{ id: "t", type: "data.transform", config: { value: { n: "{{input.n}}" } } }], output: "{{steps.t.n}}" });
createEngine({ mode: "sandbox" }).execute(workflow, { n: 2 }).then((result) => {
  assertSucceeded(result);
  if (result.output !== 2) throw new Error("unexpected output");
  console.log("cjs ok", result.status);
});
JS

cat > types.ts <<'TS'
import { createEngine, defineWorkflow, type OperationDefinition, type ExecutionResult } from "json-flow-engine";
const op: OperationDefinition<{ name: string }, { greeting: string }> = {
  type: "greet",
  effects: "none",
  configSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  execute: ({ config }) => ({ greeting: `hi ${config.name}` }),
};
const engine = createEngine({ mode: "sandbox", operations: [op] });
const workflow = defineWorkflow({ id: "typed", version: 1, steps: [{ id: "g", type: "greet", config: { name: "{{input.name}}" } }] });
export const run = (): Promise<ExecutionResult> => engine.execute(workflow, { name: "x" });
// @ts-expect-error mode is required
createEngine({});
TS
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "strict": true, "module": "NodeNext", "moduleResolution": "NodeNext", "target": "ES2022", "noEmit": true, "skipLibCheck": true, "types": [] }, "files": ["types.ts"] }
JSON

echo "== esm import"
node esm.mjs
echo "== cjs require"
node cjs.cjs
echo "== typescript consumer (NodeNext)"
"$root/node_modules/.bin/tsc" -p tsconfig.json
echo "== typescript consumer (bundler resolution)"
"$root/node_modules/.bin/tsc" -p tsconfig.json --moduleResolution bundler --module esnext
echo "== cli"
./node_modules/.bin/json-flow validate "$root/examples/workflows/create-and-verify-resource.json"
./node_modules/.bin/json-flow test "$root/examples/workflows/create-and-verify-resource.json" \
  --input "$root/examples/fixtures/create-and-verify.input.json" \
  --mocks "$root/examples/fixtures/create-and-verify.mocks.json" --log silent >/dev/null
echo "== package verification passed"
