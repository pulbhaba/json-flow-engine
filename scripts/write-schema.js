// Writes the workflow JSON Schema from the built ESM output to schemas/workflow.schema.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { workflowSchema } from "../dist/esm/workflow/schema.js";

const target = "schemas/workflow.schema.json";
const next = `${JSON.stringify(workflowSchema, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== next) {
    console.error(`${target} is out of date; run npm run build`);
    process.exit(1);
  }
  console.log(`${target} is up to date`);
} else {
  writeFileSync(target, next);
  console.log(`wrote ${target}`);
}
