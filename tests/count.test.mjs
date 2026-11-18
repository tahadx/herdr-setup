// What the "Spaces" number means, and where the pin sits.
//
// The failure this guards against: a pinned space whose shell exits keeps its
// row (that is the pin's promise) but `spaces()` no longer has it, so a header
// counted from live spaces alone dropped by one while the row stayed. A pin is
// a place: it opens a shell in its folder, so the number must not change when
// the pinned space's shell closes.
//
// The second failure: a place with no git answer yet (a new space, a folder
// outside a repo) had no flexible tail to take the row's slack, so its pin sat
// in the middle of the row instead of at the end. Both the visible pin and the
// one the keyboard shows must sit in the same slot, at the end.
//
//   node tests/count.test.mjs
//   COUNT_ROOT=/some/other/checkout node tests/count.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.COUNT_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name, file = "main.js") => readFileSync(join(root, "mods", name, file), "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

// A balanced scan for a function declaration, the way tests/pinned.test.mjs
// lifts `isPinned`: the rule is run against stubs, not copied into the test.
function pickFn(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`no ${name}`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0 && c === "}") return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

const engine = read("agents-list", "workspace-engine.js");
const placeCount = new Function("isWorktree", `
  ${pickFn(engine, "placeCount")}
  return placeCount;
`)();

const space = (id) => ({ id, name: id, folder: `/work/${id}`, machine: null });
const pin = (s) => ({ s });
const isWorktree = (s) => String(s?.id ?? "").startsWith("wt");

// ---------------------------------------------------------------- the rule
check("live places count, agents do not exist here",
  placeCount([space("a"), space("b")], []) === 2);
check("a worktree space is a checkout, not another place",
  placeCount([space("a"), space("wt1")], [], isWorktree) === 1);
check("a pin whose space is gone is still a place",
  placeCount([space("a")], [pin(space("a")), pin(null)], isWorktree) === 2);
check("a pinned worktree is not counted twice",
  placeCount([space("a"), space("wt1")], [pin(space("a")), pin(space("wt1"))], isWorktree) === 1);
check("two pins of one live space count once",
  placeCount([space("a")], [pin(space("a")), pin(space("a"))], isWorktree) === 1);

// The user's case: a pinned place, before and after its shell exits. The row
// stays, so the number stays.
const before = [space("a"), space("b"), space("c")];
const beforePins = [pin(before[0]), pin(before[1]), pin(before[2])];
const after = before.filter((s) => s.id !== "b");
const afterPins = beforePins.map((row) => (row.s?.id === "b" ? pin(null) : row));
check("closing a pinned space's shell keeps the number",
  placeCount(before, beforePins) === placeCount(after, afterPins),
  `${placeCount(before, beforePins)} -> ${placeCount(after, afterPins)}`);
check("that number is one more than live places alone",
  placeCount(after, afterPins) === after.length + 1);

// ---------------------------------------------------------------- the views
const sidebar = read("agents-list", "sidebar.js");
const palette = read("agents-list", "palette.js");
check("the sidebar imports the one count rule", /placeCount/.test(sidebar.slice(0, sidebar.indexOf("function columnOf"))));
check("the sidebar counts places and its orphan pins, not live spaces alone",
  /this\.spaceCount = placeCount\(allSpaces, pinsNow, \(s\) => forest\.worktrees\.has\(s\.id\)\)/.test(sidebar),
  "spaceCount must use placeCount(allSpaces, pinsNow, worktree test)");
check("the sidebar header reads that count", /this\.spaceCount \?\?/.test(sidebar));
check("the sheet imports the same rule", /placeCount/.test(palette.slice(0, palette.indexOf("export class Palette"))));
check("the sheet counts places and its orphan pins with the same rule",
  /this\.placeTotal = placeCount\(all, shownPins, \(s\) => this\.isWorktree\(s\)\)/.test(palette));
check("the sheet header reads that count",
  /this\.placeTotal \?\? places\.length/.test(palette));

// ---------------------------------------------------------------- the slot
// A place without git gets a spacer where the tail would be; without it the pin
// is the last child but there is no slack, so it lands mid-row.
check("a row with no git tail still takes the slack before its trailing controls",
  /\.child\(g \? this\.gitTail\(g, tree, label, t\) : div\(\)\.flex_1\(\)\)/.test(sidebar),
  "spaceRow: replace the gitTail-only child with a g-or-spacer child");
check("the pin is drawn after the tail and the fold control",
  sidebar.indexOf("child(this.gitTail") < sidebar.indexOf("id(`spin-${s.id}`)")
    && sidebar.indexOf("sfold-") < sidebar.indexOf("id(`spin-${s.id}`)"),
  "the pin slot must stay the row's last control");

// The sheet has no hover pin: its pin marker is the row's last child after a
// flexible label, so it already sits at the end. Guard the flexible label.
const markerAt = palette.indexOf(".child(marker(Boolean(r.inPins)");
const rowAt = palette.lastIndexOf("if (r.kind === \"space\")", markerAt);
const row = rowAt >= 0 && markerAt > rowAt ? palette.slice(rowAt, markerAt) : "";
check("the sheet's space label takes the slack before its pin marker",
  /\.child\(this\.label\(shown,/.test(row) && /flex_1/.test(palette.slice(palette.indexOf("  label("), palette.indexOf("  kidsOf("))),
  "Palette.label must flex, so the marker ends the row");

if (failures) {
  console.error(`\n${failures} spaces-count check(s) failed`);
  process.exit(1);
}
console.log("all spaces-count checks passed");
