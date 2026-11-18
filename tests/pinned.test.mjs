// A pinned place is never closed; a worktree is not a place to pin.
//
// What this guards:
//   - a pinned place whose folder goes is kept by the footer's sweep, instead of
//     being closed and unpinned six seconds later; a pinned worktree goes with
//     its removed checkout, because a checkout is not a place to pin;
//   - no dialog closes a pinned place, while a worktree removal deletes the
//     checkout and takes every space inside it, pinned or not;
//   - stopping an agent never takes its space with it: where the agent is the
//     only thing in a space, a shell opens there first;
//   - a removal only names a space when a space will actually go, so "Remove
//     worktree" cannot read as if it is about to close something unrelated;
//   - a recovery from the sidebar's dialogs puts the keyboard back in the list.
//
// The rules live once, in mods/agents-list/workspace-engine.js, because the sidebar and the
// find sheet are one mod: both views must refuse the same things.
//
//   node tests/pinned.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.MODS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name, file = "main.js") => readFileSync(join(root, "mods", name, file), "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

// `isPinned` is module scope in each mod (mods cannot import each other), so it
// is lifted out and run against stubs, the way tests/search.test.mjs does.
// A balanced scan, not line slicing: one of these definitions spans lines and
// one of the helpers is a function declaration.
const strip = (code) => code.replace(/^export\s+/gm, "");
function pick(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return "";
  const isFn = needle.includes("function");
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
  if (!/export (const|function) isPinned/.test(src) && !src.includes("const isPinned =")) {
    throw new Error("this mod has no isPinned");
  }
  const helpers = [
    pick(src, "const norm ="),
    pick(src, "const pinnedList =") || pick(src, "function pinnedList"),
  ].filter(Boolean).join("\n");
  const rule = pick(src, "const isPinned =") || pick(src, "export const isPinned =");
  return new Function("shared", "place", `${strip(helpers)}\n${strip(rule)}\nreturn isPinned;`);
}

const space = { id: "sp1", machine: null, folder: "/home/x/repo", name: "repo" };
const pins = [
  { id: "sp1", folder: "/home/x/repo", machine: null, name: "repo" },
  { id: "gone", folder: "/home/x/old", machine: null, name: "old" },
  // A pin saved before pins had ids: only its place identifies it.
  { folder: "/home/y/legacy", machine: null, name: "legacy" },
];

for (const [mod, file] of [["footer", "main.js"], ["worktrees", "main.js"], ["icons", "main.js"], ["agents-list", "workspace-engine.js"]]) {
  const factory = liftPinned(read(mod, file));
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
check("the sweep keeps a pinned place instead of closing it",
  /if \(isPinned\(s\) && !isWorktreeSpace\(s\)\) \{[\s\S]{0,600}?continue;/.test(sweep), "sweepGone must skip pinned places and not close them");
check("the optional top bar's sweep keeps a pinned place too",
  /if \(isPinned\(s\) && !isWorktreeSpace\(s\)\) continue;/.test(read("icons")), "the top bar must not break the pin promise");
check("a pinned worktree is not a place, so its removed folder still goes",
  /const rec = shared\("workspace\.state"\)\?\.spaces\?\.\[s\?\.id\];[\s\S]{0,120}isWorktree/.test(sweep)
  && /if \(isPinned\(s\) && !isWorktreeSpace\(s\)\)/.test(sweep)
  && /if \(isPinned\(s\) && !isWorktreeSpace\(s\)\) continue;/.test(read("icons")));
check("every sweep closes through one claim",
  ["footer", "icons", "worktrees"].every((mod) =>
    /const closeSpace = \(id\) => \{[\s\S]{0,500}shared\("space\.closing"\)/.test(read(mod)))
  && /function closeSpace\(id\) \{[\s\S]{0,500}shared\("space\.closing"\)/.test(read("agents-list", "sidebar.js")));

const worktree = read("worktrees");
check("closing a space refuses while pinned",
  /removeSpace\(cx\) \{[\s\S]{0,160}if \(isPinned\(s\)\)/.test(worktree));
// A pin protects a place, never the checkout it lives in: removing a worktree
// takes every space inside it, pinned or not. A pin on the repo's main space is
// outside the checkout and stays.
check("removing a worktree closes every space in it, pinned or not",
  /const closing = this\.spacesIn\(r\.top\);/.test(worktree)
  && !/spacesIn\(r\.top\)\.filter\(\(s\) => !isPinned\(s\)\)/.test(worktree));
check("the removal dialog offers a pinned space's checkout instead of refusing",
  !/Removing this checkout would end/.test(worktree));
check("a pin whose space survives a removal stays",
  /if \(inside\(p\)\) return survives\(p\)/.test(worktree));
// Removing a worktree is optimistic: the dialog closes on the press and hands
// the git work to the sidebar, which outlives it. The row is hidden before git
// starts, so a slow removal does not leave a checkout that looks still there.
check("a removal is handed to the sidebar and the dialog closes at once",
  /setShared\("worktree\.job", job\);[\s\S]{0,80}this\.close\(\)/.test(worktree));
check("a layout with no sidebar runs the removal in the dialog",
  /if \(!shownBy\(layout\(\), "agents-list"\)\) return cx\.spawn\([\s\S]{0,80}this\.workJob\(job, cx\)/.test(worktree));
check("stopping an agent opens a shell so its space stays",
  /const \{ s, last \} = this\.alone\(a\);[\s\S]{0,160}if \(s && last\) run\("tab\.new"/.test(worktree));
check("a removal names a space only when one goes",
  /closing\.length \? `Closes \$\{spacesNamed\(closing\)\} and deletes` : "Deletes"/.test(worktree));
check("stopping an agent says what happens to its space",
  /only terminal in \$\{home\.name\}: a shell opens in its place/.test(worktree));

// One rule, two views: the sheet and the sidebar call the same `closeRow`,
// `pinRow` and `worktreeRow` from workspace-engine.js, so neither can drift.
const core = read("agents-list", "workspace-engine.js");
const palette = read("agents-list", "palette.js");
const sidebar = read("agents-list", "sidebar.js");
check("the shared close refuses to close a pinned space",
  /if \(!tree && isPinned\(s\)\) return notify\(\{/.test(core));
check("the shared close still offers removing a worktree, pinned or not",
  /if \(!tree && isPinned\(s\)\)[\s\S]{0,1600}action: tree \? "remove" : "space"/.test(core));
check("the sheet closes its row through the shared action",
  /if \(this\.chord\(e, cx\)\)/.test(palette) && /if \(k === "d"\) \{ this\.closeRow\(this\.selectedRow\(\)\); return true; \}/.test(core));
check("the sidebar closes its row through the shared action",
  /closeEntry\(\) \{\s*\n\s*this\.closeRow\(this\.selectedRow\(\)\);/.test(sidebar));

check("the sidebar runs the removal, so it outlives the dialog",
  /watchJob\(cx\) \{[\s\S]{0,900}setShared\("worktree\.job", null\);[\s\S]{0,700}this\.runWorktreeJob\(/.test(sidebar));
check("a second removal is queued instead of overwriting the first",
  /setShared\("worktree\.jobs", \[\.\.\.\(Array\.isArray\(queued\) \? queued : \[\]\), job\]\)/.test(worktree)
  && /shared\("worktree\.jobs"\)/.test(sidebar));
check("a failed removal leaves the spaces alone",
  /"worktree", "remove"[\s\S]{0,500}if \(!error\) \{[\s\S]{0,90}if \(!windows\) closeSpaces\(\)/.test(sidebar));
check("a checkout on its way out leaves the list before git finishes",
  /const allSpaces = spaceList\.filter\(\(s\) => !removed\.has\(s\.id\)\s*&& !isRemoving\(place\(s, paneList\), s\.machine\) && !isRemoving\(s\.folder, s\.machine\)\)/.test(sidebar)
  && /forest\.checkoutParents\.get[\s\S]{0,120}isRemoving\(c\.path, c\.on\)/.test(sidebar)
  && /liveSpaces\(ps = panes\(\)\) \{[\s\S]{0,900}!isRemoving\(place\(s, ps\), s\.machine\) && !isRemoving\(s\.folder, s\.machine\)/.test(palette));
check("the space menu does not offer closing a pinned space",
  /\.\.\.\(pin \|\| isWorktreeSpace \? \[\] : \[\{ id: "sm-close"/.test(sidebar));
check("the shared close asks to remove a worktree space, not to close it",
  /const tree = this\.isWorktree\(s\);[\s\S]{0,1600}action: tree \? "remove" : "space"/.test(core));
check("closing an unopened checkout asks to remove that checkout",
  /r\.kind === "checkout"[\s\S]{0,300}action: "remove"/.test(core));
check("an unopened checkout row shows no \"open\" word",
  !/\.child\("open"\)/.test(sidebar));
check("a dialog opened from the sidebar gives the keyboard back to it",
  /if \(!at \|\| Date\.now\(\) - at > 60000\) return;[\s\S]{0,560}this\.reclaim\(cx\);/.test(sidebar));
check("an agent can be stopped from the sidebar's menu, whatever its space's pin",
  /const stop = then\(\(\) => \{[\s\S]{0,300}sidebarDialog\(\{ mod: "worktrees", kind: "dialog", width: 440, height: 156, props: \{ agent: a\.address \} \}\)/.test(sidebar));

// The removal the sidebar runs, cut out and run: git first, then the checkout's
// spaces close. A failure closes none, says why, and leaves the cached checkout
// where it was so the row comes back at once. A success drops it from the cache.
{
  const at = sidebar.indexOf("  async runWorktreeJob(");
  const end = sidebar.indexOf("\n  }", at) + 4;
  const runJob = new Function("exec", "run", "setShared", "notify", "window", "removingList", "tidyPath", "persistWorkspace", "closeSpace",
    `${sidebar.slice(at, end).replace("  async runWorktreeJob(", "async function runWorktreeJob(")}
     return runWorktreeJob;`);
  const go = async (code) => {
    const calls = { closed: [], shared: [], notes: [], refreshed: 0 };
    const self = {
      trees: { repo: [{ path: "/w" }, { path: "/other" }] },
      kbd: false,
      reclaim() {},
      refreshGit() { calls.refreshed++; },
    };
    await runJob(
      async () => ({ code, stdout: "", stderr: code ? "still dirty" : "" }),
      (name, args) => calls.closed.push([name, args?.id]),
      (k, v) => calls.shared.push([k, v]),
      (n) => calls.notes.push(n),
      () => ({ platform: "linux" }),
      () => [],
      (p) => p,
      () => false,
      (id) => calls.closed.push(["space.close", id]),
    ).call(self, { at: 1, top: "/w", main: "/repo", on: null, force: false, spaces: ["s1"], pins: [{ id: "a" }] }, { notify() {} });
    return { calls, self };
  };
  const good = await go(0);
  check("the checkout's spaces close only after git removed it",
    good.calls.closed.length === 1 && good.calls.closed[0][1] === "s1" && good.calls.notes.length === 0,
    JSON.stringify(good.calls));
  check("a removed checkout leaves the cached list at once",
    good.self.trees.repo.length === 1 && good.self.trees.repo[0].path === "/other",
    JSON.stringify(good.self.trees.repo));
  const bad = await go(1);
  check("a failed removal closes no space and says why",
    bad.calls.closed.length === 0 && bad.calls.notes.length === 1 && /still dirty/.test(bad.calls.notes[0].body),
    JSON.stringify(bad.calls));
  check("a failed removal leaves the cached checkout in the list",
    bad.self.trees.repo.length === 2 && bad.self.trees.repo.some((c) => c.path === "/w"),
    JSON.stringify(bad.self.trees.repo));
}

// What "on its way out" means, lifted out of core and run: the checkout the
// person confirmed is hidden, by path and machine, until git is done.
{
  const lift = (pins) => new Function("shared", strip([
    pick(core, "const norm ="),
    pick(core, "const tidyPath ="),
    pick(core, "export const removingList ="),
    pick(core, "export const isRemoving ="),
    "return isRemoving;",
  ].join("\n")))((key) => (key === "worktree.removing" ? pins : undefined));
  const now = Date.now();
  const hidden = lift([{ path: "/home/me/.herdr/worktrees/repo/branch/", machine: null, at: now }]);
  check("a checkout on its way out is hidden by its path",
    hidden("/home/me/.herdr/worktrees/repo/branch", null) === true);
  check("a removal on this computer says nothing about another machine",
    hidden("/home/me/.herdr/worktrees/repo/branch", "vps") === false);
  check("another checkout is not hidden",
    hidden("/home/me/.herdr/worktrees/repo/other", null) === false);
  check("a removal entry nobody cleared hides nothing after five minutes",
    lift([{ path: "/w", machine: null, at: now - 6 * 60_000 }])("/w", null) === false);
}

// A pin belongs to a space. A worktree is a checkout drawn under its repo, and
// the pin affordance on a worktree row was lost once already (the edit that was
// meant to add `!tree` wrote nothing), so all three places are pinned down here.
check("no pin on a worktree row, hovered or not",
  /\.when\(!tree && !linked && \(Boolean\(pin\) \|\| hovered\)/.test(sidebar));
check("the space menu does not offer to pin a worktree",
  /isWorktreeSpace \? \[\] : \[\{ id: "sm-pin"/.test(sidebar));
check("the shared pin row refuses a worktree",
  /if \(this\.isWorktree\(r\.s\)\) return notify\(\{/.test(core));
check("a worktree row draws no pin in the sheet",
  /!this\.isWorktree\(s\) && Boolean\(this\.spacePin\(s\)\)/.test(palette));

console.log(failures ? `\n${failures} pinned-space check(s) failed` : "all pinned-space checks passed");
process.exit(failures ? 1 : 0);
