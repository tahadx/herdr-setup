// A worktree whose checkout git removed is not a place to show: its space,
// its agents and its pin go, pinned or not.
//
// The failure this guards against: the sticky record keeps saying "worktree"
// and the cached git summary for the deleted folder keeps its last answer, so
// nothing in the frame noticed that the checkout list no longer had the path.
//
//   node tests/removed.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.REMOVED_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = readFileSync(join(root, "mods/agents-list/workspace-engine.js"), "utf8");
const sidebar = readFileSync(join(root, "mods/agents-list/sidebar.js"), "utf8");
const palette = readFileSync(join(root, "mods/agents-list/palette.js"), "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

const tidyPath = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const SEP = "\u001f";

// The method itself, from its name to its closing brace.
function method(name) {
  const at = engine.indexOf(`  ${name}(`);
  if (at < 0) throw new Error(`no method ${name}`);
  const open = engine.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < engine.length; i++) {
    if (engine[i] === "{") depth++;
    else if (engine[i] === "}" && --depth === 0) return engine.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const KEY = `${SEP}/repo`;
const WT = "/home/me/.herdr/worktrees/repo/feat";
const rec = { isWorktree: true, groupKey: KEY, worktreePath: WT, main: "/repo", branch: "feat" };

const removedWorktree = new Function("spaceRecord", "tidyPath", "SEP",
  `return function ${method("removedWorktree")};`)((s) => (s?.id === "s1" ? rec : null), tidyPath, SEP);

const space = { id: "s1", name: "feat", folder: WT, machine: null };
const ctx = (trees, treesAt) => ({ trees, treesAt });

check("a fresh checkout list without the path means removed",
  removedWorktree.call(ctx({ [KEY]: [{ path: "/other" }] }, { [KEY]: Date.now() }), space) === true);
check("a listed checkout is not removed",
  removedWorktree.call(ctx({ [KEY]: [{ path: WT }] }, { [KEY]: Date.now() }), space) === false);
check("a list from a previous start is not proof",
  removedWorktree.call(ctx({ [KEY]: [] }, {}), space) === false);
check("a checkout list nobody read is not proof",
  removedWorktree.call(ctx({}, { [KEY]: Date.now() }), space) === false);
check("a space with no sticky worktree record is left alone",
  removedWorktree.call(ctx({ [KEY]: [] }, { [KEY]: Date.now() }), { id: "s2", folder: "/repo" }) === false);
check("the stale git summary for the deleted folder decides nothing",
  !/this\.git/.test(method("removedWorktree")));

// ---- the picture keeps the repo's checkout list alive ----------------------
// A removed space is still open while the sweep waits; no live space may stand
// in the main checkout, so the sticky record has to keep the repo read.
check("a sticky worktree keeps its repo in the scan",
  /for \(const rec of Object\.values\(this\.spacePins \?\? \{\}\)\) \{[\s\S]{0,180}stickyRepos\.add\(rec\.groupKey\);/.test(sidebar)
  && /for \(const repo of stickyRepos\) repos\.add\(repo\);/.test(sidebar));

// ---- every view draws the same picture ------------------------------------
check("the sidebar hides removed spaces before the tree",
  /const removed = this\.removedWorktrees\(spaceList, paneList\);/.test(sidebar)
  && /const allSpaces = spaceList\.filter\(\(s\) => !removed\.has\(s\.id\)/.test(sidebar));
check("the sidebar hides their agents in both list styles",
  /agents\(\)\.filter\(\(a\) => !this\.removedNow\?\.has\(a\.space\)\)/.test(sidebar)
  && /!leaving\.has\(a\.space\) && !removed\.has\(a\.space\)/.test(sidebar));
check("the rail leaves removed spaces out",
  /!this\.isWorktree\(sp\) && !removed\.has\(sp\.id\)/.test(sidebar));
check("the sheet leaves removed spaces out",
  /this\.removedNow = this\.removedWorktrees\(raw, ps\);/.test(palette)
  && /!this\.removedNow\.has\(s\.id\)/.test(palette));
check("a removed worktree's pin row goes too",
  /shownPins\(all = spaces\(\), ps = null\) \{[\s\S]{0,400}!\(p\?\.id && removed\.has\(p\.id\)\)/.test(engine)
  && /this\.shownPins\(spaceList, paneList\)/.test(sidebar)
  && /this\.shownPins\(all, ps\)/.test(palette));
check("a removed space is closed after a grace, pinned or not",
  /if \(now - seen\.get\(s\.id\) < 6000\) continue;/.test(sidebar)
  && /closeSpace\(s\.id\)/.test(sidebar));
check("a removed worktree's own pin goes with it",
  /const p = pinnedList\(\)\.find\(\(x\) => x\.id === s\.id\);[\s\S]{0,80}this\.unpinPin\(p\);/.test(sidebar));

if (failures) {
  console.error(`\n${failures} removed-worktree check(s) failed`);
  process.exit(1);
}
console.log("all removed-worktree checks passed");
