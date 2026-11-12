// The search sheet's reorder step, run against the code the mod runs.
//
// The failures this guards against:
//
//   1. A step read the rows as drawn. A move lands asynchronously, so two presses
//      close together read the same order twice, aimed at the same neighbour, and
//      the second did nothing — "it only moves one row".
//   2. A step with a search active read the ranked rows, where the row below is
//      not the next place, so a move could reverse itself.
//   3. A step at either end said nothing, which reads like a broken key.
//
//   node tests/reorder.test.mjs
//   REORDER_ROOT=/some/other/checkout node tests/reorder.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.REORDER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "mods/search/main.js"), "utf8");

// A method's own text, from `  name(` to the first line that is just `  }`.
function method(name) {
  const at = src.indexOf(`  ${name}(`);
  if (at < 0) throw new Error(`mods/search/main.js: no method ${name}`);
  const end = src.indexOf("\n  }", at) + 4;
  return src.slice(at, end).replace(`  ${name}(`, `function ${name}(`);
}

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

const A = { id: "a", name: "alpha", machine: null };
const B = { id: "b", name: "beta", machine: null };
const C = { id: "c", name: "gamma", machine: null };

// A sheet with the real step, on a spaces() that only moves when the "app"
// applies it — so a test can press twice before the order has landed.
let order = [];
const runs = [];
function sheet({ filter = "" } = {}) {
  const make = new Function("spaces", "run", `
    ${method("aimedOrder")}
    ${method("move")}
    ${method("landSpace")}
    return function make(filter) {
      const self = {
        filter, note: null, aim: null, stepAt: 0, follow: null,
        spacePin: () => null,
        setPin: () => {},
        aimedOrder, move, landSpace,
      };
      return self;
    };`);
  return make(() => order, (name, args) => runs.push({ name, ...args }))(filter);
}

// ---- one step, one place -----------------------------------------------------
order = [A, B, C];
runs.length = 0;
let s = sheet();
s.move(C, -1);
check("reorder: up takes the place of the space above",
  runs.length === 1 && runs[0].name === "space.move" && runs[0].id === "c" && runs[0].index === 2,
  JSON.stringify(runs));

// ---- a second press before the order lands still steps -----------------------
// This is the reported bug: spaces() still reads [A, B, C] here.
runs.length = 0;
s.move(C, -1);
check("reorder: the next press steps from where the last one aimed",
  runs.length === 1 && runs[0].id === "c" && runs[0].index === 1, JSON.stringify(runs));

// ---- the note -----------------------------------------------------------------
order = [A, B, C];
s = sheet({ filter: "gam" });
s.move(C, -1);
check("reorder: a search says where the space landed", s.note === "gamma · 2 of 3", String(s.note));

// ---- the ends -----------------------------------------------------------------
order = [A, B];
runs.length = 0;
s = sheet();
s.move(B, 1);
check("reorder: the last space does not wrap to the top", runs.length === 0, JSON.stringify(runs));
check("reorder: the last space says nothing", s.note === null, String(s.note));
s.move(A, -1);
check("reorder: the first space does not wrap to the bottom", runs.length === 0, JSON.stringify(runs));

// ---- only a space row moves ---------------------------------------------------
// A worktree row is a checkout and an agent row is a running program; the keys do
// nothing on either, and neither offers the hint.
{
  const startMove = new Function(`${method("startMove")}; return startMove;`)();
  const stopMove = new Function(`${method("stopMove")}; return stopMove;`)();
  const cx = { timer: { after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) } };
  const run = (sel) => {
    const moves = [];
    const self = {
      selected: () => sel, hold: null, holdDir: 0, stepAt: 0, holdSteps: 0, holdId: null,
      stopMove, move: (space, dir) => moves.push([space.id, dir]),
    };
    startMove.call(self, 1, cx);
    return moves;
  };
  check("reorder: a space row moves", run({ kind: "space", s: A }).length === 1, "no move");
  check("reorder: an agent row does not move its space",
    run({ kind: "agent", a: { space: "a", address: "t1" } }).length === 0, "moved");
  check("reorder: a worktree row does not move", run({ kind: "worktree" }).length === 0, "moved");
  check("reorder: a pin row does not move", run({ kind: "pin" }).length === 0, "moved");
}

// ---- the aim is dropped when the spaces change under it ----------------------
order = [A, B, C];
s = sheet();
s.move(C, -1);
order = [A, B, C, { id: "d", name: "delta", machine: null }]; // someone opened a space
runs.length = 0;
s.move(C, -1);
check("reorder: a new space in the list is read at once, not from the old aim",
  runs.length === 1 && runs[0].index === 2, JSON.stringify(runs));

// ---- a step long after the last one reads the app's order --------------------
order = [A, B, C];
s = sheet();
s.move(C, -1);                       // aim: [A, C, B]
const realNow = Date.now;
Date.now = () => realNow() + 5000;   // the app has had time; it says [A, B, C]
order = [A, B, C];
runs.length = 0;
s.move(C, -1);
Date.now = realNow;
check("reorder: an old aim is not used once a step is long past",
  runs.length === 1 && runs[0].index === 2, JSON.stringify(runs));

console.log(failures ? `\n${failures} failed` : "\nall reorder checks passed");
process.exit(failures ? 1 : 0);
