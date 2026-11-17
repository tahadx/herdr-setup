// The bindings a person reads, against the file they install.
//
// docs/bindings.md is the page that answers "what does this key do"; keys.json is
// what install.sh merges into a Herdr home. The failures this guards against:
//
//   1. a binding added to keys.json and never documented;
//   2. a documented binding that no longer exists (a stale key, still pressed);
//   3. the copy-paste block drifting from keys.json;
//   4. install.sh merging a hand-kept subset of the layout's keys, so a fresh
//      install is missing the sidebar's own binds (it already lost Alt+B once).
//
//   node tests/bindings.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.BINDINGS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

const keys = JSON.parse(read("keys.json"));
const docs = read("docs/bindings.md");

// The page in sections, so the keys that come from keys.json and the keys a panel
// reads itself can be checked apart.
const CONTEXT = new Set(["The sidebar, with its keyboard", "The search sheet", "Dialogs and popups"]);
const sections = [];
for (const line of docs.split("\n")) {
  if (line.startsWith("## ")) sections.push({ heading: line.slice(3).trim(), lines: [] });
  else if (sections.length) sections.at(-1).lines.push(line);
}
check("the page keeps its panel sections", [...CONTEXT].every((h) => sections.some((s) => s.heading === h)),
  [...CONTEXT].filter((h) => !sections.some((s) => s.heading === h)).join(", "));

// The keys.json tables: every binding in the file, and nothing that is not in it.
const tableKeys = new Set();
for (const section of sections) {
  if (CONTEXT.has(section.heading) || section.heading === "The file") continue;
  for (const line of section.lines) {
    if (!line.startsWith("|")) continue;
    const first = line.split("|")[1] ?? "";
    for (const [, key] of first.matchAll(/`([^`]+)`/g)) tableKeys.add(key);
  }
}
const fileKeys = new Set(Object.values(keys).flatMap((section) => Object.keys(section)));
check("every key in keys.json has a row",
  [...fileKeys].every((k) => tableKeys.has(k)),
  [...fileKeys].filter((k) => !tableKeys.has(k)).join(", "));
check("every row names a key that is in keys.json",
  [...tableKeys].every((k) => fileKeys.has(k)),
  [...tableKeys].filter((k) => !fileKeys.has(k)).join(", "));

// The copy-paste block is the file itself, byte for byte.
const block = docs.match(/```json\n([\s\S]*?)\n```/);
check("the copy-paste block is keys.json itself",
  Boolean(block) && block[1].trimEnd() === read("keys.json").trimEnd(),
  block ? "the block differs from keys.json" : "no ```json block");

// install.sh merges the layout's section from this repo's file, not a copy kept
// in the script: that copy had already fallen behind keys.json.
const install = read("install.sh");
check("install.sh merges the layout's section from keys.json",
  /"\$here\/keys\.json"/.test(install));
check("install.sh keeps no copy of the bindings itself",
  !/"alt-f"\s*:\s*"/.test(install),
  "a hand-kept map drifts from keys.json");
// A fresh home gets Herdr's defaults in global/terminal; the behaviours this
// layout promises have to be in its own section, or the install never applies
// them. Alt+F and the tab/space numbering are the ones that were left behind.
check("the layout section carries the search key",
  keys["layout:workspace"]?.["alt-f"] === "mod.open:agents-list",
  "alt-f would only be a global key, which install.sh must not overwrite");
check("the layout section carries its tab and space numbers",
  keys["layout:workspace"]?.["alt-1"] === "tab.select:1"
  && keys["layout:workspace"]?.["ctrl-1"] === "space.select:1");
check("install.sh adds app-wide keys only where the person has none",
  /for name in \("global", "terminal"\)/.test(install)
  && /if key in target or \(not fill and key in ours\)/.test(install),
  "a layout-only key would leak into other layouts");

// The README points at the page.
check("the README links the bindings page",
  /\[docs\/bindings\.md\]\(docs\/bindings\.md\)/.test(read("README.md")));

console.log(failures ? `\n${failures} bindings check(s) failed` : "\nall bindings checks passed");
process.exit(failures ? 1 : 0);
