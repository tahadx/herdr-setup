// The collapsed sidebar's rail, against the code the mod runs.
//
// The rail is a jump list, not the whole space list: `Ctrl+1`…`Ctrl+9` reach
// nine spaces, so a tenth is shown as one ellipsis instead of a scrolling
// column nobody can key to. This cuts the real function out and tries the edges.
//
//   node tests/rail.test.mjs
//   RAIL_ROOT=/some/other/checkout node tests/rail.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.RAIL_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "mods/agents-list/main.js"), "utf8");

const start = src.indexOf("const railShown =");
if (start < 0) throw new Error("mods/agents-list/main.js: no railShown");
const end = src.indexOf("\n};", start) + 3;
const railShown = new Function(`${src.slice(start, end)}; return railShown;`)();

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

const cells = (n) => Array.from({ length: n }, (_, i) => ({ key: String(i), n: i + 1 }));

for (const n of [0, 1, 8, 9]) {
  const { shown, beyond } = railShown(cells(n), 9);
  check(`${n} spaces fit the rail`, shown.length === n && beyond === 0);
}
for (const n of [10, 12]) {
  const { shown, beyond } = railShown(cells(n), 9);
  check(`${n} spaces keep nine cells and one ellipsis`, shown.length === 9 && beyond === n - 9);
  check(`${n} spaces keep the first nine in order`, shown.every((c, i) => c.n === i + 1));
}
const all = railShown(cells(12), null);
check("no limit leaves the agent rail whole", all.shown.length === 12 && all.beyond === 0);
check("the rail lists places, not worktree checkouts",
  /spaces\(\)\.filter\(\(sp\) => !isCheckout\(sp\)\)/.test(src));

if (failures) {
  console.error(`\n${failures} rail check(s) failed`);
  process.exit(1);
}
console.log("all rail checks passed");
