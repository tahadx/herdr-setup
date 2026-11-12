// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, machines, run, exec, hc, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, watchFolder, home, notify } from "herdr";

// The block that shows a given mod, and the column around it.
function columnOf(node, mod, parent = null) {
  if (node?.content?.mod === mod) return parent;
  for (const child of node?.children ?? []) {
    const found = columnOf(child, mod, node);
    if (found) return found;
  }
  return null;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// The theme has no letter-spacing, so a label that has to read as a label at 9px
// gets a thin space between its characters. Caps at this size with none read as
// small text; with it they read as a heading.
const spaced = (s) => [...String(s)].join("\u2009");

// A colour from the theme with alpha, kept short: every tint in this mod is a
// wash over what is already there, so light and dark themes both work.
const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
  { id: "spaces", label: "Spaces with agents", icon: "folder" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
// The rail is a quick jump, not the whole list, and Ctrl+1…Ctrl+9 reach the
// first nine spaces anyway. Past that, one ellipsis stands for the rest.
const RAIL_MAX_SPACES = 9;
const railShown = (cells, limit) => {
  const shown = limit && cells.length > limit ? cells.slice(0, limit) : cells;
  return { shown, beyond: cells.length - shown.length };
};
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

const norm = (p) => (p ?? "").replace(/\\/g, "/");
// Herdr keeps linked checkouts at <home>/worktrees/<repo>/<branch>, so a space
// standing there is a worktree even before git has answered for it.
const inWorktrees = (folder) => /(?:^|\/)worktrees\/[^/]+\/[^/]+\/?$/.test(norm(folder ?? ""));
const base = (p) => norm(p).replace(/\/+$/, "").split("/").pop() ?? "";

// Space colours follow the palette's rule (shared "space.colors", least used
// first), so a space keeps one colour everywhere it is drawn. The tile is solid
// like the palette's avatars, so the white initial reads on it in both themes.
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
// One strong colour per hue, the same map Herdr's own spaces list draws its
// avatars from ("the same in every mod that draws space avatars"): a theme this
// muted has six greys to give, and six greys identify nothing. The tile is solid
// so the white initial reads on it in every theme.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const tintOf = (c, t) => (c.startsWith("#") ? c : (MARK[c] ?? t[c]));
function spaceColours() {
  const ids = new Set(spaces().map((s) => s.id));
  const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
  for (const s of spaces()) {
    if (kept[s.id] || s.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[s.id] = PROJECT_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}

// Where a space is now: its first terminal's live folder, else where it was made.
function placeOf(s, all) {
  const tabs = new Set((s.tabs ?? []).map((x) => x.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Pinned spaces are the palette's: the same shared list, written the same way,
// so pinning in one place shows in the other.
function pinnedSpaces() {
  const list = shared("spaces.pinned");
  return Array.isArray(list) ? list.filter((p) => p && (p.id || p.folder)) : [];
}
const sameSpacePin = (p, s) => (p.id && s.id
  ? p.id === s.id
  : (p.machine ?? null) === (s.machine ?? null) && norm(p.folder) === norm(s.folder));
function setSpacePin(s, on) {
  const list = pinnedSpaces();
  const mine = list.find((p) => sameSpacePin(p, s));
  if (on && !mine) {
    const folder = placeOf(s, panes()) ?? s.folder;
    if (!folder) return;
    setShared("spaces.pinned", [...list, { id: s.id, folder, machine: s.machine ?? null, name: s.name, named: Boolean(s.named) }]);
  } else if (!on && mine) {
    setShared("spaces.pinned", list.filter((p) => p !== mine));
  }
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
// A tinted glyph keeps the program's own colour: it is the program's mark, not
// theme text, and it must look the same in every theme.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// A count in a quiet pill. The number should read at a glance, not disappear
// into the rail.
const countPill = (t, n, tone = null) => div().flex_none().min_w(18).h(16).px(5).rounded(5)
  .bg(tone ? wash(tone, "16") : wash(t.foreground, "0a"))
  .border(1).border_color(tone ? wash(tone, "24") : wash(t.foreground, "0c"))
  .text_size(9).font_medium().text_color(tone ?? t.muted).flex().items_center().justify_center().child(String(n));

// The program on a tile of its own colour, the way the palette draws an agent.
// A known tile colour carries the program's identity; otherwise it is a quiet
// wash, so every row still lines up on the same left edge.
function appTile(t, p, size = 22, glyph = 14) {
  // A shell keeps the app's own terminal icon in the muted text colour: it is
  // not a brand, and the app's table paints it bright green.
  const plain = Boolean(p) && (p.shell || p.key === "shell");
  const known = !plain && /^#[0-9a-fA-F]{6}$/.test(p?.tile ?? "");
  const pic = icon(p, glyph, plain ? t.muted : (p?.color ?? t.foreground));
  return div().size(size).flex_none().rounded(size >= 22 ? 7 : 6)
    .bg(known ? wash(p.tile, "2e") : wash(t.foreground, "08"))
    .border(1).border_color(known ? wash(p.tile, "3c") : wash(t.foreground, "10"))
    .flex().items_center().justify_center()
    .when(Boolean(pic), (el) => el.child(pic))
    .when(!pic && !plain && Boolean(p?.name), (el) => el.child(div().text_size(size * 0.44).font_semibold().text_color(t.muted)
      .child(String(p.name).slice(0, 1).toUpperCase())))
    .when(!pic && (plain || !p?.name), (el) => el.child(svg(plain ? "mods/icons/terminal.svg" : "mods/icons/layers.svg").size(glyph).text_color(t.muted)));
}

export default class Agents extends View {
  init(_props, cx) {
    // A menu takes the keyboard from the moment it opens. Its handle has to be
    // made here: one made during render would be dropped on the next repaint.
    if (props()?.menu) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      // One git read, so "Remove worktree" is right for a checkout made outside
      // Herdr's own folder too. No timer: the menu is short-lived.
      const menu = props()?.menu ?? {};
      if (menu.kind === "space") {
        const s = spaces().find((x) => x.id === menu.id);
        const folder = s ? (placeOf(s, panes()) ?? s.folder) : null;
        if (s && folder) {
          cx.spawn(async (cx) => {
            try {
              const r = await exec("git", ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on: s.machine });
              const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
              if (r.code !== 0 || lines.length < 2) this.linked = false;
              else {
                const root = lines[0].trim();
                const common = lines[1].trim();
                this.linked = (common.endsWith("/.git") ? common.slice(0, -5) : common) !== root;
              }
            } catch {
              this.linked = false;
            }
            cx.notify();
          });
        }
      }
      return; // a menu draws and acts, nothing more
    }
    if (props()?.sortMenu) return;
    this.folded = new Set();
    this.hoveredSpace = null;
    // Git per place, as the spaces view reads it (branch, ahead/behind, linked).
    this.git = {};
    this.gitAt = {};
    this.trees = {};    // repo -> its checkouts, so an unopened worktree still shows
    this.treesAt = {};
    this.watching = new Set(); // folders already watched for git changes
    this.watchQueued = false;  // a burst of changes waits for one read
    // Machines as only hc knows them: connected, needs a login, unreachable.
    this.hcMachines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("agents.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.machinesFolded = new Set(JSON.parse(localStorage.getItem("agents.machines.folded") ?? "[]"));
    this.refreshMachines(cx, true);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    this.gitBusy = new Set();
    this.pressed = null; // a space being dragged
    this.over = null;   // the space row under the pointer
    this.pressSect = null; // the section it started in: drops stay inside it
    this.ids = "";
    this.created = undefined;
    this.refreshGit(cx, true);
    cx.timer.every(8000, (cx) => this.refreshGit(cx));
    // The rail owns the whole sidebar while collapsed, and gives it back when
    // the sidebar is dragged wider.
    this.fitRail();
    cx.timer.every(400, () => this.fitRail());
    this.watchRepo(cx, "worktrees", `${home()}/.herdr/worktrees`);
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    // The age labels are drawn in minutes, so one repaint a minute is enough:
    // a half-minute tick redrew the window for a number that had not moved.
    this.minute = Math.floor(Date.now() / 60000);
    cx.timer.every(5000, (cx) => {
      const now = Math.floor(Date.now() / 60000);
      if (now === this.minute) return;
      this.minute = now;
      cx.notify();
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  // Forget the places inside a folder that just changed, so the next read is
  // theirs and everything else stays cached.
  invalidate(dir) {
    const d = norm(dir).replace(/\/+$/, "");
    const inside = (f) => {
      const p = norm(f);
      return p === d || p.startsWith(`${d}/`);
    };
    for (const key of Object.keys(this.gitAt)) if (inside(key.split("\u0000")[1] ?? "")) delete this.gitAt[key];
    // A checkout list only changes for the repo the folder belongs to: the one
    // whose checkout holds it, or whose name the worktrees folder carries.
    const wt = d.match(/^(.*\/worktrees)\/([^/]+)/);
    for (const key of Object.keys(this.treesAt)) {
      const main = key.split("\u0000")[1] ?? "";
      if (inside(main) || (wt && base(main) === wt[2])) delete this.treesAt[key];
    }
  }

  refreshMachines(cx, force = false) {
    if (!force && sortOf().id !== "spaces") return;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.hcMachines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      cx.notify();
    });
  }

  // A machine that was rebuilt or replaced answers with another core: its
  // identity no longer matches, and it has to be paired again under the same name.
  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = (this.reconnecting[name] ??= { machine, removed: false });
    state.busy = true;
    state.error = null;
    localStorage.setItem("agents.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const ask = async (args) => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("agents.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        await ask(args);
        this.machinesFolded.delete(name);
        localStorage.setItem("agents.machines.folded", JSON.stringify([...this.machinesFolded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e?.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("agents.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // Watch a folder: a commit, a checkout or a new worktree read git at once
  // instead of waiting for the timer, the way the default spaces list does.
  // A burst (a build, a save loop) is read once after it settles, not per file.
  watchRepo(cx, key, dir) {
    if (this.watching.has(key)) return;
    this.watching.add(key);
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(dir);
        } catch {
          return; // a folder that can't be watched keeps the timer as its clock
        }
        this.invalidate(dir);
        if (this.watchQueued) continue;
        this.watchQueued = true;
        cx.timer.after(700, (cx) => {
          this.watchQueued = false;
          this.refreshGit(cx);
        });
      }
    });
  }

  // Branch, ahead/behind and whether a checkout is a linked worktree: the two
  // git calls the default spaces list makes, cached per place for a while.
  refreshGit(cx, force = false) {
    // Nothing here is on screen in the other views, so the timer costs nothing
    // there; entering the view forces one pass (see render).
    if (!force && sortOf().id !== "spaces") return;
    cx.spawn(async (cx) => {
      const ps = panes();
      const seen = new Set();
      let changed = false;
      for (const s of spaces()) {
        const folder = placeOf(s, ps);
        if (!folder) continue;
        const key = `${s.machine ?? ""}\u0000${folder}`;
        seen.add(key);
        if (this.gitBusy.has(key) || (!force && Date.now() - (this.gitAt[key] ?? 0) < 15000)) continue;
        const before = JSON.stringify(this.git[key]);
        this.gitBusy.add(key);
        try {
          // One call for the checkout, its git dir and its branch; ahead/behind
          // from rev-list, which reads refs only (git status would walk the files).
          const top = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], { cwd: folder, on: s.machine });
          const lines = (top.stdout ?? "").trim().split("\n").filter(Boolean);
          if (top.code !== 0 || lines.length < 3) {
            this.git[key] = null;
          } else {
            const root = lines[0].trim();
            const common = lines[1].trim();
            const branch = lines[2].trim() === "HEAD" ? null : lines[2].trim();
            const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
            const ab = await exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd: folder, on: s.machine });
            const [behind, ahead] = ab.code === 0 ? (ab.stdout ?? "").trim().split(/\s+/).map(Number) : [0, 0];
            this.git[key] = {
              name: main.replace(/\/+$/, "").split("/").pop(),
              branch,
              ahead: ahead || 0,
              behind: behind || 0,
              repo: `${s.machine ?? ""}\u0000${main}`,
              root,
              linked: main !== root,
            };
            // Which checkouts the repo has, so a worktree nobody opened yet is
            // still listed under it (the search sheet's rule).
            if (!s.machine) this.watchRepo(cx, `repo:${main}`, main);
            if (main === root && (force || Date.now() - (this.treesAt[`${s.machine ?? ""}\u0000${main}`] ?? 0) > 15000)) {
              try {
                const repoKey = `${s.machine ?? ""}\u0000${main}`;
                const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd: main, on: s.machine });
                const refs = await exec("git", ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], { cwd: main, on: s.machine });
                const when = new Map((refs.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
                const trees = [];
                for (const block of (list.stdout ?? "").split(/\n\n+/)) {
                  const lines = block.split("\n");
                  const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
                  if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
                  const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
                  trees.push({ path, branch, at: branch ? (when.get(branch) ?? 0) : 0 });
                }
                this.trees[repoKey] = trees.filter((c) => norm(c.path) !== norm(main)).sort((a, b) => b.at - a.at);
                this.treesAt[repoKey] = Date.now();
              } catch {
                this.trees[`${s.machine ?? ""}\u0000${main}`] = this.trees[`${s.machine ?? ""}\u0000${main}`] ?? [];
              }
            }
          }
        } catch {
          this.git[key] = this.git[key] ?? null;
        } finally {
          this.gitBusy.delete(key);
          this.gitAt[key] = Date.now();
        }
        if (before !== JSON.stringify(this.git[key])) changed = true;
      }
      // Forget places nobody stands in any more.
      for (const key of Object.keys(this.git)) if (!seen.has(key)) delete this.git[key];
      if (changed) cx.notify();
    });
  }

  // Only what's unusual, after the name: "herdr · spike ↑2 ↓1". The repo or the
  // branch goes when the name already says it, and master/main go: nearly every
  // space is on one. Same rule as the default spaces list.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    // Three slots on the right, each its own width, so a branch coming and going
    // never moves the counts, and the counts line up down the list.
    const count = (n, glyph, tone) => div().w(24).flex_none().text_right().text_size(10)
      .font_medium().text_color(tone).child(`${glyph}${n}`);
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .when(Boolean(repo), (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(repo)))
      .when(Boolean(branch), (el) => el.child(div().flex_none().max_w(104).truncate().px(5).h(16).rounded(4)
        .bg(wash(t.foreground, "07")).text_size(9.5).text_color(t.dim).flex().items_center().child(branch)))
      .when(g.ahead > 0, (el) => el.child(count(g.ahead, "\u2191", t.ansi2)))
      .when(g.behind > 0, (el) => el.child(count(g.behind, "\u2193", t.ansi1)));
  }

  // Right-click menus, in the sidebar's own style (sidebar-menu's rows) rather than
  // the shipped ones, so every dialog behind them is ours: worktrees for the
  // worktrees and the close confirmation, the app's own prompt for a rename.
  spaceMenu(s) {
    openOverlay({ mod: "agents-list", kind: "popup", width: 234, props: { menu: { kind: "space", id: s.id } } });
  }

  agentMenu(a) {
    openOverlay({ mod: "agents-list", kind: "popup", width: 234, props: { menu: { kind: "agent", id: a.address } } });
  }

  checkoutMenu(path, machine) {
    openOverlay({ mod: "agents-list", kind: "popup", width: 234, props: { menu: { kind: "checkout", id: path, machine: machine ?? null } } });
  }

  // The menu is a list of rows; every action closes it first, so the dialog it
  // opens is the only thing left on screen. It reads what it needs itself: an
  // overlay is a separate copy with no state from the sidebar's own instance.
  menuView(t, cx) {
    const menu = props()?.menu ?? {};
    const close = () => closeOverlay(props()?.overlay);
    const then = (fn) => () => { close(); fn(); };
    const SEP = { sep: true };
    let items;

    if (menu.kind === "agent") {
      const a = agents().find((x) => x.address === menu.id);
      if (!a) return div();
      const listed = new Map(agents().map((x) => [x.address, x]));
      const stop = then(() => {
        if (a.parent) {
          notify({ title: "A sub-agent ends with its parent", body: `${a.program?.name ?? a.title ?? a.address} reports to ${a.parent}` });
          return;
        }
        openOverlay({ mod: "worktrees", kind: "dialog", width: 440, height: 156, props: { agent: a.address } });
      });
      items = [
        { id: "am-focus", icon: "terminal", label: "Focus", act: then(() => run("pane.focus", { pane: a.pane })) },
        ...(listed.has(a.address) ? [] : [{ id: "am-peek", icon: "search", label: "Peek", act: then(() => run("terminal.peek", { terminal: a.address })) }]),
        { id: "am-pin", icon: a.pinned ? "pin-off" : "pin", label: a.pinned ? "Unpin" : "Pin to the top",
          act: then(() => run("terminal.pin", { terminal: a.address, pinned: !a.pinned })) },
        SEP,
        { id: "am-stop", icon: "x", label: "Stop", act: stop },
      ];
    } else if (menu.kind === "checkout") {
      const path = menu.id;
      const on = menu.machine ?? null;
      items = [
        { id: "cm-open", icon: "folder", label: "Open as a space",
          act: then(() => run("space.new", { folder: path, ...(on ? { machine: on } : {}) })) },
        { id: "cm-remove", icon: "minus", label: "Remove worktree",
          act: then(() => openOverlay({ mod: "worktrees", kind: "dialog", width: 440, height: 155, props: { folder: path, machine: on, action: "remove" } })) },
      ];
    } else {
      const s = spaces().find((x) => x.id === menu.id);
      if (!s) return div();
      const pin = pinnedSpaces().find((p) => sameSpacePin(p, s)) ?? null;
      const folder = placeOf(s, panes()) ?? s.folder ?? null;
      // A linked checkout is a worktree: it hangs under its repo, and pins are
      // for spaces, so neither the row nor this menu offers to pin it.
      const isWorktreeSpace = inWorktrees(folder) || Boolean(this.linked);
      const worktree = (action, width, height, extra = {}) => then(() => {
        if (action === "new") setShared("worktree.owner", { space: s.id, at: Date.now() });
        openOverlay({ mod: "worktrees", kind: "dialog", width, height, props: { space: s.id, action, ...extra } });
      });
      const closeSpace = then(() => openOverlay({ mod: "worktrees", kind: "dialog", width: 440, height: 150, props: { space: s.id, action: "space" } }));
      items = [
        { id: "sm-new-wt", icon: "git-branch", label: "New worktree", act: worktree("new", 460, 170, folder ? { folder } : {}) },
        { id: "sm-open-wt", icon: "folder", label: "Open worktree", act: worktree("open", 560, 480) },
        // A linked checkout is known from its path, so this row never waits on git.
        ...(inWorktrees(folder) || this.linked ? [{ id: "sm-remove-wt", icon: "minus", label: "Remove worktree", act: worktree("remove", 440, 155) }] : []),
        SEP,
        ...(isWorktreeSpace ? [] : [{ id: "sm-pin", icon: pin ? "pin-off" : "pin", label: pin ? "Unpin space" : "Pin space to the top",
          act: then(() => setSpacePin(s, !pin)) }]),
        { id: "sm-rename", icon: "square-pen", label: "Rename", act: then(() => run("space.rename", { id: s.id })) },
        SEP,
        // A pinned space is never closed: the row is not offered, so the menu
        // cannot lead to a dialog that would only refuse.
        ...(pin ? [] : [{ id: "sm-close", icon: "x", label: "Close space", act: closeSpace }]),
        { id: "sm-new-space", icon: "plus", label: "New space", act: then(() => run("space.new")) },
      ];
    }

    // Arrow keys and Enter move and run, as in the sidebar's own menu; Esc closes.
    const pick = items.filter((it) => !it.sep);
    const at = Math.min(this.at ?? 0, pick.length - 1);
    const handle = this.handle;
    const step = (dir, cx) => {
      this.at = (at + dir + pick.length) % pick.length;
      handle?.focus();
      cx.notify();
      cx.stop_propagation();
    };
    const row = (it, i) => {
      const sel = i === at;
      return h_flex()
        .id(it.id)
        .h(32)
        .flex_none()
        .px(8)
        .gap(10)
        .items_center()
        .rounded(7)
        .text_color(sel ? t.foreground : t.muted)
        .when(sel, (el) => el.bg(wash(t.foreground, "0b")))
        .hover((x) => x.bg(wash(t.foreground, "0b")).text_color(t.foreground))
        .cursor_pointer()
        .on_click(it.act)
        .child(svg(`mods/icons/${it.icon}.svg`).size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(it.label));
    };
    let seen = -1;
    return v_flex().id(menu.kind === "agent" ? "agent-menu" : "space-menu").p(6).gap(1).bg(t.popover).text_size(13)
      .when(Boolean(handle), (el) => el.track_focus(handle).on_key_down((e, cx) => {
        if (e.key === "escape" || e.key === "q") { close(); cx.stop_propagation(); }
        else if (e.key === "down") step(1, cx);
        else if (e.key === "up") step(-1, cx);
        else if (e.key === "enter") {
          pick[at]?.act();
          cx.stop_propagation();
        }
      }))
      .children(items.map((it) => (it.sep ? div().h(1).mx(4).my(3).bg(wash(t.foreground, "09")) : row(it, ++seen))));
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(6)
      .bg(t.popover)
      .text_size(12.5)
      .child(div().px(8).pt(5).pb(7).text_size(10).font_semibold().text_color(t.muted).child("SORT AGENTS"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(32)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(s.id === on ? t.foreground : t.muted)
        .when(s.id === on, (el) => el.bg(wash(t.accent, "14")))
        .hover((el) => el.bg(wash(t.foreground, "0c")).text_color(t.foreground))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(s.id === on ? t.accent : t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(13).flex_none().text_color(t.accent)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .relative()
      .pl(40)
      .pr(7)
      .rounded(7)
      .h(27)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(11.5)
      .hover((s) => s.bg(wash(t.foreground, "0b")))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(18).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(wash(t.foreground, "1c")))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .child(div().mr(8).child(appTile(t, k.program, 18, 11.5).when(on, (el) => el.border_color(wash(t.accent, "70")))))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground)
        .when(on, (el) => el.font_medium())
        .child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // Collapsed, this mod is the whole sidebar: the blocks below it have nothing
  // to show at 44 px — their mods draw nothing there — so they step aside and
  // the rail's controls land on the window's bottom edge instead of at the
  // bottom of one third of it. Only the blocks this put away are put back, and
  // the list is remembered, so a restart while collapsed restores them too.
  fitRail() {
    const hid = JSON.parse(localStorage.getItem("rail.hid") ?? "[]");
    const sidebar = find(layout(), "sidebar");
    if (narrow() && sidebar && !sidebar.hidden) {
      if (hid.length) return;
      // Everything in the sidebar that is not on this block's path: a block
      // below the rail has nothing to draw at 44 px, and a nested column around
      // it is not a block at all, so both kinds go — the whole sidebar becomes
      // the rail, at any depth the layout happens to use.
      const holds = (n) => n?.content?.mod === "agents-list" || (n.children ?? []).some(holds);
      const ids = [];
      const collect = (node) => {
        for (const child of node?.children ?? []) {
          if (holds(child)) collect(child);
          else if (child.id && !child.hidden) ids.push(child.id);
        }
      };
      collect(sidebar);
      if (!ids.length) return;
      localStorage.setItem("rail.hid", JSON.stringify(ids));
      for (const id of ids) run("layout.hide", { id });
    } else if (hid.length) {
      for (const id of hid) run("layout.show", { id });
      localStorage.removeItem("rail.hid");
    }
  }

  // The rail: a column of numbered cells, whatever the list is showing — spaces
  // in the spaces view, agents elsewhere — then search, shortcuts and settings.
  rail(t, cells, id, limit = null) {
    const { shown, beyond } = railShown(cells, limit);
    return v_flex().size_full().min_h(0).bg(t.chrome).items_center().pt(12).gap(2)
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "sidebar-menu", kind: "popup", width: 250 }); })
      .child(this.iconButton(t, "rail-expand", "mods/workspace-chrome/chevron-right.svg", "Show sidebar", toggleSidebar, 13))
      .child(div().w(16).h(1).my(3).bg(wash(t.foreground, "10")))
      // items_center here is what centres a cell in the 44 px rail: the cells
      // column is its own box, so the rail's own centring does not reach them.
      .child(v_flex().id(id).flex_1().min_h(0).gap(2).items_center().overflow_y_scrollbar()
        .children([
          ...shown.map((c) => h_flex()
            .id(`rail-${c.key}`)
            .relative()
            .size(26)
            .flex_none()
            .rounded(6)
            .items_center()
            .justify_center()
            .when(c.active, (x) => x.bg(t.selected))
            .when(!c.active, (x) => x.hover((y) => y.bg(t.hover)))
            .tooltip(c.tip)
            .on_click(c.act)
            .child(div().text_size(10.5).text_color(c.active ? t.foreground : t.muted).child(String(c.n)))
            .child(div().absolute().right(4).bottom(4).size(5).rounded_full().bg(t[c.status] ?? t.dim))),
          ...(beyond > 0 ? [h_flex()
            .id("rail-more")
            .size(26)
            .flex_none()
            .rounded(6)
            .items_center()
            .justify_center()
            .text_color(t.muted)
            .cursor_pointer()
            .hover((x) => x.bg(t.hover).text_color(t.foreground))
            .tooltip(`${beyond} more ${beyond === 1 ? "space" : "spaces"} — show the sidebar`)
            .on_click(toggleSidebar)
            .child(div().text_size(12).child("…"))] : []),
        ]))
      .child(this.iconButton(t, "rail-search", "mods/icons/search.svg", "Search \u00b7 Alt+F",
        () => run("mod.open", { name: "search" })))
      .child(this.iconButton(t, "rail-keys", "mods/icons/keyboard.svg", "Keyboard shortcuts",
        () => run("mod.open", { name: "shortcuts" })))
      .child(this.iconButton(t, "rail-settings", "mods/icons/settings.svg", "Settings",
        () => run("app.settings")))
      .child(div().h(8).flex_none());
  }

  // A header control: 26px, quiet until hovered, tinted while it holds a view.
  iconButton(t, id, icon, tip, action, size = 14, active = false) {
    return div().id(id).size(26).flex_none().rounded(7).flex().items_center().justify_center()
      .text_color(active ? t.accent : t.muted)
      .when(active, (s) => s.bg(wash(t.accent, "14")))
      .when(!active, (s) => s.hover((x) => x.bg(wash(t.foreground, "0e")).text_color(t.foreground)))
      .tooltip(tip)
      .on_click(action)
      .child(svg(icon).size(size));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(11.5).mx(1).flex_none().text_color(t.accent).spin(900).tooltip("Working");
    if (a.status === "blocked" && compact) return div().size(15).flex_none().rounded(4).bg(wash(t.blocked, "24")).text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().tooltip("Needs you").child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(wash(t.blocked, "20")).text_size(9.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a filled dot. Both calm enough to scan past.
    if (a.status === "idle") return div().size(6).mx(3).flex_none().rounded(3).border(1.5).border_color(t.idle ?? t.dim).tooltip("Idle");
    return div().size(6).mx(3).flex_none().rounded(3).bg(a.status === "done" ? color : t.dim + "00").tooltip(a.status === "done" ? "Done" : "Unknown");
  }

  // ── Priority and Grouped by space: Herdr's own list, unspecialised ────────
  // These two views are the app's, not this mod's: small program icons, a row
  // that reads "space · detail", a quiet group heading, a paragraph when nothing
  // has reported yet. Only the third view below draws spaces the way this mod
  // does. Keeping them apart is what lets each be what it is.

  // compact: a ! for blocked where a header already says "Needs you".
  plainStatus(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  // A sub-agent: the tree lines in front of it, then its own name.
  plainSubRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map((l) => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.plainStatus(t, { status: st }, compact));
  }

  // The fold chevron; folded, the count too, colored by the most urgent one.
  plainFold(a, subs) {
    const sts = subs.map((s) => kidStatus(s.t, this.listed));
    const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
    const open = !this.folded.has(a.address);
    return div()
      .id(`fold-${a.address}`)
      .h(18)
      .px(3)
      .gap(3)
      .flex()
      .items_center()
      .rounded(4)
      .text_size(11)
      .text_color(open ? t.dim : (t[top] ?? t.dim))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stopPropagation ? cx.stopPropagation() : cx.stop_propagation();
        open ? this.folded.add(a.address) : this.folded.delete(a.address);
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .when(!open, (el) => el.child(String(subs.length)));
  }

  plainList(t, cx) {
    const collapsed = narrow();
    const sort = sortOf();
    const byPriority = sort.id === "priority";
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const rankOf = (a) => RANK[a.status] ?? 0;
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.plainSubRow(t, s, shown, byPriority))];
    };

    // A row reads "space · detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const labels = new Map(list.map((a) => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map((a) => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.plainStatus(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        // The inline pin is gone from this list too; the menu still offers it.
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.agentMenu(a); })
        .when(Boolean(pic), (el) => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, (el) => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, (el) => el.child(this.plainFold(a, subs)))
        .when(Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.plainStatus(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.plainStatus(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    // Narrowed, the same rail as the spaces view, holding the agents' numbers.
    if (collapsed) return this.rail(t, list.map((a, i) => ({
      key: a.address,
      n: i + 1,
      tip: a.space_name ? `${a.space_name} \u00b7 ${a.program?.name ?? a.address}` : (a.program?.name ?? a.address),
      active: a.focused,
      status: a.status,
      act: () => run("pane.focus", { pane: a.pane }),
    })), "rail-agents");

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .pl(12)
            .pr(6)
            .h(38)
            .pt(8)
            .pb(2)
            .flex_none()
            .gap(2)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(this.iconButton(t, "ag-sort", `mods/workspace-chrome/${sort.icon}.svg`, `Sort agents: ${sort.label}`,
              () => openOverlay({ mod: "agents-list", kind: "popup", width: 230, height: 172, props: { sortMenu: true } }), 13, sort.id !== "priority"))
            .child(this.iconButton(t, "ag-search", "mods/icons/search.svg", "Search \u00b7 Alt+F",
              () => run("mod.open", { name: "search" })))
            .child(this.iconButton(t, "ag-hide", "mods/icons/sidebar.svg", "Hide sidebar", toggleSidebar)),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(14).pt(4).text_size(12).text_color(t.dim)
          .child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      // Room on the right for the scrollbar gutter, so it cannot clip the rows.
      .child(v_flex().id("ag-list").flex_1().min_h(0).pl(8).pr(12).py(0).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => {
          if (this.pressed !== null) {
            this.pressed = null;
            this.over = null;
            cx.notify();
          }
        })
        .children(rows));
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.menu) return this.menuView(t, cx);
    // Priority and Grouped by space are Herdr's own list; only the third view is
    // drawn the way this mod draws spaces.
    if (sortOf().id !== "spaces") return this.plainList(t, cx);
    const collapsed = narrow();
    // Search, sort and hide live in the header; the count gives way first when
    // the sidebar is narrow.
    const roomy = (find(layout(), "sidebar")?.size?.px ?? Infinity) >= 210;
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const bySpaces = sort.id === "spaces";
    // Spaces and worktrees are git reads, so they wait for the timer — unless
    // something just changed. A new space, or a worktree the dialog finished
    // making, reads git again at once instead of up to a tick later.
    if (bySpaces && this.shownView !== "spaces") {
      this.shownView = "spaces";
      this.refreshGit(cx, true);
      this.refreshMachines(cx, true);
    } else if (!bySpaces) {
      this.shownView = sort.id;
    }
    const idsNow = spaces().map((s) => s.id).join(",");
    const createdNow = shared("worktree.created");
    if (idsNow !== this.ids || createdNow !== this.created) {
      this.ids = idsNow;
      this.created = createdNow;
      if (this.ids) this.refreshGit(cx, true);
    }
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i, nest = 0) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs, nest);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(20)
        .px(4)
        .gap(3)
        .flex()
        .items_center()
        .rounded(5)
        .text_size(10.5)
        .text_color(open ? t.muted : (t[top] ?? t.muted))
        .cursor_pointer()
        .hover((s) => s.bg(wash(t.foreground, "0e")).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const paneList = panes();
    const leads = leadPanes(paneList);
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = [], nest = 0) => {
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(28)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .when(a.focused, (el) => el.bg(wash(t.accent, "18")))
          .when(!a.focused, (el) => el.hover((s) => s.bg(wash(t.foreground, "0c"))))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_size(10.5).text_right().text_color(a.focused ? t.foreground : wash(t.muted, "cc")).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .relative()
        .mx(2)
        .pl(6 + nest * 29)
        .pr(6)
        .h(30)
        .flex_none()
        .rounded(7)
        .items_center()
        .gap(7)
        .overflow_hidden()
        .cursor_pointer()
        .hover((s) => s.bg(wash(t.foreground, "0b")))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.agentMenu(a); })
        .when(nest > 0, (el) => el.child(div().absolute().left(30).top(0).bottom(0).w(1).bg(wash(t.foreground, "12"))))
        .when(nest > 0, (el) => el.child(div().absolute().left(30).top(17).w(7).h(1).bg(wash(t.foreground, "12"))))
        .child(div().id(`agent-fold-${a.address}`).flex_none()
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(appTile(t, a.program, 20, 13).when(a.focused, (el) => el.border_color(wash(t.accent, "70")))))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().flex_1().min_w(0).max_w(full && more ? 150 : 200).truncate().text_size(12.5)
            .when(a.focused, (el) => el.font_medium())
            .text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_none().max_w(84).truncate().px(5).h(17).rounded(4)
            .bg(wash(t.foreground, "08")).text_size(9.5).text_color(t.dim).flex().items_center().child(more))))
        .when(Boolean(machine), el => el.child(div().max_w(60).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        // A pin belongs to a space: an agent's pin is in its right-click menu,
        // not on the row. The slot keeps the age, so widths do not move.
        .child(div().w(26).flex_none().flex().items_center().justify_end()
          .when(Boolean(when), (el) => el.child(div().flex_none().text_size(10).text_color(wash(t.muted, "cc")).child(duration(now - when)))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    let rows;
    if (bySpaces) {
      // The default spaces list's rows (avatar, name as given, git tail, drag to
      // reorder, right-click menu) with the palette's tree under them: a section
      // per space urgency, every space listed, worktrees under their checkout,
      // and each space's agents one level in.
      const allSpaces = spaces();
      const colours = spaceColours();
      const pins = pinnedSpaces();
      const pinOf = (s) => pins.find((p) => sameSpacePin(p, s)) ?? null;
      const kidsOf = new Map();
      for (const a of list) kidsOf.set(a.space, [...(kidsOf.get(a.space) ?? []), a]);

      // Git as the default list reads it: repo, branch, ahead/behind, and whether
      // this checkout is a linked worktree.
      const info = new Map(allSpaces.map((s) => [s.id, this.git[`${s.machine ?? ""}\u0000${placeOf(s, paneList) ?? ""}`] ?? null]));
      // Until git answers (or where it can't), Herdr's own worktree folder decides.
      const repoOf = (s) => norm(s.folder).match(/\/worktrees\/([^/]+)\//)?.[1] ?? null;
      // "Spaces" means places to work, not the checkouts under them: a worktree
      // space is drawn under its repo, and counting it again read as a space
      // nobody could see. Agents are not spaces either.
      const isWorktree = (s) => Boolean(info.get(s.id)?.linked) || Boolean(repoOf(s));
      this.spaceCount = allSpaces.filter((s) => !isWorktree(s)).length;

      // Which space a worktree belongs under: the one it was just made from, else
      // the one named like its repo, else the first checkout of that repo. Two
      // spaces can stand in one checkout, so "first" alone would pick the wrong
      // one after the other's agent cd'd there.
      const owner = shared("worktree.owner");
      const ownerId = owner && Date.now() - (owner.at ?? 0) < 2 * 60000 ? owner.space : null;
      // A worktree just made from a folded space opens it, or it would land unseen.
      if (ownerId) this.folded.delete(`sp-${ownerId}`);
      const parentOf = (s) => {
        const g = info.get(s.id);
        if (g) {
          if (!g.linked) return null;
          const kin = allSpaces.filter((p) => p.id !== s.id && info.get(p.id) && !info.get(p.id).linked && info.get(p.id).repo === g.repo);
          return kin.find((p) => p.id === ownerId) ?? kin.find((p) => p.name === g.name) ?? kin[0] ?? null;
        }
        const repo = repoOf(s);
        if (!repo) return null;
        const kin = allSpaces.filter((p) => p.id !== s.id && base(p.folder) === repo);
        return kin.find((p) => p.id === ownerId) ?? kin[0] ?? null;
      };
      // A worktree is nested only when a parent is there to draw it under, so it
      // can never fall out of both lists. Nested worktrees of worktrees stay
      // top-level: the tree is two levels deep.
      const isNested = (s) => Boolean(parentOf(s)) && !parentOf(parentOf(s));
      const worktreesOf = (s) => allSpaces.filter((w) => parentOf(w)?.id === s.id);

      // A section header: the same ribbon the other views use, for a rank.
      const sectionHeader = (id, label, status, count) => {
        sections.add(id);
        const open = !this.folded.has(id);
        const tone = status === "working" ? t.accent : (status ? (t[status] ?? t.dim) : null);
        return h_flex()
          .id(id)
          .mx(2)
          .pl(7)
          .pr(5)
          .h(26)
          .mt(6)
          .flex_none()
          .gap(6)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((s) => s.bg(wash(t.foreground, "05")))
          .on_click((_e, cx) => {
            open ? this.folded.add(id) : this.folded.delete(id);
            cx.notify();
          })
          .when(Boolean(tone), (el) => el.child(div().size(5).flex_none().rounded_full().bg(tone)))
          .child(div().flex_none().text_size(9).font_semibold().text_color(tone ?? t.dim).child(spaced(label.toUpperCase())))
          // Open, the count is a quiet number beside the label; folded it is the
          // only thing left saying how much is inside, so it earns a pill.
          .when(open, (el) => el.child(div().flex_none().text_size(8.5).font_medium().text_color(t.dim).child(String(count))))
          .when(!open, (el) => el.child(countPill(t, count)))
          .child(div().h(1).flex_1().bg(wash(t.foreground, "07")))
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim));
      };

      // One space, drawn the way the default list draws it: avatar (a branch for
      // a worktree), the name as given, and only what's unusual on the right.
      const spaceRow = (s, kids, depth, sect) => {
        const id = `sp-${s.id}`;
        const open = !this.folded.has(id);
        const g = info.get(s.id);
        const tree = depth > 0;
        const pin = pinOf(s);
        const fill = s.name === "~" ? t.dim : tintOf(colours[s.id] ?? PROJECT_COLORS[0], t);
        // Folded, it still says what is hidden, and how urgent the agents inside
        // are: a chevron alone made "2 agents need you in here" invisible.
        const hidden = open ? 0 : kids.length + worktreesOf(s).length + checkoutsOf(s).length;
        const top = kids.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
        const topTone = top === "blocked" ? t.blocked : top === "done" ? t.done : top === "working" ? t.accent : null;
        const index = allSpaces.indexOf(s);
        const from = this.pressed === null ? -1 : allSpaces.findIndex((x) => x.id === this.pressed);
        const hovered = this.hoveredSpace === s.id;
        return h_flex()
          .id(id)
          .relative()
          .mx(2)
          .pl(tree ? 36 : 7)
          .pr(3)
          .h(tree ? 28 : 30)
          .flex_none()
          .gap(7)
          .items_center()
          .rounded(7)
          .overflow_hidden()
          .when(s.active, (el) => el.bg(t.selected))
          .when(!s.active, (el) => el.hover((x) => x.bg(t.hover)))
          .when(this.pressed === s.id && this.over !== s.id, (el) => el.opacity(0.45))
          .when(this.pressed !== null && this.pressSect === sect && this.over === s.id && this.pressed !== s.id, (el) => el.child(div()
            .absolute().left(6).right(6).h(2).rounded(1).bg(t.accent)
            .when(from < index, (l) => l.bottom(0))
            .when(from > index, (l) => l.top(0))))
          .on_mouse_down("left", () => { this.pressed = s.id; this.over = s.id; this.pressSect = sect; })
          .on_mouse_move((_e, cx) => {
            // A row in another section is not a place to drop: the sections are
            // the urgency, so a move there would be undone on the next status.
            const over = this.pressed === null || this.pressSect !== sect ? null : s.id;
            if (this.over !== over) { this.over = over; cx.notify(); }
          })
          .on_mouse_up("left", (_e, cx) => {
            const was = this.pressed;
            const same = this.pressSect === sect;
            const over = same ? this.over : null;
            this.pressed = null;
            this.over = null;
            this.pressSect = null;
            if (was !== null && over === s.id && was !== s.id) {
              const at = spaces().findIndex((x) => x.id === s.id);
              if (at !== -1) run("space.move", { id: was, index: at + 1 });
            } else if (was === s.id) run("space.select", { id: s.id });
            cx.notify();
          })
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.spaceMenu(s); })
          .on_hover((on, cx) => {
            if (on) this.hoveredSpace = s.id;
            else if (this.hoveredSpace === s.id) this.hoveredSpace = null;
            cx.notify();
          })
          // The one the window shows: a spine down its edge, the way the app
          // marks the pane you are in, and a name that steps forward.
          .when(s.active, (el) => el.child(div().absolute().left(0).top(6).bottom(6).w(2).rounded(1).bg(t.accent)))
          // A worktree runs under its checkout on a hairline, so the two levels
          // read as one tree rather than as two indents.
          .when(tree, (el) => el.child(div().absolute().left(30).top(0).bottom(0).w(1).bg(wash(t.foreground, "12"))))
          .when(tree, (el) => el.child(div().absolute().left(30).top(15).w(7).h(1).bg(wash(t.foreground, "12"))))
          .when(tree, (el) => el.child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(t.dim)))
          .when(!tree, (el) => el.child(div().size(18).flex_none().rounded(5).bg(fill).relative()
            .flex().items_center().justify_center()
            .border(1).border_color(s.active ? wash(t.accent, "66") : wash(t.foreground, "17"))
            .text_size(9).font_semibold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?")
            // Pinned is the one section not named after a state, so there the
            // tile carries it as a bead on the corner, like a portrait's status.
            .when(/pinned$/.test(sect) && Boolean(s.status) && s.status !== "idle", (el) => el.child(div()
              .absolute().right(-2).bottom(-2).size(6).flex_none().rounded_full()
              .bg(s.status === "working" ? t.accent : (t[s.status] ?? t.dim))
              .border(1).border_color(t.chrome)
              .tooltip(s.status === "blocked" ? "Needs you" : s.status === "done" ? "Done" : "Working")))))
          .child(div().flex_shrink(1).min_w(30).max_w(150).truncate().text_size(12)
            .when(s.active, (el) => el.font_medium())
            .text_color(s.active ? t.foreground : wash(t.foreground, "e6")).child(s.name))
          .child(g ? this.gitTail(g, tree, s.name, t) : div().flex_1())
          .when(hidden > 0, (el) => el.child(countPill(t, hidden, topTone)))
          .child(div().size(18).flex_none().flex().items_center().justify_center()
            .when(kids.length > 0 || worktreesOf(s).length > 0, (el) => el.child(div()
            .id(`sfold-${s.id}`)
            .size(18)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(5)
            .hover((x) => x.bg(wash(t.foreground, "0e")))
            .on_mouse_down("left", (_e, cx) => {
              cx.stop_propagation();
              open ? this.folded.add(id) : this.folded.delete(id);
              cx.notify();
            })
            .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim)))))
          // A pin is a state, not a button: quiet while the row is at rest, so a
          // column of them reads as a stripe instead of five buttons. And a pin
          // belongs to a space: a worktree is a checkout drawn under its repo,
          // not a place of its own to keep.
          .child(div().w(20).flex_none().flex().items_center().justify_center()
            .when(!tree && (Boolean(pin) || hovered), (el) => el.child(div()
            .id(`spin-${s.id}`)
            .size(18)
            .flex_none()
            .rounded(5)
            .flex().items_center().justify_center()
            .text_color(pin ? (hovered ? t.accent : wash(t.accent, "8c")) : t.muted)
            .when(Boolean(pin) && hovered, (x) => x.bg(wash(t.accent, "14")))
            .cursor_pointer()
            .hover((x) => x.bg(wash(t.foreground, "10")).text_color(t.foreground))
            .tooltip(pin ? "Unpin space" : "Pin space to the top")
            .on_mouse_down("left", (_e, cx) => {
              cx.stop_propagation();
              setSpacePin(s, !pin);
              this.hoveredSpace = null;
              cx.notify();
            })
            .child(svg(`mods/icons/${pin && hovered ? "pin-off" : "pin"}.svg`).size(12)))));
      };

      // Checkouts of this space's repo that no space stands in: listed like a
      // worktree, opened into one. The same rule the search sheet uses.
      const spaceAtPath = (path, on) => allSpaces.find((x) => (x.machine ?? null) === (on ?? null)
        && (norm(placeOf(x, paneList) ?? "") === norm(path) || norm(x.folder ?? "") === norm(path))) ?? null;
      // Only the space that holds the repo lists its checkouts: two spaces can
      // stand in one checkout, and both listed all of them.
      const checkoutsOf = (s) => {
        const g = info.get(s.id);
        if (!g || g.linked) return [];
        const holder = allSpaces.find((p) => p.id !== s.id && !info.get(p.id)?.linked && info.get(p.id)?.repo === g.repo);
        const mine = [s.id, ...(holder ? [holder.id] : [])];
        const chief = mine.sort((a, b) => {
          const na = allSpaces.find((x) => x.id === a), nb = allSpaces.find((x) => x.id === b);
          const score = (x) => (x.id === ownerId ? 0 : x.name === g.name ? 1 : 2);
          return score(na) - score(nb) || allSpaces.indexOf(na) - allSpaces.indexOf(nb);
        })[0];
        if (chief !== s.id) return [];
        return (this.trees[g.repo] ?? []).filter((c) => !spaceAtPath(c.path, s.machine));
      };
      const checkoutRow = (s, c) => h_flex()
        .id(`ck-${s.machine ?? ""}-${c.path}`)
        .relative()
        .mx(2)
        .pl(36)
        .pr(5)
        .h(28)
        .flex_none()
        .gap(7)
        .items_center()
        .rounded(7)
        .overflow_hidden()
        .hover((x) => x.bg(t.hover))
        .cursor_pointer()
        .tooltip(`${c.path} · click to open it as a space`)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.checkoutMenu(c.path, s.machine); })
        .on_click(() => run("space.new", { folder: c.path, ...(s.machine ? { machine: s.machine } : {}) }))
        .child(div().absolute().left(30).top(0).bottom(0).w(1).bg(wash(t.foreground, "12")))
        .child(div().absolute().left(30).top(15).w(7).h(1).bg(wash(t.foreground, "12")))
        .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(t.dim))
        .child(div().flex_shrink(1).min_w(30).max_w(150).truncate().text_size(12).text_color(t.dim).child(c.branch ?? base(c.path)))
        .child(div().flex_1())
        .child(div().flex_none().text_size(9.5).text_color(wash(t.dim, "cc")).child("open"));

      const out = [];
      const order = [];
      const sections = new Set();
      const emitSpace = (s, depth, sect) => {
        const kids = kidsOf.get(s.id) ?? [];
        const id = `sp-${s.id}`;
        const open = !this.folded.has(id);
        out.push(spaceRow(s, kids, depth, sect));
        if (!open) return;
        kids.forEach((a, i) => {
          order.push(a.address);
          out.push(...withKids(a, i, depth + 1));
        });
        if (depth === 0) for (const w of worktreesOf(s)) emitSpace(w, 1, sect);
        if (depth === 0) for (const c of checkoutsOf(s)) out.push(checkoutRow(s, c));
      };

      // Nested worktrees are drawn under their checkout, never as their own
      // section, and a pinned space keeps its place at the top.
      const nested = new Set(allSpaces.filter((s) => isNested(s)).map((s) => s.id));
      const top = allSpaces.filter((s) => !nested.has(s.id));

      // One block per machine once there is more than one, as the default list
      // does: this computer first, then the others by name, each with what is
      // known about reaching it, its own "+" and a New space row when it is empty.
      // Machines: this computer, then every other one any of the sources knows —
      // a space, a configured machine, one being reconnected. hc is what says
      // whether it is reachable, needs a login, or was rebuilt under us.
      const known = [...new Set([
        ...machines().map((m) => m.name).filter(Boolean),
        ...this.hcMachines.map((m) => m.name).filter(Boolean),
        ...Object.keys(this.reconnecting),
        ...top.map((s) => s.machine ?? null).filter(Boolean),
      ])].sort();
      const machineList = [null, ...known];
      const manyMachines = machineList.length > 1;

      const machineHeader = (m, mine) => {
        const id = `mach-${m ?? "local"}`;
        const open = !this.machinesFolded.has(m ?? "");
        const st = m ? this.hcMachines.find((x) => x.name === m) ?? null : null;
        const repair = m ? this.reconnecting[m] ?? null : null;
        const rebuilt = Boolean(repair) || this.rebuilt(st);
        const login = st?.state === "needs_login" ? `hc machine login ${m}` : null;
        const connected = !m || (st?.state === "connected" && !rebuilt);
        const word = !m || connected ? "" : repair?.busy ? "connecting…" : rebuilt ? (repair?.error ?? "rebuilt") : String(st?.state ?? "asleep").replace(/_/g, " ");
        const tone = connected ? t.ansi2 : (login || rebuilt ? t.blocked : t.dim);
        // Folded, the header still says how many spaces it holds and how urgent.
        const urgent = mine.reduce((r, sp) => Math.max(r, RANK[sp.status ?? "idle"] ?? 1), 0);
        const urgentTone = urgent >= RANK.blocked ? t.blocked : urgent === RANK.done ? t.done : urgent === RANK.working ? t.accent : null;
        return [
          h_flex()
            .id(id)
            .mx(4)
            .px(8)
            .pt(10)
            .h(28)
            .flex_none()
            .gap(7)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((x) => x.bg(wash(t.foreground, "06")))
            .on_click((_e, cx) => {
              open ? this.machinesFolded.add(m ?? "") : this.machinesFolded.delete(m ?? "");
              localStorage.setItem("agents.machines.folded", JSON.stringify([...this.machinesFolded]));
              cx.notify();
            })
            .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none().text_color(t.dim))
            .child(h_flex().flex_1().min_w(0).gap(7).items_center()
              .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(m ?? "This computer"))
              .when(Boolean(word), (el) => el.child(div().flex_none().max_w(96).truncate().text_size(10).text_color(tone === t.blocked ? t.blocked : t.dim).child(word)))
              .when(rebuilt, (el) => el.child(div()
                .id(`mconnect-${m}`)
                .flex_none()
                .text_size(10)
                .text_color(repair?.error ? t.blocked : t.accent)
                .hover((x) => x.text_color(t.foreground))
                .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
                .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(st ?? repair?.machine ?? { name: m }, cx); })
                .child(repair?.busy ? "Connecting…" : "Connect"))))
            .when(!open && mine.length > 0, (el) => el.child(countPill(t, mine.length, urgentTone)))
            .when(connected, (el) => el.child(div()
              .id(`madd-${m ?? "local"}`)
              .size(18)
              .flex_none()
              .rounded(4)
              .flex()
              .items_center()
              .justify_center()
              .hover((x) => x.bg(t.hover).text_color(t.foreground))
              .tooltip(`New space on ${m ?? "this computer"}`)
              .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); })
              .child(svg("mods/workspace-chrome/plus.svg").size(11).text_color(t.muted))))
            .child(div().size(6).flex_none().rounded(3).bg(tone))
            .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.muted)),
          // A machine that needs a login says what to run, and copies it.
          ...(open && login ? [h_flex()
            .id(`mlogin-${m}`)
            .mx(4)
            .px(8)
            .pb(5)
            .gap(6)
            .items_center()
            .flex_none()
            .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.blocked).tooltip(login).child(login))
            .child(div()
              .id(`mcopy-${m}`)
              .flex_none()
              .px(6)
              .py(2)
              .rounded(4)
              .text_size(10)
              .text_color(t.foreground)
              .bg(t.raised)
              .cursor_pointer()
              .hover((x) => x.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copied = login; cx.notify(); })
              .child(this.copied === login ? "Copied" : "Copy"))] : []),
        ];
      };

      const newSpaceRow = (m) => h_flex()
        .id(`mnew-${m ?? "local"}`)
        .mx(4)
        .px(8)
        .h(28)
        .flex_none()
        .gap(7)
        .items_center()
        .rounded(7)
        .text_size(12)
        .text_color(t.dim)
        .hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12))
        .child("New space there");

      for (const m of machineList) {
        const mine = top.filter((s) => (s.machine ?? null) === m);
        const mid = `mach-${m ?? "local"}`;
        const open = !this.machinesFolded.has(m ?? "");
        if (manyMachines) {
          out.push(...machineHeader(m, mine));
          if (!open) continue;
          if (!mine.length) {
            out.push(newSpaceRow(m));
            continue;
          }
        }
        const pinnedList = mine.filter((s) => pinOf(s));
        const loose = mine.filter((s) => !pinOf(s));
        if (pinnedList.length) {
          const id = manyMachines ? `${mid}-pinned` : "sec-pinned";
          out.push(sectionHeader(id, "Pinned", "accent", pinnedList.filter((s) => !isWorktree(s)).length));
          if (!this.folded.has(id)) pinnedList.forEach((s) => emitSpace(s, 0, id));
        }
        for (const r of [4, 3, 2, 1]) {
          const members = loose.filter((s) => (RANK[s.status ?? "idle"] ?? RANK.idle) === r);
          if (!members.length) continue;
          const id = manyMachines ? `${mid}-sec-${r}` : `sec-${r}`;
          out.push(sectionHeader(id, SECTION[r], SECTION_STATUS[r], members.length));
          if (!this.folded.has(id)) members.forEach((s) => emitSpace(s, 0, id));
        }
      }
      setAgentOrder(order);
      rows = out;
    } else {
      const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
      for (const a of rest) {
        const r = rankOf(a) || RANK.idle;
        const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
        if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
        else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
      }

      // A group's header; it folds the group. Folded, it says how many and the most urgent state.
      const header = (g) => {
        const open = !this.folded.has(g.id);
        const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
        // Working reads as the accent, the same tone its spinner uses.
        const tone = g.status ? (g.status === "working" ? t.accent : (t[g.status] ?? t.dim))
          : (g.id === "pinned" ? t.accent : null);
        const count = g.members.length;
        return h_flex()
          .id(g.id)
          .mx(4)
          .px(8)
          .pt(6)
          .h(30)
          .flex_none()
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(wash(t.foreground, "06")))
          .on_click((_e, cx) => {
            open ? this.folded.add(g.id) : this.folded.delete(g.id);
            cx.notify();
          })
          .when(Boolean(tone), (el) => el.child(div().size(5).flex_none().rounded_full().bg(tone)))
          .child(h_flex().flex_1().min_w(0).gap(7).items_center()
            .child(div().min_w(0).truncate().text_size(9.5).font_semibold().text_color(tone ?? t.muted).child(g.label.toUpperCase()))
            .when(byPriority || !open, (el) => el.child(countPill(t, count))))
          .when(!open && !byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.muted));
      };
      rows = groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);
    }

    // Narrowed, the sidebar is a rail: the way back, search and settings, and no
    // list at all. The other blocks hide themselves at this width.
    if (collapsed) {
      // A worktree is a checkout under its repo, not another space: counting it
      // here made the rail show six numbers for five places. The rail lists the
      // places, numbered 1…n; the checkout stays in the expanded tree and search.
      const isCheckout = (sp) => inWorktrees(placeOf(sp, paneList) ?? sp.folder);
      const places = spaces().filter((sp) => !isCheckout(sp));
      return this.rail(t, places.map((sp, i) => ({
        key: sp.id,
        n: i + 1,
        tip: sp.name,
        active: sp.active,
        status: sp.status,
        act: () => run("space.select", { id: sp.id }),
      })), "rail-spaces", RAIL_MAX_SPACES);
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "sidebar-menu", kind: "popup", width: 250 }); })
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(11)
            .h(42)
            .pt(8)
            .pb(6)
            .flex_none()
            .gap(7)
            .items_center()
            .border_b(1)
            .border_color(wash(t.border, "55"))
            .child(div().flex_none().text_size(9).font_semibold().text_color(t.dim).child(spaced(bySpaces ? "SPACES" : "AGENTS")))
            .when(roomy, (el) => el.child(countPill(t, bySpaces ? (this.spaceCount ?? spaces().length) : list.length)))
            .child(div().flex_1())
            .child(h_flex().flex_none().gap(2).items_center()
              .child(this.iconButton(t, "ag-sort", `mods/workspace-chrome/${sort.icon}.svg`, `Sort agents: ${sort.label}`,
                () => openOverlay({ mod: "agents-list", kind: "popup", width: 230, height: 172, props: { sortMenu: true } }), 13, sort.id !== "priority"))
              .child(this.iconButton(t, "ag-search", "mods/icons/search.svg", "Search \u00b7 Alt+F",
                () => run("mod.open", { name: "search" })))
              .child(div().w(1).h(14).mx(1).flex_none().bg(wash(t.foreground, "10")))
              .when(bySpaces, (el) => el.child(this.iconButton(t, "ag-new-space", "mods/workspace-chrome/plus.svg", "New space", () => run("space.new"))))
              .child(this.iconButton(t, "ag-hide", "mods/icons/sidebar.svg", "Hide sidebar", toggleSidebar))),
        ),
      )
      .when(list.length === 0 && !bySpaces && !collapsed, (el) =>
        el.child(v_flex().flex_none().px(20).pt(34).gap(7).items_center()
          .child(div().size(36).rounded(10).bg(wash(t.foreground, "06")).border(1).border_color(wash(t.foreground, "0c"))
            .flex().items_center().justify_center()
            .child(svg("mods/icons/layers.svg").size(16).text_color(t.muted)))
          .child(div().text_size(12.5).font_medium().text_color(t.muted).child("No agents yet"))
          .child(div().text_size(10.5).text_color(wash(t.muted, "cc")).text_center().child("Agents appear here once they report their status."))),
      )
      // Room on the right for the scrollbar gutter: without it the scrollbar sat
      // on top of the rows' last icons and clipped them.
      .child(v_flex().id("ag-list").flex_1().min_h(0).pt(3).pb(3).pl(8).pr(12).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => {
          // A drag let go outside the rows leaves no pointer-up on a row: clear it
          // here, so the next click can't read as a move.
          if (this.pressed !== null) {
            this.pressed = null;
            this.over = null;
            cx.notify();
          }
        })
        .children(rows)
        .when(rows.length === 0 && bySpaces, (el) => el.child(v_flex().flex_none().px(20).pt(34).gap(7).items_center()
          .child(div().size(36).rounded(10).bg(wash(t.foreground, "06")).border(1).border_color(wash(t.foreground, "0c"))
            .flex().items_center().justify_center()
            .child(svg("mods/icons/folder-plus.svg").size(16).text_color(t.muted)))
          .child(div().text_size(12.5).font_medium().text_color(t.muted).child("No spaces yet"))
          .child(div().text_size(10.5).text_color(wash(t.muted, "cc")).text_center()
            .child("A space is a place to work: a repo, a folder. Make one here, or find anything with Alt+F."))
          .child(h_flex().id("empty-new-space").mt(6).h(28).px(10).gap(6).rounded(7).items_center()
            .bg(wash(t.accent, "16")).text_color(t.accent).cursor_pointer()
            .hover((x) => x.bg(wash(t.accent, "26")).text_color(t.foreground))
            .on_click(() => run("space.new"))
            .child(svg("mods/icons/plus.svg").size(12))
            .child(div().text_size(11.5).font_medium().child("New space"))))));
  }
}

