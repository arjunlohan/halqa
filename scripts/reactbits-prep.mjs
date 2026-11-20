// React Bits components are vendored source, written for React Bits' own compiler settings.
// This repo's flags are stricter (noUncheckedIndexedAccess and friends), so each vendored file
// opts out of type checking. Its exported prop types still reach the code that uses it.
// Run after adding a component:  pnpm reactbits:prep
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../apps/web/src/reactbits/", import.meta.url));
const header = [
  "// @ts-nocheck",
  "// Vendored from React Bits (https://reactbits.dev) through the shadcn registry. Not edited by hand.",
  "",
].join("\n");

let changed = 0;
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
  const source = readFileSync(dir + name, "utf8");
  if (source.startsWith("// @ts-nocheck")) continue;
  writeFileSync(dir + name, header + source);
  changed += 1;
}
console.log(`reactbits-prep: ${changed} file(s) marked`);
