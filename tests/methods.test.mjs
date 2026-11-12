// Every `this.foo(` in a mod must name a method that mod defines, and no method
// may be defined twice (the second body silently wins).
//
// A rename that misses one call site is invisible until someone presses that key:
// `this.dropPin()` kept its old name after the method became `dropPins()`, and the
// worktree dialog answered "this.dropPin is not a function" when it was used.
//
//   node tests/methods.test.mjs
//   MODS=/some/other/mods node tests/methods.test.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mods = process.env.MODS ?? join(dirname(fileURLToPath(import.meta.url)), "..", "mods");

const files = [];
for (const name of readdirSync(mods)) {
  const dir = join(mods, name);
  if (!statSync(dir).isDirectory()) continue;
  try {
    readFileSync(join(dir, "main.js"));
    files.push({ name, src: readFileSync(join(dir, "main.js"), "utf8") });
  } catch {
    // a mod without main.js (assets only) has nothing to check
  }
}

let bad = 0;
for (const { name, src } of files) {
  // `  method(` and `  async method(` — the class body's own shape in these mods.
  const names = [...src.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const defined = new Set(names);
  // One name, one body: a second definition silently replaces the first, so the
  // dead copy still reads as live code (askStop was written twice, byte for byte).
  const counts = new Map();
  for (const method of names) counts.set(method, (counts.get(method) ?? 0) + 1);
  const used = new Set([...src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  // A call written at two spaces reads like a definition (`run(...)` at the top
  // of a method body), so only names this mod calls as `this.name(` are checked.
  const keywords = new Set(["for", "if", "while", "switch", "catch", "return", "else", "try", "do", "function", "with"]);
  for (const [method, n] of counts) {
    if (n > 1 && !keywords.has(method) && used.has(method)) {
      console.log(`${name}: ${method}() is defined ${n} times`);
      bad++;
    }
  }
  for (const method of used) {
    if (defined.has(method)) continue;
    console.log(`${name}: this.${method}() is never defined`);
    bad++;
  }
}

console.log(bad ? `\n${bad} method problem(s)` : `every this.* call is defined in ${files.length} mods, each method once`);
process.exit(bad ? 1 : 0);
