// A pinned space is never closed.
//
// What this guards:
//   - a pinned space whose folder goes is kept by the sidebar's sweep, instead of
//     being closed and unpinned six seconds later;
//   - no dialog closes one, and no worktree removal ends one;
//   - stopping an agent never takes its space with it: where the agent is the
//     only thing in a space, a shell opens there first;
//   - a removal only names a space when a space will actually go, so "Remove
//     worktree" cannot read as if it is about to close something unrelated.
//
//   node tests/pinned.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.MODS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, "mods", name, "main.js"), "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

// `isPinned` is module scope in each mod (mods cannot import each other), so it
// is lifted out and run against stubs, the way tests/search.test.mjs does.
// A balanced scan, not line slicing: one of these definitions spans lines and
// one of the helpers is a function declaration.
function pick(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return "";
  const isFn = needle.startsWith("function");
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (isFn && depth === 0 && c === "}") return src.slice(at, i + 1);
    } else if (c === ";" && depth === 0 && !isFn) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

// Returns a factory: (shared, place) => isPinned, so each case runs with its own
// stubs.
function liftPinned(src) {
  if (!src.includes("const isPinned =")) throw new Error("this mod has no isPinned");
  const helpers = [pick(src, "const norm ="), pick(src, "const pinnedList ="), pick(src, "function pinnedList")]
    .filter(Boolean).join("\n");
  return new Function("shared", "place", `${helpers}\n${pick(src, "const isPinned =")}\nreturn isPinned;`);
}

const space = { id: "sp1", machine: null, folder: "/home/x/repo", name: "repo" };
const pins = [
  { id: "sp1", folder: "/home/x/repo", machine: null, name: "repo" },
  { id: "gone", folder: "/home/x/old", machine: null, name: "old" },
  // A pin saved before pins had ids: only its place identifies it.
  { folder: "/home/y/legacy", machine: null, name: "legacy" },
];

for (const mod of ["footer", "worktrees", "search"]) {
  const factory = liftPinned(read(mod));
  const place = (s) => s?.folder ?? null;
  const isPinned = factory((key) => (key === "spaces.pinned" ? pins : undefined), place);
  check(`${mod}: a pin is matched by its space id`, isPinned(space) === true);
  check(`${mod}: a space nobody pinned is not pinned`, isPinned({ id: "sp2", machine: null, folder: "/home/x/other" }) === false);
  check(`${mod}: no space, no pin`, isPinned(null) === false && isPinned(undefined) === false);
  check(`${mod}: a pin without an id falls back to its place`,
    isPinned({ id: "new-id", machine: null, folder: "/home/y/legacy" }) === true);
  check(`${mod}: the same folder on another machine is another pin`,
    isPinned({ id: "new-id", machine: "vps", folder: "/home/y/legacy" }) === false);
  const none = factory(() => undefined, place);
  check(`${mod}: nothing pinned, nothing protected`, none(space) === false);
}

// The behaviours themselves: each is a line of source, and each line is what
// makes the rule true rather than only documented.
const sweep = read("footer");
check("the sweep keeps a pinned space instead of closing it",
  /if \(isPinned\(s\)\) \{[\s\S]{0,600}?continue;/.test(sweep), "sweepGone must skip pinned spaces and not close them");

const worktree = read("worktrees");
check("closing a space refuses while pinned",
  /removeSpace\(cx\) \{[\s\S]{0,160}if \(isPinned\(s\)\)/.test(worktree));
check("removing a worktree refuses to end a pinned space",
  /async remove\(\) \{[\s\S]{0,220}if \(s && isPinned\(s\)\) return/.test(worktree));
check("stopping an agent opens a shell so its space stays",
  /const \{ s, last \} = this\.alone\(a\);[\s\S]{0,160}if \(s && last\) run\("tab\.new"/.test(worktree));
check("a removal names a space only when one goes",
  /standing \? `Closes the space \$\{standing\.name\} and deletes` : "Deletes"/.test(worktree));
check("stopping an agent says what happens to its space",
  /only terminal in \$\{home\.name\}: a shell opens in its place/.test(worktree));

const sheet = read("search");
check("the sheet refuses to close a pinned space",
  /if \(isPinned\(sel\.s\)\) return notify\(/.test(sheet));

const sidebar = read("agents-list");
check("the space menu does not offer closing a pinned space",
  /\.\.\.\(pin \? \[\] : \[\{ id: "sm-close"/.test(sidebar));

// A pin belongs to a space. A worktree is a checkout drawn under its repo, and
// the pin affordance on a worktree row was lost once already (the edit that was
// meant to add `!tree` wrote nothing), so all three places are pinned down here.
check("no pin on a worktree row, hovered or not",
  /\.when\(!tree && \(Boolean\(pin\) \|\| hovered\)/.test(sidebar));
check("the space menu does not offer to pin a worktree",
  /isWorktreeSpace \? \[\] : \[\{ id: "sm-pin"/.test(sidebar));
check("the sheet refuses to pin a worktree",
  /kind === "space" && this\.isWorktree\(r\.s\)\) return notify/.test(sheet));
check("a worktree row draws no pin in the sheet",
  /!this\.isWorktree\(s\) && Boolean\(this\.spacePin\(s\)\)/.test(sheet));

console.log(failures ? `\n${failures} pinned-space check(s) failed` : "all pinned-space checks passed");
process.exit(failures ? 1 : 0);
