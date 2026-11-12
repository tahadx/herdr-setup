import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, nextCommand, openOverlay, spaces, exec } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const norm = (p) => (p ?? "").replace(/\/+$/, "");
// Is `path` inside `root` (or root itself)?
const inside = (path, root) => { const p = norm(path), r = norm(root); return Boolean(r) && (p === r || p.startsWith(`${r}/`)); };

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Hide the sidebar whole, or bring it back at the width it had. A floating
// handle (mods/handle) is the way back while it is hidden.
function toggleSidebar() {
  const side = find(layout(), "sidebar");
  if (!side) return;
  const width = side.size?.px;
  if (!side.hidden && width && width >= (side.min ?? 0)) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !side.hidden);
  run("layout.toggle", { id: "sidebar" });
  if (side.hidden) {
    const back = shared("sidebar.width");
    if (back) run("layout.resize", { id: "sidebar", px: back });
  }
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

const activeSpace = () => spaces().find((s) => s.active) ?? null;

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

// A theme colour with alpha, so tints follow the theme's own light and dark.
const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

// The colour of a space, kept by id in shared "space.colors" (the palette's rule).
function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
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
  const c = kept[p.id] ?? PROJECT_COLORS[0];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

// Ctrl+J / Ctrl+K: down/up. The search panel takes them while it is open; a
// terminal moves the pane focus.
let moves = 0;
function move(direction) {
  if (shared("search.open")) setShared("search.move", `${direction}:${++moves}`);
  else run("pane.go", { direction });
}

// Ctrl+Shift+D: a new worktree of the shown space's repo.
function newWorktree() {
  const s = activeSpace();
  openOverlay({ mod: "worktrees", kind: "dialog", width: 460, height: 170, props: { space: s?.id, action: "new" } });
}

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    this.tree = null;
    this.treeFor = null;
    this.gone = new Map();
    cx.timer.every(1000, (cx) => this.syncTree(cx));
    // A deleted folder must not leave a space behind.
    cx.timer.every(2000, () => this.sweepGone());
    // Ctrl+Shift+M and Ctrl+Shift+D in keys.json ("layout:workspace").
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          const c = await nextCommand();
          if (c === "flip_layout") flipLayout();
          else if (c === "worktree_new") newWorktree();
          else if (c === "dir_down") move("down");
          else if (c === "dir_up") move("up");
        } catch (e) {
          console.log(`icons: command failed: ${e}`);
        }
      }
    });
  }

  // Herdr names a space whose folder is gone "… (deleted)". Such a space is
  // closed for real (its terminals die with it) and its pin goes too, so a
  // deleted checkout can't come back from the panel. A few seconds' grace keeps
  // a drive that is merely unmounted for a moment from being swept.
  sweepGone() {
    const seen = this.gone ?? (this.gone = new Map());
    const now = Date.now();
    const gone = spaces().filter((s) => !s.machine && / \(deleted\)$/.test(s.name));
    for (const s of gone) if (!seen.has(s.id)) seen.set(s.id, now);
    for (const id of [...seen.keys()]) if (!gone.some((s) => s.id === id)) seen.delete(id);
    for (const s of gone) {
      if (now - (seen.get(s.id) ?? now) < 6000) continue;
      seen.delete(s.id);
      this.dropPin(s);
      run("space.close", { id: s.id, confirmed: true });
    }
  }

  // Removing a space removes its pin, and only its pin: two spaces can share a
  // folder, so an id decides. A pin saved before pins had ids falls back to the
  // folder, and only while no other live space is left there.
  dropPin(s) {
    if (!s) return;
    const pins = shared("spaces.pinned");
    if (!Array.isArray(pins) || !pins.length) return;
    const key = (p) => `${p?.machine ?? ""}\u0000${norm(p?.folder)}`;
    const elsewhere = spaces().some((x) => x.id !== s.id && key(x) === key(s));
    const next = pins.filter((p) => (p.id ? p.id !== s.id : elsewhere || key(p) !== key(s)));
    if (next.length !== pins.length) setShared("spaces.pinned", next);
  }

  // A worktree's space is its repo's, not its own checkout: read the main
  // worktree's path once per space and find the space that lives there.
  syncTree(cx) {
    const s = activeSpace();
    if (!s || this.treeFor === s.id) return;
    this.treeFor = s.id;
    this.tree = null;
    if (!s.folder) return;
    cx.spawn(async (cx) => {
      let tree = null;
      try {
        const r = await exec("git", ["worktree", "list", "--porcelain"], { cwd: s.folder, on: s.machine });
        const main = r.stdout.split("\n").find((l) => l.startsWith("worktree "))?.slice(9).trim() || null;
        if (main && !inside(s.folder, main)) {
          const same = spaces().filter((x) => (x.machine ?? null) === (s.machine ?? null) && x.id !== s.id);
          const parent = same.find((x) => norm(x.folder) === norm(main))
            ?? same.find((x) => inside(x.folder ?? "", main))
            ?? null;
          // The project's name is the repo's, not whichever space happens to
          // sit at the main checkout (several can share one folder).
          tree = { name: main.split("/").pop() || null, parent };
        }
      } catch {}
      // The space may have changed while git ran.
      if (this.treeFor === s.id) { this.tree = tree; cx.notify(); }
    });
  }

  // Where you are, in place of the app wordmark: tile, space name, branch. Opens
  // Spaces. In a worktree the space is its repo's: the name stays, the branch
  // says which checkout.
  spaceChip(t, tight = false) {
    const s = activeSpace();
    if (!s) return h_flex().flex_1();
    const tree = this.treeFor === s.id ? this.tree : null;
    const parent = tree?.parent ?? null;
    const name = tree?.name || s.name;
    const id = parent?.id ?? s.id;
    const branch = tree ? (s.branch || s.name) : s.branch;
    const showBranch = !tight && branch && branch !== name ? branch : null;
    return h_flex().id("active-space").flex_1().min_w(0).gap(tight ? 6 : 8).items_center().py(2).px(tight ? 2 : 4).rounded(7)
      .cursor_pointer().hover((x) => x.bg(wash(t.foreground, "0c"))).tooltip(`${name}${tree && branch ? ` \u00b7 ${branch}` : ""}${s.folder ? ` \u2014 ${s.folder}` : ""}`)
      .on_mouse_down("left", (_e, cx) => cx.stopPropagation())
      .on_click(() => run("mod.open", { name: "search" }))
      .child(h_flex().size(22).flex_none().rounded(7).bg(spaceColor(t, { ...s, id, name })).items_center().justify_center()
        .border(1).border_color(wash(t.foreground, "14"))
        .text_size(11).font_bold().text_color("#ffffff")
        .child([...name][0]?.toUpperCase() ?? "?"))
      .child(h_flex().flex_1().min_w(0).gap(tight ? 5 : 6).items_center()
        .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(name))
        .when(Boolean(showBranch), (el) => el.child(div().min_w(0).max_w(104).truncate().px(5).h(17).rounded(4)
          .bg(wash(t.foreground, "08")).text_size(9.5).text_color(t.dim).flex().items_center().child(showBranch))));
  }

  button(id, label, action, size = 27) {
    const t = theme();
    return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(7).text_color(t.muted)
      .hover(s => s.bg(wash(t.foreground, "0e")).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const bar = find(layout(), "sidebar")?.size?.px ?? Infinity;
    const collapsed = bar < 160;
    const compact = bar < 210;
    const tight = bar < 240;
    if (props()?.footer) {
      const row = (id, icon, label, dim, action, showLabel = true) => h_flex().id(id).h(30).px(8).gap(9).items_center().rounded(7)
        .when(collapsed, el => el.relative().w(30).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted)
        .hover(s => s.bg(wash(t.foreground, "0e")).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/icons/${icon}.svg`).size(14))
        .when(!collapsed && showLabel, el => el.child(label));
      const ready = div().size(5).rounded_full().bg(t.accent);
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(wash(t.border, "66")).px(8).pt(4).pb(8).text_size(12.5)
        .when(collapsed, el => el.px(0).items_center())
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"), false)
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 12).pr(compact && !collapsed ? 6 : 8).gap(3).items_center().text_size(13.5)
      .when(collapsed, el => el.px(0).gap(0).justify_center())
      .when(compact && !collapsed, el => el.pl(8))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "sidebar-menu", kind: "popup", width: 250 }); })
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(this.spaceChip(t, tight)))
      .when(!collapsed && !compact, el => el.child(this.button("search", svg("mods/icons/search.svg").size(14.5), () => run("mod.open", { name: "search" })).tooltip("Search · Alt+F")))
      .when(!collapsed && !compact, el => el.child(this.button("settings", svg("mods/icons/settings.svg").size(14.5), () => run("app.settings"))
        .tooltip("Settings")
        .when(Boolean(updates().app.ready), b => b.relative().child(div().absolute().top(4).right(4).size(5).rounded_full().bg(t.accent)))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/icons/sidebar.svg").size(14.5), toggleSidebar, compact ? 24 : 27).tooltip("Toggle sidebar")))
      .when(!collapsed && Boolean(window()?.buttons), el => el.child(div().w(1).h(14).mx(3).bg(wash(t.foreground, "12")))
        .child(this.button("win-min", svg("mods/icons/minus.svg").size(13), () => run("window.minimize"), 23))
        .child(this.button("win-max", svg("mods/icons/square.svg").size(12), () => run("window.maximize"), 23))
        .child(this.button("win-close", svg("mods/icons/x.svg").size(12), () => run("window.close"), 23)));
  }
}
