// The sidebar's context menu, shown by right-clicking anywhere in the sidebar.
// It mirrors the layout left/right and hides the sidebar.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, layout, run, props, closeOverlay, keys, shared, setShared } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
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

// A binding written the way people read it ("ctrl-shift-m" -> "Ctrl+Shift+M").
function keyLabel(binding) {
  const word = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: "Cmd", super: "Super" };
  return binding.split("-").map((p) => word[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join("+");
}

function binding(action) {
  const found = keys().find((k) => k.section !== "terminal" && k.action === action);
  return found ? keyLabel(found.keys) : "";
}

// Theme tints and a compact key cap, matching the other redesigned mods.
const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);
const keycap = (t, label) => div().flex_none().h(18).px(5).rounded(4)
  .bg(wash(t.foreground, "0a")).border(1).border_color(wash(t.foreground, "0e"))
  .text_size(9.5).font_medium().text_color(t.dim).flex().items_center().child(label);

export default class LayoutMenu extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  render() {
    const t = theme();
    const left = layout()?.children?.[0]?.id === "sidebar";
    const moveKey = binding("footer.flip_layout");
    const hideKey = binding("layout.toggle:sidebar");
    const move = () => { flipLayout(); closeOverlay(props()?.overlay); };
    const hide = () => { run("layout.hide", { id: "sidebar" }); closeOverlay(props()?.overlay); };
    const row = (id, icon, label, hint, action) => h_flex().id(id).h(32).flex_none().px(8).gap(10).items_center().rounded(7)
      .text_color(t.muted).hover((s) => s.bg(wash(t.foreground, "0b")).text_color(t.foreground)).cursor_pointer()
      .on_click(action)
      .child(svg(`mods/icons/${icon}.svg`).size(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(label))
      .when(Boolean(hint), (el) => el.child(keycap(t, hint)));
    return v_flex().id("sidebar-menu").min_w(224).p(6).gap(1).bg(t.popover).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") move();
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(row("flip-layout", left ? "panel-right" : "panel-left", left ? "Move sidebar to the right" : "Move sidebar to the left", moveKey, move))
      .child(div().h(1).mx(4).my(3).bg(wash(t.foreground, "09")))
      .child(row("hide-sidebar", "sidebar", "Hide sidebar", hideKey, hide));
  }
}
