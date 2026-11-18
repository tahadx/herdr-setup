// The shared reorder step, run against the code both views run.
//
// The failures this guards against:
//
//   1. A step read the rows as drawn. A move lands asynchronously, so two presses
//      close together read the same order twice, aimed at the same neighbour, and
//      the second did nothing — "it only moves one row".
//   2. A step with a search active read the ranked rows, where the row below is
//      not the next place, so a move could reverse itself.
//   3. A step at either end said nothing, which reads like a broken key.
//   4. The sheet and the sidebar grew two implementations of the step, and one
//      drifted from the other.
//
//   node tests/reorder.test.mjs
//   REORDER_ROOT=/some/other/checkout node tests/reorder.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.REORDER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const core = read("mods/agents-list/workspace-engine.js");
const palette = read("mods/agents-list/palette.js");
const sidebar = read("mods/agents-list/sidebar.js");

// A method's own text, from `  name(` to the first line that is just `  }`.
function from(src, where, name) {
  const at = src.indexOf(`  ${name}(`);
  if (at < 0) throw new Error(`${where}: no method ${name}`);
  const end = src.indexOf("\n  }", at) + 4;
  return src.slice(at, end).replace(`  ${name}(`, `function ${name}(`);
}
const method = (name) => from(core, "workspace-engine.js", name);

// A module-level `const` arrow, such as `placeGroup`.
function pickConst(src, name) {
  const at = src.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`no ${name}`);
  const end = src.indexOf(";\n", at) + 2;
  return src.slice(at, end);
}

// A module-level function declaration, e.g. `groupPlaces`.
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

const RANK_SRC = "const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };";
const groupHelpers = `${RANK_SRC}\n${pickConst(core, "placeGroup").replace(/^export /m, "")}\n${pickFn(core, "groupPlaces")}\n${pickFn(core, "ribbonPins")}`;
const pinHelpers = `${pickConst(core, "norm").replace(/^export /m, "")}\n${pickConst(core, "pinKey").replace(/^export /m, "")}\n${pickConst(core, "samePin").replace(/^export /m, "")}`;
const groupPlaces = new Function(`${groupHelpers}; return groupPlaces;`)();
const samePin = new Function(`${pinHelpers}; return samePin;`)();
const ribbonPins = new Function(`${groupHelpers}; return ribbonPins;`)();

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

const A = { id: "a", name: "alpha", machine: null };
const B = { id: "b", name: "beta", machine: null };
const C = { id: "c", name: "gamma", machine: null };

// A sheet with the real shared step, on a spaces() that only moves when the
// "app" applies it — so a test can press twice before the order has landed.
let order = [];
// What `spaces()` reports. It stays behind `order` while a move is in flight,
// the way the app's read does: the model it hands out is the order before the
// last `space.move` landed.
let visible = null;
const spacesNow = () => visible ?? order;
const runs = [];

// The app's side of `space.move`: the space goes to that 1-based position in
// its own machine block. It lands at once, so `order` is the truth while
// `visible` is what the mod can still see.
function applyMove(id, index) {
  const held = order.find((x) => x.id === id);
  if (!held) return;
  const rest = order.filter((x) => x.id !== id);
  rest.splice(Math.max(0, Math.min(rest.length, index - 1)), 0, held);
  order = rest;
}

function sheet(pinStart = null) {
  let pinList = (pinStart ?? []).map((p) => ({ ...p }));
  const make = new Function("spaces", "run", "machineIndexOf", "pinnedList", "writePins", "samePin", `
    ${method("predictedSpaces")}
    ${method("noteSpaceMove")}
    ${method("aimedReorder")}
    ${method("reorderStep")}
    ${method("pinnedStep")}
    ${method("moveSpaceWithin")}
    ${method("landReorder")}
    ${method("movePinSlot")}
    ${method("movePinRow")}
    ${method("stopReorder")}
    ${method("startReorder")}
    return function make() {
      return {
        reorderId: null, reorderDir: 0, reorderSteps: 0, reorderStepAt: 0,
        reorderAim: null, reorderRaw: null, reorderRawAt: 0, reorderHold: null,
        reorderPins: null, reorderAfter: null,
        spacePin: (s) => pinnedList().find((p) => p.id === s?.id) ?? null,
        reorderIds: (list = spaces()) => list.map((s) => s.id),
        pinList: () => pinnedList(),
        predictedSpaces, noteSpaceMove, aimedReorder, reorderStep, pinnedStep,
        moveSpaceWithin, landReorder, movePinSlot, movePinRow, stopReorder, startReorder,
      };
    };`);
  const indexOf = (all, machine, id) => {
    const list = all.filter((s) => (s.machine ?? null) === (machine ?? null));
    const at = list.findIndex((s) => s.id === id);
    return at < 0 ? null : at + 1;
  };
  return make(spacesNow, (name, args) => {
    runs.push({ name, ...args });
    if (name === "space.move") applyMove(args.id, args.index);
  }, indexOf, () => pinList, (next) => { pinList = next; }, samePin)();
}

// ---- one step, one place -----------------------------------------------------
order = [A, B, C];
visible = null;
runs.length = 0;
let s = sheet();
s.reorderStep(C, -1);
check("reorder: up takes the place of the space above",
  runs.length === 1 && runs[0].name === "space.move" && runs[0].id === "c" && runs[0].index === 2,
  JSON.stringify(runs));

// ---- a second press before the order lands still steps -----------------------
// `spaces()` still reads [A, B, C] here; the step must be aimed from the order
// the app will have, or its index is applied to the wrong list.
runs.length = 0;
visible = [A, B, C];
s.reorderStep(C, -1);
check("reorder: the next press steps from where the last one aimed",
  runs.length === 1 && runs[0].id === "c" && runs[0].index === 1, JSON.stringify(runs));
check("reorder: the two steps left the order the aim described",
  order.map((x) => x.id).join(",") === "c,a,b", JSON.stringify(order.map((x) => x.id)));

// ---- the note -----------------------------------------------------------------
order = [A, B, C];
visible = null;
s = sheet();
let last = null;
s.reorderAfter = (moved, step, total) => { last = [moved.name, step, total]; };
s.reorderStep(C, -1);
check("reorder: a step says where the space landed",
  last?.join(" ") === "gamma 2 3", String(last));

// ---- the ends -----------------------------------------------------------------
order = [A, B];
visible = null;
runs.length = 0;
s = sheet();
s.reorderStep(B, 1);
check("reorder: the last space does not wrap to the top", runs.length === 0, JSON.stringify(runs));
s.reorderStep(A, -1);
check("reorder: the first space does not wrap to the bottom", runs.length === 0, JSON.stringify(runs));

// ---- only a space row moves with space.move ----------------------------------
// A worktree row is a checkout: it steps inside its repo group (`startPathReorder`,
// the persisted worktree order), never through `space.move`. An agent row and a
// pin row do nothing. Each view's beginReorder decides; both hand the work to a
// shared engine method.
{
  const beginPalette = new Function("spaces", `${groupHelpers}\nreturn (${from(palette, "palette.js", "beginReorder")});`);
  const runPalette = (sel, opts = {}) => {
    const moves = [];
    const paths = [];
    let started = null;
    const self = {
      selected: () => sel,
      reorderSubject: () => opts.held ?? null,
      pathSubject: () => opts.moving ?? null,
      pathGroup: opts.group ?? null,
      pathPaths: opts.paths ?? null,
      pathAfter: opts.after ?? null,
      isWorktree: (s) => Boolean(s?.worktree || s?.linked),
      shownPins: (list = order) => opts.pins ?? [],
      spacePin: (s) => (opts.pinned?.has?.(s?.id) ? { id: s.id } : null),
      startReorder: (space, dir, setup) => { moves.push([space.id, dir]); started = setup; },
      startPathReorder: (group, path, list, dir) => paths.push([path, dir]),
      reorderWorktreeRow: (row, dir) => paths.push([row.kind, dir]),
    };
    beginPalette(() => order).call(self, 1, null);
    return { moves, paths, ids: (list = order) => started?.ids?.(list), pins: started?.pins ?? null };
  };
  check("reorder: the sheet moves a space row", runPalette({ kind: "space", s: A }).moves.length === 1, "no move");
  check("reorder: the sheet does not move an agent row",
    runPalette({ kind: "agent", a: { space: "a", address: "t1" } }).moves.length === 0, "moved");
  check("reorder: the sheet steps a worktree row inside its group",
    runPalette({ kind: "worktree", c: { path: "/w" } }).paths.length === 1, "no step");
  check("reorder: the sheet steps an opened worktree space inside its group",
    runPalette({ kind: "space", s: { ...A, worktree: true } }).paths.length === 1, "no step");
  check("reorder: the sheet does not move a pin row", runPalette({ kind: "pin" }).moves.length === 0, "moved");

  // A step stays inside the group the row is drawn in: the Pinned ribbon, or
  // one status section. The app's full order includes both, so stepping through
  // it would aim at a row in another section and the space would not move (or
  // would jump across the section on the next press).
  const i1 = { id: "i1", name: "idle one", status: "idle", machine: null };
  const i2 = { id: "i2", name: "idle two", status: "idle", machine: null };
  const w1 = { id: "w1", name: "work one", status: "working", machine: null };
  const w2 = { id: "w2", name: "work two", status: "working", machine: null };
  const p1 = { id: "p1", name: "pin one", status: "idle", machine: null };
  const p2 = { id: "p2", name: "pin two", status: "working", machine: null };
  const groupOrder = [i1, w1, p1, i2, w2, p2];
  const groupPins = [{ p: { id: "p1" }, s: p1 }, { p: { id: "p2" }, s: p2 }];
  const groupOpts = { pins: groupPins, pinned: new Set(["p1", "p2"]) };
  order = groupOrder;
  check("reorder: a working row steps inside working spaces only",
    runPalette({ kind: "space", s: w1 }, groupOpts).ids(groupOrder).join() === "w1,w2",
    runPalette({ kind: "space", s: w1 }, groupOpts).ids(groupOrder).join());
  check("reorder: an idle row steps inside idle spaces only",
    runPalette({ kind: "space", s: i1 }, groupOpts).ids(groupOrder).join() === "i1,i2",
    runPalette({ kind: "space", s: i1 }, groupOpts).ids(groupOrder).join());
  check("reorder: a pinned row steps in the pin order",
    runPalette({ kind: "space", s: p1, inPins: true }, groupOpts).ids(groupOrder).join() === "p1,p2",
    runPalette({ kind: "space", s: p1, inPins: true }, groupOpts).ids(groupOrder).join());
  check("reorder: a pinned row never steps through a status row",
    !runPalette({ kind: "space", s: p1, inPins: true }, groupOpts).ids(groupOrder).includes("w1"));
  check("reorder: a status row never steps through a pinned row",
    !runPalette({ kind: "space", s: w1 }, groupOpts).ids(groupOrder).includes("p1"));
  check("reorder: groupPlaces puts worktrees aside",
    (() => {
      const wt = { id: "wt", name: "checkout", status: "working", machine: null };
      const fn = new Function(`${groupHelpers}; return groupPlaces;`)();
      return fn([...groupOrder, wt], groupPins, "2", null, (s) => s.id === "wt").map((s) => s.id).join() === "w1,w2";
    })());
  // The Pinned ribbon's step list is slots, not live places: a pin whose shell
  // exited keeps its row, so a step must be able to pass it.
  const deadPin = { p: { id: "pd", folder: "/gone" }, s: null };
  const ribbon = [{ p: { id: "p1", folder: "/p1" }, s: p1 }, deadPin, { p: { id: "p2", folder: "/p2" }, s: p2 }];
  const ribbonOpts = { pins: ribbon, pinned: new Set(["p1", "p2"]) };
  const sheetPinned = runPalette({ kind: "space", s: p2, inPins: true }, ribbonOpts);
  check("reorder: the sheet's pinned step passes a pin with no space",
    sheetPinned.pins?.(groupOrder).map(({ p }) => p.id).join() === "p1,pd,p2",
    String(sheetPinned.pins?.(groupOrder).map(({ p }) => p.id).join()));
  check("reorder: a status row has no ribbon slots",
    runPalette({ kind: "space", s: w1 }, groupOpts).pins === null);
  // A press that lands before the sheet repainted still names the old row index,
  // which is now a different space. The step must keep moving the space the
  // reorder is about — otherwise a held key walks two spaces at once.
  check("reorder: a step in flight keeps moving its own space, not the row its index names",
    JSON.stringify(runPalette({ kind: "space", s: A }, { held: B }).moves) === '[["b",1]]',
    JSON.stringify(runPalette({ kind: "space", s: A }, { held: B }).moves));
  check("reorder: a checkout step in flight keeps stepping its own path",
    JSON.stringify(runPalette({ kind: "space", s: A }, { moving: "/w", group: "g", paths: ["/w", "/x"] }).paths)
      === '[["/w",1]]',
    JSON.stringify(runPalette({ kind: "space", s: A }, { moving: "/w", group: "g", paths: ["/w", "/x"] }).paths));

  const beginSidebar = new Function("spaces", "ribbonPins", `return (${from(sidebar, "sidebar.js", "beginReorder")});`);
  const runSidebar = (entry, opts = {}) => {
    const moves = [];
    const paths = [];
    const row = (e) => (e?.kind === "checkout" ? { kind: "checkout", path: e.path, on: null }
      : e?.linked ? { kind: "space", s: { ...A, id: e.id, linked: true } }
        : e?.kind === "space" ? { kind: "space", s: B } : null);
    let started = null;
    const self = {
      entry: () => entry,
      sidebarRow: row,
      reorderSubject: () => opts.held ?? null,
      pathSubject: () => opts.moving ?? null,
      pathGroup: opts.group ?? null,
      pathPaths: opts.paths ?? null,
      pathAfter: opts.after ?? null,
      isWorktree: (s) => Boolean(s?.worktree || s?.linked),
      drawnSpaces: () => [B],
      shownPins: (list = order) => opts.pins ?? [],
      startReorder: (space, dir, setup) => { moves.push([space.id, dir]); started = setup; },
      startPathReorder: (group, path, list, dir) => paths.push([path, dir]),
      reorderWorktreeRow: (r, e, dir) => paths.push([e.kind, dir]),
      sel: null,
    };
    beginSidebar(() => order, ribbonPins).call(self, 1, null);
    return { moves, paths, pins: started?.pins ?? null };
  };
  check("reorder: the sidebar moves a space row", runSidebar({ kind: "space", id: "a", sect: 1 }).moves.length === 1, "no move");
  check("reorder: the sidebar steps a linked checkout's space inside its group",
    runSidebar({ kind: "space", id: "a", sect: 1, linked: true }).paths.length === 1, "no step");
  check("reorder: the sidebar steps a checkout row inside its group",
    runSidebar({ kind: "checkout", path: "/w", sect: 1 }).paths.length === 1, "no step");
  check("reorder: the sidebar keeps moving the space its reorder is about",
    JSON.stringify(runSidebar({ kind: "space", id: "a", sect: 1 }, { held: B }).moves) === '[["b",1]]',
    JSON.stringify(runSidebar({ kind: "space", id: "a", sect: 1 }, { held: B }).moves));
  check("reorder: the sidebar's space step list skips linked checkouts",
    /kind === "space" && e\.sect === sect && !e\.linked/.test(sidebar));
  const sidePinned = runSidebar({ kind: "space", id: "a", sect: "sec-pinned" }, ribbonOpts);
  check("reorder: the sidebar's pinned step passes an empty pin row",
    sidePinned.pins?.(groupOrder).map(({ p }) => p.id).join() === "p1,pd,p2",
    String(sidePinned.pins?.(groupOrder).map(({ p }) => p.id).join()));
  check("reorder: the sidebar's status step has no ribbon slots",
    runSidebar({ kind: "space", id: "a", sect: 1 }, groupOpts).pins === null);
  check("reorder: the sidebar's pinned step reaches startReorder", sidePinned.moves.length === 1, "no move");
}

// ---- the aim is dropped when the spaces change under it ----------------------
order = [A, B, C];
visible = null;
s = sheet();
s.reorderStep(C, -1);
order = [A, B, C, { id: "d", name: "delta", machine: null }]; // someone opened a space
visible = null;
runs.length = 0;
s.reorderStep(C, -1);
check("reorder: a new space in the list is read at once, not from the old aim",
  runs.length === 1 && runs[0].index === 2, JSON.stringify(runs));

// ---- a step long after the last one reads the app's order --------------------
order = [A, B, C];
visible = null;
s = sheet();
s.reorderStep(C, -1);                       // aim: [A, C, B]
const realNow = Date.now;
Date.now = () => realNow() + 5000;          // the app has had time; it says [A, B, C]
order = [A, B, C];
visible = null;
runs.length = 0;
s.reorderStep(C, -1);
Date.now = realNow;
check("reorder: an old aim is not used once a step is long past",
  runs.length === 1 && runs[0].index === 2, JSON.stringify(runs));

// ---- a step at the end has nothing to repeat ----------------------------------
order = [A, B];
visible = null;
s = sheet();
let scheduled = 0;
const fakeCx = { timer: { after: () => { scheduled++; return { cancel() {} }; }, every: () => ({ cancel() {} }) } };
s.startReorder(A, -1, { ids: () => ["a", "b"] }, fakeCx);
check("reorder: a hold at the end does not start a repaint loop", scheduled === 0, String(scheduled));
s = sheet();
s.startReorder(B, -1, { ids: () => ["a", "b"] }, fakeCx);
check("reorder: a hold with somewhere to go repeats", scheduled === 1, String(scheduled));

// ---- a pinned step is one ribbon row, empty slots included --------------------
// The ribbon draws a row for every pin, and a pin whose shell exited keeps its
// row. Stepping the live places only skipped that row, so the press after it
// jumped two rows at once: "it does it good with kleeamp but always has two
// jumps for the top spaces".
const R = { id: "r", name: "reel", machine: null };
const K = { id: "k", name: "kleeamp", machine: null };
const H = { id: "h", name: "herdr-app", machine: null };
const line = (ps) => ps.pinList().map((p) => p.id).join("");
const pinnedSheet = () => {
  const ps = sheet([
    { id: "r", folder: "/reel", machine: null },
    { id: "o", folder: "/omarchy", machine: null },   // its shell has exited
    { id: "k", folder: "/kleeamp", machine: null },
    { id: "h", folder: "/herdr-app", machine: null },
  ]);
  const live = new Map([["r", R], ["k", K], ["h", H]]);
  ps.slots = () => ps.pinList().map((p) => ({ p, s: live.get(p.id) ?? null }));
  ps.idsFor = (list = spacesNow()) => groupPlaces(list, ps.slots(), "pinned").map((x) => x.id);
  ps.reorderIds = ps.idsFor;
  ps.reorderPins = ps.slots;
  return ps;
};
order = [R, K, H];
visible = null;
runs.length = 0;
let ps = pinnedSheet();
ps.reorderStep(H, -1);
check("reorder: a pinned step passes one live row at a time", line(ps) === "rohk", line(ps));
check("reorder: a pinned step still moves the space in the app",
  runs.length === 1 && runs[0].id === "h" && runs[0].index === 2, JSON.stringify(runs));
runs.length = 0;
ps.reorderStep(H, -1);
check("reorder: a pinned step past an empty pin moves one row, not two", line(ps) === "rhok", line(ps));
check("reorder: a step past an empty pin sends no space.move", runs.length === 0, JSON.stringify(runs));
ps.reorderStep(H, -1);
check("reorder: the third pinned step reaches the top", line(ps) === "hrok", line(ps));
const top = line(ps);
const wrote = runs.length;
ps.reorderStep(H, -1);
check("reorder: the top of the ribbon does not wrap", line(ps) === top && runs.length === wrote, `${line(ps)} ${runs.length}`);

// The note counts ribbon rows, so it says what the list shows.
order = [R, K, H];
visible = null;
ps = pinnedSheet();
let pinnedNote = null;
ps.reorderAfter = (moved, step, total) => { pinnedNote = [moved.name, step, total]; };
ps.reorderStep(H, -1);
check("reorder: a pinned step says its row and the ribbon's size",
  pinnedNote?.join(" ") === "herdr-app 3 4", String(pinnedNote));

// ---- a pinned hold at the ribbon's end has nothing to repeat ------------------
order = [R, K, H];
visible = null;
let pinnedScheduled = 0;
const fakeCx2 = { timer: { after: () => { pinnedScheduled++; return { cancel() {} }; }, every: () => ({ cancel() {} }) } };
ps = pinnedSheet();
const pinnedOpts = { ids: (list = spacesNow()) => ps.idsFor(list), pins: () => ps.slots() };
ps.startReorder(H, 1, pinnedOpts, fakeCx2);
check("reorder: a pinned hold at the bottom of the ribbon does not repeat",
  pinnedScheduled === 0, String(pinnedScheduled));
ps = pinnedSheet();
const pinnedTop = { ids: (list = spacesNow()) => ps.idsFor(list), pins: () => ps.slots() };
ps.startReorder(H, -1, pinnedTop, fakeCx2);
check("reorder: a pinned hold with a row above repeats", pinnedScheduled === 1, String(pinnedScheduled));

console.log(failures ? `\n${failures} failed` : "\nall reorder checks passed");
process.exit(failures ? 1 : 0);
