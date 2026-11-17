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
  const pinsAfter = new Function("shared", "spaces",
    `return (${method("mods/worktrees/main.js", "pinsAfter")});`);
  const run = (pins, live, gone, path) => pinsAfter(() => copy(pins), () => live)(gone, path) ?? [];
  const W = "/home/me/.herdr/worktrees/repo/branch";
  const both = [{ id: "a", folder: "/repo" }, { id: "b", folder: "/repo" }, { id: "w", folder: W }];

  let left = run(both, both, [{ id: "w", folder: W }], W);
  check("worktrees: removing a worktree keeps spaces pinned in the parent folder",
    left.length === 2 && left.every((p) => p.id !== "w"), JSON.stringify(left));

  left = run([{ id: "a", folder: "/repo" }, { folder: `${W}/sub` }], [{ id: "a", folder: "/repo" }], [], W);
  check("worktrees: a pin pointing inside the removed checkout goes, with or without an id",
    left.length === 1 && left[0].id === "a", JSON.stringify(left));

  left = run([{ id: "a", folder: "/repo" }, { id: "b", folder: "/repo" }],
    [{ id: "a", folder: "/repo" }, { id: "b", folder: "/repo" }], [{ id: "b", folder: "/repo" }]);
  check("worktrees: closing one space in a shared folder keeps the other's pin",
    left.length === 1 && left[0].id === "a", JSON.stringify(left));

  // A removal drops the pin of every space it closed, but a pinned space the
  // removal leaves behind (its folder is gone, the space is not) keeps its pin.
  let pinsNow = [{ id: "p", folder: W }, { id: "w", folder: W }];
  pinsNow = run(pinsNow, [{ id: "p", folder: W }, { id: "w", folder: W }], [{ id: "w", folder: W }]);
  pinsNow = run(pinsNow, [{ id: "p", folder: W }], [], W);
  check("worktrees: a pin whose space survives the removal stays",
    pinsNow.length === 1 && pinsNow[0].id === "p", JSON.stringify(pinsNow));

  // An old pin with no id, in a folder a closing space shares with another
  // space: the other space is still there, so the pin stays.
  left = run([{ folder: "/repo" }], [{ id: "a", folder: "/repo" }, { id: "b", folder: "/repo" }], [{ id: "b", folder: "/repo" }]);
  check("worktrees: an old pin stays while another space still holds its folder",
    left.length === 1, JSON.stringify(left));
}

// ---------------------------------------------------------------------- palette
// A pin reads as pinned whether it has an id or not, and pinning never repeats
// or swallows another space's pin.
{
  const pinKey = new Function("norm", `${top("mods/agents-list/workspace-engine.js", "pinKey")}; return pinKey;`)(norm);
  const samePin = new Function("pinKey", `${top("mods/agents-list/workspace-engine.js", "samePin")}; return samePin;`)(pinKey);
  const pinnedList = top("mods/agents-list/workspace-engine.js", "pinnedList");
  const cls = ["spacePin", "setPin", "bindPins", "movePinRow"].map((m) => method("mods/agents-list/workspace-engine.js", m)
    .replace(`function ${m}`, m)).join("\n");
  const palette = new Function("shared", "setShared", "spaces", "norm", "pinnedList", "pinKey", "samePin",
    "place", "writePins", "spaceAt", "spaceRecord", "groupKeyOf", "spaceColors", `${pinnedList}
    return class P {
      ${cls}
    };`);

  let pins = [];
  let live = [];
  let opening = null;
  let pinRecord = null;
  let pinColors = {};
  // The real "is a space standing here": the live place, not the folder it was
  // made in. `cwd` lets a case say "made here, working elsewhere".
  const place = (s) => s.cwd ?? s.folder;
  const spaceAt = new Function("norm", "place", "spaces", "panes",
    `${top("mods/agents-list/workspace-engine.js", "spaceAt")}; return spaceAt;`)(norm, place, () => live, () => []);
  // The factory returns the class; the test needs one copy of it.
  const make = () => new (palette((key) => (key === "pin.opening" ? copy(opening) : copy(pins)),
    (key, v) => { if (key === "pin.opening") opening = v; else pins = v; }, () => live, norm,
    () => copy(pins), pinKey, samePin, place, (next) => { pins = next; }, spaceAt,
    () => pinRecord, () => null, () => copy(pinColors)))();

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

  // A rename belongs to the place: the pin keeps the new name when the space
  // closes, and goes back to its folder when the name is cleared.
  opening = null;
  pins = [{ id: "sp1", folder: F, name: "old", named: false }];
  live = [{ id: "sp1", folder: F, name: "renamed", named: true }];
  p = make();
  p.bindPins();
  check("palette: renaming a pinned space renames its pin",
    pins[0].name === "renamed" && pins[0].named === true, JSON.stringify(pins));
  live = [{ id: "sp1", folder: F, name: "shared", named: false }];
  p = make();
  p.bindPins();
  check("palette: clearing a space's name goes back to the pin's folder",
    pins[0].named === false, JSON.stringify(pins));

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

  // The repo and the colour belong to the place: they are what its checkouts
  // hang under and what its avatar wears while the space is gone.
  pins = [];
  live = [{ id: "sp1", folder: F, machine: null, name: "one", named: true }];
  pinRecord = { groupKey: "m\u001f/w/shared" };
  pinColors = { sp1: "ansi3" };
  p = make();
  p.setPin(live[0]);
  check("palette: a pin keeps the repo and the colour of its place",
    pins[0]?.repo === "m\u001f/w/shared" && pins[0]?.color === "ansi3", JSON.stringify(pins));
  pinRecord = null;
  pinColors = {};

  // A pin is the place it names. The space its own row opens stands where the
  // pin's space did, so the pin takes it: the row keeps its slot and the place
  // stays pinned, instead of the new space coming up unpinned at the bottom.
  pins = [{ id: "a", folder: "/w/a" }, { id: "dead", folder: F }, { id: "c", folder: "/w/c" }];
  live = [{ id: "a", folder: "/w/a" }, { id: "sp1", folder: F }, { id: "c", folder: "/w/c" }];
  opening = { id: "dead", folder: F, machine: null, at: Date.now() };
  p = make();
  p.bindPins();
  check("palette: a pin takes the space its own row opened, in its slot",
    pins.length === 3 && pins[1].id === "sp1" && pins[0].id === "a" && pins[2].id === "c",
    JSON.stringify(pins));
  check("palette: the opening marker is spent once the pin has its space",
    opening === null, JSON.stringify(opening));

  // A space the person made in the folder, or a shell started there, is not the
  // pin's space: it may have been made in reel and used at home, and handing the
  // pin to it was how the reel pin became `~`.
  pins = [{ id: "dead", folder: F }];
  live = [{ id: "sp1", folder: F }];
  opening = null;
  p = make();
  p.bindPins();
  check("palette: a dead pin does not take an unrelated space in its folder",
    pins[0].id === "dead", JSON.stringify(pins));
  opening = { id: "dead", folder: F, machine: null, at: Date.now() };
  live = [{ id: "sp1", folder: F, cwd: "/home/me" }];
  p = make();
  p.bindPins();
  check("palette: a space made in the folder but working elsewhere is not the place",
    pins[0].id === "dead", JSON.stringify(pins));

  // The Pinned section reads the pin list, so a move between two pins moves the
  // pin; `space.move` alone would leave the row drawn where it was.
  pins = [{ id: "a", folder: "/w/a" }, { id: "b", folder: "/w/b" }, { id: "c", folder: "/w/c" }];
  live = [{ id: "a", folder: "/w/a" }, { id: "b", folder: "/w/b" }, { id: "c", folder: "/w/c" }];
  p = make();
  check("palette: a pinned row moves its pin too",
    p.movePinRow(live[2], live[0], -1) === true && pins.map((x) => x.id).join(",") === "c,a,b",
    JSON.stringify(pins));
  check("palette: an unpinned row moves no pin",
    p.movePinRow({ id: "nope" }, live[1], 1) === false && pins.map((x) => x.id).join(",") === "c,a,b",
    JSON.stringify(pins));

  // Two spaces in one folder are two places; a pin cannot say which one it means.
  pins = [{ id: "dead", folder: F }];
  live = [{ id: "sp1", folder: F }, { id: "sp2", folder: F }];
  p = make();
  p.bindPins();
  check("palette: two spaces in its folder leave the pin a place row",
    pins.length === 1 && pins[0].id === "dead", JSON.stringify(pins));

  // A space another pin already holds is not handed to this one.
  pins = [{ id: "old", folder: F }, { id: "sp1", folder: F }];
  live = [{ id: "sp1", folder: F }];
  p = make();
  p.bindPins();
  check("palette: a pin does not take a space another pin holds",
    pins.length === 2 && pins[0].id === "old", JSON.stringify(pins));

  pins = [{ id: "dead", folder: "/work/elsewhere" }];
  live = [{ id: "sp1", folder: F }];
  p = make();
  p.bindPins();
  check("palette: a pin whose own folder has no space stays",
    pins.length === 1 && pins[0].id === "dead", JSON.stringify(pins));

  // The row must promise what the click gives: an unnamed pin opens a space that
  // Herdr names after the folder, so that is what the row says.
  const pinLabel = new Function("base",
    `${top("mods/agents-list/workspace-engine.js", "pinLabel")}; return pinLabel;`)((q) => (q ?? "").split("/").filter(Boolean).pop() ?? "");
  check("palette: an unnamed pin reads the name its folder gets",
    pinLabel({ name: "reel", named: false, folder: F }) === "shared",
    pinLabel({ name: "reel", named: false, folder: F }));
  check("palette: a pin somebody named keeps that name",
    pinLabel({ name: "reel", named: true, folder: F }) === "reel",
    pinLabel({ name: "reel", named: true, folder: F }));
}

// ------------------------------------------------------------------- pin rows
// One slot per pin. The Pinned section draws these in order, so a place whose
// space is gone keeps the line it had, and the space that takes the place back
// is drawn in that same line.
{
  let pins = [
    { id: "a", folder: "/w/a" },
    { id: "dead", folder: "/w/b" },
    { id: "c", folder: "/w/c" },
  ];
  let live = [{ id: "a", folder: "/w/a" }, { id: "c", folder: "/w/c" }];
  const pinRows = new Function("pinnedList", "spaces", "norm", "place",
    `${top("mods/agents-list/workspace-engine.js", "pinRows")}; return pinRows;`)(
    () => copy(pins), () => live, norm, (s) => s.cwd ?? s.folder);
  let rows = pinRows();
  check("pin rows: a place with no space keeps its line",
    rows.length === 3 && rows[0].s?.id === "a" && rows[1].p.id === "dead"
      && rows[1].s === null && rows[2].s?.id === "c", JSON.stringify(rows));
  live = [{ id: "a", folder: "/w/a" }, { id: "b2", folder: "/w/b" }, { id: "c", folder: "/w/c" }];
  pins = [{ id: "a", folder: "/w/a" }, { id: "b2", folder: "/w/b" }, { id: "c", folder: "/w/c" }];
  rows = pinRows();
  check("pin rows: the space that takes the place back takes its line",
    rows.length === 3 && rows[1].s?.id === "b2" && rows[1].p.id === "b2", JSON.stringify(rows));
  // Pins saved before pins had ids name their place by folder.
  pins = [{ folder: "/w/a", machine: null }, { id: "b2", folder: "/w/b" }];
  live = [{ id: "a", folder: "/w/a" }, { id: "b2", folder: "/w/b" }];
  rows = pinRows();
  check("pin rows: an old pin without an id reads the space in its folder",
    rows[0].s?.id === "a", JSON.stringify(rows));
  // A space made in the folder and used elsewhere is not standing there.
  pins = [{ folder: "/w/a", machine: null }];
  live = [{ id: "a", folder: "/w/a", cwd: "/home/me" }];
  rows = pinRows();
  check("pin rows: a space made there but working elsewhere is not the place",
    rows[0].s === null, JSON.stringify(rows));
}

// The two views paint a closed pin with the same face: the colour saved on the
// pin. Hashing the folder in one view made the same place change colour.
check("palette: a closed pin wears its saved colour",
  /const tone = r\.color \?\? folderColor\(r\.folder\)/.test(read("mods/agents-list/palette.js"))
  && /const tone = p\.color \?\? folderColor\(p\.folder\)/.test(read("mods/agents-list/sidebar.js")));

// A pin names a repo, not just a space: the group key is what its checkouts hang
// under while the space is gone.
{
  const pinnedRepo = new Function("SEP", "tidyPath",
    `${top("mods/agents-list/workspace-engine.js", "pinnedRepo")}; return pinnedRepo;`)("\u001f", norm);
  const p = { id: "sp1", folder: "/w/repo/", machine: null };
  check("pins: a pin pinned with a repo keeps it",
    pinnedRepo({ ...p, repo: "m\u001f/w/repo" }, {}) === "m\u001f/w/repo");
  check("pins: a pin without a repo reads the scan of its folder",
    pinnedRepo(p, { "\u001f/w/repo": { repo: "\u001f/w/repo" } }) === "\u001f/w/repo");
  check("pins: with no scan answer its folder is the main checkout",
    pinnedRepo(p, {}) === "\u001f/w/repo");
}

// A space made in a repo but reported elsewhere (an agent at `~`) keeps the
// repo it stands in: the read falls back to the space's own folder, so its
// worktrees stay attached under it.
{
  const SEP = "\u001f";
  const tidyPath = (p) => (p ?? "").replace(/\/+$/, "");
  const place = (s) => s.cwd ?? s.folder;
  const spaceRead = new Function("workspace", "place", "panes", "tidyPath", "SEP",
    `${top("mods/agents-list/workspace-engine.js", "spaceRead")}; return spaceRead;`)(
    { git: {} }, place, () => [], tidyPath, SEP);
  const reel = { repo: `${SEP}/home/me/reel`, root: "/home/me/reel", branch: "main", linked: false };
  const other = { repo: `${SEP}/work/other`, root: "/work/other", branch: "work", linked: false };
  const link = { repo: `${SEP}/home/me/reel`, root: "/home/me/worktrees/reel/x", branch: "x", linked: true };
  const s = { machine: null, folder: "/home/me/reel" };
  let read = spaceRead({ ...s, cwd: "/home/me" }, { [`${SEP}/home/me`]: null, [`${SEP}/home/me/reel`]: reel }, []);
  check("space read: a space at home has no repo tail, even when made in reel",
    read === null, JSON.stringify(read));
  read = spaceRead({ ...s, cwd: "/home/me/reel" }, { [`${SEP}/home/me/reel`]: reel }, []);
  check("space read: a main checkout read answers with its repo",
    read?.key === reel.repo && read.linked === false, JSON.stringify(read));
  read = spaceRead({ ...s, cwd: "/work/other" }, { [`${SEP}/work/other`]: other, [`${SEP}/home/me/reel`]: reel }, []);
  check("space read: the repo at the live place wins over the made folder",
    read?.key === other.repo, JSON.stringify(read));
  read = spaceRead({ ...s, cwd: "/home/me/reel" }, { [`${SEP}/home/me/reel`]: link }, []);
  check("space read: a linked checkout read answers as linked",
    read?.key === reel.repo && read.linked === true, JSON.stringify(read));
}

console.log(failures ? `\n${failures} failed` : "\nall pin checks passed");
process.exit(failures ? 1 : 0);
