// Pins, checked against the exact code the mods run.
//
// A pin belongs to one space, by id. The failure this guards against: two spaces
// in one folder (very common — a space's folder is where it was made, not where
// its terminal is now), where dropping one space's pin also dropped every pin in
// that folder.
//
//   node tests/pins.test.mjs
//   PINS_ROOT=/some/other/checkout node tests/pins.test.mjs
//
// Each function is cut out of its mod and run with the few things it touches
// stubbed, so the test fails when the mod changes, not when the test drifts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PINS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const norm = (p) => (p ?? "").replace(/\/+$/, "");

// A method's own text, from `  name(` to the first line that is just `  }`.
function method(file, name) {
  const src = read(file);
  const at = src.indexOf(`  ${name}(`);
  if (at < 0) throw new Error(`${file}: no method ${name}`);
  const end = src.indexOf("\n  }", at) + 4;
  return src.slice(at, end).replace(`  ${name}(`, `function ${name}(`);
}

// A module-level function or a one-line const arrow.
// Shared state hands out copies, so every stub below reads through JSON.
const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function top(file, name) {
  const src = read(file);
  const at = src.indexOf(`function ${name}(`);
  if (at >= 0) return src.slice(at, src.indexOf("\n}", at) + 2);
  const line = src.indexOf(`const ${name} = `);
  if (line < 0) throw new Error(`${file}: no ${name}`);
  // A const arrow may wrap across lines, so end it at the first `;` that ends
  // a line, not at the end of the first line.
  const end = src.indexOf(";\n", line) + 1;
  return src.slice(line, end);
}

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

// ---------------------------------------------------------------- footer
// The deleted-folder sweep must not take a neighbour's pin with it.
{
  const dropPin = new Function("shared", "setShared", "spaces", "norm", "console",
    `return (${method("mods/footer/main.js", "dropPin")});`);
  const run = (pins, live, gone) => {
    let now = pins;
    dropPin(() => now, (_k, v) => { now = v; }, () => live, norm, { log() {} })(gone);
    return now;
  };
  const F = "/work/shared";
  let left = run([{ id: "x", folder: F }, { id: "y", folder: F }],
    [{ id: "x", folder: F }, { id: "y", folder: F }], { id: "y", folder: F, name: "second" });
  check("footer: one space removed from a shared folder keeps the other's pin",
    left.length === 1 && left[0].id === "x", JSON.stringify(left));

  left = run([{ folder: F }, { id: "x", folder: F }], [{ id: "gone", folder: F }],
    { id: "gone", folder: F, name: "gone" });
  check("footer: an old pin without an id goes when its folder has no space left",
    left.length === 1 && left[0].id === "x", JSON.stringify(left));

  left = run([{ folder: F }], [{ id: "x", folder: F }, { id: "y", folder: F }],
    { id: "y", folder: F, name: "y" });
  check("footer: an old pin without an id stays while a space still lives there",
    left.length === 1, JSON.stringify(left));

  left = run([{ id: "x", folder: "/a" }, { id: "y", folder: "/b" }], [],
    { id: "x", folder: "/a", name: "x" });
  check("footer: only the named space's pin goes",
    left.length === 1 && left[0].id === "y", JSON.stringify(left));
}

// --------------------------------------------------------------- worktrees
// Removing a checkout drops pins that point inside it, and nothing else.
{
  const dropPins = new Function("shared", "setShared", "spaces", "console",
    `return (${method("mods/worktrees/main.js", "dropPins")});`);
  const run = (pins, live, space, path) => {
    let now = pins;
    dropPins(() => now, (_k, v) => { now = v; }, () => live, { log() {} })(space, path);
    return now;
  };
  const W = "/home/me/.herdr/worktrees/repo/branch";
  const both = [{ id: "a", folder: "/repo" }, { id: "b", folder: "/repo" }, { id: "w", folder: W }];

  let left = run(both, both, { id: "w", folder: W }, W);
  check("worktrees: removing a worktree keeps spaces pinned in the parent folder",
    left.length === 2 && left.every((p) => p.id !== "w"), JSON.stringify(left));

  left = run([{ id: "a", folder: "/repo" }, { folder: `${W}/sub` }], [{ id: "a", folder: "/repo" }], null, W);
  check("worktrees: a pin pointing inside the removed checkout goes, with or without an id",
    left.length === 1 && left[0].id === "a", JSON.stringify(left));

  left = run([{ id: "a", folder: "/repo" }, { id: "b", folder: "/repo" }],
    [{ id: "a", folder: "/repo" }, { id: "b", folder: "/repo" }], { id: "b", folder: "/repo" });
  check("worktrees: closing one space in a shared folder keeps the other's pin",
    left.length === 1 && left[0].id === "a", JSON.stringify(left));
}

// ---------------------------------------------------------------------- palette
// A pin reads as pinned whether it has an id or not, and pinning never repeats
// or swallows another space's pin.
{
  const pinKey = new Function("norm", `${top("mods/search/main.js", "pinKey")}; return pinKey;`)(norm);
  const samePin = new Function("pinKey", `${top("mods/search/main.js", "samePin")}; return samePin;`)(pinKey);
  const pinnedList = top("mods/search/main.js", "pinnedList");
  const cls = ["spacePin", "setPin", "bindPins"].map((m) => method("mods/search/main.js", m)
    .replace(`function ${m}`, m)).join("\n");
  const palette = new Function("shared", "setShared", "spaces", "norm", "pinnedList", "pinKey", "samePin",
    "place", "writePins", "spaceAt", `${pinnedList}
    return class P {
      ${cls}
    };`);

  let pins = [];
  let live = [];
  // The real "is a space standing here", with place() reading the space's folder.
  const spaceAt = new Function("norm", "place", "spaces", "panes",
    `${top("mods/search/main.js", "spaceAt")}; return spaceAt;`)(norm, (s) => s.folder, () => live, () => []);
  // The factory returns the class; the test needs one copy of it.
  const make = () => new (palette(() => copy(pins), (_k, v) => { pins = v; }, () => live, norm,
    () => copy(pins), pinKey, samePin, (s) => s.folder, (next) => { pins = next; }, spaceAt))();

  const F = "/work/shared";
  pins = [{ folder: F, machine: null }];
  live = [{ id: "sp1", folder: F, machine: null, name: "one", named: true }];
  let p = make();
  check("palette: a pin without an id is not handed to a space by its folder",
    p.spacePin(live[0]) === null, JSON.stringify(p.spacePin(live[0])));

  p.bindPins();
  check("palette: opening the panel gives an old pin its space's id, once",
    pins.length === 1 && pins[0].id === "sp1", JSON.stringify(pins));

  pins = [{ id: "sp1", folder: F }, { id: "sp2", folder: F }];
  live = [{ id: "sp1", folder: F }, { id: "sp2", folder: F }];
  p = make();
  p.setPin(live[1]);
  check("palette: unpinning one space in a shared folder keeps the other's pin",
    pins.length === 1 && pins[0].id === "sp1", JSON.stringify(pins));

  // Shared state hands out copies, so an unpin once compared two equal pins as
  // two objects and removed nothing.
  pins = [{ id: "sp1", folder: F, machine: null }];
  live = [{ id: "sp1", folder: F, machine: null, name: "one" }];
  p = make();
  p.setPin(live[0]);
  check("palette: unpinning a space's only pin actually removes it",
    pins.length === 0, JSON.stringify(pins));

  pins = [{ id: "sp1", folder: F }, { id: "sp2", folder: F }];
  live = [{ id: "sp1", folder: F }, { id: "sp2", folder: F }, { id: "sp3", folder: F, name: "three" }];
  p = make();
  p.setPin(live[2]);
  check("palette: pinning a third space in that folder adds one and keeps both others",
    pins.length === 3 && pins.some((x) => x.id === "sp3"), JSON.stringify(pins));

  pins = [{ id: "sp9" }];
  p = make();
  check("palette: a pin with an id but no folder is kept, not filtered out",
    p.spacePin({ id: "sp9" })?.id === "sp9", JSON.stringify(pins));

  // A pin whose space is gone while another space stands in its folder has
  // nothing to open: kept, it is a second row for one place and a click that
  // makes a duplicate space. Opening the panel drops it.
  pins = [{ id: "dead", folder: F }];
  live = [{ id: "sp1", folder: F }];
  p = make();
  p.bindPins();
  check("palette: a pin whose place already is a space is dropped",
    pins.length === 0, JSON.stringify(pins));

  pins = [{ id: "dead", folder: "/work/elsewhere" }];
  live = [{ id: "sp1", folder: F }];
  p = make();
  p.bindPins();
  check("palette: a pin whose own folder has no space stays",
    pins.length === 1 && pins[0].id === "dead", JSON.stringify(pins));

  // The row must promise what the click gives: an unnamed pin opens a space that
  // Herdr names after the folder, so that is what the row says.
  const pinLabel = new Function("base",
    `${top("mods/search/main.js", "pinLabel")}; return pinLabel;`)((q) => (q ?? "").split("/").filter(Boolean).pop() ?? "");
  check("palette: an unnamed pin reads the name its folder gets",
    pinLabel({ name: "reel", named: false, folder: F }) === "shared",
    pinLabel({ name: "reel", named: false, folder: F }));
  check("palette: a pin somebody named keeps that name",
    pinLabel({ name: "reel", named: true, folder: F }) === "reel",
    pinLabel({ name: "reel", named: true, folder: F }));
}

console.log(failures ? `\n${failures} failed` : "\nall pin checks passed");
process.exit(failures ? 1 : 0);
