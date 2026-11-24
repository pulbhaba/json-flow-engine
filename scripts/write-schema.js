// Writes the JSON Schemas from the built ESM output to schemas/*.schema.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { workflowSchema } from "../dist/esm/workflow/schema.js";
import { integrationSchema } from "../dist/esm/integrations/schema.js";

const targets = [
  ["schemas/workflow.schema.json", workflowSchema],
  ["schemas/integration.schema.json", integrationSchema],
];
const check = process.argv.includes("--check");
let stale = false;
for (const [target, schema] of targets) {
  const next = `${JSON.stringify(schema, null, 2)}\n`;
  if (check) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== next) {
      console.error(`${target} is out of date; run npm run build`);
      stale = true;
    } else {
      console.log(`${target} is up to date`);
    }
  } else {
    writeFileSync(target, next);
    console.log(`wrote ${target}`);
  }
}
if (stale) process.exit(1);
