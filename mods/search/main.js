// Spaces, worktrees and agents in one keyboard-driven search sheet.
// Opened with Alt+F (mod.open:search). Type to filter, ↑/↓, Enter,
// Esc; Ctrl+R rename, Ctrl+D close, Ctrl+Shift+J/K move the highlighted space.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, closeOverlay, props, theme, settings, shared, setShared, exec, keys, home, notify } from "herdr";

// The sidebar's avatar colours, so a space looks the same in both places.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

// A theme colour with alpha, so every tint follows the theme's own light and dark.
const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

// A program's tile keeps its own colour, drawn solid: washed over the theme
// background it would look different in every theme, and a program's mark should
// not. Its glyph takes the program's colour, or whichever of black and white the
// tile can carry.
const tileOf = (p) => (p?.tile && /^#[0-9a-fA-F]{6}$/.test(p.tile) ? p.tile : null);
const inkOf = (p) => {
  if (p?.color) return p.color;
  const tile = tileOf(p);
  if (!tile) return null;
  const n = parseInt(tile.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#121212" : "#ffffff";
};
// The theme has no letter-spacing: a thin space between the characters is what
// makes 9px caps read as a heading instead of as small text.
const spaced = (s) => [...String(s)].join("\u2009");

// A small keyboard cap, so shortcuts read as keys rather than as prose.
const keycap = (t, label, tone = t.muted) => div().flex_none().h(18).px(5).rounded(4)
  .bg(wash(t.foreground, "10")).border(1).border_color(wash(t.foreground, "1c"))
  .text_size(9.5).font_medium().text_color(tone).flex().items_center().child(label);

// The query, drawn where it lands. A match keeps the row's colour and takes the
// weight; the rest steps back. Only on a short label: a long one is truncated,
// and pieces cannot ellipsize as one line.
const marks = (text, terms) => {
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

// Space colors, kept by space id in shared "space.colors" (same rule as the other mods).
function spaceColors() {
  const ids = new Set(spaces().map((p) => p.id));
  const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
  for (const p of spaces()) {
    if (kept[p.id] || p.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[p.id] = PROJECT_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}
function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
  const c = spaceColors()[p.id] ?? PROJECT_COLORS[0];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

// The key bound to a command, for an action row ("ctrl-shift-n" -> "Ctrl+Shift+N").
function shortcutOf(command) {
  // The shortest binding: a command on both Ctrl+N and Ctrl+Shift+N reads as
  // Ctrl+N, the key people reach for.
  const fewest = (a, b) => a.keys.split("-").length - b.keys.split("-").length;
  const all = keys().filter((b) => b.action === command).sort(fewest);
  const binding = all.find((b) => b.section !== "terminal") ?? all[0];
  if (!binding) return "";
  return binding.keys.split("-").map((part) => {
    const word = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: "Cmd", super: "Super" }[part];
    return word ?? (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1));
  }).join("+");
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// The space already standing in a folder — the same place, not one of its
// subfolders. A pin is a place, so this is what says "there is a space here".
function spaceAt(folder, on, all = spaces(), ps = panes()) {
  const f = norm(folder);
  if (!f) return null;
  // Either where a terminal is now or the folder the space was made in: a space
  // whose shell has cd'd somewhere else still stands in its own folder.
  return all.find((s) => (s.machine ?? null) === (on ?? null)
    && (norm(place(s, ps) ?? "") === f || norm(s.folder ?? "") === f)) ?? null;
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The repo a folder belongs to: main checkout, name, and whether this is a linked worktree.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

// Every checkout of a repo, the main one first, then most recently committed.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
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

const norm = (p) => (p ?? "").replace(/\\/g, "/");
const base = (p) => norm(p).replace(/\/+$/, "").split("/").pop() ?? "";

// A pin with no live space opens a new space in its folder, and Herdr names a
// space after the folder it starts in. So a pin row must read the name the click
// will give it, never the name the space had while it was open somewhere else:
// "reel" opening as "herdr-app" is a row that lied. A pin somebody named keeps
// that name, because opening it asks for the name too.
const pinLabel = (p) => (p?.named && p.name ? p.name : base(p?.folder));
const inside = (p, dir) => p === dir || p.startsWith(dir.replace(/\/+$/, "") + "/");

// The colour a saved space keeps while it has no terminals: from its folder,
// so the same pin reads the same across restarts.
function folderColor(folder) {
  let h = 0;
  for (const ch of norm(folder)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PROJECT_COLORS[h % PROJECT_COLORS.length];
}

// Pinned spaces: the id is what a pin belongs to, the folder is what lets it
// still open a shell once its space is gone. A pin is never dropped for missing
// a field (that would lose it on the next write): an id alone is enough.
function pinnedList() {
  const list = shared("spaces.pinned");
  return Array.isArray(list) ? list.filter((p) => p && (p.id || p.folder)) : [];
}

// A pinned space is never closed. The same rule, spelled the same way, in the
// sidebar, the dialogs and here: a pin names its space by id, or — pins saved
// before ids — by the place it was pinned at.
const isPinned = (s) => Boolean(s?.id) && pinnedList().some((p) => (p.id
  ? p.id === s.id
  : (p.machine ?? null) === (s.machine ?? null) && norm(place(s) ?? s.folder ?? "") === norm(p.folder)));

// Every pin write goes through here, and a shrinking list is said out loud: a
// pin that vanishes without a line in the log came from another mod.
function writePins(next, why) {
  const before = pinnedList();
  if (next.length < before.length) console.log(`palette: pins ${before.length} -> ${next.length} (${why})`);
  setShared("spaces.pinned", next);
}
const pinKey = (folder, on) => `${on ?? ""}\u0000${norm(folder ?? "")}`;
// Two reads of the same pin are two objects, so a pin is matched by its id, else
// by the folder and machine it was saved with.
const samePin = (a, b) => (a?.id && b?.id
  ? a.id === b.id
  : a?.id === b?.id && pinKey(a?.folder, a?.machine) === pinKey(b?.folder, b?.machine));

// The space already showing a checkout, if any.
function openSpaceFor(path, on, all = spaces(), ps = panes()) {
  const target = norm(path);
  return all.find((s) => (s.machine ?? null) === (on ?? null) && inside(norm(place(s, ps)), target));
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// Worktree spaces are found by running git, which is fast but not instant. Keep
// the last answer per space so the first frame of a new open already shows the
// branch icon instead of flashing the space avatar.
const CACHE_KEY = "search.worktrees";
// The branch must not be part of the key: a checkout's branch can move while the
// answer ("this is a worktree") stays true, and a miss is a visible flicker.
const cacheKey = (s) => `${s.id}\u0000${norm(s.folder ?? "")}`;
// Herdr's own worktrees live under <home>/.herdr/worktrees/<repo>/<branch>, which
// says "worktree" without waiting for git: the first frame of the panel is
// already right, instead of drawing a space avatar and swapping it out.
const worktreePath = (folder) => norm(folder).startsWith(`${norm(home())}/.herdr/worktrees/`);
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}"); } catch { return {}; }
}

export default class Palette extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = null;
    this.scroll = 0;
    this.repos = [];
    this.worktrees = [];
    this.worktreeSpaces = new Set();
    this.parent = new Map();
    this.checkoutParent = new Map();
    const cached = readCache();
    for (const s of spaces()) {
      const hit = cached[cacheKey(s)];
      if (!hit?.worktree) continue;
      this.worktreeSpaces.add(s.id);
      if (hit.parent) this.parent.set(s.id, hit.parent);
    }
    this.loaded = false;
    this.pressed = null; // the space row held by the mouse
    this.over = null;    // the space row it would land on
    this.hold = null;    // the repeat while Ctrl+Shift+J/K is held
    this.holdId = null;
    this.holdDir = 0;
    this.stepAt = 0;     // when the last step happened
    this.aim = null;     // the order the steps are aiming at
    this.note = null;    // the footer's word about the last step
    this.active = spaces().find((s) => s.active) ?? null;
    this.folder = place(this.active);
    this.on = this.active?.machine ?? null;
    this.bindPins();
    // The search text is ours: a text field would take Ctrl+A (select all) and
    // Ctrl+A has to reach the palette (a worktree of the highlighted row).
    this.filter = "";
    setShared("search.open", true);
    // Ctrl+J/K are taken by the app keymap, so icons hands them here.
    let moved = shared("search.move");
    cx.timer.every(70, (cx) => {
      const m = shared("search.move");
      if (!m || m === moved) return;
      moved = m;
      const n = this.pickable().length;
      if (!n) return;
      // Walking the list takes the highlight back from a space just moved,
      // and ends any reorder still repeating.
      this.stopMove();
      this.follow = null;
      this.at = ((this.at ?? 0) + (String(m).startsWith("down") ? 1 : n - 1)) % n;
      cx.notify();
    });
    this.handle = cx.focus_handle();
    // The overlay's first frame lays the palette out, and focus can only land
    // after it — and one attempt does not always take. Ask again until it does:
    // a sheet that opens without the keyboard sends every keystroke to the
    // terminal behind it, which is how "my keys do nothing" starts. Asking stops
    // the first time focus is granted, so a dialog opened from here keeps its own.
    const grab = (cx) => {
      if (this.handle?.is_focused?.()) { this.everFocused = true; return; }
      this.handle?.focus();
      cx.notify();
    };
    cx.timer.after(80, grab);
    let tries = 0;
    cx.timer.every(200, (cx) => {
      if (this.everFocused || ++tries > 20) return;
      grab(cx);
    });
    // A dialog opened from here takes the keyboard; when it closes, take it back.
    let closed = shared("overlay.closed");
    cx.timer.every(250, (cx) => {
      const now = shared("overlay.closed");
      if (now !== closed) { closed = now; this.handle.focus(); this.load(cx); cx.notify(); }
    });
    this.load(cx);
  }

  // Worktrees and the space tree, read again whenever the spaces change.
  load(cx) {
    if (!this.folder) { this.loaded = true; return; }
    const keep = this.at === null ? null : this.rowKey(this.selected());
    cx.spawn(async (cx) => {
      try {
        // Worktrees for every repo the spaces live in, not only the active one.
        // Both the live terminal folder and the space's start folder count.
        const seen = new Set(), places = [];
        for (const s of spaces()) {
          for (const folder of [place(s), s.folder]) {
            const on = s.machine ?? null, key = `${on ?? ""}\u0000${folder ?? ""}`;
            if (!folder || seen.has(key)) continue;
            seen.add(key); places.push({ folder, on });
          }
        }
        const repoSeen = new Set(), repos = [];
        await Promise.all(places.map(async (p) => {
          try {
            const repo = await repoOf(p.folder, p.on);
            if (!repo) return;
            const key = `${p.on ?? ""}\u0000${repo.main}`;
            if (repoSeen.has(key)) return;
            repoSeen.add(key); repos.push({ repo, on: p.on });
          } catch {}
        }));
        const worktrees = [];
        await Promise.all(repos.map(async (r) => {
          try { for (const c of await checkouts(r.repo, r.on)) worktrees.push({ c, repo: r.repo, on: r.on }); }
          catch {}
        }));
        // Build the new tree privately, then swap it in one go: resetting the
        // live maps first makes rows flicker from space icon to branch icon.
        const nextWorktrees = worktrees.filter((w) => w.c.main || !openSpaceFor(w.c.path, w.on));
        const nextParent = new Map();
        const nextCheckoutParent = new Map();
        const nextSpaces = new Set();
        const mine = [this.folder, this.active?.folder].filter(Boolean).map(norm);
        const nextRepo = repos.find((r) => (r.on ?? null) === (this.on ?? null)
          && mine.some((f) => inside(f, norm(r.repo.main)) || inside(norm(r.repo.main), f)))?.repo ?? null;
        // Tree: worktree spaces and unopened checkouts sit under their repo's space.
        const info = spaces().map((s) => {
          const folder = norm(place(s) ?? s.folder ?? ""), on = s.machine ?? null;
          let best = null;
          for (const w of worktrees) {
            if ((w.on ?? null) !== on) continue;
            const p = norm(w.c.path);
            if (inside(folder, p) && (!best || p.length > norm(best.c.path).length)) best = w;
          }
          return { s, folder, on, best };
        });
        for (const x of info) {
          if (!x.best || x.best.c.main) continue;
          nextSpaces.add(x.s.id);
          const main = norm(x.best.repo.main);
          const parent = info.find((y) => y.s !== x.s && (y.on ?? null) === (x.on ?? null)
            && inside(y.folder, main) && !(y.best && !y.best.c.main));
          if (parent) nextParent.set(x.s.id, parent.s.id);
        }
        const keyOf = (w) => `${w.on ?? ""}\u0000${w.c.path}`;
        for (const w of worktrees) {
          if (w.c.main || openSpaceFor(w.c.path, w.on)) continue;
          const main = norm(w.repo.main);
          const parent = info.find((y) => (y.on ?? null) === (w.on ?? null) && inside(y.folder, main) && !(y.best && !y.best.c.main))
            ?? info.find((y) => (y.on ?? null) === (w.on ?? null) && y.s.name === w.repo.name && !(y.best && !y.best.c.main));
          if (parent) nextCheckoutParent.set(keyOf(w), parent.s.id);
        }
        this.repos = repos;
        this.worktrees = nextWorktrees;
        this.repo = nextRepo;
        this.worktreeSpaces = nextSpaces;
        this.parent = nextParent;
        this.checkoutParent = nextCheckoutParent;
        const cache = {};
        for (const s of spaces()) {
          if (!nextSpaces.has(s.id)) continue;
          cache[cacheKey(s)] = { worktree: true, parent: nextParent.get(s.id) ?? null };
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      } catch {}
      this.loaded = true;
      // Keep the highlighted row if it still exists; otherwise the active space,
      // never whatever row happens to sit at the old index.
      const list = this.pickable();
      if (list.length) {
        const same = keep ? list.findIndex((r) => this.rowKey(r) === keep) : -1;
        const active = list.findIndex((r) => r.kind === "space" && r.s.active);
        this.at = same >= 0 ? same : active >= 0 ? active : Math.min(this.at ?? 0, list.length - 1);
        if (this.follow) {
          const i = list.findIndex((r) => r.kind === "space" && r.s.id === this.follow);
          if (i >= 0) this.at = i;
        }
      }
      const created = shared("worktree.created");
      if (created) {
        setShared("worktree.created", null);
        const at = this.pickable().findIndex((r) => r.kind === "worktree" && r.c.path === created);
        if (at >= 0) this.at = at;
      }
      cx.notify();
    });
  }


  // Keys/clicks call close() with no argument; the app calls close(cx) on teardown.
  // The next open starts clean: no filter, and the active space highlighted.
  close(cx) {
    if (shared("search.open")) setShared("search.open", false);
    this.at = null;
    this.scroll = 0;
    this.filter = "";
    this.follow = null;
    this.stopMove();
    this.stepAt = 0;
    this.aim = null;
    if (!cx) closeOverlay(props()?.overlay);
  }

  // Typing: every term has to land somewhere, and terms may land in different
  // places — "kleeamp desk" is the space and its desktop checkout. Exact names
  // and branches outrank a hit deep inside a path; a status word ("needs you")
  // finds the rows that need you whatever they are called.
  search(q) {
    const terms = q.split(/\s+/).filter(Boolean);
    this.terms = terms;
    const one = (text, term) => {
      if (!text) return -Infinity;
      const t = String(text).toLowerCase();
      if (t === term) return 100;
      if (t.startsWith(term)) return 80 - Math.min(10, t.length - term.length);
      if (t.split(/[\/\s._-]+/).some((w) => w.startsWith(term))) return 60;
      const i = t.indexOf(term);
      return i >= 0 ? 40 - Math.min(25, i) : -Infinity;
    };
    const best = (fields) => {
      let total = 0;
      for (const term of terms) {
        let hit = -Infinity;
        for (const [v, w] of fields) {
          const sc = one(v, term);
          if (sc > -Infinity) hit = Math.max(hit, sc * w);
        }
        if (hit === -Infinity) return -Infinity;
        total += hit;
      }
      return total;
    };
    const statusWord = (st) => (st === "blocked" ? "needs you" : st ?? "idle");
    const keyOf = (w) => `${w.on ?? ""}\u0000${w.c.path}`;
    const results = [];
    for (const s of spaces()) {
      const sc = best([
        [s.name, 1], [s.branch, 0.85], [base(place(s)), 0.55], [base(s.folder), 0.55],
        [s.machine, 0.5], [statusWord(s.status), 0.5],
      ]);
      if (sc > -Infinity) results.push({ kind: "space", s, score: sc });
    }
    for (const a of agents()) {
      const sc = best([
        [a.program?.name, 1], [a.title, 0.8], [a.space_name, 0.7], [a.tab_name, 0.6],
        [a.app, 0.6], [statusWord(a.status), 0.5],
      ]);
      if (sc > -Infinity) results.push({ kind: "agent", a, score: sc });
    }
    for (const w of this.worktrees) {
      if (w.c.main || openSpaceFor(w.c.path, w.on)) continue;
      const sc = best([[w.c.branch, 0.95], [base(w.c.path), 0.7], [w.repo.name, 0.6], ["worktree", 0.5]]);
      if (sc > -Infinity) results.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, score: sc });
    }
    for (const p of pinnedList()) {
      const live = spaces().some((s) => (p.id ? s.id === p.id
        : (s.machine ?? null) === (p.machine ?? null) && norm(s.folder ?? "") === norm(p.folder)));
      if (live) continue;
      const sc = best([[p.name, 1], [pinLabel(p), 0.9], [base(p.folder), 0.8], ["pinned", 0.4]]);
      if (sc > -Infinity) results.push({ kind: "pin", id: p.id ?? null, folder: p.folder, on: p.machine ?? null, name: pinLabel(p), named: Boolean(p.named), score: sc });
    }
    const labelOf = (r) => r.kind === "space" ? r.s.name : r.kind === "pin" ? r.name : r.kind === "worktree" ? (r.c.branch ?? base(r.c.path)) : r.kind === "agent" ? (r.a.program?.name ?? r.a.title ?? r.a.address) : r.label;
    results.sort((a, b) => b.score - a.score || String(labelOf(a)).localeCompare(String(labelOf(b))));

    // A matched space brings its agents and worktrees with it, so a search reads
    // like the overview tree instead of one bare row per hit. A row already
    // shown under its space is not repeated further down.
    const all = spaces();
    const agentsOf = new Map();
    for (const a of agents()) {
      if (!agentsOf.has(a.space)) agentsOf.set(a.space, []);
      agentsOf.get(a.space).push(a);
    }
    const kids = (id) => all.filter((s) => this.parent?.get(s.id) === id);
    const ckids = (id) => this.worktrees.filter((w) => !w.c.main && this.checkoutParent?.get(keyOf(w)) === id);
    const used = new Set();
    const out = [];
    const tree = (s, depth = 0) => {
      if (used.has(s.id)) return;
      used.add(s.id);
      out.push({ kind: "space", s, depth });
      for (const a of agentsOf.get(s.id) ?? []) {
        if (used.has(a.address)) continue;
        used.add(a.address);
        out.push({ kind: "agent", a, depth: depth + 1 });
      }
      for (const k of kids(s.id)) tree(k, depth + 1);
      for (const w of ckids(s.id)) {
        const key = `w\u0000${keyOf(w)}`;
        if (used.has(key)) continue;
        used.add(key);
        out.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, depth: depth + 1 });
      }
    };
    // A hit is shown with what it belongs to: a branch with the space that holds
    // it, an agent with the space it runs in, a worktree space with its repo. Two
    // bare rows for the same family read as unrelated places.
    const home = (id) => (id ? all.find((s) => s.id === id) ?? null : null);
    // A worktree space is its repo's space; that space is the top of the family.
    // A hit inside a worktree climbs the whole way, so a branch is never drawn as
    // a place of its own.
    const rootOf = (s) => {
      let top = s;
      const seen = new Set([s.id]);
      for (let p = home(this.parent?.get(top.id)); p && !seen.has(p.id); p = home(this.parent?.get(top.id))) {
        seen.add(p.id);
        top = p;
      }
      return top;
    };
    for (const r of results) {
      if (r.kind === "space") tree(rootOf(r.s));
      else if (r.kind === "agent") {
        const parent = home(r.a.space);
        if (parent) tree(rootOf(parent));
        else if (!used.has(r.a.address)) { used.add(r.a.address); out.push(r); }
      } else if (r.kind === "worktree") {
        const parent = home(this.checkoutParent?.get(keyOf(r)));
        if (parent) tree(rootOf(parent));
        else {
          const key = `w\u0000${keyOf(r)}`;
          if (!used.has(key)) { used.add(key); out.push(r); }
        }
      } else out.push(r);
    }
    // Which rows are the hits, and which only came along with one.
    const rowKey = (r) => r.kind === "space" ? `s:${r.s.id}`
      : r.kind === "agent" ? `a:${r.a.address}`
      : r.kind === "worktree" ? `w:${keyOf(r)}`
      : `p:${r.id ?? r.folder ?? ""}`;
    const hits = new Set(results.map(rowKey));
    return out.map((r) => ({ ...r, hit: hits.has(rowKey(r)) }));
  }

  // A row's name: the query's own characters step forward, the rest stays quiet.
  // A long name keeps its single truncated run, so it still ellipsizes.
  label(text, t, size, color, strong = false) {
    const parts = marks(text, this.terms);
    if (!parts) return div().flex_1().min_w(0).truncate().text_size(size).text_color(color)
      .when(strong, (el) => el.font_semibold()).child(String(text ?? ""));
    return h_flex().flex_1().min_w(0).overflow_hidden().text_size(size)
      .when(strong, (el) => el.font_semibold())
      .children(parts.map(([run, on]) => div().flex_none()
        .when(on, (el) => el.font_semibold().text_color(t.foreground))
        .when(!on, (el) => el.text_color(color))
        .child(run)));
  }

  rows() {
    const f = this.filter.trim().toLowerCase();
    if (f) return this.search(f);
    // No query: nothing is a match, so no row is drawn as one.
    this.terms = null;
    const out = [];
    const head = (label) => out.push({ kind: "head", label });
    const all = spaces();
    const active = all.find((s) => s.active);
    const keyOf = (w) => `${w.on ?? ""}\u0000${w.c.path}`;
    const kids = (id) => all.filter((s) => this.parent?.get(s.id) === id);
    const ckids = (id) => this.worktrees.filter((w) => !w.c.main && this.checkoutParent?.get(keyOf(w)) === id);
    const parentOf = (s) => { const id = this.parent?.get(s.id); return id ? all.find((x) => x.id === id) : null; };
    const emitted = new Set();
    // `seen` is the section's own list: Pinned and Current both show the one
    // space in use, so each walks its tree again with its own set.
    const emit = (s, depth = 0, seen = emitted) => {
      out.push({ kind: "space", s, depth });
      seen.add(s.id);
      emitted.add(s.id);
      // What runs there, so the overview shows agents next to their worktrees.
      for (const a of agents()) if (a.space === s.id) out.push({ kind: "agent", a, depth: depth + 1 });
      for (const k of kids(s.id)) if (!seen.has(k.id)) emit(k, depth + 1, seen);
      for (const w of ckids(s.id)) {
        if (seen.has(keyOf(w))) continue;
        out.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, depth: depth + 1 });
        seen.add(keyOf(w));
        emitted.add(keyOf(w));
      }
    };
    // Pinned spaces get their own section above Current, with their own trees,
    // whether or not anything runs there: a space that is gone leaves a row that
    // starts a shell in its folder. A pinned child of a pinned space comes with
    // its parent.
    const pinned = pinnedList();
    const pinnedIds = new Set(all
      .filter((x) => pinned.some((p) => (p.id ? p.id === x.id
        : (x.machine ?? null) === (p.machine ?? null) && norm(x.folder ?? "") === norm(p.folder))))
      .map((x) => x.id));
    const topPin = (s) => {
      for (let p = parentOf(s); p; p = parentOf(p)) if (pinnedIds.has(p.id)) return false;
      return true;
    };
    // Every pin lives in its own section above Current, the one in use too.
    const heldPins = new Set();
    const pinRows = pinned
      .map((p) => ({ p, s: all.find((x) => (p.id ? x.id === p.id
        : (x.machine ?? null) === (p.machine ?? null) && norm(x.folder ?? "") === norm(p.folder)) ) }))
      .filter(({ s }) => {
        if (!s) return true;
        if (heldPins.has(s.id)) return false;
        heldPins.add(s.id);
        return !emitted.has(s.id) && topPin(s);
      });
    // Pinned spaces read in their real order, so moving one shows here too;
    // pins with no space left follow.
    const placeOf = new Map(all.map((s, i) => [s.id, i]));
    pinRows.sort((a, b) => (a.s ? placeOf.get(a.s.id) ?? 0 : 1e6) - (b.s ? placeOf.get(b.s.id) ?? 0 : 1e6));
    const pinStart = out.length;
    if (pinRows.length) {
      // The count is pins, not top-level pin rows: a pinned worktree is drawn
      // under its repo's pinned space, and a count that skipped it read like a
      // cap on pinning.
      head(`Pinned ${pinned.length}`);
      for (const { p, s } of pinRows) {
        if (!s) {
          out.push({ kind: "pin", id: p.id ?? null, folder: p.folder, on: p.machine ?? null, name: pinLabel(p), named: Boolean(p.named) });
        } else if (!emitted.has(s.id)) {
          // Its worktrees and agents come with it, the one in use too.
          emit(s);
        }
      }
    }
    // Only the Pinned section says "pinned": a row under Current is not a pin.
    // A space in use that already shows under Pinned — pinned itself, or a
    // worktree of a pinned space — lives there alone, marked "current". One
    // that isn't in Pinned has no other home, so Current shows it.
    let activeInPins = false;
    for (let i = pinStart; i < out.length; i++) {
      out[i].inPins = true;
      if (out[i].kind === "space" && active && out[i].s.id === active.id) activeInPins = true;
    }
    // No "Current" title: the space in use carries a "current" badge, exactly
    // like a pinned row, and the section titles below line it off.
    if (active && !activeInPins) emit(active, 0, new Set());
    const rest = all.filter((s) => s.id !== active?.id);
    for (const [label, rank] of [["Needs you", 4], ["Done", 3], ["Working", 2], ["Idle", 1]]) {
      // A family appears once, at its root: a worktree's row comes with its repo.
      const roots = rest.filter((s) => !emitted.has(s.id) && (RANK[s.status] ?? 1) === rank && !parentOf(s));
      if (roots.length) {
        head(`${label} ${roots.length}`);
        roots.forEach((s) => emit(s));
      }
    }
    const orphans = this.worktrees.filter((w) => !w.c.main && !emitted.has(keyOf(w)));
    if (orphans.length) {
      head(`Worktrees ${orphans.length}`);
      orphans.forEach((w) => out.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, depth: 0 }));
    }
    return out;
  }

  pickable() { return this.rows().filter((r) => r.kind !== "head"); }

  // What a row stands for, so a reload keeps the same row highlighted.
  rowKey(r) {
    if (!r) return null;
    if (r.kind === "space") return `s:${r.s.id}`;
    if (r.kind === "pin") return `p:${r.id ?? `${r.on ?? ""}\u0000${r.folder}`}`;
    if (r.kind === "worktree") return `w:${r.on ?? ""}\u0000${r.c.path}`;
    if (r.kind === "agent") return `a:${r.a.address}`;
    return `x:${r.label}`;
  }

  // The pin of exactly this space, by its id. Two spaces can share a folder and
  // both be pinned, so the folder decides nothing here: a pin whose space is
  // gone stays a pin row (a place to open), and a space made later is never
  // handed that pin behind your back.
  spacePin(s) {
    if (!s) return null;
    return pinnedList().find((p) => p.id === s.id) ?? null;
  }

  // A pin saved before pins had ids is given one, once, when the panel opens: it
  // was pinned as this folder, so the space living there is what it means. This
  // never runs for a pin that has an id — not even a stale one — because a new
  // space must not come up pinned.
  bindPins() {
    const list = pinnedList();
    const live = spaces();
    const held = new Set(list.filter((p) => p.id && live.some((s) => s.id === p.id)).map((p) => p.id));
    let changed = false;
    for (const p of list) {
      if (p.id) continue;
      const s = live.find((x) => !held.has(x.id)
        && (x.machine ?? null) === (p.machine ?? null)
        && norm(x.folder ?? "") === norm(p.folder));
      if (!s) continue;
      held.add(s.id);
      p.id = s.id;
      p.name = p.name || s.name;
      changed = true;
    }
    if (changed) writePins(list, "gave a pin without an id its space id");
    // A pin whose space is gone while another space stands in its folder has
    // nothing left to open: that folder is a space already. Kept, it is a second
    // row for one place, and pressing it would make a duplicate space — the
    // exact way a sheet ends up with three rows all reading "herdr-app".
    const kept = list.filter((p) => (p.id && live.some((s) => s.id === p.id)) || !spaceAt(p.folder, p.machine ?? null, live));
    if (kept.length !== list.length) writePins(kept, "dropped a pin whose place already is a space");
  }

  // One pin, by id: pinning a space never touches another space in its folder,
  // and unpinning removes exactly that pin. Pins are compared by value, never by
  // object: every read of shared state is a fresh copy.
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
      : [...list, { id: s.id, folder, machine: s.machine ?? null, name: s.name, named: Boolean(s.named) }],
      mine ? `unpinned ${s.name}` : `pinned ${s.name}`);
  }

  // Ctrl+P: pin the highlighted space (or the space an agent runs in), or unpin
  // it. A pinned space is never closed from here; with nothing running there,
  // Enter starts a shell in its folder.
  // Ctrl+D on an agent: never silent, and never on a sub-agent, which its parent
  // is waiting for. The dialog says what is lost; Enter stops, Esc keeps it.
  askStop(a) {
    if (!a) return;
    if (a.parent) return notify({ title: "A sub-agent ends with its parent", body: `${a.title || a.program?.name || a.address} reports to ${a.parent}.` });
    // The same dialog that asks about a space or a worktree; Esc leaves it.
    openOverlay({ mod: "worktrees", kind: "dialog", width: 440, height: 156, props: { agent: a.address } });
  }

  // Drop the pin a pin row stands for, by id, else by the folder it was saved with.
  unpinRow(r) {
    if (!r) return;
    writePins(pinnedList().filter((p) => (r.id ? p.id !== r.id : pinKey(p.folder, p.machine) !== pinKey(r.folder, r.on))),
      `unpinned the row ${r.name}`);
  }

  togglePin() {
    const r = this.selected();
    if (!r) return;
    // A pin belongs to a space; a worktree is a checkout under its repo.
    if (r.kind === "space" && this.isWorktree(r.s)) return notify({
      title: "A worktree is not pinned",
      body: `${r.s.name} lives under its repo. Pins belong to spaces.`,
    });
    if (r.kind === "pin") {
      this.unpinRow(r);
    } else if (r.kind === "space") {
      this.setPin(r.s);
    } else if (r.kind === "agent") {
      this.setPin(spaces().find((x) => x.id === r.a.space));
    }
  }

  newWorktreeFor() {
    const r = this.selected();
    if (!r) return;
    if (r.kind === "worktree") {
      openOverlay({ mod: "worktrees", kind: "dialog", width: 460, height: 170, props: { folder: r.c.path, machine: r.on, action: "new" } });
      return;
    }
    // A row under a space (an agent) works on the space it belongs to.
    const s = r.kind === "space" ? r.s : r.kind === "agent" ? spaces().find((x) => x.id === r.a.space) : null;
    if (!s) return;
    openOverlay({ mod: "worktrees", kind: "dialog", width: 460, height: 170, props: { space: s.id, folder: place(s) ?? s.folder, action: "new" } });
  }

  selected() {
    const list = this.pickable();
    if (!list.length) return null;
    return list[Math.max(0, Math.min(this.at ?? 0, list.length - 1))];
  }

  // A worktree space, decided without git wherever the path already says so.
  isWorktree(s) {
    if (this.worktreeSpaces?.has(s.id)) return true;
    return worktreePath(place(s) ?? s.folder ?? "");
  }

  // "Spaces" means places to work: a worktree checkout is drawn under its repo,
  // and counting it again read as a space nobody could see. Agents are not
  // spaces either, however many are running.
  realSpaces() {
    return spaces().filter((s) => !this.isWorktree(s));
  }

  // Opening a space with no terminal anywhere — no tabs, or only mod panes —
  // starts a shell there, so a pinned space whose terminal is gone still lands
  // you somewhere to type.
  openSpace(s) {
    const cur = spaces().find((x) => x.id === s.id) ?? s;
    run("space.select", { id: cur.id });
    const tabs = new Set((cur.tabs ?? []).map((t) => t.id));
    if (!panes().some((p) => p.terminal && tabs.has(p.tab))) run("tab.new", { space: cur.id });
  }

  go(r) {
    if (!r) return;
    if (r.kind === "space") {
      this.close();
      this.openSpace(r.s);
    } else if (r.kind === "pin") {
      // A pin is a place, not a licence for a second space in that place: go to
      // the space already there, and say why nothing new was opened.
      const existing = spaceAt(r.folder, r.on);
      this.close();
      if (existing) {
        this.openSpace(existing);
        notify({
          title: "That folder already has a space",
          body: `${existing.name} is open there. Went to it instead of opening a second one.`,
          level: "warning",
        });
      } else run("space.new", { folder: r.folder, ...(r.named ? { name: r.name } : {}), ...(r.on ? { machine: r.on } : {}) });
    } else if (r.kind === "worktree") {
      const existing = openSpaceFor(r.c.path, r.on);
      this.close();
      if (existing) this.openSpace(existing);
      else run("space.new", { folder: r.c.path, ...(r.on ? { machine: r.on } : {}) });
    } else if (r.kind === "agent") {
      this.close();
      run("pane.focus", { pane: r.a.pane });
    }
  }

  // Ctrl+Shift+J/K: move the highlighted space within its machine block.
  // Ctrl+Shift+J/K held down keeps moving the same space, a step at a time.
  startMove(dir, cx) {
    // Already stepping this way: the key's own auto-repeat must change
    // nothing. The row under the highlight moves with the space, so reading
    // the selection again here would grab whatever slid into its place.
    if (this.hold && this.holdDir === dir && Date.now() - (this.stepAt ?? 0) < 90) return;
    const r = this.selected();
    // Only a space row moves. A worktree row is a checkout and an agent row is a
    // running program: neither is a place in the order, so the keys do nothing on
    // them (and neither row offers the hint).
    const s = r?.kind === "space" ? r.s : null;
    if (!s) return;
    this.stopMove();
    this.holdId = s.id;
    this.holdDir = dir;
    this.holdSteps = 0;
    this.move(s, dir);
    this.hold = cx.timer.after(300, (cx2) => {
      this.hold = cx2.timer.every(70, (cx3) => {
        const live = spaces().find((x) => x.id === this.holdId);
        if (!live || ++this.holdSteps > 600) return this.stopMove();
        this.move(live, this.holdDir);
        cx3.notify();
      });
    });
  }

  stopMove() {
    this.hold?.cancel();
    this.hold = null;
    this.holdId = null;
    this.holdDir = 0;
  }

  // The wheel moves the view; the highlight goes with it, so Enter still acts
  // on something you can see. No scrollbar is drawn, so this is the only way
  // the sheet says it continues.
  wheel(e, cx) {
    if (!(this.maxScroll > 0)) return;
    const next = Math.max(0, Math.min(this.scroll - e.delta.y, this.maxScroll));
    if (next === this.scroll) return;
    this.scroll = next;
    // The wheel is the pointer's way of choosing, like the arrows: a space just
    // moved must not keep the highlight pinned to itself.
    this.follow = null;
    const v = this.geom;
    const pick = v?.pick ?? [];
    if (v) {
      const h = (r) => v.H[r.kind] ?? 32;
      while (this.at < pick.length - 1 && v.tops[v.rows.indexOf(pick[this.at])] < this.scroll) this.at++;
      while (this.at > 0 && v.tops[v.rows.indexOf(pick[this.at])] + h(pick[this.at]) > this.scroll + v.height) this.at--;
    }
    cx.notify();
  }

  // Dragging a row: the move is read off the pointer, not off the row it started
  // on, so a drag that leaves its own row still lands where it is let go.
  overRow(e, cx) {
    if (this.pressed === null) return;
    const v = this.geom;
    const y = (e.local_position?.y ?? 0) + this.scroll;
    let hit = null;
    if (v) for (let i = 0; i < v.rows.length; i++) {
      const h = v.H[v.rows[i].kind] ?? 32;
      if (y >= v.tops[i] && y < v.tops[i] + h) { hit = v.rows[i]; break; }
    }
    const from = spaces().find((x) => x.id === this.pressed);
    const same = hit && hit.kind === "space" && (hit.s.machine ?? null) === (from?.machine ?? null);
    const id = same ? hit.s.id : null;
    if (this.over !== id) { this.over = id; cx.notify(); }
  }

  // A release anywhere in the list finishes a drag the rows did not see.
  dropRow(cx) {
    const from = this.pressed, over = this.over;
    this.pressed = null;
    this.over = null;
    if (from !== null && over && over !== from) {
      const order = spaces().filter((x) => (x.machine ?? null) === (spaces().find((y) => y.id === from)?.machine ?? null)).map((x) => x.id);
      // Dropped onto a row below its own: it goes after that row, the side the
      // drop line was drawn on.
      this.landSpace(spaces().find((x) => x.id === from), spaces().find((x) => x.id === over),
        order.indexOf(over) > order.indexOf(from) ? 1 : -1);
    }
    cx.notify();
  }

  // Put `s` where `target` is. Pinned spaces read above the rest, so landing on
  // the other side of that line is a pin or an unpin: never a drop that does
  // nothing.
  landSpace(s, target, dir = 0) {
    if (!s || !target || s.id === target.id) return;
    // The aimed order, with this space put where the target is.
    const list = spaces().filter((x) => (x.machine ?? null) === (s.machine ?? null));
    const at = list.findIndex((x) => x.id === target.id);
    if (at < 0) return;
    const ids = this.aimedOrder(s).filter((id) => id !== s.id);
    const ti = ids.indexOf(target.id);
    if (ti < 0) return;
    const cut = ti + (dir > 0 ? 1 : 0);
    this.aim = [...ids.slice(0, cut), s.id, ...ids.slice(cut)];
    if (Boolean(this.spacePin(s)) !== Boolean(this.spacePin(target))) this.setPin(s);
    run("space.move", { id: s.id, index: at + 1 });
    this.follow = s.id;
    return this.aim.indexOf(s.id) + 1;
  }

  // The panel stays open and the moved space keeps the highlight.
  // The space order the sheet is aiming at. A move lands asynchronously, so two
  // presses close together would read the same spaces() twice, aim at the same
  // neighbour and the second would do nothing — "it only moves one row". Steps
  // read the aim while it still describes the live set of spaces.
  aimedOrder(s) {
    const live = spaces().filter((x) => (x.machine ?? null) === (s.machine ?? null)).map((x) => x.id);
    const ids = this.aim;
    // Only while a step may still be landing: an order changed from anywhere else
    // is read from the app, not remembered.
    const fresh = Date.now() - (this.stepAt ?? 0) < 1200;
    return fresh && Array.isArray(ids) && ids.length === live.length && ids.every((id) => live.includes(id)) ? ids : live;
  }

  move(s, dir) {
    if (!s || dir === 0) return;
    // Read the aim before stamping this step: aimedOrder asks how long ago the
    // LAST one was.
    const ids = this.aimedOrder(s);
    this.stepAt = Date.now();
    const at = ids.indexOf(s.id);
    const target = at < 0 ? null : spaces().find((x) => x.id === ids[at + dir]) ?? null;
    // The end of the order: not a wrap, and nothing to say.
    if (!target) return;
    const place = this.landSpace(s, target, dir);
    // A ranked list does not move, so say where the space went.
    if (place && this.filter.trim()) this.note = `${s.name} \u00b7 ${place} of ${ids.length}`;
  }

  // The tile, and — where the section does not already say it — the space's state
  // as a bead on its corner, the way a status sits on a portrait.
  avatar(t, s, badged = false) {
    const color = spaceColor(t, s);
    const bead = badged && s.status && s.status !== "idle"
      ? (s.status === "working" ? t.accent : (t[s.status] ?? t.dim)) : null;
    return h_flex().size(20).flex_none().rounded(6).bg(color).relative().items_center().justify_center()
      .border(1).border_color(wash(t.foreground, "14"))
      .text_size(10.5).font_bold().text_color("#ffffff")
      .child([...s.name][0]?.toUpperCase() ?? "?")
      .when(Boolean(bead), (el) => el.child(div().absolute().right(-2).bottom(-2).size(6).rounded_full()
        .bg(bead).border(1).border_color(t.popover).flex_none()
        .tooltip(s.status === "blocked" ? "Needs you" : s.status === "done" ? "Done" : "Working")));
  }



  render(cx) {
    const ids = spaces().map((s) => s.id);
    // A fresh open starts clean and on the active space, even when this copy
    // lived through the previous open. Spaces made while it was closed are not
    // news: only one made while it is open closes it.
    if (!shared("search.open")) {
      setShared("search.open", true);
      this.at = null;
      this.filter = "";
      this.scroll = 0;
      this.stopMove();
      this.seen = new Set(ids);
    }
    // A new space closes the panel: it was made to work there, not to look at a
    // list. Ctrl+Shift+N, a pin row and an empty worktree all land here.
    if (this.seen && ids.some((id) => !this.seen.has(id))) {
      this.seen = new Set(ids);
      this.close();
      return div();
    }
    this.seen = new Set(ids);
    // Reordering spaces only changes the list order, not the worktrees: keep the
    // signature order-free so a move does not re-read git or flash row icons.
    const sig = spaces().map((s) => `${s.id}:${s.folder}:${s.machine ?? ""}:${s.branch ?? ""}`).sort().join("|");
    if (this.spaceSig !== undefined && sig !== this.spaceSig) this.load(cx);
    this.spaceSig = sig;
    const t = theme();
    // Whether the keyboard is on the panel, which the caret and border follow.
    const live = Boolean(this.handle?.is_focused?.());
    const rows = this.rows();
    const pick = rows.filter((r) => r.kind !== "head");
    if (this.at === null) {
      const actives = pick.flatMap((r, i) => (r.kind === "space" && r.s.active ? [i] : []));
      this.at = actives.length ? actives[actives.length - 1] : 0;
    } else if (this.at < 0) {
      // Fresh typing: the highlight belongs on the hit itself, not on the space
      // that came along with it.
      const hit = pick.findIndex((r) => r.hit);
      this.at = hit >= 0 ? hit : 0;
    }
    // A space just moved keeps the highlight, wherever its row went.
    if (this.follow) {
      const i = pick.findIndex((r) => r.kind === "space" && r.s.id === this.follow);
      if (i >= 0) this.at = i;
    }
    if (pick.length) this.at = Math.min(this.at, pick.length - 1);
    const sel = pick[this.at];
    const H = { head: 30, space: 36, pin: 36, worktree: 34, agent: 38 };
    const tops = [];
    let y = 0;
    rows.forEach((r) => { tops.push(y); y += H[r.kind] ?? 32; });
    const total = y;
    const height = Math.max(120, this.listHeight ?? 380);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    // What the wheel, PageUp/PageDown and a drag are laid out against.
    this.geom = { rows, tops, height, pick, H };
    this.maxScroll = maxScroll;
    const si = rows.indexOf(sel);
    if (si >= 0) {
      if (tops[si] < this.scroll) this.scroll = tops[si];
      if (tops[si] + (H[sel.kind] ?? 32) > this.scroll + height) this.scroll = tops[si] + (H[sel.kind] ?? 32) - height;
    }
    const at = (el, i) => fixed
      ? el.absolute().left(0).right(0).top(tops[i] - this.scroll).bottom(height - (tops[i] + (H[rows[i].kind] ?? 32) - this.scroll))
      : el;
    const visible = (i) => !fixed || (tops[i] + (H[rows[i].kind] ?? 32) > this.scroll && tops[i] < this.scroll + height);
    // The right-hand column: a pin, a spinner and a status dot sit in the same
    // 16px slot on every row, so they line up down the list.
    const marker = (el) => div().w(16).h_full().flex_none().flex().items_center().justify_center().child(el);

    const row = (r) => {
      if (r.kind === "head") {
        const m = String(r.label).match(/^(.*?)\s+(\d+)$/);
        return h_flex().h(30).px(10).pt(12).gap(7).items_center()
          .child(div().flex_none().text_size(9).font_semibold().text_color(t.dim).child(spaced((m ? m[1] : r.label).toUpperCase())))
          .when(Boolean(m), (el) => el.child(div().flex_none().text_size(8.5).font_medium().text_color(t.dim).child(m[2])))
          .child(div().h(1).flex_1().bg(wash(t.foreground, "07")));
      }
      const on = r === sel;
      if (r.kind === "space") {
        const s = r.s;
        return h_flex().id(`pal-${r.inPins ? "pin-" : ""}${s.id}`).relative().mx(4).pl(10 + (r.depth ?? 0) * 16).pr(10).h(36).rounded(9).gap(9).items_center()
          .when(on, (el) => el.bg(wash(t.accent, "16")))
          .when(!on, (el) => el.hover((x) => x.bg(wash(t.foreground, "0b"))))
          .when(this.pressed === s.id, (el) => el.opacity(0.55))
          .when(this.pressed !== null && this.over === s.id && this.pressed !== s.id, (el) => el.child(
            div().absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
              .when(spaces().findIndex((x) => x.id === this.pressed) < spaces().findIndex((x) => x.id === s.id), (line) => line.bottom(0))
              .when(spaces().findIndex((x) => x.id === this.pressed) > spaces().findIndex((x) => x.id === s.id), (line) => line.top(0)),
          ))
          .on_mouse_down("left", (_e, cx) => { this.pressed = s.id; this.over = s.id; cx.notify(); })
          .on_mouse_move((_e, cx) => {
            const from = spaces().find((x) => x.id === this.pressed);
            const same = from && (from.machine ?? null) === (s.machine ?? null);
            if (this.pressed !== null && same && this.over !== s.id) { this.over = s.id; cx.notify(); }
          })
          .on_mouse_up("left", (_e, cx) => {
            const from = this.pressed, over = this.over;
            this.pressed = null;
            this.over = null;
            if (from === s.id) this.go(r);
            else if (from !== null && over === s.id) {
              this.landSpace(spaces().find((x) => x.id === from), s);
            }
            cx.notify();
          })
          .when(on, (el) => el.child(div().absolute().left(0).top(8).bottom(8).w(2).rounded(1).bg(t.accent)))
          .when(Boolean(r.depth), (el) => el.child(div().w(10).flex_none().text_size(10.5).text_color(wash(t.muted, "cc")).child("↳")))
          // A worktree space reads as a branch, not as a space of its own.
          .when(!this.isWorktree(s), (el) => el.child(this.avatar(t, s, Boolean(r.inPins))
            .when(s.active, (a) => a.border_color(wash(t.accent, "b0")))))
          .when(this.isWorktree(s), (el) => el.child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted)))
          .child(this.label(s.name, t, 12.5, s.active ? t.foreground : t.muted, s.active))
          .when(s.active, (el) => el.child(div().flex_none().px(5).h(15).rounded(4).bg(wash(t.accent, "18"))
            .text_size(9).font_medium().text_color(t.accent).flex().items_center().child("current")))
          .when(Boolean(s.branch) && s.branch !== s.name, (el) => el.child(div().flex_none().max_w(130).truncate().px(5).h(17).rounded(4)
            .bg(wash(t.foreground, "0c")).text_size(9.5).text_color(wash(t.muted, "cc")).flex().items_center().child(s.branch)))
          .when(Boolean(s.machine), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(s.machine)))
          .child(marker(Boolean(r.inPins) && !this.isWorktree(s) && Boolean(this.spacePin(s))
            ? svg("mods/search/pin.svg").size(12).flex_none().text_color(wash(t.accent, "8c"))
            : div()));
      }
      if (r.kind === "pin") {
        const tone = folderColor(r.folder);
        return h_flex().id(`pal-pin-${r.folder}`).relative().mx(4).pl(10).pr(10).h(36).rounded(9).gap(9).items_center()
          .when(on, (el) => el.bg(wash(t.accent, "16")))
          .when(!on, (el) => el.hover((x) => x.bg(wash(t.foreground, "0b"))))
          .on_click(() => this.go(r))
          .when(on, (el) => el.child(div().absolute().left(0).top(8).bottom(8).w(2).rounded(1).bg(t.accent)))
          .child(h_flex().size(20).flex_none().rounded(6).bg(MARK[tone] ?? t[tone]).items_center().justify_center()
            .border(1).border_color(wash(t.foreground, "14"))
            .text_size(10.5).font_bold().text_color("#ffffff")
            .child([...r.name][0]?.toUpperCase() ?? "?"))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(r.name))
          // No folder: where a shell starts is Herdr's bookkeeping, and a pin is
          // read by its name. Only another machine is worth saying out loud.
          .when(Boolean(r.on), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(r.on)))
          .child(svg("mods/search/pin.svg").size(12).flex_none().text_color(t.accent));
      }
      if (r.kind === "worktree") {
        const c = r.c;
        return h_flex().id(`pal-wt-${r.inPins ? "pin-" : ""}${c.path}`).relative().mx(4).pl(10 + (r.depth ?? 0) * 16).pr(10).h(34).rounded(9).gap(9).items_center()
          .when(on, (el) => el.bg(wash(t.accent, "16")))
          .when(!on, (el) => el.hover((x) => x.bg(wash(t.foreground, "0b"))))
          .on_click(() => this.go(r))
          .when(on, (el) => el.child(div().absolute().left(0).top(7).bottom(7).w(2).rounded(1).bg(t.accent)))
          .when(Boolean(r.depth), (el) => el.child(div().w(10).flex_none().text_size(10.5).text_color(wash(t.muted, "cc")).child("↳")))
          .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
          .child(this.label(c.branch ?? c.path.split("/").pop(), t, 12.5, t.muted))
          .when(!r.depth, (el) => el.child(div().flex_none().max_w(120).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(r.repo.name)))
          .when(c.main, (el) => el.child(div().text_size(9.5).text_color(wash(t.muted, "cc")).child("main")))
          .child(div().px(5).h(16).rounded(4).bg(wash(t.foreground, "0c")).text_size(9.5).text_color(wash(t.muted, "cc")).flex().items_center().child("open"))
          .child(marker(div()));
      }
      if (r.kind === "agent") {
        const a = r.a, p = a.program;
        // A tile of its own colour, the way a worktree row reads at a glance. A
        // program without one gets a neutral that is the same in every theme.
        const tile = tileOf(p) ?? "#24252a";
        const ink = inkOf(p) ?? "#e6e6e6";
        const icon = p?.icon ? (p.tint ? svg(p.icon).size(13).text_color(ink ?? t.foreground) : image(p.icon).size(13)) : null;
        return h_flex().id(`pal-agent-${r.inPins ? "pin-" : ""}${a.address}`).relative().mx(4).pl(8 + (r.depth ?? 0) * 16).pr(10).h(38).rounded(9).gap(9).items_center()
          .when(on, (el) => el.bg(wash(t.accent, "16")))
          .when(!on, (el) => el.hover((x) => x.bg(wash(t.foreground, "0b"))))
          .on_click(() => this.go(r))
          .when(on, (el) => el.child(div().absolute().left(0).top(8).bottom(8).w(2).rounded(1).bg(t.accent)))
          // A child of a space, marked the way a worktree child is.
          .when(Boolean(r.depth), (el) => el.child(div().w(10).flex_none().text_size(10.5).text_color(wash(t.muted, "cc")).child("↳")))
          .child(div().size(22).flex_none().rounded(7).flex().items_center().justify_center().bg(tile)
            .border(1).border_color(wash(t.foreground, "14"))
            .when(!icon, (el) => el.child(div().text_size(10).font_bold().text_color(ink).child((p?.name ?? a.app ?? "?").slice(0, 1).toUpperCase())))
            .when(Boolean(icon), (el) => el.child(icon)))
          .child(h_flex().flex_1().min_w(0).gap(6).items_center()
            .child(this.label(a.title || p?.name || a.app || "agent", t, 12.5, a.status === "idle" ? t.muted : t.foreground))
            .when(Boolean(a.tab_name) && !/^\d+$/.test(a.tab_name ?? ""), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(a.tab_name))))
          .when(Boolean(a.space_name) && !r.depth, (el) => el.child(div().max_w(120).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(a.space_name)))
          .when(a.status === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(wash(t.blocked, "20")).text_size(9.5).font_semibold().text_color(t.blocked).child("Needs you")))
          .child(marker(a.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(11.5).flex_none().text_color(t.accent).spin(900)
            : a.status === "done" ? div().size(6).flex_none().rounded(3).bg(t.done)
            : a.status === "idle" ? div().size(6).flex_none().rounded(3).border(1.5).border_color(t.idle ?? t.dim)
            : div()));
      }
      return div();
    };

    // Alt+F toggles this sheet from anywhere (keys.json: mod.open:search), and
    // the header shows whichever key does it. Esc and Ctrl+Q still close it, so
    // the footer only lists what the rows themselves offer.
    const CLOSE_HINT = { k: shortcutOf("mod.open:search") || "alt f", l: "close" };
    const hints = (() => {
      if (!rows.length) return [CLOSE_HINT];
      if (sel?.kind === "space") {
        const pinned = Boolean(this.spacePin(sel.s));
        const close = this.isWorktree(sel.s) ? "remove worktree" : "close space";
        return [
          { k: "↵", l: "switch" },
          { k: "⌃J/K", l: "move" },
          { k: "⌃R", l: "rename" },
          { k: "⌃A", l: "worktree" },
          { k: "⌃P", l: pinned ? "unpin" : "pin" },
          { k: "⌃⇧J/K", l: "reorder" },
          ...(pinned ? [] : [{ k: "⌃D", l: close }]),
        ];
      }
      if (sel?.kind === "pin") return [{ k: "↵", l: "open shell" }, { k: "⌃P", l: "unpin" }];
      if (sel?.kind === "worktree") return [{ k: "↵", l: "open" }, { k: "⌃A", l: "worktree" }, { k: "⌃D", l: "remove" }];
      if (sel?.kind === "agent") {
        const s = spaces().find((x) => x.id === sel.a.space);
        return [
          { k: "↵", l: "focus" },
          { k: "⌃A", l: "worktree" },
          { k: "⌃P", l: this.spacePin(s) ? "unpin" : "pin" },
          { k: "⌃D", l: sel.a.parent ? "ends with its parent" : "stop" },
        ];
      }
      return [{ k: "↑↓", l: "choose" }, { k: "↵", l: "open" }];
    })();

    // One chip per state that has something in it: the panel opens saying where
    // the work is, and a chip is also the filter it names.
    const tally = { "needs you": 0, working: 0, done: 0 };
    for (const s of this.realSpaces()) {
      const word = s.status === "blocked" ? "needs you" : (s.status ?? "idle");
      if (word in tally) tally[word] += 1;
    }
    const chipTone = { "needs you": t.blocked, working: t.accent, done: t.done };
    const chip = (word) => h_flex().id(`pal-chip-${word.replace(/\s+/g, "-")}`).flex_none().gap(4).items_center()
      .cursor_pointer().text_color(chipTone[word])
      .hover((x) => x.opacity(0.72))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.filter = word;
        this.follow = null;
        this.at = -1;
        cx.notify();
      })
      .child(div().size(4).flex_none().rounded_full().bg(chipTone[word]))
      .child(div().text_size(9.5).font_medium().child(`${tally[word]} ${word}`));

    return v_flex().id("palette").track_focus(this.handle).on_click((_e, cx) => { this.handle.focus(); this.note = null; cx.notify(); }).w_full().h_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_up((e) => { if (e.key === "j" || e.key === "k") this.stopMove(); })
      .on_key_down((e, cx) => {
        const k = e.key, ctrl = e.modifiers.control;
        if (!(ctrl && e.modifiers.shift && (k === "j" || k === "k"))) { this.stopMove(); this.note = null; }
        if (k === "escape" || (ctrl && k === "q")) return this.close();
        if (ctrl && k === "a") {
          this.newWorktreeFor();
        } else if (k === "enter") {
          this.go(this.selected());
        } else if (k === "backspace") {
          // Ctrl+Backspace takes the word behind the caret, plain Backspace a key.
          this.filter = ctrl ? this.filter.replace(/\s*[^\s]+\s*$/, "") : this.filter.slice(0, -1);
          this.follow = null;
          this.at = -1;
        } else if (k === "space") {
          this.filter += " ";
          this.follow = null;
          this.at = -1;
        } else if (k.length === 1 && !ctrl && !e.modifiers.alt) {
          this.filter += k;
          this.follow = null;
          this.at = -1;
        } else if (ctrl && e.modifiers.shift && k === "k") {
          // Shift first: this pair used to sit below the plain Ctrl+J/K branch,
          // and that branch did not ask about Shift — so the reorder keys only
          // ever moved the highlight.
          this.startMove(-1, cx);
        } else if (ctrl && e.modifiers.shift && k === "j") {
          this.startMove(1, cx);
        } else if (ctrl && !e.modifiers.shift && (k === "j" || k === "k") && pick.length) {
          // The sheet's own Ctrl+J/K. Nothing binds them globally any more: they
          // are the terminal's (vim's Ctrl+J/K, readline's) while the sheet is
          // closed, and only mean "next/previous row" inside it.
          this.follow = null;
          this.at = (this.at + (k === "j" ? 1 : pick.length - 1)) % pick.length;
        } else if (ctrl && k === "p") {
          this.togglePin();
        } else if (ctrl && k === "r") {
          if (sel?.kind === "space") { this.close(); run("space.rename", { id: sel.s.id }); }
        } else if (ctrl && k === "d") {
          // A pinned space is never closed, and the sheet says so rather than
          // opening a dialog that could only refuse.
          if (sel?.kind === "space") {
            if (isPinned(sel.s)) return notify({
              title: "Pinned space",
              body: `${sel.s.name} stays: pinned spaces are never closed. Unpin it (Ctrl+P), then close it.`,
            });
            if (this.isWorktree(sel.s)) openOverlay({ mod: "worktrees", kind: "dialog", width: 440, height: 155, props: { space: sel.s.id, action: "remove" } });
            else openOverlay({ mod: "worktrees", kind: "dialog", width: 440, height: 150, props: { space: sel.s.id, action: "space" } });
          } else if (sel?.kind === "worktree") {
            openOverlay({ mod: "worktrees", kind: "dialog", width: 440, height: 155, props: { folder: sel.c.path, machine: sel.on, action: "remove" } });
          } else if (sel?.kind === "pin") {
            // A pin with no space left is only a place to open: closing it is
            // taking the pin away, which is exactly what Ctrl+P would do.
            this.unpinRow(sel);
          } else if (sel?.kind === "agent") {
            this.askStop(sel.a);
          }
        } else if ((k === "pagedown" || k === "pageup") && pick.length) {
          const step = Math.max(1, Math.round((this.geom?.height ?? 340) / 34) - 1);
          this.follow = null;
          this.at = Math.max(0, Math.min(pick.length - 1, this.at + (k === "pagedown" ? step : -step)));
        } else if (k === "down" && pick.length) { this.follow = null; this.at = (this.at + 1) % pick.length; }
        else if (k === "up" && pick.length) { this.follow = null; this.at = (this.at + pick.length - 1) % pick.length; }
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().gap(11).items_center()
        .child(div().size(28).flex_none().rounded(9).bg(wash(t.accent, "12"))
          .border(1).border_color(wash(t.accent, "24"))
          .flex().items_center().justify_center()
          .child(svg("mods/search/layers.svg").size(14).text_color(t.accent)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Spaces"))
          .child(h_flex().gap(9).items_center()
            .child(div().flex_none().text_size(10).text_color(t.muted)
              .child(this.filter.trim()
                ? `${rows.filter((r) => r.hit).length} ${rows.filter((r) => r.hit).length === 1 ? "match" : "matches"}`
                : `${this.realSpaces().length} ${this.realSpaces().length === 1 ? "space" : "spaces"}`))
            .when(tally["needs you"] > 0, (el) => el.child(chip("needs you")))
            .when(tally.working > 0, (el) => el.child(chip("working")))
            .when(tally.done > 0, (el) => el.child(chip("done")))))
        .child(h_flex().gap(6).items_center()
          .child(keycap(t, shortcutOf("space.new")))
          .child(div().text_size(10).text_color(t.muted).child("new space")))
        .child(keycap(t, shortcutOf("mod.open:search") || "alt f")))
      .child(h_flex().h(44).flex_none().px(13).gap(10).items_center().rounded(11)
        .border(1).border_color(wash(t.accent, live ? "70" : "2e")).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).flex_none().text_color(wash(t.muted, "cc")))
        .child(h_flex().flex_1().min_w(0).h_full().items_center()
          // The caret is drawn where text goes, not laid out beside it: over the
          // first character while the field is empty, right after the query once
          // there is one. Laid out, it pushed the text aside.
          .child(div().flex_1().min_w(0).flex().items_center()
            // The caret is a bar beside the text, sitting on the line's own height,
            // so it reads as the text cursor: just left of the first character
            // while the field is empty, just right of the query once there is one.
            .when(live && !this.filter, (el) => el.child(div().w(1).h(16).flex_none().ml(-1).rounded_full().bg(t.accent)
              .loop("opacity", { from: 0.15, to: 1, period: 900 })))
            .child(div().min_w(0).truncate().text_size(12.8).text_color(this.filter ? t.foreground : wash(t.muted, "e6"))
              .child(this.filter || "Search spaces, worktrees, agents…"))
            .when(live && Boolean(this.filter), (el) => el.child(div().w(1).h(16).flex_none().ml(1).rounded_full().bg(t.accent)
              .loop("opacity", { from: 0.15, to: 1, period: 900 })))))
        .when(Boolean(this.filter), (el) => el.child(div().id("pal-clear").size(20).flex_none().rounded(5)
          .flex().items_center().justify_center().text_color(t.muted)
          .hover((s) => s.bg(wash(t.foreground, "12")).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.filter = "";
            this.follow = null;
            this.at = 0;
            cx.notify();
          })
          .child(svg("mods/search/x.svg").size(12)))))
      .child(v_flex().id("pal-list")
        .on_size_change((size, cx) => { this.listHeight = size.height / settings().zoom; cx.notify(); })
        .on_scroll_wheel((e, cx) => this.wheel(e, cx))
        .on_mouse_move((e, cx) => this.overRow(e, cx))
        .on_mouse_up("left", (_e, cx) => this.dropRow(cx))
        .relative()
        .w_full().flex_1().min_h(0)
        .when(fixed, (el) => el.overflow_hidden())
        .when(!rows.length, (el) => el.child(v_flex().flex_1().gap(7).items_center().justify_center()
          .child(div().size(34).rounded(10).bg(wash(t.foreground, "08")).border(1).border_color(wash(t.foreground, "0e"))
            .flex().items_center().justify_center()
            .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.muted)))
          .child(div().text_size(12.5).font_medium().text_color(t.muted).child(this.filter ? "No matches" : "Nothing here yet"))
          .child(div().text_size(10.5).text_color(wash(t.muted, "cc"))
            .child(this.filter ? "Try a name, a branch, a folder, or a state." : "Create a space with the shortcut above."))))
        .children(rows.map((r, i) => (visible(i) ? at(row(r), i) : null)).filter(Boolean))
        // No scrollbar anywhere: the list is plain content, and its own edge
        // softens when there is more of it out of sight. Three strips of the
        // panel colour do the fade, so it works with every theme.
        .when(this.scroll > 0, (el) => el
          .child(div().absolute().top(0).left(0).right(0).h(5).bg(wash(t.popover, "cc")))
          .child(div().absolute().top(5).left(0).right(0).h(6).bg(wash(t.popover, "88")))
          .child(div().absolute().top(11).left(0).right(0).h(8).bg(wash(t.popover, "33"))))
        .when(this.scroll < maxScroll, (el) => el
          .child(div().absolute().bottom(0).left(0).right(0).h(5).bg(wash(t.popover, "cc")))
          .child(div().absolute().bottom(5).left(0).right(0).h(6).bg(wash(t.popover, "88")))
          .child(div().absolute().bottom(11).left(0).right(0).h(8).bg(wash(t.popover, "33")))))
      // The hint strip sits centred between its hairline and the panel's edge, so
      // it reads as a footer rather than as text pressed against the bottom.
      .child(h_flex().flex_none().gap(11).items_center().pt(18).border_t(1).border_color(wash(t.foreground, "08")).overflow_hidden()
        .when(Boolean(this.note), (el) => el.child(div().flex_none().max_w(240).truncate().text_size(10).text_color(t.accent).child(this.note)))
        .children(hints.map((h) => h_flex().flex_none().gap(5).items_center()
          .child(keycap(t, h.k))
          .child(div().text_size(10).text_color(t.muted).child(h.l)))));
  }
}
