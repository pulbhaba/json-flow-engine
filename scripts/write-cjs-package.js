// Marks dist/cjs as CommonJS so Node does not treat its .js files as ESM (the root is "type": "module").
import { writeFileSync } from "node:fs";

writeFileSync("dist/cjs/package.json", `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
