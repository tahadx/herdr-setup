// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, machines, run, exec, hc, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, watchFolder, notify, nextCommand } from "herdr";
import {
  Workspace, wash, place, norm, tidyPath, base, inWorktrees, isRemoving, removingList,
  pinnedList, pinnedRepo, isPinned, checkouts, dropGitCache, worktreeTree, spaceColor, RANK, MARK,
  pinLabel, folderColor,
  onGitRefresh, takeGitAsk, touchWorkspace, listedCheckouts, pictureKey,
  beginPaint, endPaint, frameCache, spaceRecord, pinSpace, persistWorkspace, spaceRead,
  checkoutRecordOf, groupKeyOf, worktreeSiblings, movePathWithin, machineIndexOf,
  orderedPaths, orderedPlaces, SEP,
} from "./workspace-engine.js";

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
const narrow = () => (find(frameCache("layout", layout), "sidebar")?.size?.px ?? Infinity) < 160;

// The list's bar: this far in from the top and bottom, and the width of the
// lane the pointer can grab (the thumb itself is thinner).
const BAR_INSET = 3;
const BAR_LANE = 9;
const BAR_WIDTH = 3;

// A watch event counts when it can change the branch, the ahead/behind counts,
// or the checkout list. The index, the object store and a file save do not.
// A batch that names the git dir itself means the whole dir changed.
function gitTouched(paths, dir) {
  if (!Array.isArray(paths)) return true;
  if (!paths.length) return false;
  const root = norm(dir).replace(/\/+$/, "");
  for (const raw of paths) {
    const p = norm(raw).replace(/\/+$/, "");
    if (p === root) return true;
    if (!p.startsWith(`${root}/`)) continue;
    const rel = p.slice(root.length + 1);
    if (rel === "HEAD" || rel === "config" || rel === "packed-refs") return true;
    if (rel === "refs" || rel.startsWith("refs/")) return true;
    if (rel === "worktrees" || rel.startsWith("worktrees/")) return true;
  }
  return false;
}

// A dialog the sidebar opens takes the keyboard; the flag tells init to ask for
// it back when the dialog closes, so the list never loses the person.
const sidebarDialog = (overlay) => {
  setShared("sidebar.dialog", Date.now());
  openOverlay(overlay);
};

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  const collapsing = !narrow();
  if (collapsing) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", collapsing);
  const px = collapsing ? (window()?.platform === "macos" ? 76 : 44) : (shared("sidebar.width") ?? 223);
  // The rail owns the whole sidebar from the first frame, not when the width
  // timer next runs. Hiding the blocks below it before the resize keeps the
  // bottom controls on the window's edge instead of letting them jump there a
  // frame later. Expanding shows them back with the width.
  if (collapsing) fitRailTo(px, find(layout(), "sidebar"));
  run("layout.resize", { id: "sidebar", px });
  if (!collapsing) fitRailTo(px, find(layout(), "sidebar"));
}

// Swap the sidebar with the work column, and the panel with the terminal pane.
function flipLayout() {
  const tree = JSON.parse(JSON.stringify(layout() ?? {}));
  if (!Array.isArray(tree.children) || tree.children.length < 2) return;
  tree.children.reverse();
  const body = find(tree, "work-body");
  if (body?.type === "row" && Array.isArray(body.children) && body.children.length > 1) body.children.reverse();
  const panel = find(tree, "panel");
  if (panel) {
    // A hidden panel's live width is its collapsed sliver; keep the real one.
    if (!panel.hidden && (panel.size?.px ?? 0) >= (panel.min ?? 0)) setShared("panel.width", panel.size.px);
    else if ((panel.size?.px ?? 0) < (panel.min ?? 0)) panel.size.px = shared("panel.width") ?? 368;
  }
  run("layout.set", { layout: tree });
}

// Closing the last terminal of a space opens a fresh shell in that same space
// first, so Herdr never jumps to another space's terminal.
function closeFocused(name) {
  const f = focused();
  const tabId = f?.tab;
  if (!tabId) return;
  const space = spaces().find((s) => s.tabs.some((t) => t.id === tabId));
  if (!space) return;
  if (name === "close_pane" && f.pane && panes().filter((p) => p.tab === tabId).length > 1) return run("pane.close", { pane: f.pane });
  if (space.tabs.length > 1) return run("tab.close", { id: tabId });
  run("tab.new", { space: space.id });
  run("tab.close", { id: tabId });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// localStorage is a cache an older version (or a bad write) may have left in a
// shape this build doesn't expect. A broken value must not stop the sidebar
// from loading: read it as absent instead.
function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
const storedObject = (key) => {
  const value = stored(key, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};
const storedArray = (key) => {
  const value = stored(key, []);
  return Array.isArray(value) ? value : [];
};

// The blocks in the sidebar that are not on the rail's path: everything below
// the agents block, at any depth the layout happens to use. The rail is the
// whole column, so those blocks step aside while it is shown.
function railBlockIds(node) {
  const holds = (n) => n?.content?.mod === "agents-list" || (n.children ?? []).some(holds);
  const ids = [];
  const collect = (n) => {
    for (const child of n?.children ?? []) {
      if (holds(child)) collect(child);
      else if (child.id && !child.hidden) ids.push(child.id);
    }
  };
  collect(node);
  return ids;
}

// Put the sidebar in (or out of) rail mode for a known width. The width is
// passed in because the caller has just asked for it: the layout still reads
// the old one until the host applies the resize. The stored list is what a
// restart (or a second fit) uses to put back only the blocks this hid.
function fitRailTo(width, node) {
  const hid = storedArray("rail.hid");
  if (width < 160 && node && !node.hidden) {
    if (hid.length) return false;
    const ids = railBlockIds(node);
    if (!ids.length) return false;
    localStorage.setItem("rail.hid", JSON.stringify(ids));
    for (const id of ids) run("layout.hide", { id });
    return true;
  }
  if (hid.length) {
    for (const id of hid) run("layout.show", { id });
    localStorage.removeItem("rail.hid");
    return true;
  }
  return false;
}

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

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The letter a space's avatar wears, and the word a state says in a tooltip.
const initial = (name) => ([...(name ?? "")][0] ?? "?").toUpperCase();
const STATE = { working: "working", blocked: "needs you", done: "done", idle: "idle" };

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

export class Sidebar extends Workspace {
  init(_props, cx) {
    // A menu takes the keyboard from the moment it opens. Its handle has to be
    // made here: one made during render would be dropped on the next repaint.
    if (props()?.menu) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      // "Remove worktree" follows the shared sticky record, which already knows
      // a checkout after its shell `cd`s: a menu open runs no git of its own.
      const menu = props()?.menu ?? {};
      if (menu.kind === "space") {
        const s = spaces().find((x) => x.id === menu.id);
        this.linked = s ? this.isWorktree(s) : false;
      }
      return; // a menu draws and acts, nothing more
    }
    if (props()?.sortMenu) return;
    // Pins, removals and the step state are the find sheet's too: one copy.
    this.initShared();
    // The keyboard in the sidebar: Alt+B hands it here and takes it back. The
    // rows it moves through are collected on each render, in the order drawn.
    this.handle = cx.focus_handle();
    // The list scrolls here (see `scroller`): the app's bar cannot be made
    // thin or accented from a mod, so this one is drawn instead of it.
    this.scrollTop = 0;
    this.viewH = {};     // the list's viewport height, per view
    this.contentH = {};  // everything inside it, per view
    this.rowH = {};      // each row's height, per view: how reveal knows where one is
    this.pad = {};       // the list's own top padding, per view
    this.bar = null;     // the drawn thumb's geometry, read by the pointer
    this.barDrag = null; // the grab that owns the pointer, while one does
    this.barHover = false;
    this.sel = null;
    this.entries = [];
    // The shared walk counter: the app's Ctrl+J/K binding bypasses a focused
    // panel, so the sidebar writes the step and its own watcher reads it back.
    this.moves = 0;
    // Focus is claimed a moment before the window answers `is_focused()`, so the
    // style follows this flag: set the instant Alt+B lands, never a frame late.
    this.kbd = false;
    this.kbdSeen = false;
    // A press outside the list ends keyboard mode, even where the app leaves the
    // focus where it was (the footer, a tab bar, the background): the press is
    // the person's answer, and nothing inside the panel happened.
    this.blurred = false;
    // Until this moment a claim (in or out) is in flight: one press flips the
    // last press's answer, not some half-applied focus.
    this.pendingUntil = 0;
    // Keys that act on the sidebar: its focus, a space, and the worktree dialogs
    // the space menu opens (keys.json points them here). The dialogs are the same
    // ones the menu uses, so a key never lands somewhere right-click cannot.
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          this.command(await nextCommand(), cx);
        } catch (e) {
          console.log(`agents-list: command failed: ${e}`);
        }
      }
    });
    // A dialog opened from here hands the keyboard to the pane behind it when it
    // closes. Take it back: removing a worktree must leave the person in the
    // list, not in a terminal.
    let overlayAt = shared("overlay.closed");
    cx.timer.every(200, (cx) => {
      this.watchJob(cx);
      const now = shared("overlay.closed");
      if (now === overlayAt) return;
      overlayAt = now;
      const at = shared("sidebar.dialog");
      // Stale flag: a dialog that never reported back must not steal a later one.
      if (!at || Date.now() - at > 60000) return;
      setShared("sidebar.dialog", null);
      this.blurred = false;
      this.kbd = true;
      this.kbdSeen = false;
      this.pendingUntil = Date.now() + 1000;
      if (!(this.entries ?? []).some((e) => e.key === this.sel)) this.sel = this.focusKey();
      this.reclaim(cx);
      cx.notify();
    });
    this.folded = new Set();
    // Git, checkouts and the per-space record live on the shared picture
    // (bindWorkspace). This copy only watches and scans.
    this.watching = new Set(); // folders already watched for git changes
    this.watchQueued = false;  // a burst of changes waits for one read
    // Machines as only hc knows them: connected, needs a login, unreachable.
    this.hcMachines = [];
    this.reconnecting = storedObject("agents.reconnecting");
    for (const state of Object.values(this.reconnecting)) if (state && typeof state === "object") state.busy = false;
    this.machinesFolded = new Set(storedArray("agents.machines.folded"));
    this.machinesAt = 0; // when the check that holds machinesRunning began
    this.machinesGen = 0;
    this.refreshMachines(cx, true);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    this.gitBusy = new Set();
    this.pressed = null; // a space being dragged
    this.over = null;   // the space row under the pointer
    this.pressSect = null; // the section it started in: drops stay inside it
    this.publishedKb = null; // what "sidebar.kb" last said
    this.ids = "";
    this.createdAt = 0; // the worktree.createdAt last drawn
    this.createdSeen = 0; // the one last handed to a git scan
    this.jobAt = 0; // the removal last taken from the worktrees dialog
    this.gitRunning = false;
    this.gitStartedAt = 0; // when the pass that holds the flag began (watchdog)
    this.gitGen = 0;       // bumped when a held pass is abandoned
    this.gitAgain = false;
    this.gitForce = false;
    // The sheet asks this copy to read. It is the one that stays mounted.
    this.scanCx = cx;
    onGitRefresh(() => {
      const ask = takeGitAsk();
      this.refreshGit(this.scanCx, ask.force, ask.live);
    });
    this.refreshGit(cx, true);
    cx.timer.every(8000, (cx) => this.refreshGit(cx));
    // A removed checkout is hidden by the picture at once; this takes the empty
    // space away too, after the same few seconds a deleted folder gets.
    this.goneAt = new Map();
    cx.timer.every(4000, (cx) => this.sweepRemoved(cx));
    // The rail owns the whole sidebar while collapsed, and gives it back when
    // the sidebar is dragged wider.
    this.fitRail();
    // While the list is painting it already measured the width. The timer only
    // has to look when nothing else has redrawn, so a drag still reaches the rail.
    cx.timer.every(400, () => {
      if (typeof this.sidePx === "number" && Date.now() - (this.sidePxAt ?? 0) < 800) this.fitRail(this.sidePx);
      else this.fitRail();
    });
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = storedObject("changed");
    this.pendingPins = storedArray("pins");
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
    if (dirty) {
      // Gone and old: the list alone is empty right after a start.
      const listed = new Set(list.map((a) => a.address));
      for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
      this.changedDirty = true;
    }
    // Status ticks must not write localStorage on the paint that drew them.
    if (!this.changedDirty || now - (this.changedWrite ?? 0) < 1000) return;
    this.changedDirty = false;
    this.changedWrite = now;
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
  // theirs and everything else stays cached. A worktree's folder is not inside
  // its main checkout, so a change to the repo also drops the git remembered
  // for every checkout of that repo.
  invalidate(dir) {
    const d = norm(dir).replace(/\/+$/, "");
    const inside = (f) => {
      const p = norm(f);
      return p === d || p.startsWith(`${d}/`);
    };
    for (const key of Object.keys(this.gitAt ?? {})) {
      const folder = key.split(SEP)[1] ?? "";
      const rec = this.git?.[key];
      const repo = rec?.repo ? (rec.repo.split(SEP)[1] ?? "") : "";
      if (inside(folder) || (repo && norm(repo) === d) || (rec?.root && norm(rec.root) === d)) delete this.gitAt[key];
    }
    // A checkout list only changes for the repo the folder belongs to: the one
    // whose checkout holds it, or whose name the worktrees folder carries.
    const wt = d.match(/^(.*\/worktrees)\/([^/]+)/);
    for (const key of Object.keys(this.treesAt ?? {})) {
      const main = key.split(SEP)[1] ?? "";
      if (inside(main) || norm(main) === d || (wt && base(main) === wt[2])) delete this.treesAt[key];
    }
    dropGitCache(d);
  }

  // The host order is what keyboard cycling walks. Skip the call when the list
  // has not moved: rendering asks for it every frame.
  publishOrder(addresses) {
    const next = addresses.join("\u0000");
    if (next === this.agentOrder) return;
    this.agentOrder = next;
    setAgentOrder(addresses);
  }

  refreshMachines(cx, force = false) {
    if (!force && sortOf().id !== "spaces") return;
    // `hc` can answer nothing just as a scan can (see refreshGit): a hung check
    // must not leave the machine list stale for the rest of the session.
    if (this.machinesRunning) {
      if (Date.now() - (this.machinesAt ?? 0) < 30_000) return;
      console.log("agents-list: a machine check has held for 30s; abandoning it");
      this.machinesGen = (this.machinesGen ?? 0) + 1;
      this.machinesRunning = false;
    }
    this.machinesRunning = true;
    this.machinesAt = Date.now();
    const gen = this.machinesGen ?? 0;
    cx.spawn(async (cx) => {
      let next = this.hcMachines;
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) next = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      // A later check owns the flag now; this answer is stale, not news.
      if (gen !== (this.machinesGen ?? 0)) return;
      this.machinesRunning = false;
      if (JSON.stringify(next) === JSON.stringify(this.hcMachines)) return;
      this.hcMachines = next;
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

  // Watch a repo's git directory, not its working tree. Agents write source
  // files constantly; the list only changes when HEAD, a ref, or a worktree
  // record does. `scope` is the working tree those records belong to.
  // A burst is read once after it settles, not per file.
  watchRepo(cx, key, dir, scope = dir) {
    if (this.watching.has(key)) return;
    this.watching.add(key);
    cx.spawn(async (cx) => {
      for (;;) {
        let paths;
        try {
          paths = await watchFolder(dir);
        } catch {
          return; // a folder that can't be watched keeps the timer as its clock
        }
        if (!gitTouched(paths, dir)) continue;
        this.invalidate(scope);
        if (this.watchQueued) continue;
        this.watchQueued = true;
        cx.timer.after(700, (cx) => {
          this.watchQueued = false;
          this.refreshGit(cx);
        });
      }
    });
  }

  // A place whose git has never been read. A cd into a new folder is one of
  // these, and it should not wait for the timer.
  folderMissing(ps) {
    if (!this.gitAt) return true;
    for (const s of frameCache("spaces", spaces)) {
      for (const folder of [place(s, ps), s.folder]) {
        if (!folder) continue;
        if (this.gitAt[`${s.machine ?? ""}${SEP}${tidyPath(folder)}`] == null) return true;
      }
    }
    return false;
  }

  forgetRepo(main) {
    if (main) dropGitCache(main);
  }

  // Branch, ahead/behind and whether a checkout is a linked worktree: the two
  // git calls the default spaces list makes, cached per place for a while.
  // One scan at a time. A second request, from a watch or a new space, waits
  // and runs once more when this one finishes, instead of a pile of them.
  //
  // A scan that never comes back must not freeze the panel for the session: the
  // app can take an `exec` before its core is ready and answer nothing, and the
  // flag then stayed up until the next restart (no branch, no worktree record,
  // a checkout reading as a space of its own). Ninety seconds is longer than any
  // pass should take; the abandoned pass is fenced by `gitGen` so it cannot prune
  // or persist over the one that replaces it.
  refreshGit(cx, force = false, live = false) {
    // The scan no longer depends on which sort is shown: the sticky worktree
    // record is what keeps a repo bound, and it must stay right while the
    // person works in another view too. The per-folder TTL (30 s) and the git
    // directory watch are what keep this from being a subprocess storm.
    if (this.gitRunning) {
      if (Date.now() - (this.gitStartedAt ?? 0) < 90_000) {
        this.gitAgain = true;
        if (force) this.gitForce = true;
        if (live) this.gitLive = true;
        return;
      }
      console.log("agents-list: a git scan has held for 90s; abandoning it");
      this.gitGen = (this.gitGen ?? 0) + 1;
      this.gitRunning = false;
    }
    this.gitRunning = true;
    this.gitStartedAt = Date.now();
    this.gitLive = live;
    const gen = this.gitGen ?? 0;
    cx.spawn(async (cx) => {
      let pass = force;
      try {
        do {
          this.gitAgain = false;
          this.gitForce = false;
          await this.scanGit(cx, pass, gen);
          pass = this.gitForce;
        } while (this.gitAgain && gen === (this.gitGen ?? 0));
      } finally {
        const mine = gen === (this.gitGen ?? 0);
        if (mine) this.gitRunning = false;
        const againLive = this.gitLive;
        this.gitLive = false;
        if (this.gitAgain && mine) this.refreshGit(cx, this.gitForce, againLive);
      }
    });
  }

  async scanGit(cx, force, gen = this.gitGen ?? 0) {
    const ps = panes();
    const all = frameCache("spaces", spaces);
    const stale = () => gen !== (this.gitGen ?? 0);
    const seen = new Set();
    const jobs = [];
    // Where a space is now *and* where it was made: a worktree's shell can cd
    // anywhere, and the folder it was made in is what keeps it a checkout.
    for (const s of all) {
      for (const folder of [...new Set([place(s, ps), s.folder].filter(Boolean))]) {
        const key = `${s.machine ?? ""}${SEP}${tidyPath(folder)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({ machine: s.machine ?? null, folder, key });
      }
    }
    // A pinned place is still a place: its repo stays read while its space is
    // closed, so its checkouts stay listed — and a space opened there binds at
    // once, from the answer this scan already has.
    for (const p of pinnedList()) {
      if (!p.folder) continue;
      const key = `${p.machine ?? ""}${SEP}${tidyPath(p.folder)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ machine: p.machine ?? null, folder: p.folder, key });
    }
    // A sticky worktree record keeps its repo's checkout list alive even when no
    // space stands in the main checkout: reading the main folder is what keeps
    // that list fresh, and a fresh list without the checkout is how a removed
    // worktree is known (and stays known while its space is still open).
    const stickyRepos = new Set();
    for (const rec of Object.values(this.spacePins ?? {})) {
      if (!rec?.isWorktree || !rec.groupKey) continue;
      stickyRepos.add(rec.groupKey);
      const at = rec.groupKey.indexOf(SEP);
      const on = rec.groupKey.slice(0, at) || null;
      const main = rec.groupKey.slice(at + 1);
      if (!main) continue;
      const key = `${on}${SEP}${tidyPath(main)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ machine: on, folder: main, key });
    }
    let changed = false;
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= jobs.length) return;
        if (await this.probeGit(cx, jobs[i], force)) changed = true;
      }
    };
    const width = Math.min(4, jobs.length);
    if (width) await Promise.all(Array.from({ length: width }, () => worker()));
    // An abandoned pass returns to a newer one's picture: it may not prune what
    // the new pass has already read, nor write its records or its state.
    if (stale()) return;
    for (const key of Object.keys(this.git)) if (!seen.has(key)) {
      delete this.git[key];
      changed = true;
    }
    // A repo nobody stands in any more keeps no checkout list. This also drops
    // a list written by an older build under a key this one cannot address. A
    // pin is a place: its repo keeps its list even with no space in it.
    const repos = new Set(Object.values(this.git).map((g) => g?.repo).filter(Boolean));
    for (const p of pinnedList()) {
      const repo = pinnedRepo(p, this.git);
      if (repo) repos.add(repo);
    }
    for (const repo of stickyRepos) repos.add(repo);
    for (const key of Object.keys(this.trees ?? {})) {
      if (repos.has(key)) continue;
      delete this.trees[key];
      delete this.treesAt?.[key];
      changed = true;
    }
    // Fold each read into its space's sticky record. This is the only writer of
    // `workspace.spacePins`, and it runs after git, never during a paint. A
    // worktree stays a worktree when its shell `cd`s out: `pinSpace` keeps the
    // record unless the shell lands in a *different* repository root.
    const live = new Set(all.map((s) => s.id));
    for (const id of Object.keys(this.spacePins ?? {})) {
      if (live.has(id)) continue;
      delete this.spacePins[id];
      changed = true;
    }
    for (const s of all) {
      // The live place first, the folder the space was made in second. An agent
      // that reports a folder outside the repo (opencode at `~`) must not erase
      // the place the space stands in: without the fallback the reel space lost
      // its repo record, and every worktree under reel lost its parent row.
      const read = spaceRead(s, this.git, ps);
      if (!read) continue;
      if (pinSpace(s, read)) changed = true;
    }
    if (changed) {
      touchWorkspace();
      cx.notify();
    }
    // Always offer the picture to shared state; the writer is a no-op unless
    // something changed (or a stale key needs dropping).
    persistWorkspace(true);
  }

  // A worktree checkout git no longer lists must not leave its space behind.
  // The picture hides it everywhere at once; this only ends an unpinned space
  // after a grace, the way a deleted folder is ended. A pinned space is never
  // closed: it keeps running, hidden, and comes back if the checkout does.
  sweepRemoved(cx) {
    const rows = frameCache("spaces", spaces);
    const removed = this.removedWorktrees(rows, frameCache("panes", panes));
    const seen = this.goneAt ?? (this.goneAt = new Map());
    const now = Date.now();
    for (const id of [...seen.keys()]) if (!removed.has(id)) seen.delete(id);
    let closed = false;
    for (const s of rows) {
      if (!removed.has(s.id)) continue;
      if (!seen.has(s.id)) { seen.set(s.id, now); continue; }
      if (now - seen.get(s.id) < 6000 || isPinned(s)) continue;
      seen.delete(s.id);
      closed = true;
      run("space.close", { id: s.id, confirmed: true });
    }
    if (closed) cx.notify();
  }

  async probeGit(cx, job, force) {
    const { machine, folder, key } = job;
    if (this.gitBusy.has(key)) return false;
    // A fresh summary still refreshes the checkout list when that list was
    // dropped (a worktree was added or removed). The summary and the list
    // change for different reasons. Thirty seconds is the clock; a watch event
    // on the git dir invalidates the entry sooner, and a new folder is read at
    // once (`folderMissing`), so a scan is not what keeps this correct.
    const fresh = !force && this.gitAt[key] && Date.now() - this.gitAt[key] < 30000;
    if (fresh) {
      const rec = this.git[key];
      if (!rec?.repo) return false;
      return this.refreshTrees(cx, rec.repo, machine, force, rec.gitDir);
    }
    const before = JSON.stringify(this.git[key] ?? null);
    this.gitBusy.add(key);
    let changed = false;
    try {
      // One call for the checkout, its git dir and its branch; ahead/behind
      // from rev-list, which reads refs only (git status would walk the files).
      const top = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], { cwd: folder, on: machine });
      const lines = (top.stdout ?? "").trim().split("\n").filter(Boolean);
      if (top.code !== 0 || lines.length < 3) {
        this.git[key] = null;
      } else {
        const root = tidyPath(lines[0]);
        const common = tidyPath(lines[1]);
        const branch = lines[2].trim() === "HEAD" ? null : lines[2].trim();
        // `--git-common-dir` is `<main>/.git` for a main checkout and the
        // *parent's* `.git` for a linked worktree: the one canonical identity,
        // wherever the checkout folder lives.
        const main = tidyPath(common.endsWith("/.git") ? common.slice(0, -5) : common);
        const ab = await exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd: folder, on: machine });
        const [behind, ahead] = ab.code === 0 ? (ab.stdout ?? "").trim().split(/\s+/).map(Number) : [0, 0];
        this.git[key] = {
          name: base(main),
          branch,
          ahead: ahead || 0,
          behind: behind || 0,
          repo: `${machine ?? ""}${SEP}${main}`,
          root,
          gitDir: common,
          linked: main !== root,
        };
        if (await this.refreshTrees(cx, `${machine ?? ""}${SEP}${main}`, machine, force, common)) changed = true;
      }
    } catch {
      this.git[key] = this.git[key] ?? null;
    } finally {
      this.gitBusy.delete(key);
      this.gitAt[key] = Date.now();
    }
    if (before !== JSON.stringify(this.git[key] ?? null)) changed = true;
    return changed;
  }

  // Which checkouts the repo has, so a worktree nobody opened yet is still
  // listed under it. A failed read keeps the list already drawn and does not
  // count as fresh, so the next pass tries again.
  async refreshTrees(cx, repoKey, machine, force, gitDir) {
    this.treesBusy ??= new Set();
    const treesDue = force || !(this.treesAt[repoKey] > 0) || Date.now() - this.treesAt[repoKey] > 30000;
    if (!treesDue || this.treesBusy.has(repoKey)) return false;
    const main = repoKey.split(SEP)[1] ?? "";
    if (!main) return false;
    // `common` is the git dir itself when it does not live at main/.git.
    if (!machine) this.watchRepo(cx, `repo:${main}`, gitDir || `${main}/.git`, main);
    const gen = this.treesGen ?? 0;
    const treesBefore = JSON.stringify(this.trees[repoKey] ?? null);
    this.treesBusy.add(repoKey);
    let changed = false;
    try {
      const trees = await checkouts({ main }, machine);
      // A newer add or remove already drew the truth. Don't put the old list back.
      if ((this.treesGen ?? 0) !== gen) return false;
      if (!Array.isArray(trees)) {
        this.trees[repoKey] = Array.isArray(this.trees[repoKey]) ? this.trees[repoKey] : [];
      } else {
        const next = trees.filter((c) => !c.main && norm(c.path) !== norm(main));
        this.trees[repoKey] = next;
        if (treesBefore !== JSON.stringify(this.trees[repoKey])) changed = true;
        this.treesAt[repoKey] = Date.now();
      }
    } catch {
      this.trees[repoKey] = Array.isArray(this.trees[repoKey]) ? this.trees[repoKey] : [];
    } finally {
      this.treesBusy.delete(repoKey);
    }
    return changed;
  }

  // Only what's unusual, after the name: "herdr · spike ↑2 ↓1". The repo or the
  // branch goes when the name already says it, and master/main go: nearly every
  // space is on one. Same rule as the default spaces list.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    // The counts keep a width of their own, so a branch coming and going never
    // moves them and they line up down the list.
    const count = (n, glyph, tone) => div().w(20).flex_none().text_right().text_size(9.5)
      .font_medium().text_color(tone).child(`${glyph}${n}`);
    // One tail, as the app's own spaces list draws it: "herdr \u00b7 spike \u21912 \u21931".
    // It grows from its text's width (`flex_auto`, not `flex_1`, whose zero basis
    // made the tail a zero-width box that painted its contents over the name) and
    // keeps a floor, so the name and the tail give way in proportion instead of one
    // of them disappearing. A boxed per-word chip could not: at 223 px the chip and
    // the name cannot both fit beside the counts, the fold and the pin.
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(where ? 48 : 0)
      .gap(4)
      .justify_end()
      .items_center()
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().text_size(9.5)
        .text_color(t.dim).child(where)))
      .when(g.ahead > 0, (el) => el.child(count(g.ahead, "\u2191", t.ansi2)))
      .when(g.behind > 0, (el) => el.child(count(g.behind, "\u2193", t.ansi1)));
  }

  // A worktree row reads its checkout's branch, the same name the sheet gives it:
  // a space named before the branch was renamed, or made without a name, would
  // otherwise keep the stale one. Before a scan answers, the folder it was made
  // in is the one name it still has.
  worktreeName(s) {
    if (!this.isWorktree(s)) return null;
    const c = this.checkoutRecord(s, this.paneSnap);
    return c?.branch ?? (c?.root ? base(c.root) : null) ?? (s?.folder ? base(s.folder) : null);
  }

  // Every dialog the sidebar opens goes through here, so closing one always
  // leaves the keyboard in the list.
  openDialog(opts) {
    sidebarDialog(opts);
  }

  // A dialog, opened at the size the space menu opens it. A removal names the
  // checkout itself: a space whose shell cd'd out of its worktree must still
  // remove the checkout it was made in, not whatever repo it is standing in now.
  dialog(s, action, width, height, extra = {}) {
    const here = s ? (place(s, panes()) ?? s.folder) : null;
    // The sticky record names the checkout after a `cd` out of it.
    const folder = action === "remove" ? (checkoutRecordOf(s)?.root ?? (inWorktrees(s?.folder) ? s.folder : here)) : null;
    this.openDialog({ mod: "worktrees", kind: "dialog", width, height,
      props: { space: s?.id, ...(folder ? { folder } : {}), action, ...extra } });
  }


  // A removal handed over by the worktrees dialog, which closes the moment the
  // person confirms — its own tasks would end with it, so the git work happens
  // here, in the panel that stays. The checkout is already hidden (the dialog
  // put it in "worktree.removing"); this is what makes that true.
  watchJob(cx) {
    const queued = shared("worktree.jobs");
    const job = shared("worktree.job");
    // The dialog appends to the list and also sets the single slot, so a second
    // confirm before this timer runs does not erase the first removal.
    const batch = Array.isArray(queued) && queued.length ? queued : (job ? [job] : []);
    if (!batch.length) return;
    setShared("worktree.job", null);
    setShared("worktree.jobs", null);
    this.jobs ??= [];
    this.taken ??= new Set();
    for (const item of batch) {
      if (!item) continue;
      // `at` is Date.now(), so two confirms in one millisecond share it. The
      // checkout path keeps them distinct. A job already taken is not run twice
      // when a later confirm rewrites the list with both.
      const id = `${item.at}\u0000${item.top}`;
      if (this.taken.has(id)) continue;
      this.taken.add(id);
      this.jobAt = item.at;
      this.jobs.push(item);
    }
    if (!this.jobs.length || this.jobBusy) return;
    this.jobBusy = true;
    cx.spawn(async (cx) => {
      try {
        while (this.jobs.length) await this.runWorktreeJob(this.jobs.shift(), cx);
      } finally {
        this.jobBusy = false;
      }
    });
  }

  async runWorktreeJob(job, cx) {
    const on = job.on ?? null;
    const path = tidyPath(job.top);
    const windows = window()?.platform === "windows";
    const closeSpaces = () => {
      for (const id of job.spaces ?? []) run("space.close", { id, confirmed: true });
    };
    // Windows only: a live shell keeps the folder busy, so its spaces go first.
    if (windows) closeSpaces();
    let error = "";
    try {
      const r = await exec("git", ["worktree", "remove", ...(job.force ? ["--force"] : []), job.top], { cwd: job.main, on, timeout: 600_000 });
      if (r.code !== 0) error = (r.stderr ?? r.stdout ?? "").trim() || "git worktree remove failed.";
    } catch (e) {
      error = String(e?.message ?? e);
    }
    if (!error) {
      if (!windows) closeSpaces();
      // The spaces closed after git, which can be a while after the press: if the
      // person is still in the list, their keyboard stays there.
      if (this.kbd) this.reclaim(cx);
      // Pins as the dialog worked them out: the spaces it closed lose theirs,
      // and one inside the checkout only goes if its space is gone too.
      if (Array.isArray(job.pins)) setShared("spaces.pinned", job.pins);
      // Git agreed, so the row goes now. A scan that was already reading must
      // not write the old checkout list back over this.
      this.treesGen = (this.treesGen ?? 0) + 1;
      // Its place in the person's worktree order goes too, or a later checkout
      // that reuses the path would inherit the removed row's position.
      for (const key of Object.keys(this.order ?? {})) {
        const list = Array.isArray(this.order[key]) ? this.order[key] : [];
        const kept = list.filter((p) => tidyPath(p) !== path);
        if (kept.length !== list.length) this.order[key] = kept;
      }
      for (const key of Object.keys(this.trees)) {
        const list = this.trees[key];
        if (Array.isArray(list)) this.trees[key] = list.filter((c) => tidyPath(c.path) !== path);
      }
      if (this.treesAt) {
        const main = tidyPath(job.main);
        for (const key of Object.keys(this.treesAt)) {
          if (tidyPath(key.split(SEP)[1] ?? "") === main) delete this.treesAt[key];
        }
      }
      this.forgetRepo?.(job.main);
      this.noteTree?.();
      persistWorkspace();
    } else {
      // The checkout is still there: it comes back to the list with the reason.
      // The cached rows stay, so it does not wait for a rescan to reappear.
      notify({ title: "Couldn't remove the worktree", body: error });
    }
    setShared("worktree.removing", removingList().filter((r) => !((r.machine ?? null) === on && tidyPath(r.path) === path)));
    this.refreshGit(cx);
    cx.notify();
  }

  // The dialog learns which space it was opened for, so the new checkout is
  // attached to it; the action itself is the shared one.
  beforeWorktree(s) {
    setShared("worktree.owner", { space: s.id, at: Date.now() });
  }

  newWorktree(s) {
    this.worktreeRow({ kind: "space", s });
  }

  // What the sidebar's keys do. Each one is a row of the space menu, run against
  // a space — the selected one, else the active one — so the keyboard and the
  // menu do exactly the same thing. The layout's own keys come here too: the
  // sidebar is mounted on the rail, and the footer and terminals list are not.
  command(c, cx) {
    if (c === "dir_down" || c === "dir_up") {
      const direction = c === "dir_down" ? "down" : "up";
      if (shared("search.open")) return setShared("search.move", `${direction}:${++this.moves}`);
      if (shared("sidebar.kb")) return setShared("sidebar.move", `${direction}:${++this.moves}`);
      return run("pane.go", { direction });
    }
    if (c === "flip_layout") return flipLayout();
    if (c === "close_pane" || c === "close_tab") return closeFocused(c);
    const space = this.spaceOf(this.entry());
    if (c === "focus_sidebar") return this.toggleFocus(cx);
    if (c === "toggle_sidebar") return toggleSidebar();
    // A space made with the keyboard in the list keeps the list: the new
    // terminal would take the keys.
    if (c === "new_space") { if (this.newSpace() && this.kb()) this.reclaim(cx); return; }
    if (!space) return;
    if (c === "close_space") this.closeRow({ kind: "space", s: space });
    else if (c === "worktree_new") this.newWorktree(space);
    else if (c === "worktree_open") this.dialog(space, "open", 560, 480);
    else if (c === "worktree_remove") this.dialog(space, "remove", 440, 155);
  }

  // The row the keyboard is on, and the space it belongs to (a row about an
  // agent still names a space, so w / r work on it).
  entry() {
    return (this.entries ?? []).find((e) => e.key === this.sel) ?? null;
  }

  spaceOf(e) {
    const id = e?.kind === "space" ? e.id : e?.spaceId;
    return (id && spaces().find((s) => s.id === id)) || spaces().find((s) => s.active) || null;
  }

  // The keyboard is the sidebar's only while this handle holds it; the row
  // highlight is drawn only then, so a terminal that has the keyboard never
  // shows a stray selection. `is_focused()` answers the window's truth; the flag
  // covers the turn in which focus was just claimed and the window has not
  // answered yet, and lets go as soon as the truth says the keyboard went
  // somewhere else.
  kb() {
    // A press outside said the list is done, even where the app left the focus
    // on this element: the answer to a press must not wait for the window.
    if (this.blurred) return false;
    const real = Boolean(this.handle?.is_focused());
    const now = Date.now();
    if (this.kbd) {
      if (real) {
        this.kbdSeen = true;
        return true;
      }
      // Confirmed once, then the window says the keyboard is elsewhere: it moved.
      if (this.kbdSeen) {
        this.kbd = false;
        this.kbdSeen = false;
        return false;
      }
      // The claim is still in flight: keep the look the press promised.
      if (now < this.pendingUntil) return true;
      this.kbd = false;
      return false;
    }
    // Focus can come back on its own (an overlay over this panel closing).
    if (real && now > this.pendingUntil) {
      this.kbd = true;
      this.kbdSeen = true;
      return true;
    }
    return false;
  }

  // The keyboard left the list: a press outside, or a pane asked for it. Never
  // steal it back — the press that took it away is already doing its own work.
  blur(cx) {
    this.barDrag = null;
    this.blurred = true;
    this.kbd = false;
    this.kbdSeen = false;
    this.pendingUntil = 0;
    this.stopReorder();
    cx?.notify?.();
  }

  // Back inside: the press will focus the panel itself (track_focus), so only the
  // "left already" answer is cleared here.
  touch(cx) {
    // A press anywhere in the panel ends a bar drag the pointer let go of
    // somewhere the release never came back from.
    this.barDrag = null;
    if (!this.blurred) return;
    this.blurred = false;
    this.kbd = true;
    this.kbdSeen = false;
    this.pendingUntil = Date.now() + 1000;
    cx?.notify?.();
  }

  // Where the keyboard lands when it comes in: the top row, always, so entering
  // is the same move every time and Up from it means nothing was skipped.
  focusKey() {
    return (this.entries ?? [])[0]?.key ?? null;
  }

  toggleFocus(cx) {
    // The press flips what the press before it asked for. The window's answer
    // only breaks a tie once no claim is in flight (a click into a terminal).
    const here = this.kbd && (Boolean(this.handle?.is_focused()) || Date.now() < this.pendingUntil);
    if (here) return this.leave(cx);
    this.blurred = false;
    // The rail has no list to move through: show the sidebar first.
    const rail = narrow();
    if (rail) toggleSidebar();
    this.sel = this.focusKey();
    this.kbd = true;
    this.kbdSeen = false;
    this.pendingUntil = Date.now() + 1000;
    this.handle?.focus();
    cx.notify();
    // The element that tracked the handle a moment ago is replaced by the render
    // above, so claim it once more on the element that is actually on screen.
    // Harmless when the first claim already landed.
    cx.timer.after(40, (cx) => {
      if (!this.kbd) return;
      this.handle?.focus();
      cx.notify();
    });
    if (rail) cx.timer.after(150, (cx) => {
      if (this.kb() && !this.entry()) { this.sel = this.focusKey(); this.scrollTop = 0; }
      cx.notify();
    });
  }

  // The sidebar asked for the change, so it keeps the keyboard: making or closing
  // a space hands focus to a terminal, and the list must not lose the person in
  // the middle of using it. Claims are spread over the moment the app settles.
  reclaim(cx) {
    this.blurred = false;
    this.handle?.focus();
    for (const ms of [40, 140, 340, 700]) cx.timer.after(ms, () => { this.handle?.focus(); cx.notify(); });
  }

  // Back to the terminal the window shows, without changing which pane that is.
  leave(cx) {
    this.kbd = false;
    this.kbdSeen = false;
    this.pendingUntil = Date.now() + 1000;
    // Hand the app's focus back to the pane the window shows. The style is
    // already off above, so the look never waits for the keyboard to catch up.
    const pane = focused()?.pane;
    if (pane) run("pane.focus", { pane });
    cx.notify();
  }

  walk(step, cx) {
    this.slide(step);
    cx?.notify?.();
  }

  // Move the highlight along the rows already drawn. The paint that noticed
  // the key draws the new row; notifying again would paint the list twice.
  slide(steps) {
    const list = this.entries ?? [];
    if (!list.length || !steps) return;
    this.stopReorder();
    let at = list.findIndex((e) => e.key === this.sel);
    if (at < 0) at = steps > 0 ? -1 : 0;
    const dir = steps > 0 ? 1 : -1;
    const count = Math.min(Math.abs(steps), list.length);
    for (let i = 0; i < count; i++) at = Math.max(0, Math.min(list.length - 1, at + dir));
    this.sel = list[at].key;
    this.reveal(list[at].at, this.bar?.key ?? "spaces");
  }

  // ---- The list's own scroll, and the bar drawn for it --------------------
  //
  // The app's bar is sixteen pixels wide, square and grey, and a mod cannot
  // change any of that: its width, its colours and its radius are the base
  // theme's, written in Rust, with no setter in this API. Clipping it only
  // hides the grey, never tints it.
  //
  // So the list scrolls here instead. The wheel moves `scrollTop`, the rows are
  // drawn `scrollTop` pixels up, and the bar is a thumb this mod paints: three
  // pixels of the theme's accent, fully rounded, no track, a little wider while
  // the pointer is on it. The wheel, the press on the bar, its drag and the
  // keyboard's reveal all do what they did before; only the grey pipe is gone.
  //
  // `key` names the view ("spaces", "plain"): the two lists have different rows
  // and different heights, and a sort switch must not read one's numbers
  // against the other's.

  // The list, its rows, and the lane the pointer grabs. Everything inside is
  // absolutely placed so it can be moved without the viewport resizing it.
  scroller(t, rows, key, opts = {}) {
    const padTop = opts.padTop ?? 0;
    const padBottom = opts.padBottom ?? 0;
    this.pad[key] = padTop;
    const hs = (this.rowH[key] ??= []);
    const viewH = this.viewH[key] ?? 0;
    const contentH = this.contentH[key] ?? 0;
    const max = Math.max(0, contentH - viewH);
    // A list that shrank under the pointer leaves the offset past its end.
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, max));
    const track = Math.max(0, viewH - BAR_INSET * 2);
    const on = track > 0 && max > 0.5;
    const thumbH = on ? Math.min(track, Math.max(26, track * viewH / contentH)) : 0;
    const thumbY = on ? (track - thumbH) * (this.scrollTop / max) : 0;
    this.bar = { key, track, thumbH, thumbY, max };
    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .on_size_change((size, cx) => {
        if (Math.abs((this.viewH[key] ?? -1) - size.height) < 0.5) return;
        this.viewH[key] = size.height;
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => this.listWheel(e, cx))
      .on_mouse_move((e, cx) => this.barMove(e, cx))
      .on_mouse_up("left", (_e, cx) => {
        let again = false;
        // A drag let go outside the rows leaves no pointer-up on a row: clear it
        // here, so the next click can't read as a move.
        if (this.pressed !== null) {
          this.pressed = null;
          this.over = null;
          again = true;
        }
        if (this.barDrag) {
          this.barDrag = null;
          again = true;
        }
        if (again) cx.notify();
      })
      .child(v_flex()
        // Absolute, so its height is the rows' own however tall they get, and
        // `top` can move it: a scrolled list, with nothing in the layout moving.
        .absolute()
        .left(0)
        .right(0)
        .top(padTop - this.scrollTop)
        .pl(8)
        .pr(12)
        .when(padBottom > 0, (el) => el.pb(padBottom))
        .on_size_change((size, cx) => {
          if (Math.abs((this.contentH[key] ?? -1) - size.height) < 0.5) return;
          this.contentH[key] = size.height;
          cx.notify();
        })
        // One measured wrapper per row: `reveal` sums them to find a row, since
        // there is no scroll area left to hand it a row index. The heights are
        // read after layout, so no repaint is asked for here.
        .children(rows.map((row, i) => div()
          .id(`${key}-row-${i}`)
          .flex_none()
          .on_size_change((size) => { hs[i] = size.height; })
          .child(row))))
      .when(on, (el) => el.child(div()
        .id(`${key}-bar`)
        .absolute()
        .top(BAR_INSET)
        .bottom(BAR_INSET)
        .right(0)
        .w(BAR_LANE)
        .cursor_default()
        .on_hover((over, cx) => {
          if (this.barHover === over) return;
          this.barHover = over;
          cx.notify();
        })
        .on_mouse_down("left", (e, cx) => this.barDown(e, cx))
        .child(div()
          .absolute()
          .right(BAR_INSET)
          .top(Math.round(thumbY))
          .w(this.barHover ? BAR_WIDTH + 1 : BAR_WIDTH)
          .h(Math.round(thumbH))
          .rounded_full()
          // Quiet at rest, the accent's own strength under the pointer: a bar
          // that sits in the corner without asking to be looked at.
          .bg(this.barHover ? wash(t.accent, "cc") : wash(t.accent, "80")))));
  }

  // Where a pointer at `y` in the track scrolls to: the thumb's travel is the
  // track less its own length, and that maps onto the offset's whole range.
  scrollToY(y) {
    const g = this.bar;
    if (!g) return 0;
    const span = Math.max(1, g.track - g.thumbH);
    return Math.max(0, Math.min((y / span) * g.max, g.max));
  }

  // A press on the bar takes the thumb, or jumps there and takes it from the
  // press, the way a scrollbar has always worked.
  barDown(e, cx) {
    const g = this.bar;
    if (!g || !(g.track > 0) || !(g.max > 0)) return;
    const y = Math.max(0, Math.min(e.local_position?.y ?? 0, g.track));
    const held = y >= g.thumbY && y <= g.thumbY + g.thumbH;
    const grab = held ? y - g.thumbY : g.thumbH / 2;
    this.barDrag = { grab };
    if (!held) this.scrollTop = this.scrollToY(y - grab);
    cx.stop_propagation();
    cx.notify();
  }

  // The pointer, while it holds the thumb. The lane starts BAR_INSET down,
  // and the move arrives against the list's own box.
  barMove(e, cx) {
    if (!this.barDrag) return;
    const next = this.scrollToY((e.local_position?.y ?? 0) - BAR_INSET - this.barDrag.grab);
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    cx.notify();
  }

  listWheel(e, cx) {
    const g = this.bar;
    if (!g || !(g.max > 0)) return;
    const next = Math.max(0, Math.min(this.scrollTop - (e.delta?.y ?? 0), g.max));
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    cx.notify();
  }

  // Keep the keyboard's row on screen. A row's top is the measured heights of
  // the rows above it, plus the list's own padding.
  reveal(at, key) {
    const hs = this.rowH[key] ?? [];
    if (!(at >= 0) || at >= hs.length) return;
    let top = this.pad[key] ?? 0;
    for (let i = 0; i < at; i++) top += hs[i] ?? 0;
    const h = hs[at] ?? 0;
    const viewH = this.viewH[key] ?? 0;
    const max = Math.max(0, (this.contentH[key] ?? 0) - viewH);
    if (top < this.scrollTop) this.scrollTop = Math.max(0, Math.min(top, max));
    else if (top + h > this.scrollTop + viewH) this.scrollTop = Math.max(0, Math.min(top + h - viewH, max));
  }

  // The spaces in the order the list draws them, within one section: a step is
  // the row above or below the highlighted one, never a jump into another status
  // group (those are regrouped on every status, so a move there would not stay).
  drawnSpaces(sect) {
    // One map for the whole walk: the old `spaces().find` per row was O(n²) on
    // every key press, and `spaces()` copies the model each call.
    const byId = new Map(frameCache("spaces", spaces).map((s) => [s.id, s]));
    return (this.entries ?? [])
      .filter((e) => e.kind === "space" && e.sect === sect && !e.linked)
      .map((e) => byId.get(e.id))
      .filter(Boolean);
  }




  // Ctrl+J/K with the keyboard in the sidebar: the app's keymap takes them first
  // (they are the handle's dir commands), so the handle hands the walk here as a
  // shared value. The same hand-off the find sheet uses.
  watchMoves(cx, on) {
    this.watchWalk(cx, on, "sidebar.move");
  }


  // The highlighted row, in the shape both views' actions take.
  sidebarRow(e) {
    if (!e) return null;
    if (e.kind === "space") return { kind: "space", s: this.spaceOf(e) };
    if (e.kind === "pin") return { kind: "pin", pin: e.pin };
    if (e.kind === "checkout") return { kind: "checkout", path: e.path, on: e.machine ?? null };
    if (e.kind === "agent") {
      // A sub-agent without a pane is not in agents(); the row still names the
      // terminal that would be stopped.
      const a = agents().find((x) => x.address === e.address)
        ?? { address: e.address, pane: e.pane ?? null, space: e.spaceId, parent: null };
      return { kind: "agent", a };
    }
    return null;
  }

  selectedRow() {
    return this.sidebarRow(this.entry());
  }

  // The sidebar leaves the keyboard to the pane it just opened; the sheet closes
  // instead. One hook each way.
  afterOpen(cx) {
    // Opening a row *is* the move: the app is about to focus the space, tab or
    // agent the action named. Only let go of the keyboard — focusing the pane
    // that was current a moment ago would drag the view back and undo the open.
    this.release(cx);
  }

  // Drop keyboard mode without asking the app for any pane: the action that just
  // ran already says where focus goes.
  release(cx) {
    this.kbd = false;
    this.kbdSeen = false;
    this.pendingUntil = Date.now() + 1000;
    cx.notify();
  }

  // Ctrl+Shift+J/K: the space steps inside the section it is drawn in. The
  // section is the urgency, so a step never crosses into another one (that
  // would be undone on the next status). A worktree row steps inside its repo
  // group instead, through the persisted worktree order.
  beginReorder(dir, cx) {
    // A checkout step in flight keeps its own path: a press that lands before
    // the next paint would otherwise read the highlight's *index* and name its
    // neighbour. Same for a space step below.
    const moving = this.pathSubject();
    if (moving) {
      return this.startPathReorder(this.pathGroup, moving, this.pathPaths ?? [], dir, cx, this.pathAfter);
    }
    const e = this.entry();
    const row = this.sidebarRow(e);
    const held = this.reorderSubject();
    const targetRow = held ? { kind: "space", s: held } : row;
    if (targetRow?.kind === "checkout" || (targetRow?.kind === "space" && this.isWorktree(targetRow.s))) {
      return this.reorderWorktreeRow(targetRow, e, dir, cx);
    }
    const s = targetRow?.kind === "space" ? targetRow.s : null;
    const sect = e?.sect;
    if (!s || sect == null) return;
    this.startReorder(s, dir, {
      // The section's rows in the order the app will have, not the order the
      // last paint drew: a step lands asynchronously, and the neighbour read
      // from the painted list is the one already moved past. Pinned rows read
      // the pin list instead: a pin moves at the press, so the drawn order is
      // already the order that will be, and the app's space order says nothing
      // about it.
      ids: (list = spaces()) => {
        const drawn = this.drawnSpaces(sect).map((x) => x.id);
        if (/pinned$/.test(String(sect))) return drawn;
        const rank = new Map((list ?? []).map((x, i) => [x.id, i]));
        return drawn.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
      },
      after: (moved) => { this.sel = `sp-${moved.id}`; },
    }, cx);
  }

  // A worktree checkout (opened as a space or not) steps among its siblings in
  // the repo group. It is never a `space.move`: checkouts have their own order,
  // persisted per repo so a nested move cannot corrupt Herdr's spaces.
  reorderWorktreeRow(row, e, dir, cx) {
    const all = frameCache("spaces", spaces);
    const list = listedCheckouts();
    const s = row?.kind === "space" ? row.s : null;
    const c0 = row?.kind === "checkout"
      ? list.find((x) => (x.on ?? null) === (row.on ?? null) && tidyPath(x.path) === tidyPath(row.path))
      : null;
    const rec = s ? this.checkoutRecord(s, this.paneSnap) : null;
    // The repo's identity, even before a sticky record exists.
    const groupKey = spaceRecord(s)?.groupKey
      ?? (rec?.main ? `${s?.machine ?? ""}${SEP}${tidyPath(rec.main)}` : null)
      ?? (s ? groupKeyOf(s, this.paneSnap) : null)
      ?? (c0 ? `${row.on ?? ""}${SEP}${tidyPath(c0.repoMain ?? "")}` : null);
    const path = c0 ? c0.path : rec?.root ?? null;
    const machine = c0 ? row.on ?? null : s?.machine ?? null;
    const key = c0 ? `ck-${machine ?? ""}-${c0.path}` : s ? `sp-${s.id}` : null;
    if (!groupKey || !path) return;
    const paths = this.pathSiblings(groupKey, all, list);
    this.startPathReorder(groupKey, path, paths, dir, cx, (moved) => {
      const hit = all.find((x) => tidyPath(this.checkoutRecord(x, this.paneSnap)?.root ?? "") === moved);
      this.sel = hit ? `sp-${hit.id}` : key;
    });
  }

  // Enter: go there, through the same action the find sheet's Enter runs.
  activate(cx) {
    this.openRow(this.selectedRow(), cx);
  }

  // Ctrl+D: close a space, remove a checkout, or stop an agent — the same rule
  // the sheet's Ctrl+D uses, dialog and all.
  closeEntry() {
    this.closeRow(this.selectedRow());
  }

  pinEntry(cx) {
    const row = this.selectedRow()
      ?? (this.spaceOf(null) ? { kind: "space", s: this.spaceOf(null) } : null);
    this.pinRow(row);
    cx.notify();
  }

  // Ctrl+A: a worktree of the row, through the shared action.
  newWorktreeEntry() {
    this.worktreeRow(this.selectedRow());
  }

  // Ctrl+R: rename the row's space, the app's own prompt (as the menu's Rename).
  renameEntry() {
    this.renameRow(this.selectedRow());
  }

  // f: fold or unfold the selected space or agent.
  foldEntry(cx) {
    const e = this.entry();
    const id = e?.kind === "space" ? `sp-${e.id}` : e?.kind === "agent" ? e.address : null;
    if (!id) return;
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    cx.notify();
  }

  // Plain keys, only while the sidebar holds the keyboard (Alt+B). Everything
  // with a modifier stays an app binding, so those keep working here too. Plain
  // keys are consumed even when they do nothing: while the list has the keyboard,
  // typing must not fall through and land in the terminal behind it.
  key(e, cx) {
    if (!this.kb()) return;
    const m = e.modifiers ?? {};
    const k = e.key;
    // Any key that is not the held reorder step ends it.
    if (!(m.control && m.shift && (k === "j" || k === "k"))) this.stopReorder();
    // The find sheet's map, key for key, in one method both views call: walking
    // with Ctrl+J/K, reordering with Ctrl+Shift+J/K, pinning with Ctrl+P,
    // renaming with Ctrl+R, closing or removing with Ctrl+D, a worktree with
    // Ctrl+A. It sits above the modifier return, which would hand these to the
    // app.
    if (this.chord(e, cx)) {
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (m.control || m.alt || m.platform) return;
    cx.stop_propagation();
    const act =
      k === "down" || k === "j" ? () => this.walk(1, cx)
        : k === "up" || k === "k" ? () => this.walk(-1, cx)
          : k === "home" ? () => this.walk(-1e6, cx)
            : k === "end" ? () => this.walk(1e6, cx)
              : k === "enter" ? () => this.activate(cx)
                : k === "escape" || k === "q" ? () => this.leave(cx)
                  : k === "n" ? () => { if (this.newSpace() && this.kb()) this.reclaim(cx); }
                    : k === "g" ? () => this.command("worktree_open", cx)
                      : k === "f" ? () => this.foldEntry(cx)
                        : null;
    act?.();
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
        sidebarDialog({ mod: "worktrees", kind: "dialog", width: 440, height: 156, props: { agent: a.address } });
      });
      items = [
        { id: "am-focus", icon: "terminal", label: "Focus", act: then(() => this.focusAgent(a)) },
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
          act: then(() => this.openCheckout({ path, on })) },
        { id: "cm-remove", icon: "minus", label: "Remove worktree",
          act: then(() => sidebarDialog({ mod: "worktrees", kind: "dialog", width: 440, height: 155, props: { folder: path, machine: on, action: "remove" } })) },
      ];
    } else {
      const s = spaces().find((x) => x.id === menu.id);
      if (!s) return div();
      const pin = this.spacePin(s);
      // A worktree's own folder first: its shell may have cd'd out of the
      // checkout, and the menu's actions are about the checkout.
      const folder = checkoutRecordOf(s)?.root ?? (inWorktrees(s.folder) ? s.folder : (place(s, panes()) ?? s.folder ?? null));
      // A linked checkout is a worktree: it hangs under its repo, and pins are
      // for spaces, so neither the row nor this menu offers to pin it.
      const isWorktreeSpace = this.isWorktree(s) || Boolean(this.linked);
      const worktree = (action, width, height, extra = {}) => then(() => {
        if (action === "new") setShared("worktree.owner", { space: s.id, at: Date.now() });
        sidebarDialog({ mod: "worktrees", kind: "dialog", width, height,
          props: { space: s.id, ...(action === "remove" && folder ? { folder } : {}), action, ...extra } });
      });
      const closeSpace = then(() => sidebarDialog({ mod: "worktrees", kind: "dialog", width: 440, height: 150, props: { space: s.id, action: "space" } }));
      items = [
        { id: "sm-new-wt", icon: "git-branch", label: "New worktree", act: worktree("new", 460, 170, folder ? { folder } : {}) },
        { id: "sm-open-wt", icon: "folder", label: "Open worktree", act: worktree("open", 560, 480) },
        // A linked checkout is known from its path, so this row never waits on git.
        ...(inWorktrees(folder) || this.linked ? [{ id: "sm-remove-wt", icon: "minus", label: "Remove worktree", act: worktree("remove", 440, 155) }] : []),
        SEP,
        ...(isWorktreeSpace ? [] : [{ id: "sm-pin", icon: pin ? "pin-off" : "pin", label: pin ? "Unpin space" : "Pin space to the top",
          act: then(() => this.setPin(s)) }]),
        { id: "sm-rename", icon: "square-pen", label: "Rename", act: then(() => run("space.rename", { id: s.id })) },
        SEP,
        // A pinned space is never closed, and a worktree's space is ended by
        // removing its checkout: neither is offered a close of its own, so the
        // menu cannot lead to a dialog that would only refuse or half-do it.
        ...(pin || isWorktreeSpace ? [] : [{ id: "sm-close", icon: "x", label: "Close space", act: closeSpace }]),
        { id: "sm-new-space", icon: "plus", label: "New space", act: then(() => this.newSpace()) },
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

  subRow(t, s, shown, compact, nest = 0) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .relative()
      // A sub-agent sits one step in from the agent row that drew it. Under a
      // worktree's agent that row is already two steps in (nest 2), so the old
      // fixed 40 px put the child left of its parent and outside the gutter.
      .pl(nest > 0 ? 11 + nest * 29 : 40)
      .pr(7)
      .rounded(7)
      .h(27)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(11.5)
      .when(this.kbPaint && this.sel === `sub-${k.address}`, (el) => el.bg(wash(t.accent, "26")))
      .hover((s) => s.bg(wash(t.foreground, "0b")))
      .on_click(() => this.focusAgent(k))
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
  // bottom of one third of it. `toggleSidebar` fits at the press; this method is
  // the width clock for a drag and the restart path.
  fitRail(px) {
    const sidebar = find(layout(), "sidebar");
    fitRailTo(typeof px === "number" ? px : (sidebar?.size?.px ?? Infinity), sidebar);
  }

  // The rail's state, at the avatar's corner: a spinner while working, a "!"
  // when it needs you, a filled dot when done, a hollow ring when idle. The
  // idle ring is the same quiet mark the rows use; a filled dot for it read as
  // a disabled control.
  railMark(t, status) {
    const corner = () => div().absolute().right(1).bottom(1).flex().items_center().justify_center();
    if (status === "working") return corner().size(12).rounded_full().bg(t.chrome)
      .child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.accent).spin(900));
    if (status === "blocked") return corner().size(12).rounded_full().bg(t.chrome)
      .child(div().size(9).rounded_full().bg(t.blocked).text_size(8).font_bold().text_color(t.chrome)
        .flex().items_center().justify_center().child("!"));
    if (status === "done") return corner().size(6).rounded_full().bg(t.done).border(1.5).border_color(t.chrome);
    if (status === "idle") return corner().size(6).rounded_full().bg(t.chrome)
      .border(1.5).border_color(t.idle ?? t.dim);
    return null;
  }

  // The rail: a column of space avatars, whatever the list is showing — spaces
  // in the spaces view, agents elsewhere — then search, shortcuts and settings.
  rail(t, cells, id, limit = null) {
    const { shown, beyond } = railShown(cells, limit);
    return v_flex().size_full().min_h(0).bg(t.chrome).items_center().pt(12).gap(2)
      .border(1)
      .border_color(this.kbPaint ? wash(t.accent, "7a") : t.chrome)
      .when(this.kbPaint, (el) => el.bg(wash(t.accent, "08")))
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_key_up((e) => { if (e.key === "j" || e.key === "k") this.stopReorder(); })
      // A press inside comes back to the list; a press anywhere else ends the
      // keyboard mode even when the app leaves focus where it was.
      .on_mouse_down("left", (_e, cx) => this.touch(cx))
      .on_mouse_down_out((_e, cx) => this.blur(cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "sidebar-menu", kind: "popup", width: 250 }); })
      .child(this.iconButton(t, "rail-expand", "mods/workspace-chrome/chevron-right.svg", "Show sidebar", toggleSidebar, 13))
      .child(div().w(16).h(1).my(3).bg(wash(t.foreground, "10")))
      // items_center here is what centres a cell in the 44 px rail: the cells
      // column is its own box, so the rail's own centring does not reach them.
      .child(v_flex().id(id).flex_1().min_h(0).gap(2).items_center().overflow_y_scrollbar()
        .children([
          ...shown.map((c) => {
            const mark = this.railMark(t, c.status);
            return h_flex()
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
              .child(div().size(20).flex_none().rounded(5).bg(c.fill)
                .flex().items_center().justify_center()
                .border(1).border_color(c.active ? wash(t.accent, "a0") : wash(t.foreground, "17"))
                .text_size(9.5).font_semibold().text_color("#ffffff")
                .child(c.initial))
              .when(Boolean(mark), (x) => x.child(mark));
          }),
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
        () => run("mod.open", { name: "agents-list" })))
      .child(this.iconButton(t, "rail-keys", "mods/icons/keyboard.svg", "Keyboard shortcuts",
        () => run("mod.open", { name: "shortcuts" })))
      .child(this.iconButton(t, "rail-settings", "mods/icons/settings.svg", "Settings",
        () => run("app.settings")))
      .child(div().h(8).flex_none());
  }

  // The rail's cell for a pin whose space has exited. It wears the colour and
  // initial the open tree's pin row wears, and opens a shell in the place, so
  // collapsing the sidebar loses neither the row nor what it stands for.
  pinCell(t, p) {
    const tone = p.color ?? folderColor(p.folder);
    const color = tone.startsWith("#") ? tone : (MARK[tone] ?? t[tone] ?? t.dim);
    const name = pinLabel(p);
    return {
      key: `pin-${p.machine ?? ""}-${norm(p.folder)}`,
      tip: `${p.folder} \u00b7 click to open a shell there`,
      active: false,
      status: null,
      fill: color,
      initial: initial(name),
      act: () => this.openRow({ kind: "pin", pin: { ...p } }),
    };
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
      .when(this.kbPaint && this.sel === `sub-${k.address}`, (el) => el.bg(wash(t.accent, "26")))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.focusAgent(k))
      .children(s.lines.map((l) => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.plainStatus(t, { status: st }, compact));
  }

  // The fold chevron; folded, the count too, colored by the most urgent one.
  plainFold(t, a, subs) {
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
        cx.stop_propagation();
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
    // A removed worktree's agents go with its row: the view is the same picture.
    let list = agents().filter((a) => !this.removedNow?.has(a.space));
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const treeMemo = new Map();
    const subsOf = (addr) => {
      let hit = treeMemo.get(addr);
      if (!hit) { hit = this.tree(all, addr); treeMemo.set(addr, hit); }
      return hit;
    };
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => subsOf(a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const rankOf = (a) => RANK[a.status] ?? 0;
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    this.publishOrder(list.map((a) => a.address));
    // Folded, the rail is the avatars only. Building every row and throwing it
    // away was the delay while the sidebar was narrow.
    if (collapsed) return this.rail(t, list.map((a) => {
      const name = a.space_name || a.program?.name || a.address;
      return {
        key: a.address,
        tip: [a.space_name, a.program?.name ?? a.address, STATE[a.status]].filter(Boolean).join(" \u00b7 "),
        active: a.focused,
        status: a.status,
        fill: spaceColor(t, { id: a.space, name: a.space_name }),
        initial: initial(name),
        act: () => this.focusAgent(a),
      };
    }), "rail-agents");

    // Each row comes back with what it stands for, so the keyboard can walk the
    // list in the order it is drawn.
    const withKids = (a, i) => {
      const subs = collapsed ? [] : subsOf(a.address);
      const r = row(a, i, subs);
      const mine = [{ key: `ag-${a.address}`, kind: "agent", address: a.address, pane: a.pane, spaceId: a.space, focused: a.focused }, r];
      if (this.folded.has(a.address)) return [mine];
      return [mine, ...subs.map((s) => [{ key: `sub-${s.t.address}`, kind: "agent", address: s.t.address, pane: null, spaceId: a.space }, this.plainSubRow(t, s, shown, byPriority)])];
    };

    // A row reads "space · detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(frameCache("spaces", spaces).flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
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
          .on_click(() => this.focusAgent(a))
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
        .when(this.kbPaint && this.sel === `ag-${a.address}`, (el) => el.bg(wash(t.accent, "26")))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.focusAgent(a))
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
        .when(subs.length > 0, (el) => el.child(this.plainFold(t, a, subs)))
        .when(Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.plainStatus(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `space-${a.space}`;
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
    const rows = [];
    const emit = (pairs) => {
      for (const [entry, el] of pairs) {
        rows.push(el);
        this.entries.push({ ...entry, at: rows.length - 1 });
      }
    };
    for (const g of groups) {
      rows.push(header(g));
      if (!this.folded.has(g.id)) g.members.forEach((a, i) => emit(withKids(a, i)));
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      // The ring is drawn in the panel's own colour while the terminal has the
      // keyboard, so taking focus never moves a row by a pixel.
      .border(1)
      .border_color(this.kbPaint ? wash(t.accent, "7a") : t.chrome)
      .when(this.kbPaint, (el) => el.bg(wash(t.accent, "08")))
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_key_up((e) => { if (e.key === "j" || e.key === "k") this.stopReorder(); })
      // A press inside comes back to the list; a press anywhere else ends the
      // keyboard mode even when the app leaves focus where it was.
      .on_mouse_down("left", (_e, cx) => this.touch(cx))
      .on_mouse_down_out((_e, cx) => this.blur(cx))
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
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(this.kbPaint ? t.accent : t.dim).child("Agents"))
            .child(this.iconButton(t, "ag-sort", `mods/workspace-chrome/${sort.icon}.svg`, `Sort agents: ${sort.label}`,
              () => openOverlay({ mod: "agents-list", kind: "popup", width: 230, height: 172, props: { sortMenu: true } }), 13, sort.id !== "priority"))
            .child(this.iconButton(t, "ag-search", "mods/icons/search.svg", "Search \u00b7 Alt+F",
              () => run("mod.open", { name: "agents-list" })))
            .child(this.iconButton(t, "ag-hide", "mods/icons/sidebar.svg", "Collapse sidebar", toggleSidebar)),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(14).pt(4).text_size(12).text_color(t.dim)
          .child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      // The list, scrolled and barred by this mod (see `scroller`).
      .child(this.scroller(t, rows, "plain"));
  }

  render(cx) {
    beginPaint();
    try {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.menu) return this.menuView(t, cx);
    // The sheet asks this copy to scan. Keep the context it will spawn on.
    this.scanCx = cx;
    // Read the focus answer once per render, so every style below agrees.
    const here = this.kb();
    this.kbPaint = here;
    // Ctrl+J/K are the app's keys (the footer's dir commands), so a panel with the
    // keyboard cannot see them. Say where the keyboard is, and the footer hands
    // the walk back here.
    if (here !== this.publishedKb) {
      this.publishedKb = here;
      setShared("sidebar.kb", here);
      this.watchMoves(cx, here);
    }
    // The key already repainted this view. Step before the rows are rebuilt,
    // using the list from the paint before, so this paint shows the new row.
    const steps = this.pendingSteps();
    if (steps) this.slide(steps);
    // The rows the keyboard moves through, in the order they are drawn.
    this.entries = [];
    // One space and one pin read for this frame, whichever list draws: a place
    // whose space is gone is drawn on its own line, and a space standing in a
    // pin's place takes that pin — and its line — back, so exiting a pinned
    // space's shell never reshuffles Pinned. The rail and the expanded tree read
    // the same two lists, so collapsing changes the drawing and nothing else.
    const spaceList = frameCache("spaces", spaces);
    // One pane snapshot for this frame. `place` copies the whole list per call.
    const paneList = frameCache("panes", panes);
    this.paneSnap = paneList;
    this.bindPins(spaceList);
    // A worktree whose checkout is gone is not a place to show, pinned or not:
    // its rows, its agents and its pin all go, in every view and in the sheet.
    const removed = this.removedWorktrees(spaceList, paneList);
    this.removedNow = removed;
    const pinsNow = this.shownPins(spaceList, paneList);
    // A pinned row names the place, never the program's report of where it is:
    // an agent at `~` made the reel pin read `~` and open home. A space the person
    // named keeps its own name, so renames still show.
    const pinOfSpace = (s) => pinsNow.find(({ s: live }) => live?.id === s?.id)?.p ?? null;
    const placeName = (s, sect) => {
      if (!/pinned$/.test(String(sect))) return this.spaceName(s);
      const p = pinOfSpace(s);
      return p && !p.named && !s?.named ? pinLabel(p) : this.spaceName(s);
    };
    // One layout read for the width, the rail and the header. `layout()` copies
    // the whole tree, and this frame used to ask for it twice.
    const sort = sortOf();
    const sidePx = find(frameCache("layout", layout), "sidebar")?.size?.px ?? Infinity;
    this.sidePx = sidePx;
    this.sidePxAt = Date.now();
    // Priority and Grouped by space are Herdr's own list; only the third view is
    // drawn the way this mod draws spaces.
    if (sort.id !== "spaces") return this.plainList(t, cx);
    const collapsed = sidePx < 160;
    // Search, sort and hide live in the header; the count gives way first when
    // the sidebar is narrow.
    const roomy = sidePx >= 210;
    // A checkout on its way out takes its agents with it, before git has finished.
    const leaving = new Set(spaceList.filter((s) => isRemoving(place(s, paneList) ?? s.folder, s.machine)).map((s) => s.id));
    let list = agents().filter((a) => !leaving.has(a.space) && !removed.has(a.space));
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const treeMemo = new Map();
    const subsOf = (addr) => {
      let hit = treeMemo.get(addr);
      if (!hit) { hit = this.tree(all, addr); treeMemo.set(addr, hit); }
      return hit;
    };
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => subsOf(a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const bySpaces = sort.id === "spaces";
    // Spaces and worktrees are git reads, so they wait for the timer — unless
    // something just changed. A new space, or a worktree the dialog finished
    // making, reads git again at once instead of up to a tick later.
    // Opening the view is not a reason to read every repo again: the scan runs
    // in every view (the picture is shared), so a forced pass here only spawned
    // a storm of git subprocesses on the press that switched the sort.
    if (bySpaces && this.shownView !== "spaces") {
      this.shownView = "spaces";
      this.refreshGit(cx);
      this.refreshMachines(cx);
    } else if (!bySpaces) {
      this.shownView = sort.id;
    }
    // Order is not part of the signature: dragging a row must not rescan git.
    // A new or removed space is. A worktree the dialog just made is drawn in
    // this frame, then git confirms it without throwing the cached summaries away.
    const idsNow = frameCache("spaces", spaces).map((s) => s.id).sort().join(",");
    const createdAt = shared("worktree.createdAt") ?? 0;
    if (createdAt !== (this.createdAt ?? 0)) {
      this.createdAt = createdAt;
      const createdNow = shared("worktree.created");
      if (createdAt && typeof createdNow === "string") this.noteCreated(createdNow, createdAt);
    }
    const missing = this.folderMissing(paneList);
    if (idsNow !== this.ids || createdAt !== (this.createdSeen ?? 0) || missing) {
      this.ids = idsNow;
      this.createdSeen = createdAt;
      if (this.ids) this.refreshGit(cx);
    }
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...subsOf(a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];

    // Folded, the rail is the spaces' avatars. The tree below is what the open
    // sidebar draws; building it here and discarding it was the delay.
    if (collapsed) {
      // A worktree is a checkout under its repo, not another space: counting it
      // here made the rail show six cells for five places. The rail lists the
      // places, each with its avatar; the checkout stays in the expanded tree and search.
      // A worktree is a checkout under its repo, never a place of its own; the
      // shared rule knows one even after its shell cds out.
      const places = spaceList.filter((sp) => !this.isWorktree(sp) && !removed.has(sp.id)
        && !isRemoving(place(sp, paneList), sp.machine) && !isRemoving(sp.folder, sp.machine));
      // The same places, in the same order both lists draw: pinned slots first,
      // then needs you, done, working, idle. Collapsing the sidebar must not
      // reshuffle the avatars, and a status tick must move a cell only when it
      // moves the row.
      // A pin whose space has exited keeps its slot here too. The open tree
      // draws that row from the pin alone; reading only the live spaces made the
      // cell vanish with the shell — the one thing a pin is for.
      const byId = new Map(places.map((sp) => [sp.id, sp]));
      // Ctrl+1…Ctrl+9 select by the app's own space index, not the rail's: after
      // grouping, the nth cell is not the nth space. Only a cell whose key really
      // selects it names that key.
      const appAt = new Map(spaceList.map((sp, i) => [sp.id, i]));
      const cell = (sp) => {
        const at = appAt.get(sp.id);
        const p = pinOfSpace(sp);
        const name = p && !p.named && !sp.named ? pinLabel(p) : this.spaceName(sp);
        return {
          key: sp.id,
          tip: [name, STATE[sp.status], at != null && at < RAIL_MAX_SPACES ? `Ctrl+${at + 1}` : null].filter(Boolean).join(" \u00b7 "),
          active: sp.active,
          status: sp.status,
          fill: spaceColor(t, sp),
          initial: initial(name),
          act: () => run("space.select", { id: sp.id }),
        };
      };
      const cells = [];
      for (const { p, s } of pinsNow) {
        const sp = s ? byId.get(s.id) : null;
        if (sp) { byId.delete(sp.id); cells.push(cell(sp)); }
        // A live worktree is not a place: it stays under its repo in the tree.
        else if (!s) cells.push(this.pinCell(t, p));
      }
      for (const sp of orderedPlaces([...byId.values()], [])) cells.push(cell(sp));
      return this.rail(t, cells, "rail-spaces", RAIL_MAX_SPACES);
    }

    // Each row comes back with the thing it stands for, so the keyboard can walk
    // the list in the order it is drawn.
    const withKids = (a, i, nest = 0) => {
      const subs = collapsed ? [] : subsOf(a.address);
      const r = row(a, i, subs, nest);
      const mine = [{ key: `ag-${a.address}`, kind: "agent", address: a.address, pane: a.pane, spaceId: a.space, focused: a.focused }, r];
      if (this.folded.has(a.address)) return [mine];
      return [mine, ...subs.map((s) => [{ key: `sub-${s.t.address}`, kind: "agent", address: s.t.address, pane: null, spaceId: a.space }, this.subRow(t, s, shown, byPriority, nest)])];
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
    // The pane snapshot was taken at the top of this render.
    const leads = leadPanes(paneList);
    const tabs = new Map(frameCache("spaces", spaces).flatMap(s => s.tabs).map(tab => [tab.id, tab]));
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
      // The tree gutter follows the row's own indent (a worktree's agents are
      // one level deeper than a repo's).
      const gutter = 30 + Math.max(0, nest - 1) * 29;
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
          .on_click(() => this.focusAgent(a))
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
        .when(this.kbPaint && this.sel === `ag-${a.address}`, (el) => el.bg(wash(t.accent, "26")))
        .hover((s) => s.bg(wash(t.foreground, "0b")))
        .on_click(() => this.focusAgent(a))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.agentMenu(a); })
        .when(nest > 0, (el) => el.child(div().absolute().left(gutter).top(0).bottom(0).w(1).bg(wash(t.foreground, "12"))))
        .when(nest > 0, (el) => el.child(div().absolute().left(gutter).top(17).w(7).h(1).bg(wash(t.foreground, "12"))))
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
      // reorder, right-click menu) with the find sheet's tree under them: a section
      // per space urgency, every space listed, worktrees under their checkout,
      // and each space's agents one level in.
      const allSpaces = spaceList.filter((s) => !removed.has(s.id)
        && !isRemoving(place(s, paneList), s.machine) && !isRemoving(s.folder, s.machine));
      const pinOf = (s) => this.spacePin(s);
      const kidsOf = new Map();
      for (const a of list) kidsOf.set(a.space, [...(kidsOf.get(a.space) ?? []), a]);

      // Git as the default list reads it: repo, branch, ahead/behind, and whether
      // this checkout is a linked worktree. Both the live place and the folder a
      // space was made in count, so a shell that cds out of its worktree keeps it.
      const gitOf = (s) => this.checkoutRecord(s, paneList);
      const info = new Map(allSpaces.map((s) => [s.id, this.spaceGit(s, paneList)]));
      // Forget spaces that closed, so the remembered checkouts cannot pile up.
      const liveIds = new Set(allSpaces.map((s) => s.id));
      for (const id of this.checkoutById.keys()) if (!liveIds.has(id)) this.checkoutById.delete(id);
      // Every checkout this panel knows, in the shape the shared tree takes.
      // The sheet builds its forest from the same list.
      const trees = listedCheckouts();
      // One tree for both views: which space holds each worktree and which holds
      // each checkout nobody has opened. The same spaces and folders keep the
      // tree from the frame before, so a status tick does not rebuild it.
      const forestKey = pictureKey(paneList, allSpaces);
      const forest = forestKey === this.forestKey && this.forest
        ? this.forest
        : worktreeTree(allSpaces, gitOf, trees, paneList);
      if (forest !== this.forest) {
        this.forest = forest;
        this.forestKey = forestKey;
      }
      this.worktreeSpaces = forest.worktrees;
      // "Spaces" means places to work, not the checkouts under them: a worktree
      // space is drawn under its repo, and counting it again read as a space
      // nobody could see. Agents are not spaces either.
      this.spaceCount = allSpaces.filter((s) => !forest.worktrees.has(s.id)).length;

      // A worktree just made from a folded space opens it, or it would land unseen.
      const owner = shared("worktree.owner");
      const ownerId = owner && Date.now() - (owner.at ?? 0) < 2 * 60000 ? owner.space : null;
      if (ownerId) this.folded.delete(`sp-${ownerId}`);
      const byId = new Map(allSpaces.map((s) => [s.id, s]));
      const parentOf = (s) => (s && forest.parents.has(s.id) ? byId.get(forest.parents.get(s.id)) ?? null : null);
      // A worktree is nested only when a parent is there to draw it under, so it
      // can never fall out of both lists. Nested worktrees of worktrees stay
      // top-level: the tree is two levels deep.
      const isNested = (s) => Boolean(parentOf(s)) && !parentOf(parentOf(s));
      const wtOf = new Map();
      const ckOf = new Map();
      // The person's order comes first, then the scan's. `groupKeyOf` is the
      // repo identity from the sticky record; both lists are the same order the
      // reorder keys and drags write, so a row never jumps on the next scan.
      const worktreesOf = (s) => {
        let hit = wtOf.get(s.id);
        if (!hit) {
          hit = orderedPaths(groupKeyOf(s, paneList),
            allSpaces.filter((w) => forest.parents.get(w.id) === s.id),
            (w) => this.checkoutRecord(w, paneList)?.root ?? "");
          wtOf.set(s.id, hit);
        }
        return hit;
      };
      // The checkouts this space's repo holds that no space stands in, as the
      // shared tree placed them, in the same persisted order. A row asks twice
      // (the fold count and the chevron).
      const checkoutsOf = (s) => {
        const hit = ckOf.get(s.id);
        if (hit) return hit;
        const out = [];
        for (const c of trees) {
          if (forest.checkoutParents.get(`${c.on ?? ""}\u0000${c.path}`) !== s.id) continue;
          if (isRemoving(c.path, c.on)) continue;
          out.push(c);
        }
        const ordered = orderedPaths(groupKeyOf(s, paneList), out, (c) => c.path);
        ckOf.set(s.id, ordered);
        return ordered;
      };
      // A worktree's place among its group's worktrees: the drop line and the
      // drag both read this, never `allSpaces.indexOf` (which counts spaces of
      // every repo and machine).
      const groupRank = (id, parentId) => {
        const p = allSpaces.find((x) => x.id === parentId);
        if (!p) return -1;
        const paths = [
          ...worktreesOf(p).map((w) => tidyPath(this.checkoutRecord(w, paneList)?.root ?? "")),
          ...checkoutsOf(p).map((c) => tidyPath(c.path)),
        ];
        const row = allSpaces.find((x) => x.id === id);
        const path = row ? tidyPath(this.checkoutRecord(row, paneList)?.root ?? "") : "";
        return paths.indexOf(path);
      };

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
          .child(div().flex_none().text_size(11).font_medium().text_color(tone ?? t.dim).child(label))
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
        // A checkout at the top of a section (a worktree whose repo has no space
        // here) keeps the branch mark, not the avatar: it reads as the checkout it
        // is, and it never gains a space's drag or its pin.
        const linked = !tree && forest.worktrees.has(s.id);
        const pin = pinOf(s);
        const fill = spaceColor(t, s);
        // Folded, it still says what is hidden, and how urgent the agents inside
        // are: a chevron alone made "2 agents need you in here" invisible.
        const hidden = open ? 0 : kids.length + worktreesOf(s).length + checkoutsOf(s).length;
        const top = kids.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
        const topTone = top === "blocked" ? t.blocked : top === "done" ? t.done : top === "working" ? t.accent : null;
        const label = placeName(s, sect);
        const index = tree ? groupRank(s.id, forest.parents.get(s.id)) : allSpaces.indexOf(s);
        const from = this.pressed === null ? -1
          : (tree && this.pressParent != null ? groupRank(this.pressed, this.pressParent) : allSpaces.findIndex((x) => x.id === this.pressed));
        // The drop line belongs to the drag's own list: a space in its section
        // and on its machine, a worktree among its repo's worktrees.
        const overHere = this.pressed !== null && this.over === s.id && this.pressed !== s.id
          && this.pressSect === sect
          && (tree
            ? this.pressTree && this.pressParent === forest.parents.get(s.id)
            : !this.pressTree && this.pressMachine === (s.machine ?? null));
        // The pin shows for a pinned space, and for the row the keyboard is on.
        // A mouse hover used to rebuild the whole sidebar on every row.
        const hovered = this.kbPaint && this.sel === id;
        return h_flex()
          .id(id)
          .relative()
          .mx(2)
          .pl(tree ? 36 : 7)
          .pr(3)
          .h(tree ? 28 : 30)
          .flex_none()
          .gap(6)
          .items_center()
          .rounded(7)
          .overflow_hidden()
          .when(s.active, (el) => el.bg(t.selected))
          .when(this.kbPaint && this.sel === id, (el) => el.bg(wash(t.accent, "26")))
          .when(!s.active, (el) => el.hover((x) => x.bg(t.hover)))
          .when(this.pressed === s.id && this.over !== s.id, (el) => el.opacity(0.45))
          .when(overHere, (el) => el.child(div()
            .absolute().left(6).right(6).h(2).rounded(1).bg(t.accent)
            .when(from < index, (l) => l.bottom(0))
            .when(from > index, (l) => l.top(0))))
          .on_mouse_down("left", () => {
            // A worktree is dragged inside its own repo group (it has its own
            // persisted order); it is never a `space.move`. A checkout whose repo
            // has no row here is not a space of any section: it opens on click and
            // keeps the order its repo's list has. Anything else is a space in its
            // section.
            if (linked) { this.pressed = null; this.over = null; return; }
            this.pressed = s.id; this.over = s.id;
            this.pressSect = sect;
            this.pressMachine = s.machine ?? null;
            this.pressTree = Boolean(tree);
            this.pressParent = tree ? (forest.parents.get(s.id) ?? null) : null;
          })
          .on_mouse_move((_e, cx) => {
            if (this.pressed === null) { if (this.over !== null) { this.over = null; cx.notify(); } return; }
            let over = null;
            if (tree) {
              // A worktree lands only among its own group's worktrees, and only
              // while the press began on one.
              over = this.pressTree && this.pressParent != null
                && forest.parents.get(s.id) === this.pressParent && this.pressed !== s.id ? s.id : null;
            } else if (!this.pressTree && this.pressSect === sect && this.pressMachine === (s.machine ?? null)) {
              over = s.id;
            }
            if (this.over !== over) { this.over = over; cx.notify(); }
          })
          .on_mouse_up("left", (_e, cx) => {
            const was = this.pressed;
            const over = this.over;
            const sectOk = this.pressSect === sect;
            const machineOk = this.pressMachine === (s.machine ?? null);
            const pressTree = this.pressTree;
            const parent = this.pressParent;
            this.pressed = null;
            this.over = null;
            this.pressSect = null;
            this.pressMachine = null;
            this.pressTree = false;
            this.pressParent = null;
            if (tree) {
              // A click opens it. A drag inside the group reorders the checkouts;
              // a drag from anywhere else does nothing.
              if (was !== null && over === s.id && was !== s.id && pressTree && parent != null
                && forest.parents.get(s.id) === parent) {
                const from = allSpaces.find((x) => x.id === was);
                const fromPath = this.checkoutRecord(from, paneList)?.root ?? null;
                const toPath = this.checkoutRecord(s, paneList)?.root ?? null;
                if (fromPath && toPath) {
                  const p = allSpaces.find((x) => x.id === parent);
                  const groupKey = p ? groupKeyOf(p, paneList) : null;
                  const paths = groupKey ? this.pathSiblings(groupKey, allSpaces, trees) : [];
                  const at = (x) => paths.findIndex((q) => tidyPath(q) === tidyPath(x));
                  const dir = at(toPath) > at(fromPath) ? 1 : -1;
                  if (movePathWithin(groupKey, paths, fromPath, toPath, dir)) {
                    touchWorkspace();
                    persistWorkspace();
                    this.sel = `sp-${was}`;
                  }
                }
              } else if (was === null || was === s.id) this.openSpace(s);
              cx.notify();
              return;
            }
            if (was !== null && !pressTree && over === s.id && was !== s.id && sectOk && machineOk) {
              // The same landing rule the sheet's drag and both views' keys use:
              // a drop on the row below lands after it, on the row above before it.
              const ids = this.drawnSpaces(sect).map((x) => x.id);
              const from = ids.indexOf(was), to = ids.indexOf(s.id);
              if (from >= 0 && to >= 0) {
                this.landReorder(spaces().find((x) => x.id === was), s, ids, to > from ? 1 : -1);
              }
            } else if (was === s.id) this.openSpace(s);
            cx.notify();
          })
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.spaceMenu(s); })
          // The one the window shows: a spine down its edge, the way the app
          // marks the pane you are in, and a name that steps forward.
          .when(s.active, (el) => el.child(div().absolute().left(0).top(6).bottom(6).w(2).rounded(1).bg(t.accent)))
          // A worktree runs under its checkout on a hairline, so the two levels
          // read as one tree rather than as two indents.
          .when(tree, (el) => el.child(div().absolute().left(30).top(0).bottom(0).w(1).bg(wash(t.foreground, "12"))))
          .when(tree, (el) => el.child(div().absolute().left(30).top(15).w(7).h(1).bg(wash(t.foreground, "12"))))
          .when(tree, (el) => el.child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(t.dim)))
          .when(linked, (el) => el.child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted)))
          .when(!tree && !linked, (el) => el.child(div().size(18).flex_none().rounded(5).bg(fill).relative()
            .flex().items_center().justify_center()
            .border(1).border_color(s.active ? wash(t.accent, "66") : wash(t.foreground, "17"))
            .text_size(9).font_semibold().text_color("#ffffff").child([...label][0]?.toUpperCase() ?? "?")
            // Pinned is the one section not named after a state, so there the
            // tile carries it as a bead on the corner, like a portrait's status.
            .when(/pinned$/.test(sect) && Boolean(s.status) && s.status !== "idle", (el) => el.child(div()
              .absolute().right(-2).bottom(-2).size(6).flex_none().rounded_full()
              .bg(s.status === "working" ? t.accent : (t[s.status] ?? t.dim))
              .border(1).border_color(t.chrome)
              .tooltip(s.status === "blocked" ? "Needs you" : s.status === "done" ? "Done" : "Working")))))
          .child(div().flex_shrink(1).min_w(30).truncate().text_size(12)
            .when(s.active, (el) => el.font_medium())
            .text_color(s.active ? t.foreground : wash(t.foreground, "e6")).child(label))
          .when(Boolean(g), (el) => el.child(this.gitTail(g, tree, label, t)))
          .when(hidden > 0, (el) => el.child(countPill(t, hidden, topTone)))
          .child(div().size(18).flex_none().flex().items_center().justify_center()
            .when(kids.length > 0 || worktreesOf(s).length > 0 || checkoutsOf(s).length > 0, (el) => el.child(div()
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
          // A pin shows on a pinned space, and on the row the keyboard is on.
          // Showing it for whichever row the pointer crossed rebuilt the whole
          // sidebar on the way past. A pin belongs to a space: a worktree is a
          // checkout drawn under its repo, not a place of its own to keep.
          .child(div().w(18).flex_none().flex().items_center().justify_center()
            .when(!tree && !linked && (Boolean(pin) || hovered), (el) => el.child(div()
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
              this.setPin(s);
              cx.notify();
            })
            .child(svg(`mods/icons/${pin && hovered ? "pin-off" : "pin"}.svg`).size(12)))));
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
        .when(this.kbPaint && this.sel === `ck-${s.machine ?? ""}-${c.path}`, (x) => x.bg(wash(t.accent, "26")))
        .hover((x) => x.bg(t.hover))
        .cursor_pointer()
        .tooltip(`${c.path} · click to open it as a space`)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.checkoutMenu(c.path, s.machine); })
        .on_click(() => this.openCheckout({ path: c.path, on: s.machine ?? null, c }))
        .child(div().absolute().left(30).top(0).bottom(0).w(1).bg(wash(t.foreground, "12")))
        .child(div().absolute().left(30).top(15).w(7).h(1).bg(wash(t.foreground, "12")))
        .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(t.muted))
        .child(div().flex_shrink(1).min_w(30).max_w(150).truncate().text_size(12).text_color(wash(t.foreground, "e6")).child(c.branch ?? base(c.path)))
        .child(div().flex_1());

      // A pin whose space is gone is still a place to open, exactly as the sheet
      // draws it. Leaving it out here made the two views disagree about how many
      // pins there are.
      const pinSpaceRow = (p) => {
        const key = `pin-${p.machine ?? ""}-${norm(p.folder)}`;
        // The colour the place was pinned with, so the row keeps its avatar when
        // its space's shell exits; a pin from an older build falls back to the
        // folder's own colour.
        const tone = p.color ?? folderColor(p.folder);
        const color = tone.startsWith("#") ? tone : (MARK[tone] ?? t[tone] ?? t.dim);
        const name = pinLabel(p);
        return h_flex()
          .id(key)
          .relative()
          .mx(2)
          .pl(7)
          .pr(5)
          .h(30)
          .flex_none()
          .gap(7)
          .items_center()
          .rounded(7)
          .overflow_hidden()
          .when(this.kbPaint && this.sel === key, (x) => x.bg(wash(t.accent, "26")))
          .hover((x) => x.bg(t.hover))
          .cursor_pointer()
          .tooltip(`${p.folder} · click to open a shell there`)
          .on_click(() => this.openRow({ kind: "pin", pin: { ...p } }))
          .child(div().size(18).flex_none().rounded(5).bg(color)
            .flex().items_center().justify_center()
            .border(1).border_color(wash(t.foreground, "17"))
            .text_size(9).font_semibold().text_color("#ffffff")
            .child([...name][0]?.toUpperCase() ?? "?"))
          .child(div().flex_shrink(1).min_w(30).max_w(150).truncate().text_size(12)
            .text_color(wash(t.foreground, "e6")).child(name))
          .when(Boolean(p.machine), (el) => el.child(div().max_w(60).truncate().text_size(9.5).text_color(t.dim).child(p.machine)))
          .child(div().flex_1())
          .child(svg("mods/icons/pin.svg").size(12).flex_none().text_color(wash(t.accent, "8c")));
      };

      const out = [];
      const order = [];
      const sections = new Set();
      const emitSpace = (s, depth, sect) => {
        const kids = kidsOf.get(s.id) ?? [];
        const id = `sp-${s.id}`;
        const open = !this.folded.has(id);
        out.push(spaceRow(s, kids, depth, sect));
        this.entries.push({ key: id, kind: "space", id: s.id, name: placeName(s, sect), linked: forest.worktrees.has(s.id), sect, at: out.length - 1 });
        if (!open) return;
        kids.forEach((a, i) => {
          order.push(a.address);
          for (const [entry, el] of withKids(a, i, depth + 1)) {
            out.push(el);
            this.entries.push({ ...entry, at: out.length - 1 });
          }
        });
        if (depth === 0) for (const w of worktreesOf(s)) emitSpace(w, 1, sect);
        if (depth === 0) for (const c of checkoutsOf(s)) {
          out.push(checkoutRow(s, c));
          this.entries.push({ key: `ck-${s.machine ?? ""}-${c.path}`, kind: "checkout", path: c.path, machine: s.machine ?? null, at: out.length - 1 });
        }
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

      // The pins were read once at the top of the frame: the rail and the Pinned
      // section use the same slots. A pin whose space is gone still names a repo:
      // its unopened checkouts and the worktree spaces that hang under no space
      // any more stay under it, so closing a space hides nothing that belongs to
      // the place.
      const pinnedIds = new Set(pinsNow.filter(({ s }) => s).map(({ s }) => s.id));
      const pinRepo = (p) => pinnedRepo(p, this.git);
      const pinCheckouts = (p) => {
        const repo = pinRepo(p);
        if (!repo) return [];
        const out = [];
        for (const c of trees) {
          // The tree keys its checkouts with NUL (`<on>\0<path>`), the same key
          // `opened` and `checkoutParents` hold. A SEP here missed both sets, so
          // a checkout already open as a worktree space was drawn a second time
          // as an unopened row under the pin.
          const key = `${c.on ?? ""}\u0000${tidyPath(c.path)}`;
          if (`${c.on ?? ""}${SEP}${tidyPath(c.repoMain ?? "")}` !== repo) continue;
          if (forest.checkoutParents.has(key) || forest.opened.has(key)) continue;
          if (isRemoving(c.path, c.on)) continue;
          out.push(c);
        }
        return orderedPaths(repo, out, (c) => c.path);
      };
      const pinWorktrees = (p) => {
        const repo = pinRepo(p);
        if (!repo) return [];
        return orderedPaths(repo, allSpaces.filter((w) => forest.worktrees.has(w.id)
          && !forest.parents.has(w.id)
          && (w.machine ?? null) === (p.machine ?? null)
          && `${w.machine ?? ""}${SEP}${tidyPath(this.checkoutRecord(w, paneList)?.main ?? "")}` === repo),
          (w) => this.checkoutRecord(w, paneList)?.worktreePath
            ?? this.checkoutRecord(w, paneList)?.root ?? "");
      };
      // What a place row drew under itself, so the Worktrees section does not
      // draw the same row twice.
      const drawnPinWorktrees = new Set();
      const drawnPinCheckouts = new Set();
      for (const m of machineList) {
        // The one order the rail, this tree and the sheet share: pinned places
        // in their slots, then what needs you, done, working, idle.
        const mine = orderedPlaces(top.filter((s) => (s.machine ?? null) === m), pinsNow);
        const mid = `mach-${m ?? "local"}`;
        const open = !this.machinesFolded.has(m ?? "");
        if (manyMachines) {
          out.push(...machineHeader(m, mine));
          if (!open) continue;
          if (!mine.length) out.push(newSpaceRow(m));
        }
        // A worktree is a checkout, never a row of a section: one whose repo has
        // no space here is drawn with the other unheld checkouts, below.
        const loose = mine.filter((s) => !pinnedIds.has(s.id) && !forest.worktrees.has(s.id));
        // One slot per pin, in the order the pins were made — the sheet draws the
        // same order. A place whose space is gone keeps its line, and the space a
        // click opens there takes that line back, so a pinned space never moves
        // down the section when its shell exits.
        const pins = pinsNow.filter(({ p }) => (p.machine ?? null) === m);
        if (pins.length) {
          const id = manyMachines ? `${mid}-pinned` : "sec-pinned";
          out.push(sectionHeader(id, "Pinned", "accent", pins.length));
          if (!this.folded.has(id)) {
            // Their worktrees come with them: a pinned repo brings its checkouts.
            for (const { p, s } of pins) {
              if (s && !forest.worktrees.has(s.id)) { emitSpace(s, 0, id); continue; }
              const key = `pin-${p.machine ?? ""}-${norm(p.folder)}`;
              out.push(pinSpaceRow(p));
              this.entries.push({ key, kind: "pin", pin: { ...p, machine: p.machine ?? null }, at: out.length - 1 });
              // The place keeps its checkouts: the repo outlives the space that
              // named it, so a closed space still shows what hangs under it.
              for (const w of pinWorktrees(p)) {
                emitSpace(w, 1, id);
                drawnPinWorktrees.add(w.id);
              }
              for (const c of pinCheckouts(p)) {
                out.push(checkoutRow({ machine: p.machine ?? null }, c));
                this.entries.push({ key: `ck-${p.machine ?? ""}-${c.path}`, kind: "checkout", path: c.path, machine: p.machine ?? null, at: out.length - 1 });
                drawnPinCheckouts.add(`${p.machine ?? ""}${SEP}${tidyPath(c.path)}`);
              }
            }
          }
        }
        for (const r of [4, 3, 2, 1]) {
          const members = loose.filter((s) => (RANK[s.status ?? "idle"] ?? RANK.idle) === r);
          if (!members.length) continue;
          const id = manyMachines ? `${mid}-sec-${r}` : `sec-${r}`;
          out.push(sectionHeader(id, SECTION[r], SECTION_STATUS[r], members.length));
          if (!this.folded.has(id)) members.forEach((s) => emitSpace(s, 0, id));
        }
        // A checkout with no space to hang under — opened as a space, or only
        // listed. The sheet lists these too; leaving them out here is how the two
        // views disagreed. An opened one keeps its space (and its agents) and is
        // still drawn as a checkout, never as a place of its own.
        const orphans = trees.filter((c) => (c.on ?? null) === m
          && !forest.checkoutParents.has(`${c.on ?? ""}\u0000${c.path}`)
          && !forest.opened.has(`${c.on ?? ""}\u0000${norm(c.path).replace(/\/+$/, "")}`)
          && !drawnPinCheckouts.has(`${c.on ?? ""}${SEP}${tidyPath(c.path)}`)
          && !isRemoving(c.path, c.on));
        const homeless = mine.filter((s) => forest.worktrees.has(s.id) && !forest.parents.has(s.id)
          && !drawnPinWorktrees.has(s.id));
        if (orphans.length || homeless.length) {
          const id = manyMachines ? `${mid}-worktrees` : "sec-worktrees";
          out.push(sectionHeader(id, "Worktrees", null, homeless.length + orphans.length));
          if (!this.folded.has(id)) {
            for (const s of homeless) emitSpace(s, 0, id);
            for (const c of orphans) {
              out.push(checkoutRow({ machine: m }, c));
              this.entries.push({ key: `ck-${m ?? ""}-${c.path}`, kind: "checkout", path: c.path, machine: m ?? null, at: out.length - 1 });
            }
          }
        }
      }
      this.publishOrder(order);
      rows = out;
    } else {
      const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
      for (const a of rest) {
        const r = rankOf(a) || RANK.idle;
        const id = byPriority ? `sec-${r}` : `space-${a.space}`;
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

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "sidebar-menu", kind: "popup", width: 250 }); })
      .border(1)
      .border_color(this.kbPaint ? wash(t.accent, "7a") : t.chrome)
      .when(this.kbPaint, (el) => el.bg(wash(t.accent, "08")))
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_key_up((e) => { if (e.key === "j" || e.key === "k") this.stopReorder(); })
      // A press inside comes back to the list; a press anywhere else ends the
      // keyboard mode even when the app leaves focus where it was.
      .on_mouse_down("left", (_e, cx) => this.touch(cx))
      .on_mouse_down_out((_e, cx) => this.blur(cx))
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
            .child(div().flex_none().text_size(11.5).text_color(this.kbPaint ? t.accent : t.dim).child(bySpaces ? "Spaces" : "Agents"))
            .when(roomy, (el) => el.child(countPill(t, bySpaces ? (this.spaceCount ?? frameCache("spaces", spaces).length) : list.length)))
            .child(div().flex_1())
            .child(h_flex().flex_none().gap(2).items_center()
              .child(this.iconButton(t, "ag-sort", `mods/workspace-chrome/${sort.icon}.svg`, `Sort agents: ${sort.label}`,
                () => openOverlay({ mod: "agents-list", kind: "popup", width: 230, height: 172, props: { sortMenu: true } }), 13, sort.id !== "priority"))
              .child(this.iconButton(t, "ag-search", "mods/icons/search.svg", "Search \u00b7 Alt+F",
                () => run("mod.open", { name: "agents-list" })))
              .child(div().w(1).h(14).mx(1).flex_none().bg(wash(t.foreground, "10")))
              .when(bySpaces, (el) => el.child(this.iconButton(t, "ag-new-space", "mods/workspace-chrome/plus.svg", "New space", () => this.newSpace())))
              .child(this.iconButton(t, "ag-hide", "mods/icons/sidebar.svg", "Collapse sidebar", toggleSidebar))),
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
      // The list, scrolled and barred by this mod (see `scroller`). The empty
      // state is a row like any other, so it scrolls with the rest.
      .child(this.scroller(t, rows.length === 0 && bySpaces
        ? [v_flex().flex_none().px(20).pt(34).gap(7).items_center()
          .child(div().size(36).rounded(10).bg(wash(t.foreground, "06")).border(1).border_color(wash(t.foreground, "0c"))
            .flex().items_center().justify_center()
            .child(svg("mods/icons/folder-plus.svg").size(16).text_color(t.muted)))
          .child(div().text_size(12.5).font_medium().text_color(t.muted).child("No spaces yet"))
          .child(div().text_size(10.5).text_color(wash(t.muted, "cc")).text_center()
            .child("A space is a place to work: a repo, a folder. Make one here, or find anything with Alt+F."))
          .child(h_flex().id("empty-new-space").mt(6).h(28).px(10).gap(6).rounded(7).items_center()
            .bg(wash(t.accent, "16")).text_color(t.accent).cursor_pointer()
            .hover((x) => x.bg(wash(t.accent, "26")).text_color(t.foreground))
            .on_click(() => this.newSpace())
            .child(svg("mods/icons/plus.svg").size(12))
            .child(div().text_size(11.5).font_medium().child("New space")))]
        : rows, "spaces", { padTop: 3, padBottom: 3 }));
    } finally { endPaint(); }
  }
}

