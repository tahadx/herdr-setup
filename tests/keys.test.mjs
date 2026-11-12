// The sheet's keys: Shift has to be read before plain Ctrl.
//
// The bug this guards against: the plain Ctrl+J/K branch sat above the
// Ctrl+Shift+J/K pair and never asked about Shift, so the reorder keys were
// unreachable — pressing them walked the highlight, which looks like nothing
// happened. The order of two branches in a long else-if chain is invisible in
// review and invisible to every other test, and it costs a person their keys.
//
//   node tests/keys.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PALETTE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "mods/search/main.js"), "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

// The key handler is one else-if chain; a branch only runs if nothing above it
// matched. So what matters is the order of the conditions in the source.
const at = (needle) => src.indexOf(needle);
const shiftUp = at('ctrl && e.modifiers.shift && k === "k"');
const shiftDown = at('ctrl && e.modifiers.shift && k === "j"');
const walk = at('ctrl && !e.modifiers.shift && (k === "j" || k === "k")');
const paging = at('(k === "pagedown" || k === "pageup")');

check("Ctrl+Shift+K reorders up", shiftUp > 0);
check("Ctrl+Shift+J reorders down", shiftDown > 0);
check("plain Ctrl+J/K asks about Shift first", walk > 0);
check(
  "the reorder branches come before the walk",
  shiftUp > 0 && shiftDown > 0 && walk > 0 && shiftUp < walk && shiftDown < walk,
  "Ctrl+Shift+J/K would be swallowed by the Ctrl+J/K branch",
);
check("paging is still somewhere below", paging > 0);

// Both reorder branches have to call the reorder, not the walk.
const reorderCalls = [...src.matchAll(/this\.startMove\((-?1), cx\)/g)].map((m) => m[1]).sort();
check("both directions call startMove", reorderCalls.join(",") === "-1,1", `saw ${reorderCalls.join(",") || "none"}`);

console.log(failures ? `\n${failures} key check(s) failed` : "all key checks passed");
process.exit(failures ? 1 : 0);
