// Spaces, worktrees and agents in one keyboard-driven search sheet.
// Opened with Alt+F (mod.open:agents-list). Type to filter, ↑/↓, Enter,
// Esc; Ctrl+R rename, Ctrl+D close, Ctrl+Shift+J/K move the highlighted space.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, panes, run, closeOverlay, props, theme, settings, shared, setShared } from "herdr";
import {
  Workspace, MARK, wash, tileOf, inkOf, marks, keycap, shortcutOf, place,
  pinnedList, pinnedRepo, isRemoving, removingList, folderColor, pinLabel, norm, base,
  tidyPath, spaceColor, worktreeTree, RANK, askGit, listedCheckouts, pictureKey,
  beginPaint, endPaint, frameCache, scoreTerms, termsOf, spaceRecord,
  groupKeyOf, orderedPaths, orderedPlaces, placeCount, movePathWithin, machineIndexOf, persistWorkspace,
  touchWorkspace, SEP,
} from "./workspace-engine.js";

export class Palette extends Workspace {
  init(_props, cx) {
    // Pins and pins-as-places are the sidebar's too: one rule, one bind. This
    // also hydrates the shared picture, so the first frame already knows every
    // repo, checkout and sticky worktree — no git, no localStorage guess.
    this.initShared();
    this.filter = "";
    this.at = null;
    this.scrollTop = 0;
    this.parent = new Map();
    this.checkoutParent = new Map();
    this.pressed = null; // the space row held by the mouse
    this.over = null;    // the space row it would land on
    this.note = null;    // the footer's word about the last step
    this.active = spaces().find((s) => s.active) ?? null;
    this.folder = place(this.active);
    this.on = this.active?.machine ?? null;
    // A checkout made before this sheet opened is already in the shared list.
    // Remembering the timestamp here keeps opening the sheet from jumping to it.
    this.createdAt = shared("worktree.createdAt") ?? 0;
    // The search text is ours: a text field would take Ctrl+A (select all) and
    // Ctrl+A has to reach the palette (a worktree of the highlighted row).
    this.filter = "";
    setShared("search.open", true);
    // Ctrl+J/K are taken by the app keymap, so the footer hands them here.
    this.watchWalk(cx, true, "search.move");
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
    // The revision is the sidebar's picture: when it moves, draw again. A notify
    // over there does not reach this overlay. No git is asked for here: opening
    // the sheet is not a reason to run a subprocess.
    let closed = shared("overlay.closed");
    let seenRev = shared("workspace.rev") ?? 0;
    cx.timer.every(250, (cx) => {
      const now = shared("overlay.closed");
      const rev = shared("workspace.rev") ?? 0;
      if (now !== closed) { closed = now; seenRev = rev; this.handle.focus(); cx.notify(); }
      else if (rev !== seenRev) { seenRev = rev; cx.notify(); }
    });
  }

  // A read after an explicit change (a checkout made or removed here): the
  // sidebar's scanner does the work and writes the shared picture back. This is
  // never called on open, typing, or a status tick.
  load(_cx) {
    this.loadGen = (this.loadGen ?? 0) + 1;
    askGit(false);
  }

  // The sidebar's tree. Same git, same checkouts, same parents. A checkout
  // added or removed over there is this list too. Typing does not change who
  // holds a checkout, so the tree from the last frame stands.
  adopt(ps) {
    const all = this.liveSpaces(ps);
    const key = pictureKey(ps, all);
    this.paneSnap = ps;
    if (key === this.forestSig && this.opened) return;
    this.forestSig = key;
    this.treeRows = null;
    const gitOf = (s) => this.checkoutRecord(s, ps);
    const checkoutList = listedCheckouts();
    const forest = worktreeTree(all, gitOf, checkoutList, ps);
    this.worktreeSpaces = forest.worktrees;
    this.parent = forest.parents;
    this.checkoutParent = forest.checkoutParents;
    this.opened = forest.opened;
  }

  // Keys/clicks call close() with no argument; the app calls close(cx) on teardown.
  // The next open starts clean: no filter, and the active space highlighted.
  close(cx) {
    if (shared("search.open")) setShared("search.open", false);
    this.at = null;
    this.scrollTop = 0;
    this.filter = "";
    this.follow = null;
    this.stopReorder();
    if (!cx) closeOverlay(props()?.overlay);
  }

  // Typing: every term has to land somewhere, and terms may land in different
  // places — "kleeamp desk" is the space and its desktop checkout. Exact names
  // and branches outrank a hit deep inside a path; a status word ("needs you")
  // finds the rows that need you whatever they are called. The scoring rule is
  // the engine's, so the sidebar's rows and this sheet rank the same.
  search(q) {
    const terms = termsOf(q);
    this.terms = terms;
    const best = (fields) => scoreTerms(terms, fields);
    const statusWord = (st) => (st === "blocked" ? "needs you" : st ?? "idle");
    const keyOf = (w) => `${w.on ?? ""}\u0000${w.c.path}`;
    const results = [];
    // One pane snapshot and one space snapshot for the query. The overview
    // already took them; asking the host again per row was a full model copy.
    const ps = this.paneSnap ?? (typeof panes === "function" ? frameCache("panes", panes) : undefined);
    const listed = this.liveSpaces(ps);
    const listedIds = new Set(listed.map((s) => s.id));
    const listedAgents = typeof agents === "function" ? agents() : [];
    const pinned = pinnedList();
    const trees = this.liveTrees();
    for (const s of listed) {
      const sc = best([
        [this.spaceName(s), 1], [s.branch, 0.85], [base(place(s, ps)), 0.55], [base(s.folder), 0.55],
        [s.machine, 0.5], [statusWord(s.status), 0.5],
      ]);
      if (sc > -Infinity) results.push({ kind: "space", s, score: sc });
    }
    for (const a of listedAgents) {
      if (!listedIds.has(a.space)) continue;
      const sc = best([
        [a.program?.name, 1], [a.title, 0.8], [a.space_name, 0.7], [a.tab_name, 0.6],
        [a.app, 0.6], [statusWord(a.status), 0.5],
      ]);
      if (sc > -Infinity) results.push({ kind: "agent", a, score: sc });
    }
    for (const w of trees) {
      if (w.c.main) continue;
      const sc = best([[w.c.branch, 0.95], [base(w.c.path), 0.7], [w.repo.name, 0.6], ["worktree", 0.5]]);
      if (sc > -Infinity) results.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, score: sc });
    }
    for (const p of pinned) {
      const live = listed.some((s) => (p.id ? s.id === p.id
        : (s.machine ?? null) === (p.machine ?? null) && norm(s.folder ?? "") === norm(p.folder)));
      if (live) continue;
      const sc = best([[p.name, 1], [pinLabel(p), 0.9], [base(p.folder), 0.8], ["pinned", 0.4]]);
      if (sc > -Infinity) results.push({ kind: "pin", id: p.id ?? null, folder: p.folder, machine: p.machine ?? null,
        repo: p.repo ?? null, color: p.color ?? null, name: pinLabel(p), named: Boolean(p.named), score: sc });
    }
    const labelOf = (r) => r.kind === "space" ? this.spaceName(r.s) : r.kind === "pin" ? r.name : r.kind === "worktree" ? (r.c.branch ?? base(r.c.path)) : r.kind === "agent" ? (r.a.program?.name ?? r.a.title ?? r.a.address) : r.label;
    results.sort((a, b) => b.score - a.score || String(labelOf(a)).localeCompare(String(labelOf(b))));

    // A matched space brings its agents and worktrees with it, so a search reads
    // like the overview tree instead of one bare row per hit. A row already
    // shown under its space is not repeated further down.
    const agentsOf = new Map();
    for (const a of listedAgents) {
      if (!agentsOf.has(a.space)) agentsOf.set(a.space, []);
      agentsOf.get(a.space).push(a);
    }
    const kids = (id) => this.kidsOf(all, id);
    const ckids = (id) => this.checkoutsOf(all, id, trees);
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
    const all = listed;
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
      } else if (r.kind === "pin") {
        const key = `p\u0000${r.id ?? r.folder ?? ""}`;
        if (!used.has(key)) { used.add(key); out.push(r); }
        // A pin is the place: its worktrees come with it, the way the overview's
        // Pinned section draws them. Searching "reel" found the pin row and the
        // checkout whose folder happened to carry the word, but not the other
        // worktree of the repo.
        const pin = pinned.find((p) => (r.id ? p.id === r.id
          : (p.machine ?? null) === (r.machine ?? null) && norm(p.folder ?? "") === norm(r.folder ?? ""))) ?? r;
        const place = this.pinChildren(pin, listed, trees, ps);
        for (const w of place.spaces) if (!used.has(w.id)) tree(w, 1);
        for (const w of place.trees) {
          const k = `w\u0000${keyOf(w)}`;
          if (used.has(k)) continue;
          used.add(k);
          out.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, depth: 1 });
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

  // A space's children in the one order both views draw: worktrees first in the
  // person's persisted order, then the checkouts nobody opened.
  kidsOf(all, id) {
    const parent = all.find((s) => s.id === id);
    return orderedPaths(groupKeyOf(parent, this.paneSnap),
      all.filter((s) => this.parent?.get(s.id) === id),
      (w) => this.checkoutRecord(w, this.paneSnap)?.root ?? "");
  }

  checkoutsOf(all, id, trees = this.liveTrees()) {
    const parent = all.find((s) => s.id === id);
    const groupKey = groupKeyOf(parent, this.paneSnap);
    const list = trees.filter((w) => !w.c.main && this.checkoutParent?.get(`${w.on ?? ""}\u0000${w.c.path}`) === id);
    return orderedPaths(groupKey, list, (w) => w.c.path);
  }

  // What a pin's place holds even when its space is gone: the live worktree
  // spaces of its repo that hang under no space, and the checkouts nobody has
  // opened yet. The sidebar draws the same rows under a dead pin, so the sheet
  // must not show fewer of the place's worktrees than the sidebar does.
  pinChildren(p, all = this.liveSpaces(this.paneSnap), trees = this.liveTrees(), ps = this.paneSnap, skip = null) {
    const repo = pinnedRepo(p, this.git);
    if (!repo) return { spaces: [], trees: [] };
    const parentOf = (s) => {
      const id = this.parent?.get(s.id);
      return id ? all.find((x) => x.id === id) ?? null : null;
    };
    const spacesNow = orderedPaths(repo, all.filter((w) => this.isWorktree(w) && !parentOf(w)
      && (w.machine ?? null) === (p.machine ?? null)
      && `${w.machine ?? ""}${SEP}${tidyPath(this.checkoutRecord(w, ps)?.main ?? "")}` === repo),
      (w) => this.checkoutRecord(w, ps)?.worktreePath ?? this.checkoutRecord(w, ps)?.root ?? "");
    const treesNow = orderedPaths(repo, trees.filter((w) => !w.c.main
      && `${w.on ?? ""}${SEP}${tidyPath(w.repo?.main ?? "")}` === repo
      && !this.checkoutParent?.has(`${w.on ?? ""}\u0000${w.c.path}`)
      && !(skip?.(w) ?? false)), (w) => w.c.path);
    return { spaces: spacesNow, trees: treesNow };
  }

  rows() {
    // The same forest the sidebar draws, before the filter or the sections, so
    // a search and the overview cannot disagree about who holds a checkout.
    const ps = typeof panes === "function" ? frameCache("panes", panes) : undefined;
    this.adopt(ps);
    const f = this.filter.trim().toLowerCase();
    if (f) return this.search(f);
    // No query: nothing is a match, so no row is drawn as one.
    this.terms = null;
    const out = [];
    const head = (label) => out.push({ kind: "head", label });
    const all = this.liveSpaces(ps);
    // A pin is the place: a space standing where a pin's space used to be takes
    // that pin, so the row keeps its slot and the place stays pinned.
    this.bindPins(all);
    const agentList = agents();
    const keyOf = (w) => `${w.on ?? ""}\u0000${w.c.path}`;
    const kids = (id) => this.kidsOf(all, id);
    const ckids = (id) => this.checkoutsOf(all, id);
    const parentOf = (s) => { const id = this.parent?.get(s.id); return id ? all.find((x) => x.id === id) : null; };
    const emitted = new Set();
    // `seen` is a section's own list: a place walks its tree again under Pinned,
    // so a family drawn twice does not draw the same child twice.
    const emit = (s, depth = 0, seen = emitted) => {
      out.push({ kind: "space", s, depth });
      seen.add(s.id);
      emitted.add(s.id);
      // What runs there, so the overview shows agents next to their worktrees.
      for (const a of agentList) if (a.space === s.id) out.push({ kind: "agent", a, depth: depth + 1 });
      for (const k of kids(s.id)) if (!seen.has(k.id)) emit(k, depth + 1, seen);
      for (const w of ckids(s.id)) {
        if (seen.has(keyOf(w))) continue;
        out.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, depth: depth + 1 });
        seen.add(keyOf(w));
        emitted.add(keyOf(w));
      }
    };
    // Pinned spaces get their own section above the rest, with their own trees,
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
    // Every pin lives in its own section above the rest, the one in use too, in
    // the slot it was pinned in: a place whose space is gone keeps its line, as
    // it does in the sidebar, and the space a click opens there takes it back.
    const heldPins = new Set();
    const shownPins = this.shownPins(all, ps);
    const pinRowList = shownPins
      .filter(({ s }) => {
        if (!s) return true;
        if (heldPins.has(s.id)) return false;
        heldPins.add(s.id);
        return !emitted.has(s.id) && topPin(s);
      });
    // A pin whose space is gone still names a repo: its checkouts, and the
    // spaces standing in them, stay under the place row — the repo outlives the
    // space that named it.
    const pinKids = (p) => this.pinChildren(p, all, this.liveTrees(), ps, (w) => emitted.has(keyOf(w)));
    const pinStart = out.length;
    if (pinRowList.length) {
      // The count is pins, not top-level pin rows: a pinned worktree is drawn
      // under its repo's pinned space, and a count that skipped it read like a
      // cap on pinning.
      head(`Pinned ${pinned.length}`);
      for (const { p, s } of pinRowList) {
        if (!s) {
          out.push({ kind: "pin", id: p.id ?? null, folder: p.folder, on: p.machine ?? null, machine: p.machine ?? null,
            repo: p.repo ?? null, color: p.color ?? null, name: pinLabel(p), named: Boolean(p.named) });
          const kids = pinKids(p);
          for (const w of kids.spaces) emit(w, 1);
          for (const w of kids.trees) {
            out.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, depth: 1 });
            emitted.add(keyOf(w));
          }
        } else if (!emitted.has(s.id) && !this.isWorktree(s)) {
          // Its worktrees and agents come with it, the one in use too. A pinned
          // checkout is not a pin row of its own: its repo's row brings it.
          emit(s);
        }
      }
    }
    // Only the Pinned section says "pinned": a row drawn below is not one.
    for (let i = pinStart; i < out.length; i++) out[i].inPins = true;
    // The one order the rail, the sidebar and this sheet share: pinned places
    // first in their slots, then needs you, done, working, idle, with the app's
    // order inside a group. The space in use keeps its place in that order and
    // wears a "current" badge; it is not hoisted out of its section. A family
    // appears once, at its root: a worktree's row comes with its repo, and a root
    // already drawn above (a pinned repo) is not repeated.
    const rest = orderedPlaces(all, pinRowList);
    for (const [label, rank] of [["Needs you", 4], ["Done", 3], ["Working", 2], ["Idle", 1]]) {
      const roots = rest.filter((s) => !emitted.has(s.id) && (RANK[s.status] ?? 1) === rank
        && !parentOf(s) && !this.isWorktree(s));
      if (roots.length) {
        head(`${label} ${roots.length}`);
        roots.forEach((s) => emit(s));
      }
    }
    // A checkout with no space to hang under — opened as a space, or only
    // listed. It is a checkout here too: never a place of its own. An opened one
    // is drawn as its space (Enter goes to it) with its agents under it.
    const homeless = all.filter((s) => this.isWorktree(s) && !parentOf(s) && !emitted.has(s.id));
    const orphans = this.liveTrees().filter((w) => !w.c.main && !emitted.has(keyOf(w)));
    if (homeless.length || orphans.length) {
      head(`Worktrees ${homeless.length + orphans.length}`);
      for (const s of homeless) emit(s, 0, new Set());
      orphans.forEach((w) => out.push({ kind: "worktree", c: w.c, repo: w.repo, on: w.on, depth: 0 }));
    }
    // The header's number: places to work. A pin whose space closed keeps its
    // row — a click starts a shell there — so it is still a space, and exiting a
    // pinned space's shell must not take one off the count while the row stays.
    // A checkout under its repo (worktree space or listed one) is not a place.
    this.placeTotal = placeCount(all, shownPins, (s) => this.isWorktree(s));
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

  // A row, in the shape both views' actions take.
  paletteRow(r) {
    if (!r) return null;
    if (r.kind === "space") return { kind: "space", s: r.s };
    if (r.kind === "agent") return { kind: "agent", a: r.a };
    if (r.kind === "worktree") return { kind: "checkout", path: r.c.path, on: r.on ?? null, c: r.c };
    if (r.kind === "pin") return { kind: "pin", pin: { id: r.id ?? null, folder: r.folder, machine: r.on ?? null, name: r.name, named: r.named } };
    return null;
  }

  selectedRow() {
    return this.paletteRow(this.selected());
  }

  // Walking is the sheet's own: it wraps, because its list is a loop of hits.
  walk(step, cx) {
    const n = this.pickable().length;
    if (!n) return;
    this.stopReorder();
    this.follow = null;
    this.at = ((this.at ?? 0) + (step > 0 ? 1 : n - 1)) % n;
    cx?.notify?.();
  }

  // Ctrl+Shift+J/K: the sheet steps through every space of the machine; the
  // sidebar's sections are not its order. A worktree checkout steps inside its
  // repo group, through the persisted worktree order.
  //
  // The subject is the space the reorder is about, not "whatever row the
  // highlight is on now". A row moves asynchronously, so a key press that lands
  // before the sheet repainted still sees the highlight on the *index* it had,
  // which is now a different space — that is how a held key walked two spaces at
  // once. While a step is in flight, keep stepping its own space.
  beginReorder(dir, cx) {
    // A checkout step in flight keeps its own path for the same reason.
    const moving = this.pathSubject();
    if (moving) {
      return this.startPathReorder(this.pathGroup, moving, this.pathPaths ?? [], dir, cx, this.pathAfter);
    }
    const held = this.reorderSubject();
    const r = held ? { kind: "space", s: held } : this.selected();
    if (r?.kind === "worktree" || (r?.kind === "space" && this.isWorktree(r.s))) {
      return this.reorderWorktreeRow(r, dir, cx);
    }
    const s = r?.kind === "space" ? r.s : null;
    if (!s) return;
    this.startReorder(s, dir, {
      // The overview's order, not the ranked one: pinned places in the order
      // they were pinned, then the rest in the app's order. With a search on,
      // the drawn rows are ranked, and a step read from those would reverse
      // itself.
      ids: (list = spaces()) => {
        const mine = list.filter((x) => (x.machine ?? null) === (s.machine ?? null) && !this.isWorktree(x));
        const held = new Set(mine.map((x) => x.id));
        const pinned = this.shownPins(list)
          .filter(({ p, s: hit }) => (p.machine ?? null) === (s.machine ?? null) && hit && held.has(hit.id))
          .map(({ s: hit }) => hit.id);
        const seen = new Set(pinned);
        return [...pinned, ...mine.map((x) => x.id).filter((id) => !seen.has(id))];
      },
      after: (moved, step, total) => {
        this.follow = moved.id;
        if (this.filter.trim()) this.note = `${moved.name} \u00b7 ${step} of ${total}`;
      },
    }, cx);
  }

  reorderWorktreeRow(r, dir, cx) {
    const all = this.liveSpaces(this.paneSnap);
    const list = listedCheckouts();
    const s = r.kind === "space" ? r.s : null;
    const c = r.kind === "worktree"
      ? list.find((x) => (x.on ?? null) === (r.on ?? null) && tidyPath(x.path) === tidyPath(r.c.path))
      : null;
    const rec = s ? this.checkoutRecord(s, this.paneSnap) : null;
    // The group key is the repo's identity even before a sticky record exists:
    // the checkout's main checkout is the key `spaceRecord` would hold.
    const groupKey = spaceRecord(s)?.groupKey
      ?? (rec?.main ? `${s?.machine ?? ""}${SEP}${tidyPath(rec.main)}` : null)
      ?? (s ? groupKeyOf(s, this.paneSnap) : null)
      ?? (c ? `${r.on ?? ""}${SEP}${tidyPath(c.repoMain ?? "")}` : null);
    const path = c ? c.path : rec?.root ?? null;
    if (!groupKey || !path) return;
    const paths = this.pathSiblings(groupKey, all, list);
    this.startPathReorder(groupKey, path, paths, dir, cx, (moved, step, total) => {
      const hit = all.find((x) => tidyPath(this.checkoutRecord(x, this.paneSnap)?.root ?? "") === moved);
      if (hit) { this.follow = hit.id; this.followPath = null; }
      else { this.follow = null; this.followPath = moved; }
      if (this.filter.trim()) this.note = `${base(moved)} \u00b7 ${step} of ${total}`;
    });
  }

  // The sheet reads pinned spaces above the rest, so crossing that line is a
  // pin or an unpin: a step lands somewhere the list will draw.
  landBefore(s, target) {
    if (Boolean(this.spacePin(s)) !== Boolean(this.spacePin(target))) this.setPin(s);
  }

  // A worktree space keeps its checkout's name: the branch it was made for, from
  // the same scan the tree is built from.
  worktreeName(s) {
    if (!this.isWorktree(s)) return null;
    const c = this.checkoutRecord(s, this.paneSnap);
    return c?.branch ?? (c?.root ? base(c.root) : null) ?? (s?.folder ? base(s.folder) : null);
  }

  // The sheet closes before it acts; the sidebar leaves the keyboard to the pane.
  beforeOpen() { this.close(); }
  beforeRename() { this.close(); }

  selected() {
    const list = this.pickable();
    if (!list.length) return null;
    return list[Math.max(0, Math.min(this.at ?? 0, list.length - 1))];
  }

  // What the sheet lists. A checkout the worktrees dialog has already taken away
  // is not a row any more, even while git is still working on it: it was asked
  // for, so it must not read as still there. A worktree git no longer lists is
  // gone the same way, pinned or not.
  liveSpaces(ps = panes()) {
    // A checkout on its way out hides its space wherever that space's shell is:
    // the live place first, and the folder it was made in too. One pane snapshot
    // for the whole list: `place` copies it out of the host on every call.
    // One list per snapshot: the overview, the search and the header all read it.
    // The short clock lets the sidebar's next scan reach a list already drawn.
    if (this._live && this._livePs === ps && Date.now() - (this._liveAt ?? 0) < 500) return this._live;
    const raw = frameCache("spaces", spaces);
    this.removedNow = this.removedWorktrees(raw, ps);
    const list = raw.filter((s) => !this.removedNow.has(s.id)
      && !isRemoving(place(s, ps), s.machine) && !isRemoving(s.folder, s.machine));
    this._live = list;
    this._livePs = ps;
    this._liveAt = Date.now();
    return list;
  }

  liveTrees() {
    // The sidebar's checkout list, minus a checkout already open as a space and
    // minus one the dialog has already taken away. A failed removal leaves the
    // list alone, so the row comes back here the moment it comes back there.
    // One pass per tree: a search asks for this from every row.
    if (this.treeRows) return this.treeRows;
    const opened = this.opened;
    const rows = [];
    for (const c of listedCheckouts()) {
      if (c.main || isRemoving(c.path, c.on)) continue;
      if (opened?.has(`${c.on ?? ""}\u0000${norm(c.path).replace(/\/+$/, "")}`)) continue;
      rows.push({
        c: { path: c.path, branch: c.branch, main: false },
        repo: { main: c.repoMain, name: base(c.repoMain ?? "") },
        on: c.on ?? null,
      });
    }
    this.treeRows = rows;
    return rows;
  }

  // "Spaces" means places to work: a worktree checkout is drawn under its repo,
  // and counting it again read as a space nobody could see. Agents are not
  // spaces either, however many are running.
  realSpaces() {
    const list = this._live ?? frameCache("spaces", spaces);
    return list.filter((s) => !this.isWorktree(s));
  }

  // The wheel moves the view; the highlight goes with it, so Enter still acts
  // on something you can see. No scrollbar is drawn, so this is the only way
  // the sheet says it continues.
  wheel(e, cx) {
    if (!(this.maxScroll > 0)) return;
    const next = Math.max(0, Math.min(this.scrollTop - e.delta.y, this.maxScroll));
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    // The wheel is the pointer's way of choosing, like the arrows: a space just
    // moved must not keep the highlight pinned to itself.
    this.follow = null;
    const v = this.geom;
    const pick = v?.pick ?? [];
    if (v) {
      const h = (r) => v.H[r.kind] ?? 32;
      while (this.at < pick.length - 1 && v.tops[v.rows.indexOf(pick[this.at])] < this.scrollTop) this.at++;
      while (this.at > 0 && v.tops[v.rows.indexOf(pick[this.at])] + h(pick[this.at]) > this.scrollTop + v.height) this.at--;
    }
    cx.notify();
  }

  // Dragging a row: the move is read off the pointer, not off the row it started
  // on, so a drag that leaves its own row still lands where it is let go.
  overRow(e, cx) {
    if (this.pressed === null) return;
    const v = this.geom;
    const y = (e.local_position?.y ?? 0) + this.scrollTop;
    let hit = null;
    if (v) for (let i = 0; i < v.rows.length; i++) {
      const h = v.H[v.rows[i].kind] ?? 32;
      if (y >= v.tops[i] && y < v.tops[i] + h) { hit = v.rows[i]; break; }
    }
    const from = this.liveSpaces(this.paneSnap).find((x) => x.id === this.pressed);
    const same = hit && hit.kind === "space" && !this.isWorktree(hit.s) && (hit.s.machine ?? null) === (from?.machine ?? null);
    const id = same ? hit.s.id : null;
    if (this.over !== id) { this.over = id; cx.notify(); }
  }

  // A release anywhere in the list finishes a drag the rows did not see.
  dropRow(cx) {
    const from = this.pressed, over = this.over;
    this.pressed = null;
    this.over = null;
    if (from !== null && over && over !== from) {
      const all = this.liveSpaces(this.paneSnap);
      const machine = all.find((y) => y.id === from)?.machine ?? null;
      // The visual list: spaces of this machine, no worktrees. `space.move`
      // indexes this list, not the raw `spaces()` array.
      const order = all.filter((x) => (x.machine ?? null) === machine && !this.isWorktree(x)).map((x) => x.id);
      // Dropped onto a row below its own: it goes after that row, the side the
      // drop line was drawn on.
      const a = order.indexOf(from), b = order.indexOf(over);
      if (a >= 0 && b >= 0) this.landSpace(all.find((x) => x.id === from), all.find((x) => x.id === over), b > a ? 1 : -1);
    }
    cx.notify();
  }

  // Put `s` where `target` is. Pinned spaces read above the rest, so landing on
  // the other side of that line is a pin or an unpin: never a drop that does
  // nothing.
  // A drag lands where it was let go, through the same step the keys use.
  landSpace(s, target, dir = 0) {
    if (!s || !target || this.isWorktree(s) || this.isWorktree(target)) return null;
    if ((s.machine ?? null) !== (target.machine ?? null)) return null;
    const ids = this.liveSpaces(this.paneSnap)
      .filter((x) => (x.machine ?? null) === (s.machine ?? null) && !this.isWorktree(x))
      .map((x) => x.id);
    const place = this.landReorder(s, target, ids, dir);
    if (place !== null) this.follow = s.id;
    return place;
  }

  // The tile, and — where the section does not already say it — the space's state
  // as a bead on its corner, the way a status sits on a portrait.
  avatar(t, s, badged = false, label = this.spaceName(s)) {
    const color = spaceColor(t, s);
    const bead = badged && s.status && s.status !== "idle"
      ? (s.status === "working" ? t.accent : (t[s.status] ?? t.dim)) : null;
    return h_flex().size(20).flex_none().rounded(6).bg(color).relative().items_center().justify_center()
      .border(1).border_color(wash(t.foreground, "14"))
      .text_size(10.5).font_bold().text_color("#ffffff")
      .child([...label][0]?.toUpperCase() ?? "?")
      .when(Boolean(bead), (el) => el.child(div().absolute().right(-2).bottom(-2).size(6).rounded_full()
        .bg(bead).border(1).border_color(t.popover).flex_none()
        .tooltip(s.status === "blocked" ? "Needs you" : s.status === "done" ? "Done" : "Working")));
  }



  render(cx) {
    beginPaint();
    try {
    const listed = frameCache("spaces", spaces);
    const ids = listed.map((s) => s.id);
    // Subscribes this overlay to the sidebar's picture. A notify over there
    // does not reach here; the revision does.
    this.seenRev = shared("workspace.rev") ?? 0;
    // A fresh open starts clean and on the active space, even when this copy
    // lived through the previous open. Spaces made while it was closed are not
    // news: only one made while it is open closes it.
    if (!shared("search.open")) {
      setShared("search.open", true);
      this.at = null;
      this.filter = "";
      this.scrollTop = 0;
      this.stopReorder();
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
    // A worktree just made is a row in this frame. The flag stays put: the
    // sidebar reads it too, and nulling it here is how the sidebar used to miss it.
    // This is an explicit creation, so asking the scanner once is correct — the
    // open path and every status tick never do.
    const createdAt = shared("worktree.createdAt") ?? 0;
    if (createdAt !== (this.createdAt ?? 0)) {
      this.createdAt = createdAt;
      const created = shared("worktree.created");
      if (createdAt && typeof created === "string") {
        this.followCreated = created;
        this.noteCreated(created, createdAt);
        this.load(cx);
      }
    }
    // A removal changed. The row hides while it is in progress (isRemoving) and
    // comes back if git refuses, because the checkout list is only edited when
    // the removal succeeds — the same list the sidebar draws.
    const removingNow = removingList().map((r) => `${r.machine ?? ""}\u0000${tidyPath(r.path)}`).sort().join("|");
    if (this.removingNow !== undefined && removingNow !== this.removingNow) this.load(cx);
    this.removingNow = removingNow;
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
    // A checkout just moved keeps the highlight too.
    if (this.followPath) {
      const i = pick.findIndex((r) => r.kind === "worktree" && tidyPath(r.c?.path) === tidyPath(this.followPath));
      if (i >= 0) { this.at = i; this.followPath = null; }
    }
    // The checkout just made, once the shared list actually has its row.
    if (this.followCreated) {
      const path = tidyPath(this.followCreated);
      const at = pick.findIndex((r) => r.kind === "worktree" && tidyPath(r.c?.path) === path);
      if (at >= 0) {
        this.at = at;
        this.followCreated = null;
      }
    }
    if (pick.length) this.at = Math.min(this.at, pick.length - 1);
    // Ctrl+J/K arrived as a shared write, which is what repainted this sheet.
    // Move before the rows are drawn so this paint is the one that shows it.
    const steps = this.pendingSteps();
    if (steps && pick.length) {
      this.stopReorder();
      this.follow = null;
      let at = this.at ?? 0;
      const count = Math.min(Math.abs(steps), pick.length);
      const dir = steps > 0 ? 1 : -1;
      for (let i = 0; i < count; i++) at = (at + (dir > 0 ? 1 : pick.length - 1)) % pick.length;
      this.at = at;
    }
    const sel = pick[this.at];
    const H = { head: 30, space: 36, pin: 36, worktree: 34, agent: 38 };
    const tops = [];
    let y = 0;
    rows.forEach((r) => { tops.push(y); y += H[r.kind] ?? 32; });
    const total = y;
    const height = Math.max(120, this.listHeight ?? 380);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
    // What the wheel, PageUp/PageDown and a drag are laid out against.
    this.geom = { rows, tops, height, pick, H };
    this.maxScroll = maxScroll;
    const si = rows.indexOf(sel);
    if (si >= 0) {
      if (tops[si] < this.scrollTop) this.scrollTop = tops[si];
      if (tops[si] + (H[sel.kind] ?? 32) > this.scrollTop + height) this.scrollTop = tops[si] + (H[sel.kind] ?? 32) - height;
    }
    const at = (el, i) => fixed
      ? el.absolute().left(0).right(0).top(tops[i] - this.scrollTop).bottom(height - (tops[i] + (H[rows[i].kind] ?? 32) - this.scrollTop))
      : el;
    const visible = (i) => !fixed || (tops[i] + (H[rows[i].kind] ?? 32) > this.scrollTop && tops[i] < this.scrollTop + height);
    // The right-hand column: a pin, a spinner and a status dot sit in the same
    // 16px slot on every row, so they line up down the list.
    const marker = (el) => div().w(16).h_full().flex_none().flex().items_center().justify_center().child(el);

    // Where a dragged space sits among the spaces of its machine, worktrees
    // aside: the same list `space.move` indexes. A drop line compares these
    // places, never raw `spaces()` indices (which count every repo and machine).
    const visual = new Map();
    {
      const counts = new Map();
      for (const r of rows) {
        if (r.kind !== "space" || this.isWorktree(r.s) || visual.has(r.s.id)) continue;
        const m = r.s.machine ?? null;
        const n = counts.get(m) ?? 0;
        counts.set(m, n + 1);
        visual.set(r.s.id, { m, n });
      }
    }

    const row = (r) => {
      if (r.kind === "head") {
        const m = String(r.label).match(/^(.*?)\s+(\d+)$/);
        return h_flex().h(30).px(10).pt(12).gap(7).items_center()
          .child(div().flex_none().text_size(9).font_semibold().text_color(t.dim).child((m ? m[1] : r.label).toUpperCase()))
          .when(Boolean(m), (el) => el.child(div().flex_none().text_size(8.5).font_medium().text_color(t.dim).child(m[2])))
          .child(div().h(1).flex_1().bg(wash(t.foreground, "07")));
      }
      const on = r === sel;
      if (r.kind === "space") {
        const s = r.s;
        const branch = this.spaceGit(s, this.paneSnap)?.branch ?? s.branch;
        // A pin is a place: an unnamed pin reads its folder even when the program
        // in the space reports another folder (the reel pin read `~`). A space
        // the person named keeps that name; any other row is the path it is.
        const pin = r.inPins ? this.spacePin(s) : null;
        const shown = pin && !pin.named && !s.named ? pinLabel(pin) : this.spaceName(s);
        return h_flex().id(`pal-${r.inPins ? "pin-" : ""}${s.id}`).relative().mx(4).pl(10 + (r.depth ?? 0) * 16).pr(10).h(36).rounded(9).gap(9).items_center()
          .when(on, (el) => el.bg(wash(t.accent, "16")))
          .when(!on, (el) => el.hover((x) => x.bg(wash(t.foreground, "0b"))))
          .when(this.pressed === s.id, (el) => el.opacity(0.55))
          .when(this.pressed !== null && this.over === s.id && this.pressed !== s.id, (el) => el.child(
            div().absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
              .when((visual.get(this.pressed)?.m === visual.get(s.id)?.m) && (visual.get(this.pressed)?.n ?? 0) < (visual.get(s.id)?.n ?? 0), (line) => line.bottom(0))
              .when((visual.get(this.pressed)?.m === visual.get(s.id)?.m) && (visual.get(this.pressed)?.n ?? 0) > (visual.get(s.id)?.n ?? 0), (line) => line.top(0)),
          ))
          .on_mouse_down("left", (_e, cx) => {
            if (this.isWorktree(s)) return;
            this.pressed = s.id; this.over = s.id; cx.notify();
          })
          .on_mouse_move((_e, cx) => {
            if (this.isWorktree(s)) {
              if (this.over === s.id) { this.over = null; cx.notify(); }
              return;
            }
            const from = this.liveSpaces(this.paneSnap).find((x) => x.id === this.pressed);
            const same = from && (from.machine ?? null) === (s.machine ?? null);
            if (this.pressed !== null && same && this.over !== s.id) { this.over = s.id; cx.notify(); }
          })
          .on_mouse_up("left", (_e, cx) => {
            if (this.isWorktree(s)) {
              const from = this.pressed;
              this.pressed = null;
              this.over = null;
              if (from == null) this.openRow(this.paletteRow(r));
              cx.notify();
              return;
            }
            const from = this.pressed, over = this.over;
            this.pressed = null;
            this.over = null;
            if (from === s.id) this.openRow(this.paletteRow(r));
            else if (from !== null && over === s.id) {
              const live = this.liveSpaces(this.paneSnap);
              this.landSpace(live.find((x) => x.id === from), s);
            }
            cx.notify();
          })
          .when(on, (el) => el.child(div().absolute().left(0).top(8).bottom(8).w(2).rounded(1).bg(t.accent)))
          .when(Boolean(r.depth), (el) => el.child(div().w(10).flex_none().text_size(10.5).text_color(wash(t.muted, "cc")).child("↳")))
          // A worktree space reads as a branch, not as a space of its own.
          .when(!this.isWorktree(s), (el) => el.child(this.avatar(t, s, Boolean(r.inPins), shown)
            .when(s.active, (a) => a.border_color(wash(t.accent, "b0")))))
          .when(this.isWorktree(s), (el) => el.child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted)))
          .child(this.label(shown, t, 12.5, s.active ? t.foreground : t.muted, s.active))
          .when(s.active, (el) => el.child(div().flex_none().px(5).h(15).rounded(4).bg(wash(t.accent, "18"))
            .text_size(9).font_medium().text_color(t.accent).flex().items_center().child("current")))
          .when(Boolean(branch) && branch !== shown && !this.isWorktree(s), (el) => el.child(div().flex_none().max_w(130).truncate().px(5).h(17).rounded(4)
            .bg(wash(t.foreground, "0c")).text_size(9.5).text_color(wash(t.muted, "cc")).flex().items_center().child(branch)))
          .when(Boolean(s.machine), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(s.machine)))
          .child(marker(Boolean(r.inPins) && !this.isWorktree(s) && Boolean(this.spacePin(s))
            ? svg("mods/icons/pin.svg").size(12).flex_none().text_color(wash(t.accent, "8c"))
            : div()));
      }
      if (r.kind === "pin") {
        // The colour the place was pinned with, exactly as the sidebar draws it:
        // hashing the folder alone made a closed pin change colour between the
        // two views. A pin from an older build still falls back to the hash.
        const tone = r.color ?? folderColor(r.folder);
        const fill = String(tone).startsWith("#") ? tone : (MARK[tone] ?? t[tone] ?? t.dim);
        return h_flex().id(`pal-pin-${r.folder}`).relative().mx(4).pl(10).pr(10).h(36).rounded(9).gap(9).items_center()
          .when(on, (el) => el.bg(wash(t.accent, "16")))
          .when(!on, (el) => el.hover((x) => x.bg(wash(t.foreground, "0b"))))
          .on_click(() => this.openRow(this.paletteRow(r)))
          .when(on, (el) => el.child(div().absolute().left(0).top(8).bottom(8).w(2).rounded(1).bg(t.accent)))
          .child(h_flex().size(20).flex_none().rounded(6).bg(fill).items_center().justify_center()
            .border(1).border_color(wash(t.foreground, "14"))
            .text_size(10.5).font_bold().text_color("#ffffff")
            .child([...r.name][0]?.toUpperCase() ?? "?"))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(r.name))
          // No folder: where a shell starts is Herdr's bookkeeping, and a pin is
          // read by its name. Only another machine is worth saying out loud.
          .when(Boolean(r.on), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(r.on)))
          .child(svg("mods/icons/pin.svg").size(12).flex_none().text_color(t.accent));
      }
      if (r.kind === "worktree") {
        const c = r.c;
        return h_flex().id(`pal-wt-${r.inPins ? "pin-" : ""}${c.path}`).relative().mx(4).pl(10 + (r.depth ?? 0) * 16).pr(10).h(34).rounded(9).gap(9).items_center()
          .when(on, (el) => el.bg(wash(t.accent, "16")))
          .when(!on, (el) => el.hover((x) => x.bg(wash(t.foreground, "0b"))))
          .on_click(() => this.openRow(this.paletteRow(r)))
          .when(on, (el) => el.child(div().absolute().left(0).top(7).bottom(7).w(2).rounded(1).bg(t.accent)))
          .when(Boolean(r.depth), (el) => el.child(div().w(10).flex_none().text_size(10.5).text_color(wash(t.muted, "cc")).child("↳")))
          .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
          .child(this.label(c.branch ?? c.path.split("/").pop(), t, 12.5, t.muted))
          .when(!r.depth, (el) => el.child(div().flex_none().max_w(120).truncate().text_size(9.5).text_color(wash(t.muted, "cc")).child(r.repo.name)))
          .when(c.main, (el) => el.child(div().text_size(9.5).text_color(wash(t.muted, "cc")).child("main")))
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
          .on_click(() => this.openRow(this.paletteRow(r)))
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

    // Alt+F toggles this sheet from anywhere (keys.json: mod.open:agents-list), and
    // the header shows whichever key does it. Esc and Ctrl+Q still close it, so
    // the footer only lists what the rows themselves offer.
    const CLOSE_HINT = { k: shortcutOf("mod.open:agents-list") || "alt f", l: "close" };
    const hints = (() => {
      if (!rows.length) return [CLOSE_HINT];
      if (sel?.kind === "space") {
        // A worktree's space is ended by removing its checkout, so it keeps the
        // removal key whether or not a stale pin names its folder.
        const pinned = !this.isWorktree(sel.s) && Boolean(this.spacePin(sel.s));
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
        const s = frameCache("spaces", spaces).find((x) => x.id === sel.a.space);
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
    const places = this.realSpaces();
    for (const s of places) {
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
      // A drag released outside the list never reaches its own mouse-up; clear
      // it here so the next hover cannot draw a drop line for an old press.
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed === null) return;
        this.pressed = null;
        this.over = null;
        cx.notify();
      })
      .on_key_up((e) => { if (e.key === "j" || e.key === "k") this.stopReorder(); })
      .on_key_down((e, cx) => {
        const k = e.key, ctrl = e.modifiers.control;
        if (!(ctrl && e.modifiers.shift && (k === "j" || k === "k"))) { this.stopReorder(); this.note = null; }
        if (k === "escape" || (ctrl && k === "q")) return this.close();
        // The find sheet's map, shared with the sidebar: walk, reorder, pin,
        // rename, close and worktree all go through the same methods.
        if (this.chord(e, cx)) { cx.stop_propagation(); cx.notify(); return; }
        if (k === "enter") {
          this.openRow(this.selectedRow(), cx);
        } else if (k === "backspace") {
          // Ctrl+Backspace takes the word behind the caret, plain Backspace a key.
          this.filter = ctrl ? this.filter.replace(/\s*[^\s]+\s*$/, "") : this.filter.slice(0, -1);
          this.follow = null;
          this.at = -1;
        } else if (k === "space") {
          this.filter += " ";
          this.follow = null;
          this.at = -1;
        } else if (k.length === 1 && !ctrl && !e.modifiers.alt && !e.modifiers.platform) {
          this.filter += k;
          this.follow = null;
          this.at = -1;
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
          .child(svg("mods/agents-list/layers.svg").size(14).text_color(t.accent)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Spaces"))
          .child(h_flex().gap(9).items_center()
            .child(div().flex_none().text_size(10).text_color(t.muted)
              .child(this.filter.trim()
                ? `${rows.filter((r) => r.hit).length} ${rows.filter((r) => r.hit).length === 1 ? "match" : "matches"}`
                : `${this.placeTotal ?? places.length} ${(this.placeTotal ?? places.length) === 1 ? "space" : "spaces"}`))
            .when(tally["needs you"] > 0, (el) => el.child(chip("needs you")))
            .when(tally.working > 0, (el) => el.child(chip("working")))
            .when(tally.done > 0, (el) => el.child(chip("done")))))
        .child(h_flex().gap(6).items_center()
          .child(keycap(t, shortcutOf("space.new")))
          .child(div().text_size(10).text_color(t.muted).child("new space")))
        .child(keycap(t, shortcutOf("mod.open:agents-list") || "alt f")))
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
          .child(svg("mods/agents-list/x.svg").size(12)))))
      .child(v_flex().id("pal-list")
        .on_size_change((size, cx) => {
          const next = size.height / (settings().zoom || 1);
          if (this.listHeight != null && Math.abs(this.listHeight - next) < 0.5) return;
          this.listHeight = next;
          cx.notify();
        })
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
        .when(this.scrollTop > 0, (el) => el
          .child(div().absolute().top(0).left(0).right(0).h(5).bg(wash(t.popover, "cc")))
          .child(div().absolute().top(5).left(0).right(0).h(6).bg(wash(t.popover, "88")))
          .child(div().absolute().top(11).left(0).right(0).h(8).bg(wash(t.popover, "33"))))
        .when(this.scrollTop < maxScroll, (el) => el
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
    } finally { endPaint(); }
  }
}
