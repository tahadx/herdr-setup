// The shared workspace engine: the sticky worktree record, the persisted
// worktree order, and the machine-scoped index `space.move` takes.
//
// The failures this guards against:
//
//   1. A worktree detached from its repo when its shell `cd`ed into the main
//      checkout, a subfolder, or a folder with no repo at all.
//   2. A nested worktree reorder went through `space.move`, which moves spaces,
//      not checkouts — corrupting Herdr's global order.
//   3. A drop row's visual position was passed to `space.move` as if it were an
//      index in the raw `spaces()` array, so a filtered or multi-machine list
//      moved the wrong space.
//
//   node tests/engine.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.ENGINE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "mods/agents-list/workspace-engine.js"), "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

// A top-level function, from `export function name(` to its closing brace.
function lift(name) {
  const at = src.indexOf(`export function ${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1).replace(/^export /, "");
  }
  throw new Error(`unbalanced ${name}`);
}
const constant = (name) => {
  const at = src.indexOf(`export const ${name} =`);
  if (at < 0) throw new Error(`no const ${name}`);
  const end = src.indexOf(";", at) + 1;
  return src.slice(at, end).replace(/^export /, "");
};

const norm = (p) => (p ?? "").replace(/\\/g, "/");
const tidyPath = (p) => norm(p).replace(/\/+$/, "");
const base = (p) => tidyPath(p).split("/").pop() ?? "";

function engine() {
  const workspace = { spacePins: {}, order: {}, dirty: false };
  const factory = new Function("workspace", "tidyPath", "base",
    `const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
     ${constant("RANK")}
     ${lift("spaceRecord")}
     ${lift("noteSpaceRecord")}
     ${lift("pinSpace")}
     ${lift("orderOf")}
     ${lift("orderedPaths")}
     ${lift("movePathWithin")}
     ${lift("machineIndexOf")}
     ${lift("orderedPlaces")}
     return { spaceRecord, noteSpaceRecord, pinSpace, orderOf, orderedPaths, movePathWithin, machineIndexOf, orderedPlaces };`);
  return { workspace, api: factory(workspace, tidyPath, base) };
}

const space = { id: "s1", name: "wt", machine: null, folder: "/repo/.herdr/worktrees/repo/feat" };
const MAIN = "/home/me/repo";
const WT = "/home/me/.herdr/worktrees/repo/feat";
const key = (main) => `\u001f${main}`;

// ---- a read of the checkout pins the space --------------------------------
{
  const { workspace, api } = engine();
  api.pinSpace(space, { key: key(MAIN), main: MAIN, root: WT, branch: "feat", linked: true });
  const rec = api.spaceRecord(space);
  check("a linked read pins the space to its repo",
    rec?.groupKey === key(MAIN) && rec?.worktreePath === WT && rec?.isWorktree === true && rec?.branch === "feat",
    JSON.stringify(rec));
  check("the record is written once, and a repeat changes nothing",
    api.noteSpaceRecord(space, { ...rec }) === false && Object.keys(workspace.spacePins).length === 1);
}

// ---- the shell wanders off -------------------------------------------------
{
  const { api } = engine();
  api.pinSpace(space, { key: key(MAIN), main: MAIN, root: WT, branch: "feat", linked: true });
  // cd into the main checkout: same repo, different toplevel.
  api.pinSpace(space, { key: key(MAIN), main: MAIN, root: MAIN, branch: "main", linked: false });
  let rec = api.spaceRecord(space);
  check("cd into the main checkout keeps the worktree (and its branch)",
    rec?.worktreePath === WT && rec?.isWorktree === true && rec?.branch === "feat",
    JSON.stringify(rec));
  // cd into an ordinary subfolder of the checkout: root is still the checkout.
  api.pinSpace(space, { key: key(MAIN), main: MAIN, root: WT, branch: "feat", linked: true });
  // Not a repo at all: keep the record.
  api.pinSpace(space, null);
  rec = api.spaceRecord(space);
  check("a folder with no repo keeps the record", rec?.worktreePath === WT, JSON.stringify(rec));
  // A completely different repository root: re-evaluate.
  api.pinSpace(space, { key: key("/other/repo"), main: "/other/repo", root: "/other/repo", branch: "main", linked: false });
  rec = api.spaceRecord(space);
  check("a different repository root re-pins the space",
    rec?.groupKey === key("/other/repo") && rec?.isWorktree === false && rec?.worktreePath === null,
    JSON.stringify(rec));
}

// ---- worktree order is per repo, never Herdr's space order -----------------
{
  const { workspace, api } = engine();
  const g = key(MAIN);
  const drawn = [WT, `${WT}2`, `${WT}3`];
  const next = api.movePathWithin(g, drawn, `${WT}3`, WT, 0);
  check("a worktree moves before its target in the drawn list",
    JSON.stringify(next) === JSON.stringify([`${WT}3`, WT, `${WT}2`]), JSON.stringify(next));
  check("the order is persisted per repo", JSON.stringify(workspace.order[g]) === JSON.stringify(next));
  const ordered = api.orderedPaths(g, [{ path: WT }, { path: `${WT}2` }, { path: `${WT}3` }], (x) => x.path);
  check("both views draw that order",
    JSON.stringify(ordered.map((x) => x.path)) === JSON.stringify(next), JSON.stringify(ordered));
  check("a path with no saved place keeps scan order after the saved ones",
    JSON.stringify(api.orderedPaths(g, [{ path: "/new" }, { path: WT }], (x) => x.path).map((x) => x.path))
      === JSON.stringify([WT, "/new"]));
}

// ---- one order for the rail, the sidebar and the sheet ---------------------
{
  const { api } = engine();
  const all = [
    { id: "idle1", name: "idle one", status: "idle" },
    { id: "work", name: "working", status: "working" },
    { id: "pinB", name: "pinned idle", status: "idle" },
    { id: "blocked", name: "blocked", status: "blocked" },
    { id: "done", name: "done", status: "done" },
    { id: "pinA", name: "pinned done", status: "done" },
    { id: "idle2", name: "idle two", status: "idle" },
  ];
  const pins = [{ s: { id: "pinA" } }, { s: { id: "pinB" } }, { s: null, id: "gone" }];
  const got = api.orderedPlaces(all, pins).map((s) => s.id);
  check("places read pinned first, then needs you, done, working, idle",
    JSON.stringify(got) === JSON.stringify(["pinA", "pinB", "blocked", "done", "work", "idle1", "idle2"]),
    JSON.stringify(got));
  check("the app's order holds inside a group",
    api.orderedPlaces(all, []).map((s) => s.id).join(",") === "blocked,done,pinA,work,idle1,pinB,idle2",
    JSON.stringify(api.orderedPlaces(all, []).map((s) => s.id)));
  check("a pin whose place is gone does not drop a place",
    api.orderedPlaces(all, [{ s: null, id: "gone" }]).length === all.length);
  check("a missing status reads as idle",
    api.orderedPlaces([{ id: "unknown" }, { id: "idle", status: "idle" }], []).map((s) => s.id).join(",") === "unknown,idle");
}

// ---- space.move takes a machine-scoped position ----------------------------
{
  const { api } = engine();
  const all = [
    { id: "a", machine: null }, { id: "b", machine: "vps" },
    { id: "c", machine: null }, { id: "d", machine: null },
  ];
  check("the local drop row maps to its place in the local block",
    api.machineIndexOf(all, null, "d") === 3, String(api.machineIndexOf(all, null, "d")));
  check("another machine's row maps inside that machine's block",
    api.machineIndexOf(all, "vps", "b") === 1, String(api.machineIndexOf(all, "vps", "b")));
  check("a row of another machine is not a local index",
    api.machineIndexOf(all, null, "b") === null);
}

// ---- the sheet's open path runs no git ------------------------------------
{
  const palette = readFileSync(join(root, "mods/agents-list/palette.js"), "utf8");
  const at = palette.indexOf("  init(_props, cx) {");
  const end = palette.indexOf("\n  }", at) + 4;
  const init = palette.slice(at, end);
  check("opening the sheet asks for no git", !init.includes("askGit") && !init.includes("this.load("), init.slice(0, 80));
  check("the sheet hydrates the shared picture first",
    /this\.initShared\(\);/.test(init));
  check("a space's checkout comes from the sticky record first",
    /checkoutRecord\(s, ps\) \{\n    const rec = checkoutRecordOf\(s\);\n    if \(rec\) return rec;/.test(src));
  check("worktree identity is the record, not a folder prefix",
    /isWorktree\(s\) \{\n    if \(!s\) return false;\n    const rec = spaceRecord\(s\);\n    if \(rec\) return Boolean\(rec\.isWorktree\);/.test(src));
  // Ctrl+J/K arrive as a shared write from the sidebar; another copy's write does
  // not repaint this view, so the consumer must notice it without one.
  check("the handed-back walk notices a signal from another copy",
    /this\.walkTick = cx\.timer\.every\(60,/.test(src) && /this\.walkSeen = this\.walkMark;/.test(src));
  check("the sheet subscribes its walk channel on open",
    /this\.watchWalk\(cx, true, "search\.move"\);/.test(palette));
}

console.log(failures ? `\n${failures} engine check(s) failed` : "all engine checks passed");
process.exit(failures ? 1 : 0);
