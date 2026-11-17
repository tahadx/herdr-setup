// Where worktrees hang, and the name they keep.
//
// The failures this guards against:
//
//   1. The find sheet's tree was a second copy of the sidebar's, and it silently
//      fell over (three helpers were not imported), so every worktree space read
//      as a bare row under IDLE instead of nested under its repo.
//   2. A terminal that cd'd out of its checkout made the space stop being a
//      worktree: it detached from its repo and Herdr renamed it after the new
//      folder ("test" became "tmp").
//   3. A checkout that already had a space was also listed as an unopened
//      checkout, so every worktree appeared twice.
//   4. Opening a checkout from a row did not start anything: the space was made
//      unnamed, and the first `cd` renamed it away.
//
//   node tests/worktree.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.WORKTREE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const core = read("mods/agents-list/workspace-engine.js");
const palette = read("mods/agents-list/palette.js");
const sidebar = read("mods/agents-list/sidebar.js");

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

// A top-level function, from `export function name(` to its closing brace.
function lift(src, name) {
  const at = src.indexOf(`export function ${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(at, i + 1).replace(/^export /, "");
  }
  throw new Error(`unbalanced ${name}`);
}
const constant = (name) => {
  const at = core.indexOf(`export const ${name} =`);
  if (at < 0) throw new Error(`no const ${name}`);
  const end = core.indexOf(";", at) + 1;
  return core.slice(at, end).replace(/^export /, "");
};

const norm = (p) => (p ?? "").replace(/\\/g, "/");
const base = (p) => norm(p).replace(/\/+$/, "").split("/").pop() ?? "";
const factory = new Function("norm", "base", "shared", "place", "spaceRecord",
  `${constant("inside")}\n${lift(core, "openSpaceFor")}\n${lift(core, "worktreeTree")}\n
   return { openSpaceFor, worktreeTree, inside };`);
const shared = () => undefined;

const main = "/home/taha/Projects/oss/cliamp";
const tree = "/home/taha/.herdr/worktrees/cliamp/test";
const other = "/home/taha/.herdr/worktrees/cliamp/fglkdfg";
const repo = { id: "r", name: "cliamp", folder: "/home/taha/.config/herdr-app", live: main, machine: null };
// A worktree whose shell cd'd out: place() says /tmp, its folder says the checkout.
const wt = { id: "t", name: "tmp", folder: tree, live: "/tmp", machine: null };

const make = (spaces, trees) => factory(norm, base, shared, (s) => (s.live ?? s.folder), () => null).worktreeTree(
  spaces,
  (s) => (s.id === "r"
    ? { main, root: main, linked: false, branch: "main" }
    : s.id === "t"
      ? { main, root: tree, linked: true, branch: "test" }
      : null),
  trees,
);

const checkouts = [
  { path: main, branch: "main", main: true, on: null, repoMain: main },
  { path: other, branch: "fglkdfg", main: false, on: null, repoMain: main },
  { path: tree, branch: "test", main: false, on: null, repoMain: main },
];

const out = make([repo, wt], checkouts);
check("a worktree space hangs under the space that holds its repo",
  out.worktrees.has("t") && out.parents.get("t") === "r", JSON.stringify([...out.parents]));
check("an unopened checkout hangs there too, so the repo's line is whole",
  out.checkoutParents.get(`\u0000${other}`) === "r", JSON.stringify([...out.checkoutParents]));
check("a checkout that already has a space is not listed a second time",
  !out.checkoutParents.has(`\u0000${tree}`), JSON.stringify([...out.checkoutParents]));

// The sidebar's Pinned section draws the same checkouts: a pin whose space has
// exited must not list a checkout a live worktree space already stands in, or
// the row appears twice under one place.
{
  const at = sidebar.indexOf("const pinCheckouts = (p) => {");
  let depth = 0;
  let end = -1;
  for (let i = at; at >= 0 && i < sidebar.length; i++) {
    if (sidebar[i] === "{") depth++;
    else if (sidebar[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error("sidebar.js: no pinCheckouts");
  const tidyPath = (p) => norm(p).replace(/\/+$/, "");
  const pinCheckouts = new Function("pinRepo", "trees", "forest", "isRemoving", "orderedPaths", "SEP", "tidyPath",
    `${sidebar.slice(at, end)}; return pinCheckouts;`)(
    () => `\u001f${main}`, checkouts.filter((c) => !c.main),
    { checkoutParents: new Map(), opened: new Set([`\u0000${tree}`]) },
    () => false, (_repo, list) => list, "\u001f", tidyPath);
  const drawn = pinCheckouts({ folder: main }).map((c) => c.path);
  check("a pinned repo does not draw an open worktree a second time",
    !drawn.includes(tree) && drawn.includes(other), JSON.stringify(drawn));
}

// A shell that wandered off still finds the space standing in its checkout.
const { openSpaceFor } = factory(norm, base, shared, (s) => (s.live ?? s.folder), () => null);
check("opening a checkout goes to the space standing there, even after a cd",
  openSpaceFor(tree, null, [repo, wt], []).id === "t");
check("opening a checkout nobody stands in finds no space",
  !openSpaceFor(other, null, [repo, wt], []));

// Both views read the name from the checkout, not from Herdr's live name — and
// a pinned row from the pin's place, through the same helper.
check("the sidebar names a row through the shared rule",
  /const label = placeName\(s, sect\);/.test(sidebar)
  && /\.child\(label\)/.test(sidebar)
  && /const placeName = \(s, sect\) =>/.test(sidebar));
check("the sheet names a row through the shared rule",
  /const shown = pin && !pin\.named && !s\.named \? pinLabel\(pin\) : this\.spaceName\(s\);/.test(palette)
  && /this\.label\(shown/.test(palette) && /this\.avatar\(t, s, Boolean\(r\.inPins\), shown\)/.test(palette));
check("the sidebar answers with the checkout's branch",
  /worktreeName\(s\) \{[\s\S]{0,260}return c\?\.branch/.test(sidebar));
check("the sheet answers with the checkout's branch",
  /worktreeName\(s\) \{[\s\S]{0,260}return c\?\.branch/.test(palette));

// Opening a checkout names the new space, or Herdr renames it on the first cd.
check("opening a checkout names the space after its branch, on this computer when it is local",
  /const name = r\.c\?\.branch \?\? r\.branch \?\? base\(r\.path\);[\s\S]{0,280}run\("space\.new", \{ folder: r\.path, name, machine: r\.on \?\? "" \}\)/.test(core));
check("a pin opens on this computer when it names no machine",
  /run\("space\.new", \{ folder: p\.folder, \.\.\.\(p\.named \? \{ name: p\.name \} : \{\}\), machine: p\.machine \?\? "" \}\)/.test(core));
check("the worktrees dialog names the space it opens too, on this computer when it is local",
  /const name = c\.branch \?\? c\.path\.split\("\/"\)\.pop\(\);[\s\S]{0,220}run\("space\.new", \{ folder: c\.path, name, machine: this\.on \?\? "" \}\)/.test(read("mods/worktrees/main.js")));
check("a space standing in a worktree still refreshes that repo's checkouts",
  !/main === root/.test(sidebar) && /const treesBefore = JSON\.stringify\(this\.trees\[repoKey\] \?\? null\)/.test(sidebar));
check("a failed checkout read is not an empty repo",
  /if \(!list\.ok\) return null;/.test(core));
check("Enter in the open dialog opens the checkout, never makes one",
  /this\.input\.on\("submit", \(_e, cx\) => \{[\s\S]{0,120}if \(this\.opening\) this\.open\(this\.shown\(\)\[this\.at\]\);[\s\S]{0,80}else this\.go\(cx\);/.test(read("mods/worktrees/main.js")));
check("a worktree's removal points at its checkout, not its shell's folder",
  /const folder = tree \? \(rec\?\.root \?\? \(inWorktrees\(s\.folder\) \? s\.folder : \(place\(s\) \?\? s\.folder\)\)\) : null;/.test(core));

// One tree, both views: neither keeps its own parent map builder.
check("the sidebar builds no tree of its own",
  !/const parentOf = \(s\) => \{[\s\S]{0,80}info\.get\(s\.id\)/.test(sidebar) && /worktreeTree\(allSpaces, gitOf, trees, paneList\)/.test(sidebar));
check("the sheet builds no tree of its own",
  /worktreeTree\(all, gitOf, checkoutList, ps\)/.test(palette) && !/nextParent\.set/.test(palette));
check("the sheet and the sidebar draw one checkout list",
  /const checkoutList = listedCheckouts\(\)/.test(palette)
  && /const trees = listedCheckouts\(\)/.test(sidebar)
  && !/this\.worktrees = \(this\.worktrees/.test(palette));
check("git is watched in the git dir, not the working tree",
  /this\.watchRepo\(cx, `repo:\$\{main\}`, gitDir \|\| `\$\{main\}\/\.git`, main\)/.test(sidebar)
  && !/watchRepo\(cx, "worktrees"/.test(sidebar));
check("reordering spaces does not rescan git",
  /frameCache\("spaces", spaces\)\.map\(\(s\) => s\.id\)\.sort\(\)\.join\(","\)/.test(sidebar));
check("one git scan runs at a time",
  /if \(this\.gitRunning\)/.test(sidebar));
check("a stale sheet read cannot overwrite a newer one",
  /this\.loadGen/.test(palette));

// A new space made while the focused place is a worktree belongs to the repo's
// main checkout, never inside the checkout: a space there is another worktree
// row, not a place. An existing main place is gone to instead of a second one.
{
  const at = core.indexOf("  newSpace() {");
  const end = core.indexOf("\n  }", at) + 4;
  const build = (folder, all) => {
    const calls = [];
    const fn = new Function("newSpaceFolder", "spaces", "spaceRecord", "norm", "place", "panes", "run",
      `${core.slice(at, end).replace("  newSpace() {", "function newSpace() {")}; return newSpace;`)(
      () => folder, () => all, (s) => s.record ?? null, norm,
      (s) => s.live ?? s.folder, () => [], (name, args) => calls.push([name, args]));
    const self = { paneSnap: [], openSpace: (s) => calls.push(["openSpace", s.id]) };
    return { made: fn.call(self), calls };
  };
  const wt = { id: "w", name: "typing", folder: "/wt", machine: null, record: { isWorktree: true } };
  const place = { id: "p", name: "reel", folder: "/repo", machine: null, record: { isWorktree: false } };
  let go = build({ folder: "/repo", machine: null }, [wt, place]);
  check("new space in a worktree goes to the repo's main place",
    go.made === false && go.calls[0]?.[0] === "openSpace" && go.calls[0]?.[1] === "p",
    JSON.stringify(go.calls));
  go = build({ folder: "/repo", machine: null }, [wt, { ...place, live: "/home/me" }]);
  check("a space made in the main checkout but working elsewhere is not that place",
    go.made === true && go.calls[0]?.[0] === "space.new"
      && go.calls[0]?.[1]?.folder === "/repo", JSON.stringify(go.calls));
  go = build({ folder: "/repo", machine: null }, [wt]);
  check("new space in a worktree starts the main place when none is open",
    go.made === true && go.calls[0]?.[0] === "space.new"
      && go.calls[0]?.[1]?.folder === "/repo", JSON.stringify(go.calls));
  go = build(null, [wt]);
  check("new space anywhere else keeps Herdr's default",
    go.made === true && go.calls[0]?.[0] === "space.new" && go.calls[0]?.[1] === undefined,
    JSON.stringify(go.calls));
  check("the sidebar's New space uses the shared place rule",
    /if \(c === "new_space"\) \{ if \(this\.newSpace\(\)/.test(sidebar)
    && /"New space", \(\) => this\.newSpace\(\)/.test(sidebar));
}

// A main space that leaves its repo for a folder with no repo is that folder
// now: its old record goes, so its row cannot keep another place's tail. A
// worktree keeps its record, because the checkout is what the space is.
check("a main space that leaves its repo drops the record it is not in",
  /if \(!rec \|\| rec\.isWorktree \|\| !rec\.root\) continue;[\s\S]{0,220}delete this\.spacePins\[s\.id\]/.test(sidebar));

console.log(failures ? `\n${failures} worktree check(s) failed` : "all worktree checks passed");
process.exit(failures ? 1 : 0);
