// Sidebar footer: the machine you are on, then search, settings and the
// sidebar's collapse. The old top row is gone, so this strip is also what drags
// the window (the layout marks it window_drag; buttons stop the press).
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, theme, run, layout, shared, setShared, nextCommand, openOverlay, notify } from "herdr";

// A theme colour with alpha, for tints over whatever is beneath.
const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Pinned spaces are kept by the person, so nothing in these mods closes one:
// not the sweep below, not a dialog, not a removal. A pin names its space by id,
// or — pins saved before ids — by its machine and folder.
const norm = (p) => (p ?? "").replace(/\/+$/, "");
const pinnedList = () => (Array.isArray(shared("spaces.pinned")) ? shared("spaces.pinned") : []);
const isPinned = (s) => Boolean(s?.id) && pinnedList().some((p) => (p.id
  ? p.id === s.id
  : (p.machine ?? null) === (s.machine ?? null) && norm(p.folder) === norm(s.folder)));

const activeSpace = () => spaces().find((s) => s.active) ?? null;

// Close a space once. The sidebar, the top bar and this footer all watch for a
// folder that is gone; the first claim closes it, the rest skip instead of
// closing a space that no longer exists (which posts "space.close failed").
const closeSpace = (id) => {
  if (!id || !spaces().some((s) => s.id === id)) return false;
  const now = Date.now();
  const claims = shared("space.closing") ?? {};
  if (claims[id] && now - claims[id] < 15000) return false;
  const next = { ...claims, [id]: now };
  for (const [key, at] of Object.entries(next)) if (now - at > 60000) delete next[key];
  setShared("space.closing", next);
  run("space.close", { id, confirmed: true });
  return true;
};

// A worktree is a checkout, not a place to pin. The sticky record says whether
// this space is one even after its folder is gone.
const isWorktreeSpace = (s) => {
  const rec = shared("workspace.state")?.spaces?.[s?.id];
  return Boolean(rec?.isWorktree) || /(?:^|\/)worktrees\/[^/]+\/[^/]+\/?$/.test(norm(s?.folder));
};

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

function newWorktree() {
  const s = activeSpace();
  openOverlay({ mod: "worktrees", kind: "dialog", width: 460, height: 170, props: { space: s?.id, action: "new" } });
}

export default class Status extends View {
  init(_props, cx) {
    this.gone = new Map();
    // Ctrl+J/K move panes (or the search panel, or the sidebar's rows),
    // Ctrl+Shift+M flips the layout, Ctrl+Shift+D makes a worktree: keys.json
    // points those here.
    cx.spawn(async (cx) => {
      let moves = 0;
      for (;;) {
        try {
          const c = await nextCommand();
          if (c === "dir_down" || c === "dir_up") {
            const direction = c === "dir_down" ? "down" : "up";
            // Ctrl+J/K is the app's binding, so the panel with the keyboard cannot
            // see it: it says so, and the walk comes back to it here. Same for
            // the find sheet.
            if (shared("search.open")) setShared("search.move", `${direction}:${++moves}`);
            else if (shared("sidebar.kb")) setShared("sidebar.move", `${direction}:${++moves}`);
            else run("pane.go", { direction });
          } else if (c === "flip_layout") flipLayout();
          else if (c === "worktree_new") newWorktree();
        } catch (e) {
          console.log(`footer: command failed: ${e}`);
        }
      }
    });
    // A deleted folder must not leave a space behind.
    cx.timer.every(2000, () => this.sweepGone());
  }

  // Herdr names a space whose folder is gone "… (deleted)". Such a space is
  // closed for real (its terminals die with it) and its pin goes too, so a
  // deleted checkout can't come back from the panel. A few seconds' grace keeps
  // a drive that is merely unmounted for a moment from being swept.
  sweepGone() {
    const seen = this.gone ?? (this.gone = new Map());
    const now = Date.now();
    const gone = spaces().filter((s) => !s.machine && / \(deleted\)$/.test(s.name));
    const kept = this.kept ?? (this.kept = new Set());
    for (const s of gone) if (!seen.has(s.id)) seen.set(s.id, now);
    for (const id of [...seen.keys()]) if (!gone.some((s) => s.id === id)) { seen.delete(id); kept.delete(id); }
    for (const s of gone) {
      // A pinned space is never closed, whatever happened to its folder: that is
      // what pinning means. It stays in the list, named "(deleted)", until the
      // person unpins it. A worktree is the exception: a checkout is not a place
      // to pin, so a pin on one does not keep a folder git has already removed.
      if (isPinned(s) && !isWorktreeSpace(s)) {
        if (!kept.has(s.id)) {
          kept.add(s.id);
          notify({ title: "Pinned space kept", body: `${s.name} stays. Pinned spaces are never closed; unpin it if the folder is really gone.` });
        }
        continue;
      }
      if (now - (seen.get(s.id) ?? now) < 6000) continue;
      seen.delete(s.id);
      this.dropPin(s);
      closeSpace(s.id);
    }
  }

  // Only this space's own pin goes. Two spaces can sit in one folder and both be
  // pinned, so an id decides; a pin saved before pins had ids falls back to the
  // folder, and only while no other live space is left there.
  dropPin(s) {
    if (!s) return;
    const pins = shared("spaces.pinned");
    if (!Array.isArray(pins) || !pins.length) return;
    const key = (p) => `${p?.machine ?? ""}\u0000${norm(p?.folder)}`;
    const elsewhere = spaces().some((x) => x.id !== s.id && key(x) === key(s));
    const next = pins.filter((p) => (p.id ? p.id !== s.id : elsewhere || key(p) !== key(s)));
    if (next.length !== pins.length) {
      console.log(`footer: dropped the pin of ${s.name} (${pins.length} -> ${next.length})`);
      setShared("spaces.pinned", next);
    }
  }

  button(id, icon, action, tip) {
    const t = theme();
    return div().id(id).size(26).flex_none().rounded(7).flex().items_center().justify_center()
      .text_color(t.muted).hover((s) => s.bg(wash(t.foreground, "0e")).text_color(t.foreground))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action).child(svg(icon).size(14));
  }

  render() {
    const t = theme();
    const space = activeSpace();
    const width = find(layout(), "sidebar")?.size?.px ?? Infinity;
    const narrow = width < 160;
    const compact = width < 210;
    // On the rail the agents header carries the controls; the footer draws
    // nothing at all.
    if (narrow) return div().size_full().bg(t.chrome);
    return h_flex().size_full().px(narrow ? 0 : 9).gap(4).items_center()
      .when(narrow, (el) => el.justify_center())
      .bg(t.chrome).border_t(1).border_color(wash(t.border, "55")).text_size(11).text_color(t.muted)
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "sidebar-menu", kind: "popup", width: 250 }); })
      .when(!narrow, (el) => el.child(h_flex().flex_1().min_w(0).gap(7).items_center().rounded(7).py(2).px(3)
        .cursor_pointer().hover((x) => x.bg(wash(t.foreground, "0b")).text_color(t.foreground))
        .tooltip("Machines")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("app.settings", { section: "machines" }))
        .child(div().size(20).flex_none().rounded(6).bg(wash(t.foreground, "07")).border(1).border_color(wash(t.foreground, "0c"))
          .flex().items_center().justify_center()
          .child(svg(`mods/icons/${space?.machine ? "server" : "monitor"}.svg`).size(11.5).flex_none().text_color(t.muted)))
        .when(!compact, (el) => el.child(div().min_w(0).truncate().text_size(11.5).child(space?.machine ?? "This computer")))))
      // Search and collapse the sidebar moved to the agents header; settings stays,
      // so the rail keeps one control of its own.
      .child(h_flex().flex_none().gap(2).items_center()
        .child(this.button("footer-keys", "mods/icons/keyboard.svg", () => run("mod.open", { name: "shortcuts" }), "Keyboard shortcuts"))
        .child(this.button("footer-settings", "mods/icons/settings.svg", () => run("app.settings"), "Settings")));
  }
}
