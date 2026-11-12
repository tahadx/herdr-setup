// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-header" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, props, run, theme, home, layout, setShared, shared } from "herdr";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

// Bring the sidebar back at the width it had, from the pane header.
function showSidebar() {
  const side = find(layout(), "sidebar");
  if (!side?.hidden) return;
  run("layout.show", { id: "sidebar" });
  const back = shared("sidebar.width");
  if (back) run("layout.resize", { id: "sidebar", px: back });
  setShared("sidebar.collapsed", false);
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // Closing the last terminal of a space opens a fresh shell in that same
  // space first, so Herdr never jumps to another space's terminal.
  close(paneId) {
    const pane = panes().find((p) => p.pane === paneId);
    const tabId = pane?.tab;
    if (!tabId) return;
    const space = spaces().find((s) => s.tabs.some((t) => t.id === tabId));
    if (!space) return;
    if (panes().filter((p) => p.tab === tabId).length > 1) return run("pane.close", { pane: paneId });
    if (space.tabs.length > 1) return run("tab.close", { id: tabId });
    run("tab.new", { space: space.id });
    run("tab.close", { id: tabId });
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .size(24)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_color(t.dim)
      .hover((s) => s.bg(wash(t.foreground, "0e")).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-header/${icon}.svg`).size(13.5));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(12)
      .gap(9)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(wash(t.border, "66"))
      .text_size(12.5)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      // The way back when the sidebar is hidden; nothing to see while it is shown.
      .when(Boolean(find(layout(), "sidebar")?.hidden), (el) => el.child(
        div().id(`ph-sidebar-${pane}`).size(24).rounded(6).flex().items_center().justify_center().text_color(t.dim)
          .hover((s) => s.bg(wash(t.foreground, "0e")).text_color(t.accent))
          .tooltip("Show sidebar")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); showSidebar(); })
          .child(svg("mods/icons/sidebar.svg").size(14))))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(11.5).flex_none().text_color(t.accent).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(wash(t.blocked, "20")).text_size(9.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(6).flex_none().rounded(3).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(div().id(`ph-x-${pane}`).size(24).rounded(6).flex().items_center().justify_center().text_color(t.dim)
          .hover((s) => s.bg(wash(t.blocked, "18")).text_color(t.blocked))
          .on_click((_e, cx) => { cx.stop_propagation(); this.close(pane); })
          .child(svg("mods/pane-header/close.svg").size(14))));
  }
}
