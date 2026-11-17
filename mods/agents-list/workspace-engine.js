// One logic, two views.
//
// The sidebar and the find sheet are the same thing twice: the same places,
// pins, removals, worktrees and space order, drawn once as a list that stays
// open and once as a sheet that opens over it. Herdr only lets a mod import its
// own folder, so they are one mod here, and this file is the one copy of what
// they both do.
//
// Everything that can be derived, resolved or scored lives here, and so does
// the shared picture (`shared.json` key `workspace.state`):
//
//   - `workspace.git` / `.trees`: the git summaries and checkout lists, read by
//     one scanner in the sidebar, never in a render.
//   - `workspace.spacePins`: the sticky space -> repo/worktree record. It is
//     what keeps a worktree bound to its parent after a `cd` out of the
//     checkout, and it survives a restart.
//   - `workspace.order`: the per-repo worktree order. Herdr's `space.move` is
//     for spaces; nested checkouts reorder here instead.
//
// The find sheet reads this on its first frame, which is why Alt+F opens with no
// git call of its own. A rule belongs here when both views need it: where a
// space is, what a pin is, what is on its way out, how a step lands, what Ctrl+D
// does to a row. What is left in palette.js and sidebar.js is how each one draws
// and walks its own rows.
import { View, div } from "gpui-kit";
import { spaces, panes, agents, run, shared, setShared, notify, keys, openOverlay, exec } from "herdr";

// A separator for keys that cross into shared.json. NUL is fine inside this
// process but Herdr's shared state truncates an object key at NUL (`a\0b` reads
// back as `a`), which collapsed the whole git/checkout map onto one entry. Unit
// separator is not a path or machine-name character and survives JSON.
export const SEP = "\u001f";

// The sidebar's avatar colours, so a space looks the same in both places.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

// A theme colour with alpha, so every tint follows the theme's own light and dark.
export const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

// A program's tile keeps its own colour, drawn solid: washed over the theme
// background it would look different in every theme, and a program's mark should
// not. Its glyph takes the program's colour, or whichever of black and white the
// tile can carry.
export const tileOf = (p) => (p?.tile && /^#[0-9a-fA-F]{6}$/.test(p.tile) ? p.tile : null);
export const inkOf = (p) => {
  if (p?.color) return p.color;
  const tile = tileOf(p);
  if (!tile) return null;
  const n = parseInt(tile.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#121212" : "#ffffff";
};

// A small keyboard cap, so shortcuts read as keys rather than as prose.
export const keycap = (t, label, tone = t.muted) => div().flex_none().h(18).px(5).rounded(4)
  .bg(wash(t.foreground, "10")).border(1).border_color(wash(t.foreground, "1c"))
  .text_size(9.5).font_medium().text_color(tone).flex().items_center().child(label);

// The query, drawn where it lands. A match keeps the row's colour and takes the
// weight; the rest steps back. Only on a short label: a long one is truncated,
// and pieces cannot ellipsize as one line.
export const marks = (text, terms) => {
  const s = String(text ?? "");
  if (!terms?.length || s.length > 30) return null;
  const lower = s.toLowerCase();
  const hits = [];
  for (const term of terms) {
    for (let i = lower.indexOf(term); i >= 0 && hits.length < 32; i = lower.indexOf(term, i + term.length)) {
      hits.push([i, i + term.length]);
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a[0] - b[0]);
  const run = [];
  for (const [a, b] of hits) {
    const last = run.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else run.push([a, b]);
  }
  const parts = [];
  let at = 0;
  for (const [a, b] of run) {
    if (a > at) parts.push([s.slice(at, a), false]);
    if (b > a) parts.push([s.slice(a, b), true]);
    at = b;
  }
  if (at < s.length) parts.push([s.slice(at), false]);
  return parts;
};

// The query, split the one way both views split it ("kleeamp desk" is two
// terms) and scored by the one fuzzy rule. Both the sheet's results and its
// pin/worktree rows go through this, so two copies cannot rank differently.
export const termsOf = (q) => String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);

export function scoreTerms(terms, fields) {
  const one = (text, term) => {
    if (!text) return -Infinity;
    const t = String(text).toLowerCase();
    if (t === term) return 100;
    if (t.startsWith(term)) return 80 - Math.min(10, t.length - term.length);
    if (t.split(/[\/\s._-]+/).some((w) => w.startsWith(term))) return 60;
    const i = t.indexOf(term);
    return i >= 0 ? 40 - Math.min(25, i) : -Infinity;
  };
  let total = 0;
  for (const term of terms) {
    let hit = -Infinity;
    for (const [value, weight] of fields) {
      const sc = one(value, term);
      if (sc > -Infinity) hit = Math.max(hit, sc * weight);
    }
    if (hit === -Infinity) return -Infinity;
    total += hit;
  }
  return total;
}

// One paint shares the host copies it asks for. `spaces()` and `layout()` copy
// the whole model out of the app, and a single frame used to ask again per row.
// A click runs later, outside the paint, so it still reads the live values.
let paintDepth = 0;
const paintBox = new Map();
export function beginPaint() {
  if (paintDepth === 0) paintBox.clear();
  paintDepth++;
}
export function endPaint() {
  paintDepth = Math.max(0, paintDepth - 1);
  if (paintDepth === 0) paintBox.clear();
}
export function frameCache(key, read) {
  if (paintDepth === 0) return read();
  if (paintBox.has(key)) return paintBox.get(key);
  const value = read();
  paintBox.set(key, value);
  return value;
}

// Space colours, kept by space id in shared "space.colors". The least used
// colour wins, so two neighbouring spaces rarely share one.
export function spaceColors() {
  if (paintDepth > 0 && paintBox.has("space.colors.result")) return paintBox.get("space.colors.result");
  const list = frameCache("spaces", spaces);
  const stored = shared("space.colors") ?? {};
  const ids = new Set(list.map((p) => p.id));
  const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(stored).length;
  for (const p of list) {
    if (kept[p.id] || p.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[p.id] = PROJECT_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  // A pin's colour belongs to the place, not to the space id it was pinned with:
  // a place whose space is gone keeps its avatar, and the space that takes the
  // place back wears it too.
  const pins = pinnedList();
  let pinsChanged = false;
  for (const p of pins) {
    if (!p.id || !ids.has(p.id)) continue;
    const color = kept[p.id] ?? p.color;
    if (!color) continue;
    if (p.color !== color) { p.color = color; pinsChanged = true; }
    if (kept[p.id] !== color) { kept[p.id] = color; changed = true; }
  }
  if (pinsChanged) writePins(pins, "gave a pin the colour of its place");
  if (changed) setShared("space.colors", kept);
  if (paintDepth > 0) paintBox.set("space.colors.result", kept);
  return kept;
}
export function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
  const c = spaceColors()[p.id] ?? PROJECT_COLORS[0];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

// The key bound to a command, for an action row ("ctrl-shift-n" -> "Ctrl+Shift+N").
export function shortcutOf(command) {
  // The shortest binding: a command on both Ctrl+N and Ctrl+Shift+N reads as
  // Ctrl+N, the key people reach for. The sheet asks for a few of these per
  // paint; one copy of the keymap serves all of them.
  const fewest = (a, b) => a.keys.split("-").length - b.keys.split("-").length;
  const all = frameCache("keys", keys).filter((b) => b.action === command).sort(fewest);
  const binding = all.find((b) => b.section !== "terminal") ?? all[0];
  if (!binding) return "";
  return binding.keys.split("-").map((part) => {
    const word = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: "Cmd", super: "Super" }[part];
    return word ?? (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1));
  }).join("+");
}

// Tab -> the first pane (in list order) that shows it. `panes()` copies the whole
// list, and one frame asks for a space's folder many times against that one copy.
const paneAt = new WeakMap();
function paneIndex(all) {
  const hit = paneAt.get(all);
  if (hit) return hit;
  const byTab = new Map();
  let i = 0;
  for (const p of all) {
    if (p?.tab && p.cwd && !byTab.has(p.tab)) byTab.set(p.tab, { cwd: p.cwd, i });
    i++;
  }
  paneAt.set(all, byTab);
  return byTab;
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `null` is not "use the default": a caller that has no snapshot passes null and
// gets the folder the space was made in, without asking the host for panes.
export function place(s, all = panes()) {
  if (!s) return null;
  if (!all || typeof all !== "object") return s.folder || null;
  const byTab = paneIndex(all);
  let best = null;
  let bestI = Infinity;
  for (const c of s.tabs ?? []) {
    const hit = byTab.get(c?.id);
    if (hit && hit.i < bestI) {
      best = hit.cwd;
      bestI = hit.i;
    }
  }
  return best || s.folder || null;
}

// Checkouts the worktrees dialog has already taken off the list. It hides one on
// confirm and the sidebar does the git work behind it, so neither view may offer
// a row that is on its way out as if it were still there. The same array for one
// second: `shared` hands back a fresh copy, and a frame asks this per row.
export const removingList = () => {
  const bucket = (Date.now() / 1000) | 0;
  // A frame asks once per row. The list does not change mid-paint, so the
  // later rows reuse this read instead of copying it out of the host again.
  if (removingList.kept && removingList.at && (Date.now() - removingList.at) < 16 && removingList.bucket === bucket) {
    return removingList.kept;
  }
  removingList.at = Date.now();
  const list = shared("worktree.removing");
  if (!Array.isArray(list)) {
    if (removingList.bucket === bucket && removingList.mark === "") return removingList.kept;
    removingList.bucket = bucket;
    removingList.mark = "";
    return (removingList.kept = []);
  }
  const mark = list.map((r) => `${r?.machine ?? ""}\u0000${r?.path ?? ""}\u0000${r?.at ?? ""}`).join("\u0001");
  if (removingList.bucket === bucket && removingList.mark === mark) return removingList.kept;
  removingList.bucket = bucket;
  removingList.mark = mark;
  const since = Date.now() - 5 * 60_000;
  return (removingList.kept = list.filter((r) => (r.at ?? 0) > since));
};
export const isRemoving = (path, machine) => Boolean(path) && removingList()
  .some((r) => (r.machine ?? null) === (machine ?? null) && tidyPath(r.path) === tidyPath(path));

// The space already standing in a folder — the same place, not one of its
// subfolders. A pin is a place, so this is what says "there is a space here".
// Only the live place counts: a space made in the folder and used somewhere
// else is somewhere else, and claiming it for a pin would turn the pin into
// that other place (the "reel" pin showing a `~` space's row and opening it).
export function spaceAt(folder, on, all = spaces(), ps = panes()) {
  const f = norm(folder);
  if (!f) return null;
  return all.find((s) => (s.machine ?? null) === (on ?? null)
    && norm(place(s, ps) ?? "") === f) ?? null;
}

// The git read a space stands for: where it is now, never the folder it was
// made in. A space made in `reel` and used at `~` is at `~`: giving it reel's
// repo made its row read `~` beside a `reel`/`herdr-app` tail, two names for
// one place, and claimed checkouts it was no longer standing in. A worktree's
// sticky record keeps its own repo across a `cd`; the scan does not need to
// re-read the made folder to keep it a checkout.
export function spaceRead(s, git = workspace.git, ps = panes()) {
  if (!s) return null;
  const at = place(s, ps) ?? s.folder;
  const g = git?.[`${s.machine ?? ""}${SEP}${tidyPath(at ?? "")}`];
  if (!g?.repo) return null;
  return {
    key: g.repo,
    main: g.repo.split(SEP)[1] ?? "",
    root: g.root,
    branch: g.branch,
    linked: Boolean(g.linked),
  };
}

export async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// Git answers the sidebar and the sheet both ask for, remembered for a few
// seconds. A second open of the sheet, or the sidebar's timer, must not start
// the same rev-parse again. A failed read is remembered only briefly, so a
// repo that was busy is tried again; a drop forgets an answer that a worktree
// add or remove has already made wrong. An in-flight read is shared, and a
// drop while it is running keeps its result from being stored afterwards.
const GIT_OK = 20000;
const GIT_MISS = 2000;
const repoCache = new Map();
const treeCache = new Map();

function remember(map, key, run) {
  const hit = map.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.value);
  let pending;
  pending = Promise.resolve().then(run).then((value) => {
    if (map.get(key)?.pending === pending) map.set(key, { at: Date.now(), ttl: value == null ? GIT_MISS : GIT_OK, value });
    return value;
  }, (error) => {
    if (map.get(key)?.pending === pending) map.delete(key);
    throw error;
  });
  map.set(key, { at: 0, ttl: 0, value: undefined, pending });
  return pending;
}

// Forget cached git. A main checkout forgets just that repo; nothing forgets
// every repo, which is what a worktree add does before the path's repo is known.
export function dropGitCache(main) {
  if (!main) {
    repoCache.clear();
    treeCache.clear();
    return;
  }
  const m = tidyPath(main);
  for (const key of repoCache.keys()) {
    const hit = repoCache.get(key);
    if ((hit?.value?.main && tidyPath(hit.value.main) === m) || key.endsWith(`${SEP}${m}`)) repoCache.delete(key);
  }
  for (const key of treeCache.keys()) if (key.endsWith(`${SEP}${m}`)) treeCache.delete(key);
}

// The one picture both views draw. The sidebar writes it — that copy stays
// mounted, hidden or not — and the sheet reads it. Two private lists are how a
// checkout could hang under one space in the sidebar and under another, or be
// gone, in the sheet.
//
// `spacePins` is the sticky half: once git says a space stands in a worktree,
// the space stays that checkout's space even when its shell `cd`s into the main
// checkout, a subfolder, or somewhere with no repo at all. `order` is the
// per-repo worktree order the sidebar and the sheet both draw, kept apart from
// Herdr's global `spaces()` order. Both are persisted in shared state.
export const workspace = {
  git: {},
  gitAt: {},
  trees: {},
  treesAt: {},
  spacePins: {},
  order: {},
  checkoutById: new Map(),
  treesGen: 0,
  rev: 0,
  notedAt: 0,
  want: false,
  wantForce: false,
  hydrated: false,
  dirty: false,
  savedAt: 0,
  saved: "",
};

// The shared record every copy reads. One object, so the sheet's first frame
// (before the sidebar's next scan) already knows the repos, the checkouts and
// the worktree order — no git, no localStorage guess.
const STATE_KEY = "workspace.state";
const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

export function workspaceState() {
  return asObject(shared(STATE_KEY)) ?? {};
}

// Fill the in-memory picture from shared state once. The maps are mutated in
// place: the views bind to these objects by reference, and replacing one would
// leave a view reading last restart's picture.
export function hydrateWorkspace() {
  if (workspace.hydrated) return;
  workspace.hydrated = true;
  const state = workspaceState();
  const usable = (key) => typeof key === "string" && key.includes(SEP);
  for (const [key, value] of Object.entries(asObject(state.git) ?? {})) {
    if (!usable(key) || key in workspace.git) continue;
    workspace.git[key] = value;
  }
  for (const [key, value] of Object.entries(asObject(state.trees) ?? {})) {
    if (!usable(key) || key in workspace.trees) continue;
    workspace.trees[key] = value;
  }
  Object.assign(workspace.spacePins, asObject(state.spaces) ?? {});
  Object.assign(workspace.order, asObject(state.order) ?? {});
  workspace.rev = Math.max(workspace.rev ?? 0, Number(state.rev) || 0);
}

// Write the picture for the other copy (and for the next start). Debounced, and
// skipped when nothing changed: setShared repaints every mod, and a scan that
// found nothing new must not do that. `force` is for the moment a scan ends.
export function persistWorkspace(force = false) {
  const now = Date.now();
  if (!force && now - (workspace.savedAt ?? 0) < 1000) {
    workspace.dirty = true;
    return false;
  }
  workspace.savedAt = now;
  workspace.dirty = false;
  // Keys that crossed shared state under an older separator (or arrived from a
  // corrupt file) cannot be addressed any more. Drop them here as well, so one
  // stale entry cannot ride along forever.
  const clean = (map) => Object.fromEntries(Object.entries(map ?? {}).filter(([key]) => key.includes(SEP)));
  // `at` is when the picture was written, not part of it. Keeping it out of the
  // comparison matters: with it in, every scan looked like a change, so an idle
  // window rewrote shared state (and repainted every mod) once per scan.
  const state = {
    rev: workspace.rev ?? 0,
    git: clean(workspace.git),
    trees: clean(workspace.trees),
    spaces: workspace.spacePins,
    order: workspace.order,
  };
  const json = JSON.stringify(state);
  // If the file still holds a key this build cannot address, write once more:
  // the whole `workspace.state` is replaced, which is how the stale entry goes.
  const raw = workspaceState();
  const stale = ["git", "trees"].some((name) =>
    Object.keys(asObject(raw[name]) ?? {}).some((key) => !key.includes(SEP)))
    || Object.keys(asObject(raw.order) ?? {}).some((key) => !key.includes(SEP));
  if (json === workspace.saved && !stale) return false;
  workspace.saved = json;
  setShared(STATE_KEY, { ...state, at: now });
  return true;
}

// A space's sticky record: { groupKey, main, worktreePath, root, branch,
// isWorktree }. `groupKey` is `<machine>\0<git-common-dir's repo>`: the canonical
// identity of a repository, so a worktree always binds to its parent no matter
// where its folder lives. The record outlives a `cd`, a restart and a re-scan.
export function spaceRecord(s) {
  return asObject(workspace.spacePins?.[s?.id]) ?? null;
}

export function noteSpaceRecord(s, next) {
  if (!s?.id) return false;
  const prev = workspace.spacePins[s.id];
  if (!next) {
    if (!prev) return false;
    delete workspace.spacePins[s.id];
    workspace.dirty = true;
    return true;
  }
  const same = prev && prev.groupKey === next.groupKey
    && tidyPath(prev.worktreePath ?? "") === tidyPath(next.worktreePath ?? "")
    && prev.isWorktree === next.isWorktree;
  if (same) {
    // Same checkout: keep the object, refresh the branch. A `cd` out of the
    // checkout does not rewrite which checkout the space is.
    if (prev.branch !== next.branch) { prev.branch = next.branch; workspace.dirty = true; }
    return false;
  }
  workspace.spacePins[s.id] = next;
  workspace.dirty = true;
  return true;
}

// Fold one git read into a space's sticky record. `read` is the scanner's
// answer for the space's primary pane: { key, main, root, branch, linked } or
// null (not a repository, or asleep).
//
// A linked read always wins. A main-checkout read of the SAME repo is a shell
// that `cd`ed out of its worktree: the space is still the worktree's, so the
// pinned path and branch stay. Only a read of a different repository root
// re-evaluates the space — that is a different place of work, not a detour.
export function pinSpace(s, read) {
  if (!s?.id) return false;
  const prev = spaceRecord(s);
  if (!read) return false;
  if (prev?.isWorktree && prev.groupKey === read.key) {
    const branch = tidyPath(read.root) === tidyPath(prev.worktreePath ?? "") ? read.branch : prev.branch;
    return noteSpaceRecord(s, {
      groupKey: prev.groupKey, main: prev.main, worktreePath: prev.worktreePath,
      root: prev.root, branch, isWorktree: true,
    });
  }
  return noteSpaceRecord(s, {
    groupKey: read.key,
    main: read.main,
    worktreePath: read.linked ? tidyPath(read.root) : null,
    root: tidyPath(read.root),
    branch: read.branch,
    isWorktree: Boolean(read.linked),
  });
}

// Worktrees of one repo, in the order the person put them in. The paths not
// named yet keep the order they arrived in, after the named ones: a new
// checkout appears at the end, where `git worktree list` puts it.
export function orderOf(groupKey) {
  const list = workspace.order?.[groupKey];
  return Array.isArray(list) ? list.map(tidyPath).filter(Boolean) : [];
}

// The checkout shape the views draw, from the sticky record. Null before the
// first scan; the views then fall back to their in-memory git answer.
export function checkoutRecordOf(s) {
  const rec = spaceRecord(s);
  if (!rec) return null;
  return {
    main: rec.main ?? null,
    root: rec.worktreePath ?? rec.root ?? null,
    linked: Boolean(rec.isWorktree),
    branch: rec.branch ?? null,
  };
}

// A space's repo identity (`<machine>\0<main checkout>`), from its record or
// from the git summary of where it is now.
export function groupKeyOf(s, ps) {
  const rec = spaceRecord(s);
  if (rec?.groupKey) return rec.groupKey;
  const at = ps ? place(s, ps) : place(s);
  const key = `${s?.machine ?? ""}${SEP}${tidyPath(at ?? s?.folder ?? "")}`;
  return workspace.git?.[key]?.repo ?? null;
}

// Every worktree of one repo, opened as a space or not: what a repo group's
// worktree rows are, in the order they belong in. `checkoutList` is
// listedCheckouts() once per paint.
export function worktreeSiblings(groupKey, all, checkoutList) {
  const out = [];
  for (const s of all ?? []) {
    const rec = spaceRecord(s);
    if (!rec?.isWorktree || rec.groupKey !== groupKey || !rec.worktreePath) continue;
    out.push({ path: rec.worktreePath, space: s });
  }
  for (const c of checkoutList ?? []) {
    if (`${c.on ?? ""}${SEP}${tidyPath(c.repoMain ?? "")}` !== groupKey) continue;
    if (out.some((x) => tidyPath(x.path) === tidyPath(c.path))) continue;
    out.push({ path: c.path, checkout: c });
  }
  return orderedPaths(groupKey, out, (x) => x.path);
}

export function orderedPaths(groupKey, rows, pathOf) {
  const order = orderOf(groupKey);
  if (!order.length || rows.length < 2) return rows;
  const rank = new Map(order.map((p, i) => [p, i]));
  return rows
    .map((row, i) => ({ row, i, rank: rank.get(tidyPath(pathOf(row))) }))
    .sort((a, b) => (a.rank == null ? 1 : 0) - (b.rank == null ? 1 : 0)
      || (a.rank == null ? a.i - b.i : a.rank - b.rank))
    .map(({ row }) => row);
}

// Put `path` at `targetPath`'s place in the drawn order. Used for worktrees,
// which Herdr does not reorder (`space.move` is about spaces, not checkouts):
// the answer is a persisted array per repo, never a shuffle of `spaces()`.
export function movePathWithin(groupKey, paths, path, targetPath, dir = 0) {
  if (!groupKey || !path) return null;
  const p = tidyPath(path);
  const t = tidyPath(targetPath);
  const list = paths.map(tidyPath).filter((x) => x !== p);
  const at = list.indexOf(t);
  if (at < 0 || p === t) return null;
  list.splice(at + (dir > 0 ? 1 : 0), 0, p);
  workspace.order[groupKey] = list;
  workspace.dirty = true;
  return list;
}

// Which index `space.move` wants for a row dropped on `target`: a position
// inside that space's own machine block, 1-based. The sidebar and the sheet
// draw filtered, grouped and nested rows; the raw `spaces()` index is not what
// the drop means, and a cross-machine drop is not a move at all.
export function machineIndexOf(all, machine, id) {
  const list = (all ?? []).filter((s) => (s.machine ?? null) === (machine ?? null));
  const at = list.findIndex((s) => s.id === id);
  return at < 0 ? null : at + 1;
}

let gitAsk = null;

// The sidebar registers the one scanner. The sheet asks it to read, instead of
// starting a second git walk that can finish last and disagree.
export function onGitRefresh(fn) { gitAsk = fn; }

export function askGit(force = false) {
  workspace.want = true;
  if (force) workspace.wantForce = true;
  gitAsk?.();
}

// What the sheet asked for, once. Cleared here so a scan does not see its own
// request and start another.
export function takeGitAsk() {
  const force = Boolean(workspace.wantForce);
  const live = Boolean(workspace.want);
  workspace.want = false;
  workspace.wantForce = false;
  return { force, live };
}

// The sheet repaints when this moves. It reads the revision while it draws, and
// a bump that did not change the value would redraw forever.
export function touchWorkspace() {
  const next = (workspace.rev ?? 0) + 1;
  workspace.rev = next;
  if (shared("workspace.rev") !== next) setShared("workspace.rev", next);
}

// A checkout the dialog just made, in the list both views draw this frame. The
// git scan that follows replaces the guess. The same timestamp is one add: the
// sidebar and the sheet both see it, and the second must not bump the scan
// generation again.
export function noteCheckout(path, at) {
  if (at && workspace.notedAt === at) return false;
  const clean = tidyPath(path);
  const m = clean.match(/^(.*)\/worktrees\/([^/]+)\/([^/]+)$/);
  if (!m) return false;
  if (at) workspace.notedAt = at;
  const repo = m[2];
  const branch = m[3];
  let known = false;
  for (const key of Object.keys(workspace.trees)) {
    const main = key.split(SEP)[1] ?? "";
    if (base(main) !== repo) continue;
    known = true;
    dropGitCache(main);
    const list = Array.isArray(workspace.trees[key]) ? workspace.trees[key] : [];
    if (!list.some((c) => tidyPath(c.path) === clean)) {
      workspace.trees[key] = [...list, { path: clean, branch, main: false }];
    }
    delete workspace.treesAt[key];
  }
  // The repo is not cached yet. Drop every checkout list so the scan that
  // follows cannot treat a stale one as fresh.
  if (!known) {
    dropGitCache();
    for (const key of Object.keys(workspace.treesAt)) delete workspace.treesAt[key];
  }
  workspace.treesGen = (workspace.treesGen ?? 0) + 1;
  touchWorkspace();
  return true;
}

// Every checkout the sidebar has read, in the shape the shared tree takes.
// Both views build their forest from this, so neither keeps a second list.
export function listedCheckouts() {
  const out = [];
  for (const [key, list] of Object.entries(workspace.trees)) {
    if (!Array.isArray(list)) continue;
    const at = key.indexOf(SEP);
    const on = key.slice(0, at) || null;
    const repoMain = key.slice(at + 1);
    for (const c of list) out.push({ path: c.path, branch: c.branch, main: false, on, repoMain });
  }
  return out;
}

// The checkouts the picture already lists, by the place a space would stand in.
// A space living in one of them *is* that checkout before git has answered for
// its folder: a scan that is behind, or a checkout made outside
// `<home>/worktrees/<repo>/`, otherwise read as a place of its own while this
// very list already drew its row under the repo — the same worktree twice.
// One map per paint; the list is the sidebar's, so both views agree.
export function knownCheckouts() {
  return frameCache("checkouts.byPath", () => {
    const map = new Map();
    for (const c of listedCheckouts()) {
      if (c.main) continue;
      map.set(`${c.on ?? ""}${SEP}${tidyPath(c.path)}`, c);
    }
    return map;
  });
}

// The listed checkout a space stands in, from the folders it may be at: where it
// is now and where it was made. `null` leaves the answer to git and the path
// guess, exactly as before.
export function knownCheckoutAt(on, folders) {
  const map = knownCheckouts();
  for (const folder of folders ?? []) {
    if (!folder) continue;
    const hit = map.get(`${on ?? ""}${SEP}${tidyPath(folder)}`);
    if (hit) return hit;
  }
  return null;
}

// A space's listed checkout, when its own view has no pane snapshot.
export function knownCheckoutFor(s, ps) {
  if (!s) return null;
  const at = ps ? place(s, ps) : place(s);
  return knownCheckoutAt(s.machine ?? null, [at, s.folder]);
}

// The repo a folder belongs to: main checkout, name, and whether this is a linked worktree.
export async function repoOf(folder, on) {
  const key = `${on ?? ""}${SEP}${tidyPath(folder)}`;
  return remember(repoCache, key, async () => {
    const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
    const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
    if (!top.ok || !common.ok) return null;
    const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
    return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
  });
}

// Every checkout of a repo, the main one first, then most recently committed.
// The sidebar and the sheet both read the same git answer through this.
async function readCheckouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  // null, not []: a failed read must not look like a repo with no checkouts,
  // or the sidebar would wipe the list it already drew.
  if (!list.ok) return null;
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").filter(Boolean).map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

export async function checkouts(repo, on) {
  const key = `${on ?? ""}${SEP}${tidyPath(repo?.main ?? "")}`;
  return remember(treeCache, key, () => readCheckouts(repo, on));
}

export const norm = (p) => (p ?? "").replace(/\\/g, "/");
export const tidyPath = (p) => norm(p).replace(/\/+$/, "");
export const base = (p) => norm(p).replace(/\/+$/, "").split("/").pop() ?? "";

// A pin with no live space opens a new space in its folder, and Herdr names a
// space after the folder it starts in. So a pin row must read the name the click
// will give it, never the name the space had while it was open somewhere else:
// "reel" opening as "herdr-app" is a row that lied. A pin somebody named keeps
// that name, because opening it asks for the name too.
export const pinLabel = (p) => (p?.named && p.name ? p.name : base(p?.folder));
export const inside = (p, dir) => p === dir || p.startsWith(dir.replace(/\/+$/, "") + "/");

// The colour a saved space keeps while it has no terminals: from its folder,
// so the same pin reads the same across restarts.
export function folderColor(folder) {
  let h = 0;
  for (const ch of norm(folder)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PROJECT_COLORS[h % PROJECT_COLORS.length];
}

// Herdr keeps linked checkouts at <home>/worktrees/<repo>/<branch>, so a space
// standing there is a worktree even before git has answered for it. The sidebar
// and the sheet read the same path, so neither can call it a space of its own.
export const inWorktrees = (folder) => /(?:^|\/)worktrees\/[^/]+\/[^/]+\/?$/.test(norm(folder ?? ""));

// Pinned spaces: the id is what a pin belongs to, the folder is what lets it
// still open a shell once its space is gone. A pin is never dropped for missing
// a field (that would lose it on the next write): an id alone is enough.
export function pinnedList() {
  const list = shared("spaces.pinned");
  return Array.isArray(list) ? list.filter((p) => p && (p.id || p.folder)) : [];
}

// The repo a pin names, as a group key (`<machine>\0<main checkout>`): the
// record taken when it was pinned, else the scan's answer for its folder, else
// the folder itself is the main checkout. A pin is a place, and its repo is
// what its checkouts hang under while the space is gone.
export function pinnedRepo(p, git = workspace.git) {
  if (!p) return null;
  if (p.repo) return p.repo;
  if (!p.folder) return null;
  const key = `${p.machine ?? ""}${SEP}${tidyPath(p.folder)}`;
  return git?.[key]?.repo ?? key;
}

// Every pin in its own slot: one row per pin, in the order the pins were made,
// which is the order the Pinned section draws. A place whose space is gone keeps
// its line, and the space the place opens takes that line back. `s` is the live
// space, or null for a place with nothing in it right now.
export function pinRows(all = spaces()) {
  const live = new Map(all.map((s) => [s.id, s]));
  // Pins saved before pins had ids name their place by folder, never a space.
  // Only the live place counts; a space made there and used elsewhere is not
  // the place, and handing it the pin would move the pin out of its folder.
  const at = (p) => all.find((s) => (s.machine ?? null) === (p.machine ?? null)
    && norm(place(s) ?? "") === norm(p.folder));
  return pinnedList().map((p) => ({ p, s: (p.id ? (live.get(p.id) ?? null) : (at(p) ?? null)) }));
}

// A pinned space is never closed. The same rule, spelled the same way, in the
// sidebar, the dialogs and here: a pin names its space by id, or — pins saved
// before ids — by the place it was pinned at.
export const isPinned = (s) => Boolean(s?.id) && pinnedList().some((p) => (p.id
  ? p.id === s.id
  : (p.machine ?? null) === (s.machine ?? null) && norm(place(s) ?? s.folder ?? "") === norm(p.folder)));

// Every pin write goes through here, and a shrinking list is said out loud: a
// pin that vanishes without a line in the log came from another mod.
export function writePins(next, why) {
  const before = pinnedList();
  if (next.length < before.length) console.log(`pins ${before.length} -> ${next.length} (${why})`);
  setShared("spaces.pinned", next);
}
export const pinKey = (folder, on) => `${on ?? ""}\u0000${norm(folder ?? "")}`;
// Two reads of the same pin are two objects, so a pin is matched by its id, else
// by the folder and machine it was saved with.
export const samePin = (a, b) => (a?.id && b?.id
  ? a.id === b.id
  : a?.id === b?.id && pinKey(a?.folder, a?.machine) === pinKey(b?.folder, b?.machine));

// The space already showing a checkout, if any. The space's live place is asked
// first, then the folder it was made in: a shell that cd'd out of its worktree is
// still the space standing in it, and opening the checkout again must go there
// rather than start a duplicate.
export function openSpaceFor(path, on, all = spaces(), ps = panes()) {
  const target = norm(path);
  return all.find((s) => (s.machine ?? null) === (on ?? null)
    && (inside(norm(place(s, ps)), target) || inside(norm(s.folder), target)));
}

// Where a new space should start when the focused place is a worktree. A space
// is a place; a worktree is a checkout under its repo, and a second space in
// that checkout is drawn as another worktree row instead of a place. So the new
// space starts in the repo's main checkout. A shell that has cd'd out of the
// checkout keeps Herdr's own default — the folder it is in now — because that is
// the place the person moved to. Null means "leave the default".
export function newSpaceFolder(all = spaces(), ps = panes()) {
  const active = (all ?? []).find((s) => s.active);
  if (!active) return null;
  const rec = spaceRecord(active);
  const panesNow = ps ?? [];
  const at = panesNow.find((p) => p.focused && p.cwd)?.cwd ?? place(active, panesNow);
  if (rec?.isWorktree && rec.main) {
    const root = rec.worktreePath ?? rec.root ?? null;
    if (!root) return null;
    if (!at || !inside(norm(at), norm(root))) return null;
    return { folder: rec.main, machine: active.machine ?? null };
  }
  return null;
}

// What a frame's tree depends on. Both views skip rebuilding it while this stays
// put: an agent changing status, or a character typed into the sheet, does not
// move a checkout. `all` is the space list already in hand, so this does not
// ask the host for another copy.
export function pictureKey(ps, all) {
  const list = all ?? frameCache("spaces", spaces);
  let gone = "";
  for (const r of removingList()) gone += `${r.machine ?? ""}\u0000${tidyPath(r.path)}\u0001`;
  const owner = shared("worktree.owner");
  const own = owner && Date.now() - (owner.at ?? 0) < 2 * 60000 ? (owner.space ?? "") : "";
  let body = `${workspace.rev ?? 0}\u0000${gone}\u0000${own}\u0000`;
  for (const s of list) {
    const at = ps ? place(s, ps) : place(s);
    body += `${s.id}\u0002${s.machine ?? ""}\u0002${s.folder ?? ""}\u0002${at ?? ""}\u0001`;
  }
  return body;
}

// Where every checkout hangs: the one tree both views draw.
//
// A worktree space *is* a checkout, so it is drawn under the space that holds its
// repo, never as a space of its own — and it stays one when its shell cds
// somewhere else. A checkout nobody has opened is drawn there too, so a repo's
// line reads the same before and after opening one.
//
// `gitOf(s)` is the view's git answer for a space ({main, root, linked, branch});
// `trees` every checkout it can see ({path, branch, main, on, repoMain}).
export function worktreeTree(all, gitOf, trees, ps) {
  const keyOf = (t) => `${t.on ?? ""}\u0000${t.path}`;
  const onOf = (s) => s.machine ?? null;
  // One pane snapshot for the whole tree. `place` copies the pane list out of
  // the host when no snapshot is passed, and this walks every space.
  const at = (s) => place(s, ps);
  // A space's checkout: the sticky record first (a shell that `cd`ed out of its
  // worktree is still that checkout's space), then git's answer, then the path
  // itself — a machine still asleep, or the frame right after a checkout was
  // made, has no answer yet and must not read as a plain space in the meantime.
  const checkoutOf = (s) => {
    const rec = spaceRecord(s);
    if (rec) {
      return {
        main: rec.main ? norm(rec.main) : null,
        root: rec.worktreePath ? norm(rec.worktreePath) : (rec.root ? norm(rec.root) : null),
        linked: Boolean(rec.isWorktree),
        branch: rec.branch ?? null,
      };
    }
    const g = gitOf(s);
    if (g?.main) {
      return { main: norm(g.main), root: g.root ? norm(g.root) : null, linked: Boolean(g.linked), branch: g.branch ?? null };
    }
    // A checkout the picture already lists decides before the path guess: that
    // list is where the row under the repo comes from, so a space standing there
    // must be that row, never a space beside it (a checkout outside
    // `<home>/worktrees/<repo>/` had no other way to be recognised).
    const known = knownCheckoutAt(onOf(s), [at(s), s.folder]);
    if (known) {
      return {
        main: known.repoMain ? norm(known.repoMain) : null,
        root: norm(known.path),
        linked: true,
        branch: known.branch ?? null,
      };
    }
    const path = [at(s), s.folder].map(norm)
      .find((p) => /(?:^|\/)worktrees\/[^/]+\/[^/]+\/?$/.test(p)) ?? norm(at(s) ?? s.folder ?? "");
    const m = path.match(/(?:^|\/)worktrees\/([^/]+)\/[^/]+\/?$/);
    return m ? { main: null, root: path, linked: true, branch: null, name: m[1] } : null;
  };
  const checkout = new Map(all.map((s) => [s.id, checkoutOf(s)]));
  const owner = shared("worktree.owner");
  const ownerId = owner && Date.now() - (owner.at ?? 0) < 2 * 60000 ? owner.space : null;
  const folderOf = (s) => at(s) ?? s.folder ?? "";
  // The space that holds a repo: the one a checkout was just made from, else the
  // one named like the repo, else its first space. Never another checkout.
  // Unopened checkouts of one repo share a holder; that lookup is remembered.
  // A worktree skips itself, so that case is not shared.
  const held = new Map();
  const holder = (main, name, on, skip) => {
    const memo = skip == null;
    const memoKey = memo ? `${on ?? ""}\u0000${main ?? ""}\u0000${name ?? ""}` : "";
    if (memo && held.has(memoKey)) return held.get(memoKey);
    const kin = all.filter((p) => p !== skip && (p.machine ?? null) === (on ?? null)
      && !checkout.get(p.id)?.linked
      && (main ? checkout.get(p.id)?.main === main : Boolean(name) && base(folderOf(p)) === name));
    const found = kin.find((p) => p.id === ownerId)
      ?? kin.find((p) => base(folderOf(p)) === (name ?? base(main ?? "")))
      ?? kin[0] ?? null;
    if (memo) held.set(memoKey, found);
    return found;
  };
  const worktrees = new Set();
  const parents = new Map();
  for (const s of all) {
    const c = checkout.get(s.id);
    if (!c?.linked) continue;
    worktrees.add(s.id);
    const p = holder(c.main, c.main ? base(c.main) : c.name, onOf(s), s);
    if (p) parents.set(s.id, p.id);
  }
  // Which checkout paths are already spaces, so none is drawn twice.
  // Both views read this set instead of walking every space per checkout.
  const opened = new Set();
  for (const s of all) {
    const c = checkout.get(s.id);
    if (c?.linked && c.root) opened.add(`${onOf(s) ?? ""}\u0000${c.root.replace(/\/+$/, "")}`);
  }
  const checkoutParents = new Map();
  for (const t of trees) {
    if (t.main) continue;
    const key = keyOf(t);
    if (opened.has(`${t.on ?? ""}\u0000${norm(t.path).replace(/\/+$/, "")}`)) continue;
    const main = norm(t.repoMain ?? "");
    const p = holder(main, base(main), t.on ?? null, null);
    if (p) checkoutParents.set(key, p.id);
  }
  return { worktrees, parents, checkoutParents, keyOf, opened };
}

export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// The one order every view draws places in: pinned places first, in the order
// they were pinned, then what needs you, then done, working and idle. The app's
// own order holds inside a group, so a reorder stays where it landed and a
// status tick only moves a place between groups. `pins` is `pinRows(all)`; an
// orphan pin has no place here. A worktree is a checkout, not a place: callers
// leave worktrees out and draw them under their repo.
export function orderedPlaces(all, pins = []) {
  const pinAt = new Map();
  for (const row of pins ?? []) {
    const id = row?.s?.id ?? row?.id;
    if (id && !pinAt.has(id)) pinAt.set(id, pinAt.size);
  }
  const at = new Map((all ?? []).map((s, i) => [s.id, i]));
  return [...(all ?? [])].sort((a, b) => {
    const ap = pinAt.get(a.id);
    const bp = pinAt.get(b.id);
    if (ap != null || bp != null) {
      if (ap == null) return 1;
      if (bp == null) return -1;
      if (ap !== bp) return ap - bp;
    }
    const ar = RANK[a.status ?? "idle"] ?? RANK.idle;
    const br = RANK[b.status ?? "idle"] ?? RANK.idle;
    return br - ar || (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0);
  });
}

// What both views inherit. Everything here is one rule with two callers: a pin,
// a removal, a worktree, a step, an action on the selected row.
export class Workspace extends View {
  // Called by both inits. The step state lives on the view, never at module
  // scope: two copies (the sidebar block and the open sheet) must not share one
  // held key.
  initShared() {
    // The picture the other copy has already written: repos, checkouts, sticky
    // worktree records and their order. The sheet's first frame draws from it
    // without running git.
    hydrateWorkspace();
    this.reorderHold = null;
    this.reorderId = null;
    this.reorderDir = 0;
    this.reorderSteps = 0;
    this.reorderStepAt = 0;
    this.reorderAim = null;
    this.reorderRaw = null;
    this.reorderRawAt = 0;
    this.reorderIds = null;
    this.reorderAfter = null;
    this.pathHold = null;
    this.pathDir = 0;
    this.pathGroup = null;
    this.pathNow = null;
    this.pathPaths = null;
    this.walkTick = null;
    this.worktreeSpaces ??= new Set();
    this.bindWorkspace();
    this.bindPins();
  }

  // Point this copy at the one picture. The removal job writes `this.trees`,
  // and that has to be the list the sheet draws.
  bindWorkspace() {
    this.git = workspace.git;
    this.gitAt = workspace.gitAt;
    this.trees = workspace.trees;
    this.treesAt = workspace.treesAt;
    this.spacePins = workspace.spacePins;
    this.order = workspace.order;
    this.checkoutById = workspace.checkoutById;
  }

  get treesGen() { return workspace.treesGen; }
  set treesGen(n) { workspace.treesGen = n; }

  noteCreated(path, at) { noteCheckout(path, at); }

  noteTree() { touchWorkspace(); }

  // The pin of exactly this space, by its id: the menu, the refusal to close and
  // the pin toggle all ask about the space in hand. Two spaces can share a folder
  // and both be pinned, so the folder decides nothing here; `bindPins` is what
  // gives a place row's pin to the space a click opens there, by writing its id.
  spacePin(s) {
    if (!s) return null;
    return pinnedList().find((p) => p.id === s.id) ?? null;
  }

  // A pin names a place, and its space id is how it finds that place while the
  // space lives. When the space is gone, the pin waits as a place row: its own
  // row starts a new space there, and only that space takes the pin back. A
  // space another click or a shell made in the same folder is a different place,
  // even when the folder is where it was made — claiming it was how the reel pin
  // became the `~` space and opened from home. Pins saved before pins had ids are
  // given one once, and only to a space actually standing in their folder.
  bindPins(all = spaces()) {
    const list = pinnedList();
    const byId = new Map(all.map((s) => [s.id, s]));
    const held = new Set(list.filter((p) => p.id && byId.has(p.id)).map((p) => p.id));
    // The space a pin's own row just opened (see `openRow`). Fresh for a minute,
    // just long enough for the core to make the space and the next paint to see
    // it; folder and machine name the place, the id names the pin.
    const opening = shared("pin.opening");
    const fresh = opening && Date.now() - (opening.at ?? 0) < 60_000 ? opening : null;
    const openedFor = (p) => Boolean(fresh)
      && norm(fresh.folder ?? "") === norm(p.folder ?? "")
      && (fresh.machine ?? null) === (p.machine ?? null)
      && (fresh.id ? fresh.id === p.id : !p.id);
    // The one space this pin's place holds that no other pin has claimed.
    const claim = (p) => {
      if (!p.folder) return null;
      if (p.id && !openedFor(p)) return null;
      const at = all.filter((s) => !held.has(s.id)
        && (s.machine ?? null) === (p.machine ?? null)
        && norm(place(s) ?? "") === norm(p.folder));
      return at.length === 1 ? at[0] : null;
    };
    let changed = false;
    let usedOpening = false;
    for (const p of list) {
      const here = p.id ? byId.get(p.id) : null;
      // A pin taken before pins kept their repo learns it while the space is
      // still here, so its checkouts can stay listed when the space goes.
      if (here && !p.repo) {
        const gk = spaceRecord(here)?.groupKey;
        if (gk) { p.repo = gk; changed = true; }
      }
      // A rename belongs to the pinned place too: a space the person named is
      // the pin's name once it closes, and clearing the name goes back to the
      // folder. Without this a rename lived only while the space did.
      if (here?.named && (p.name !== here.name || !p.named)) {
        p.name = here.name;
        p.named = true;
        changed = true;
      } else if (here && !here.named && p.named) {
        p.named = false;
        changed = true;
      }
      if (here) continue;
      const opened = openedFor(p);
      const s = claim(p);
      if (!s) continue;
      held.add(s.id);
      p.id = s.id;
      p.name = p.name || s.name;
      changed = true;
      if (opened) usedOpening = true;
    }
    if (usedOpening || (opening && !fresh)) setShared("pin.opening", null);
    if (changed) writePins(list, "gave a pin the place it names");
  }

  // One pin, by id: pinning a space never touches another space in its folder,
  // and unpinning removes exactly that pin. Pins are compared by value, never by
  // object: every read of shared state is a fresh copy. Pins are a toggle.
  setPin(s) {
    if (!s) return;
    // Where the space is now, not the folder it was made in: a space created in
    // one place and used in another is named after the second, and reopening the
    // pin must land there too.
    const folder = place(s) ?? s.folder;
    if (!folder) return;
    const list = pinnedList();
    const mine = this.spacePin(s);
    writePins(mine
      ? list.filter((p) => !samePin(p, mine))
      : [...list, {
        id: s.id, folder, machine: s.machine ?? null, name: s.name, named: Boolean(s.named),
        // The repo and the colour belong to the place, not the space id: they are
        // what its checkouts hang under, and what its avatar wears, while the
        // space is gone.
        repo: spaceRecord(s)?.groupKey ?? groupKeyOf(s) ?? null,
        color: spaceColors()[s.id] ?? null,
      }],
      mine ? `unpinned ${s.name}` : `pinned ${s.name}`);
  }

  unpinPin(p) {
    if (!p) return;
    writePins(pinnedList().filter((x) => !samePin(x, p)), `unpinned the row ${p.name ?? p.folder ?? ""}`);
  }

  // Git for a space, from its live place and from where it was made. A shell
  // that cds out of its worktree must not turn the checkout into a plain space.
  // The sticky record is the answer whenever it exists; the git summaries are
  // only the frame before the first scan, or a space with no record yet.
  spaceGit(s, ps) {
    const rec = checkoutRecordOf(s);
    if (rec) {
      const snap = ps ?? this.paneSnap;
      const at = snap ? place(s, snap) : place(s);
      const live = this.git?.[`${s?.machine ?? ""}${SEP}${tidyPath(at ?? "")}`] ?? null;
      const onCheckout = rec.root && tidyPath(at ?? "") === tidyPath(rec.root);
      return {
        ...(live ?? {}),
        name: rec.main ? base(rec.main) : (live?.name ?? base(rec.root ?? "")),
        branch: rec.branch,
        repo: rec.main ? `${s?.machine ?? ""}${SEP}${rec.main}` : (live?.repo ?? null),
        root: rec.root,
        linked: Boolean(rec.linked),
        ahead: onCheckout ? (live?.ahead ?? 0) : 0,
        behind: onCheckout ? (live?.behind ?? 0) : 0,
      };
    }
    const snap = ps ?? this.paneSnap;
    const at = snap ? place(s, snap) : place(s);
    const probe = (folder) => this.git?.[`${s?.machine ?? ""}${SEP}${tidyPath(folder ?? "")}`];
    const live = probe(at);
    const made = probe(s?.folder);
    if (live?.linked) return live;
    if (made?.linked) return made;
    // git has not answered for this space yet: the checkout the picture lists is
    // still the truth, and it carries the branch the row reads before the scan.
    const known = knownCheckoutAt(s?.machine ?? null, [at, s?.folder]);
    if (known) {
      return {
        name: base(known.repoMain ?? known.path),
        branch: known.branch ?? null,
        repo: known.repoMain ? `${s?.machine ?? ""}${SEP}${known.repoMain}` : null,
        root: known.path,
        linked: true,
        ahead: 0,
        behind: 0,
      };
    }
    if (live !== undefined) return live;
    return made ?? null;
  }

  // A worktree space whose checkout is gone. The sticky record still says
  // worktree, but the repo's checkout list (a successful read, made after this
  // process started) no longer holds its path: git has removed the checkout, so
  // the branch it was for is gone. The stale git summary for the deleted folder
  // says nothing either way — a failed read keeps it on purpose — which is why
  // the checkout list decides. A pin never keeps the row: a removed checkout is
  // not a place to show, pinned or not.
  removedWorktree(s) {
    const rec = spaceRecord(s);
    if (!rec?.isWorktree || !rec.worktreePath) return false;
    const groupKey = rec.groupKey;
    if (!groupKey || !(groupKey in (this.trees ?? {}))) return false;
    // Only a this-session read can call a path gone. A hydrated list is as old
    // as the last start, and a failed read leaves the old list and no `treesAt`.
    if (!(this.treesAt?.[groupKey] > 0)) return false;
    const list = this.trees[groupKey];
    if (!Array.isArray(list)) return false;
    const root = tidyPath(rec.worktreePath);
    return !list.some((c) => tidyPath(c.path) === root);
  }

  // The ids of every live worktree space whose checkout has gone.
  removedWorktrees(all = spaces(), ps = null) {
    const out = new Set();
    for (const s of all) if (this.removedWorktree(s, ps)) out.add(s.id);
    return out;
  }

  // The checkout paths those spaces were made in, for a pin that outlives its
  // space: a removed worktree's pin row goes with the row.
  removedWorktreeRoots(all = spaces(), ps = null) {
    const out = new Set();
    for (const s of all) {
      const rec = spaceRecord(s);
      if (rec?.isWorktree && this.removedWorktree(s, ps)) out.add(tidyPath(rec.worktreePath));
    }
    return out;
  }

  // The pins to draw, minus a pin whose checkout was removed. `all` may already
  // have the removed spaces filtered out (the sheet's list); the sockets are
  // read from the raw spaces, so a pin keeps no line for a checkout that is gone.
  shownPins(all = spaces(), ps = null) {
    const raw = frameCache("spaces", spaces);
    const removed = this.removedWorktrees(raw, ps);
    const roots = this.removedWorktreeRoots(raw, ps);
    return pinRows(all).filter(({ p, s }) => !(s && removed.has(s.id))
      && !(p?.id && removed.has(p.id))
      && !roots.has(tidyPath(p?.folder ?? "")));
  }

  // The checkout a space stands in. The sticky record wins over every path
  // heuristic: it is what keeps a worktree a worktree after its shell `cd`s
  // out of it. The in-memory git answer is the fallback for the first frame, and
  // the listed checkout (the row already drawn under its repo) the frame after
  // a space is made, when git has not answered for its folder yet.
  checkoutRecord(s, ps) {
    const rec = checkoutRecordOf(s);
    if (rec) return rec;
    const g = this.gitCheckout(s, ps);
    if (g) return g;
    const known = knownCheckoutFor(s, ps ?? this.paneSnap);
    return known ? { main: known.repoMain ?? null, root: known.path, linked: true, branch: known.branch ?? null } : null;
  }

  // The git-only answer, used before the first scan and by the scanner.
  gitCheckout(s, ps) {
    if (!s) return null;
    const snap = ps ?? this.paneSnap;
    const at = snap ? place(s, snap) : place(s);
    const rec = (folder) => this.git?.[`${s.machine ?? ""}${SEP}${tidyPath(folder ?? "")}`] ?? null;
    const live = rec(at);
    const made = rec(s.folder);
    const g = live?.linked ? live : made?.linked ? made : live;
    const source = g?.repo ? g : made?.repo ? made : null;
    if (!source) return this.checkoutById?.get(s.id) ?? null;
    const main = source.repo.split(SEP)[1] ?? null;
    const root = source.root ?? null;
    const linked = Boolean(source.linked);
    const branch = source.branch ?? null;
    const prev = this.checkoutById?.get(s.id);
    if (prev && prev.main === main && prev.root === root && prev.linked === linked && prev.branch === branch) return prev;
    const known = { main, root, linked, branch };
    this.checkoutById?.set(s.id, known);
    return known;
  }

  // A worktree space: the sticky record decides; path and git are how a space
  // is recognised before it has one. Once pinned, a `cd` cannot detach it.
  isWorktree(s) {
    if (!s) return false;
    const rec = spaceRecord(s);
    if (rec) return Boolean(rec.isWorktree);
    if (this.worktreeSpaces?.has(s.id)) return true;
    // One place for this space. The frame's pane snapshot, when the view has
    // one, so a row does not ask the host for a fresh pane list.
    // Both where the space is now and where it was made: a worktree is a checkout
    // for good, and its shell wandering off does not make it a space again.
    const here = this.paneSnap ? place(s, this.paneSnap) : place(s);
    if (inWorktrees(here) || inWorktrees(s.folder)) return true;
    // The checkout the picture lists, whatever its folder is called: a worktree
    // made anywhere is a worktree from the frame it is opened, not a tick later.
    if (knownCheckoutAt(s.machine ?? null, [here, s.folder])) return true;
    if (!this.git) return false;
    const on = s.machine ?? "";
    if (this.git[`${on}${SEP}${tidyPath(here ?? "")}`]?.linked) return true;
    if ((here ?? "") !== (s.folder ?? "") && this.git[`${on}${SEP}${tidyPath(s.folder ?? "")}`]?.linked) return true;
    return false;
  }

  // The name a worktree space keeps: its branch, else its checkout folder. A
  // view answers this from its own git read; the default is `s.name`.
  worktreeName(_s) { return null; }

  // What a row is called. A worktree is named by its checkout, never by where its
  // shell happens to be, so cd-ing out of it cannot rename the row.
  spaceName(s) {
    return this.worktreeName(s) ?? s?.name ?? "";
  }

  // The top of a space's family: a worktree's repo, else the space itself. The
  // sheet never puts a checkout at the top of a section — it is its repo's child,
  // so a section that starts from the space in use starts from the top. `all` is
  // the list already in hand, so this asks the host for nothing.
  rootSpace(s, all = spaces()) {
    if (!s || !this.parent) return s;
    let top = s;
    const seen = new Set([s.id]);
    for (let id = this.parent.get(top.id); id && !seen.has(id); id = this.parent.get(top.id)) {
      const p = all.find((x) => x.id === id);
      if (!p) break;
      seen.add(p.id);
      top = p;
    }
    return top;
  }

  // A checkout nobody has opened becomes a space there, named after its branch so
  // Herdr does not rename it the moment the shell changes directory.
  openCheckout(r) {
    if (!r?.path) return;
    const existing = openSpaceFor(r.path, r.on ?? null);
    if (existing) return this.openSpace(existing);
    const name = r.c?.branch ?? r.branch ?? base(r.path);
    // "" is this computer. Omitting machine follows whichever space is focused,
    // so a local checkout opened from a remote space would land on that machine.
    run("space.new", { folder: r.path, name, machine: r.on ?? "" });
  }

  // Opening a space with no terminal anywhere — no tabs, or only mod panes —
  // starts a shell there, so a pinned space whose terminal is gone still lands
  // you somewhere to type. It starts in the space's place, never in the machine's
  // home: a space made in `reel` whose pane has wandered must come back to
  // `reel`, not open `~` and rename the place after it.
  openSpace(s) {
    const cur = spaces().find((x) => x.id === s.id) ?? s;
    run("space.select", { id: cur.id });
    const tabs = new Set((cur.tabs ?? []).map((t) => t.id));
    if (!panes().some((p) => p.terminal && tabs.has(p.tab))) {
      const pin = this.spacePin(cur);
      run("tab.new", { space: cur.id, folder: pin?.folder ?? place(cur) ?? cur.folder });
    }
  }

  // New space: a place, never a second checkout of the same repo. From a
  // worktree it belongs in the repo's main checkout; a space actually standing
  // there is gone to instead of opening a second one in that folder. Anywhere
  // else Herdr's own default — the focused terminal's folder — is already the
  // place the person is working. True means a space was made; false means an
  // existing place was opened.
  newSpace() {
    const all = spaces();
    const ps = panes();
    const next = newSpaceFolder(all, ps);
    if (!next) { run("space.new"); return true; }
    const at = all.find((s) => (s.machine ?? null) === (next.machine ?? null)
      && !spaceRecord(s)?.isWorktree
      && norm(place(s, ps) ?? "") === norm(next.folder));
    if (at) { this.openSpace(at); return false; }
    run("space.new", { folder: next.folder, machine: next.machine ?? "" });
    return true;
  }

  // Hand a pin to the space actually standing in its place (the pin row found
  // it there), without touching another pin's space. This is the one path that
  // binds a pin to a space it did not open itself.
  bindPin(p, s) {
    if (!p || !s?.id) return false;
    const list = pinnedList();
    const i = list.findIndex((x) => (p.id ? x.id === p.id : samePin(x, p)));
    if (i < 0 || list[i].id === s.id) return false;
    const next = [...list];
    next[i] = { ...next[i], id: s.id, name: next[i].name || s.name };
    if (s.named) {
      next[i].name = s.name;
      next[i].named = true;
    }
    writePins(next, `bound ${next[i].name ?? p.folder} to the space in its folder`);
    return true;
  }

  // An agent's own pane when it has one (the listed agent wins over a stale row),
  // else the terminal address, else a peek: one rule for a click and for Enter.
  focusAgent(a) {
    if (!a) return;
    const listed = agents().find((x) => x.address === a.address);
    if (listed?.pane) return run("pane.focus", { pane: listed.pane });
    if (a.pane) return run("pane.focus", { pane: a.pane });
    run("terminal.peek", { terminal: a.address });
  }

  // The space a row belongs to: a space row is itself, an agent row the space it
  // runs in. A checkout owns none.
  spaceOfRow(r) {
    if (r?.kind === "space") return r.s ?? null;
    if (r?.kind === "agent") return spaces().find((x) => x.id === r.a?.space) ?? null;
    return null;
  }

  // How a view opens a dialog. The sidebar adds its own flag so it can take the
  // keyboard back when the dialog closes; an overlay over the sheet does not
  // need that. Both views call this, so every action asks in the same place.
  openDialog(opts) {
    openOverlay(opts);
  }

  // Hooks the views answer differently: the sheet closes before it acts; the
  // sidebar drops keyboard mode after, without pulling focus back to a pane.
  beforeOpen() {}
  afterOpen() {}
  beforeRename() {}
  beforeWorktree() {}

  // Enter on a row, and a click on it: one implementation for both views.
  openRow(r, cx) {
    if (!r) return;
    this.beforeOpen(cx);
    if (r.kind === "space") {
      this.openSpace(r.s);
    } else if (r.kind === "pin") {
      const p = r.pin;
      // The pin's own space first, by id. A pin keeps the space it was pinned
      // from: its shell may `cd` out of the folder, and the folder may hold no
      // space of its own, but the row still means that space. Looking the
      // folder up instead found another space — or none, and opened a duplicate
      // in a place that already had one.
      const own = p.id ? spaces().find((x) => x.id === p.id) : null;
      // A place with no space of its own: another space actually standing in
      // that folder is that place. Go to it and give the pin to it, so one place
      // has one row. A space merely made in the folder but working elsewhere is
      // not there (`spaceAt` reads the live place, never the made-in folder).
      const existing = own ? null : spaceAt(p.folder, p.machine ?? null);
      if (own) {
        setShared("pin.opening", null);
        this.openSpace(own);
      } else if (existing) {
        setShared("pin.opening", null);
        if (!this.spacePin(existing)) this.bindPin(p, existing);
        this.openSpace(existing);
        notify({
          title: "That folder already has a space",
          body: `${existing.name} is open there. Went to it instead of opening a second one.`,
          level: "warning",
        });
      } else {
        // The row starts the space it promises. The marker gives that space the
        // pin when it appears; no later space made in the folder can take it.
        setShared("pin.opening", {
          id: p.id ?? null, folder: p.folder, machine: p.machine ?? null, at: Date.now(),
        });
        run("space.new", { folder: p.folder, ...(p.named ? { name: p.name } : {}), machine: p.machine ?? "" });
      }
    } else if (r.kind === "checkout") {
      this.openCheckout(r);
    } else if (r.kind === "agent") {
      this.focusAgent(r.a);
    }
    this.afterOpen(cx);
  }

  // Ctrl+D on an agent: never silent, and never on a sub-agent, which its parent
  // is waiting for. The dialog says what is lost; Enter stops, Esc keeps it.
  askStop(a) {
    if (!a) return;
    if (a.parent) return notify({ title: "A sub-agent ends with its parent", body: `${a.title || a.program?.name || a.address} reports to ${a.parent}.` });
    // The same dialog that asks about a space or a worktree; Esc leaves it.
    this.openDialog({ mod: "worktrees", kind: "dialog", width: 440, height: 156, props: { agent: a.address } });
  }

  // Ctrl+D on the selected row: close a space, remove a checkout, stop an agent,
  // or take a pin away. One rule for both views.
  closeRow(r) {
    if (!r) return;
    if (r.kind === "agent") return this.askStop(r.a);
    if (r.kind === "pin") return this.unpinPin(r.pin);
    if (r.kind === "checkout") {
      return this.openDialog({ mod: "worktrees", kind: "dialog", width: 440, height: 155,
        props: { folder: r.path, machine: r.on ?? null, action: "remove" } });
    }
    if (r.kind !== "space") return;
    const s = r.s;
    const tree = this.isWorktree(s);
    // A pinned space is never closed, and the view says so rather than opening a
    // dialog that could only refuse. A worktree's space is a checkout: removing
    // it stays on offer, pinned or not.
    if (!tree && isPinned(s)) return notify({
      title: "Pinned space",
      body: `${s.name} stays: pinned spaces are never closed. Unpin it (Ctrl+P), then close it.`,
    });
    // A worktree's checkout is the folder it was made in, not necessarily where
    // its shell is now: a `cd` out of the checkout must not point the removal at
    // some other repo (the dialog would then only say "not a worktree"). The
    // sticky record knows the checkout even after that `cd`.
    const rec = checkoutRecordOf(s);
    const folder = tree ? (rec?.root ?? (inWorktrees(s.folder) ? s.folder : (place(s) ?? s.folder))) : null;
    this.openDialog({ mod: "worktrees", kind: "dialog", width: 440, height: tree ? 155 : 150,
      props: { space: s.id, ...(folder ? { folder } : {}), action: tree ? "remove" : "space" } });
  }

  // Ctrl+P on the selected row.
  pinRow(r) {
    if (!r) return;
    if (r.kind === "pin") return this.unpinPin(r.pin);
    if (r.kind === "agent") return this.setPin(this.spaceOfRow(r));
    if (r.kind !== "space") return;
    // A pin belongs to a space; a worktree is a checkout under its repo.
    if (this.isWorktree(r.s)) return notify({
      title: "A worktree is not pinned",
      body: `${r.s.name} lives under its repo. Pins belong to spaces.`,
    });
    this.setPin(r.s);
  }

  // Ctrl+A on the selected row: a worktree of the row — its checkout if the row
  // is one, else the repo of the space it belongs to (an agent row works on its
  // space).
  worktreeRow(r) {
    if (!r) return;
    if (r.kind === "checkout") {
      return this.openDialog({ mod: "worktrees", kind: "dialog", width: 460, height: 170,
        props: { folder: r.path, machine: r.on ?? null, action: "new" } });
    }
    const s = this.spaceOfRow(r);
    if (!s) return;
    this.beforeWorktree(s);
    // The repo's own checkout, not wherever a wandering shell stands: a worktree
    // is made from the repo the space belongs to.
    const folder = checkoutRecordOf(s)?.root ?? place(s) ?? s.folder;
    this.openDialog({ mod: "worktrees", kind: "dialog", width: 460, height: 170,
      props: { space: s.id, folder, action: "new" } });
  }

  // Ctrl+R on the selected row: the app's own prompt, as the menu's Rename.
  renameRow(r) {
    if (r?.kind !== "space" || !r.s?.id) return;
    this.beforeRename();
    run("space.rename", { id: r.s.id });
  }

  // The find sheet's map, key for key, used by both views: walking with
  // Ctrl+J/K, reordering with Ctrl+Shift+J/K, pinning with Ctrl+P, renaming with
  // Ctrl+R, closing or removing with Ctrl+D, a worktree with Ctrl+A. Shift is
  // read before plain Ctrl — the other order makes the reorder keys unreachable.
  chord(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    if (!m.control) return false;
    if (m.shift && (k === "j" || k === "k")) {
      // The OS key repeat is ignored: `startReorder` repeats the step itself, so
      // there is one source of steps. Counting both made a held key move two
      // rows per repeat and fight its own aim.
      if (!e.is_held) this.beginReorder(k === "j" ? 1 : -1, cx);
      return true;
    }
    // Only Ctrl+Shift+J/K belong to the list. Other shifted chords are the
    // app's (`ctrl-shift-p` palette, `ctrl-shift-d` new worktree), and taking
    // them here meant they stopped working whenever the panel had the keyboard.
    if (m.shift) return false;
    if (k === "j" || k === "k") {
      this.walk(k === "j" ? 1 : -1, cx);
      return true;
    }
    if (k === "p") { this.pinRow(this.selectedRow()); return true; }
    if (k === "r") { this.renameRow(this.selectedRow()); return true; }
    if (k === "d") { this.closeRow(this.selectedRow()); return true; }
    if (k === "a") { this.worktreeRow(this.selectedRow()); return true; }
    return false;
  }

  // One step of a reorder, and the held repeat that follows it. The scope (which
  // spaces are being stepped through) is the caller's: the sheet steps through
  // every space, the sidebar only through the section under the selected row.
  startReorder(s, dir, opts, cx) {
    if (!s || !dir) return;
    this.stopReorder();
    this.reorderId = s.id;
    this.reorderDir = dir;
    this.reorderSteps = 0;
    this.reorderIds = opts.ids;
    this.reorderAfter = opts.after ?? null;
    this.reorderStep(s, dir);
    // Holding the key repeats the step here, not through the OS key repeat: the
    // repeat events are ignored (see `chord`), so there is exactly one source of
    // steps and the speed is the same on every desktop.
    this.reorderHold = cx?.timer.after(320, (cx2) => {
      this.reorderHold = cx2.timer.every(90, (cx3) => {
        const live = spaces().find((x) => x.id === this.reorderId);
        if (!live || ++this.reorderSteps > 600) return this.stopReorder();
        this.reorderStep(live, this.reorderDir);
        cx3.notify();
      });
    }) ?? null;
  }

  // The raw order the app will have once the moves already sent have landed.
  //
  // `space.move` is asynchronous, and a held key asks for the next step before
  // the last one landed: `spaces()` then still returns the order from *before*
  // it. The index read from that stale order is applied by the app to its newer
  // order, which is how one press used to swap two spaces instead of moving one.
  // So each step is computed against this prediction and the prediction is
  // advanced by the same move, in the order the app receives them.
  predictedSpaces() {
    const live = spaces();
    const byId = new Map(live.map((s) => [s.id, s]));
    const ids = live.map((s) => s.id);
    const raw = this.reorderRaw;
    const usable = Array.isArray(raw)
      && raw.length === ids.length
      && raw.every((id) => byId.has(id))
      && Date.now() - (this.reorderRawAt ?? 0) < 2000;
    if (!usable) {
      this.reorderRaw = ids.slice();
      this.reorderRawAt = Date.now();
    }
    return (this.reorderRaw ?? ids).map((id) => byId.get(id)).filter(Boolean);
  }

  // Fold the move just asked for into the prediction: `index` is the 1-based
  // final position inside that machine's block, which is what `space.move` takes.
  noteSpaceMove(list, machine, id, index) {
    const block = list.filter((s) => (s.machine ?? null) === (machine ?? null));
    const held = block.find((s) => s.id === id);
    if (!held) return;
    const rest = block.filter((s) => s.id !== id);
    rest.splice(Math.max(0, Math.min(rest.length, index - 1)), 0, held);
    let i = 0;
    this.reorderRaw = list.map((s) => ((s.machine ?? null) === (machine ?? null) ? (rest[i++]?.id ?? s.id) : s.id));
    this.reorderRawAt = Date.now();
  }

  // The order the steps are aiming at: the drawn, visual order (worktrees are
  // never stepped through; they belong to their parent). A move lands
  // asynchronously, so two presses close together would read the same list
  // twice, aim at the same neighbour and the second would do nothing. Read the
  // aim while it still describes the live set of spaces.
  aimedReorder() {
    const live = this.reorderIds?.(this.predictedSpaces()) ?? [];
    const ids = this.reorderAim;
    // Only while a step may still be landing: an order changed from anywhere else
    // is read from the app, not remembered.
    const fresh = Date.now() - (this.reorderStepAt ?? 0) < 2000;
    return fresh && Array.isArray(ids) && ids.length === live.length && ids.every((id) => live.includes(id)) ? ids : live;
  }

  // Put `s` where `target` is, in `ids`. Pinned spaces read above the rest in
  // the sheet, so landing on the other side of that line is a pin or an unpin:
  // never a drop that does nothing. Returns the space's place in the aim, 1-based.
  landReorder(s, target, ids, dir = 0) {
    if (!s || !target || s.id === target.id) return null;
    // `space.move` is scoped to one machine's block; a drop onto another
    // machine is not a move, and there is no index to give it.
    if ((s.machine ?? null) !== (target.machine ?? null)) return null;
    const list = this.predictedSpaces();
    const at = machineIndexOf(list, s.machine ?? null, target.id);
    if (at == null) return null;
    const rest = ids.filter((id) => id !== s.id);
    const ti = rest.indexOf(target.id);
    if (ti < 0) return null;
    const cut = ti + (dir > 0 ? 1 : 0);
    this.reorderAim = [...rest.slice(0, cut), s.id, ...rest.slice(cut)];
    this.landBefore(s, target);
    // The Pinned section reads the pin list, so a move inside it has to move the
    // pin too: `space.move` alone would reorder Herdr's spaces and leave the row
    // drawn where it was.
    this.movePinRow(s, target, dir);
    // The drop row maps back to the *machine-scoped* position, never the raw
    // index in spaces(): the sidebar draws sections, filter, and nested rows.
    run("space.move", { id: s.id, index: at });
    this.noteSpaceMove(list, s.machine ?? null, s.id, at);
    return this.reorderAim.indexOf(s.id) + 1;
  }

  // The sheet toggles a pin when a step crosses the pinned line; the sidebar's
  // sections already keep pins apart, so it does nothing. One hook, overridden.
  landBefore() {}

  // A pin keeps the slot it was given, and both views draw the Pinned section
  // from the pin list, so a move between two pins moves the pin. Moving by value
  // (`samePin`), never by index: `landBefore` may just have written a pin.
  movePinRow(s, target, dir) {
    const mine = this.spacePin(s);
    const theirs = this.spacePin(target);
    if (!mine || !theirs) return false;
    const list = pinnedList();
    const at = list.findIndex((p) => samePin(p, mine));
    if (at < 0) return false;
    const [held] = list.splice(at, 1);
    const to = list.findIndex((p) => samePin(p, theirs));
    if (to < 0) { list.splice(at, 0, held); return false; }
    list.splice(to + (dir > 0 ? 1 : 0), 0, held);
    writePins(list, `moved ${s.name ?? s.id}`);
    return true;
  }

  reorderStep(s, dir) {
    if (!s || !dir || !this.reorderIds) return;
    // Read the aim before stamping this step: aimedReorder asks how long ago the
    // LAST one was.
    const list = this.predictedSpaces();
    const ids = this.aimedReorder();
    this.reorderStepAt = Date.now();
    const at = ids.indexOf(s.id);
    const target = at < 0 ? null : list.find((x) => x.id === ids[at + dir]) ?? null;
    // The end of the order: not a wrap, and nothing to say.
    if (!target) return;
    const step = this.landReorder(s, target, ids, dir);
    if (step) this.reorderAfter?.(s, step, ids.length);
  }

  // One step of a worktree reorder, and the held repeat. Worktrees are not
  // spaces: Herdr has no order for checkouts, so the step writes the persisted
  // per-repo order both views draw (`workspace.order`), never `space.move`.
  startPathReorder(groupKey, path, paths, dir, cx, after) {
    if (!groupKey || !path || !dir || !paths || paths.length < 2) return;
    this.stopReorder();
    this.pathDir = dir;
    this.pathGroup = groupKey;
    this.pathNow = tidyPath(path);
    this.pathPaths = paths.map(tidyPath);
    this.pathAfter = after ?? null;
    const step = () => {
      const list = this.pathPaths;
      const at = list.indexOf(this.pathNow);
      const target = at < 0 ? null : list[at + dir];
      if (!target) return false;
      const next = movePathWithin(this.pathGroup, list, this.pathNow, target, dir);
      if (!next) return false;
      this.pathPaths = next;
      this.pathStepAt = Date.now();
      this.pathAfter?.(this.pathNow, next.indexOf(this.pathNow) + 1, next.length);
      touchWorkspace();
      persistWorkspace();
      return true;
    };
    if (!step()) return;
    this.pathHold = cx.timer.after(300, (cx2) => {
      this.pathHold = cx2.timer.every(70, (cx3) => {
        if (!step()) return this.stopReorder();
        cx3.notify();
      });
    });
    cx.notify();
  }

  // The worktree rows of a repo in the order drawn: opened checkouts and
  // unopened ones in one list, whichever the step is on.
  pathSiblings(groupKey, all, checkoutList) {
    return worktreeSiblings(groupKey, all, checkoutList).map((x) => x.path);
  }

  stopReorder() {
    this.reorderHold?.cancel();
    this.reorderHold = null;
    this.pathHold?.cancel();
    this.pathHold = null;
    this.pathDir = 0;
    this.reorderDir = 0;
    // `reorderId` and `pathNow` stay behind on purpose: a press that lands
    // before the next paint still has to move the row this reorder is about,
    // not whatever row its old index points at now. `reorderSubject` and
    // `pathSubject` time them out.
  }

  // The space the keys are still reordering, if the last step was a moment ago.
  reorderSubject() {
    if (!this.reorderId) return null;
    if (Date.now() - (this.reorderStepAt ?? 0) > 900) return null;
    return spaces().find((x) => x.id === this.reorderId) ?? null;
  }

  // The checkout path the keys are still reordering, under the same rule.
  pathSubject() {
    if (!this.pathNow) return null;
    if (Date.now() - (this.pathStepAt ?? 0) > 900) return null;
    return this.pathNow;
  }

  // Ctrl+J/K are the app's keys (the sidebar's dir commands), so a view with the
  // keyboard cannot see them. The sidebar hands the walk over through a shared
  // value. That write already repaints this view: the highlight moves in that
  // paint. A timer used to notice the write up to 70ms later, and dropped
  // repeats that landed in the same gap.
  watchWalk(cx, on, channel) {
    this.walkTick?.cancel();
    this.walkTick = null;
    this.walkOn = Boolean(on);
    if (!on) return;
    this.walkChannel = channel;
    // A count left from the last session is not a jump waiting to happen.
    if (this.walkMark == null) this.walkMark = shared(channel) ?? "";
    // The hand-off is a shared write from the sidebar. A copy of a mod is
    // its own view: another copy's write does not repaint this one, so without
    // this the key moved nothing until some unrelated timer happened to paint.
    // Poll the one small string; ask for a paint only when it changed, and the
    // paint's `pendingSteps` consumes it.
    this.walkSeen = this.walkMark;
    this.walkTick = cx.timer.every(60, (cx2) => {
      const now = shared(channel) ?? "";
      if (now === this.walkSeen) return;
      this.walkSeen = now;
      cx2.notify();
    });
  }

  // How many steps the handed-back walk gained since this view last drew it.
  // Positive is down. Zero when nothing new arrived. Taken once per paint.
  pendingSteps() {
    if (!this.walkOn || !this.walkChannel) return 0;
    const m = shared(this.walkChannel);
    if (m == null || m === this.walkMark) return 0;
    const read = (s) => {
      const text = String(s ?? "");
      const i = text.lastIndexOf(":");
      const n = i < 0 ? 0 : Number(text.slice(i + 1));
      return { dir: i < 0 ? text : text.slice(0, i), n: Number.isFinite(n) ? n : 0 };
    };
    const prev = read(this.walkMark);
    const next = read(m);
    this.walkMark = m;
    // The poll below must not repaint for a step this paint already consumed.
    this.walkSeen = m;
    let count = next.n - prev.n;
    // The sidebar's counter starts at zero each launch, so the first step after
    // a restart is a lower number, not a leap back through the old count.
    if (count <= 0 || count > 40) count = 1;
    return next.dir === "up" ? -count : count;
  }
}
