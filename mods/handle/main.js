// A tab at the window's edge while the sidebar is fully hidden: click to bring
// it back at the width it had. icons shows the one on the sidebar's side.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, layout, shared, placement } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

export default class SidebarHandle extends View {
  render() {
    const t = theme();
    const tree = layout();
    const side = find(tree, "sidebar");
    // Hidden nodes keep their size, so the width is still the sidebar's own.
    if (!side || !side.hidden) return div().size(0);
    const left = (tree?.children ?? [])[0]?.id === "sidebar";
    // One copy per edge; only the sidebar's own side draws the tab.
    const edge = placement()?.edge ?? (left ? "left" : "right");
    if ((edge === "left") !== left) return div().size(0);
    const back = side.size?.px ?? shared("sidebar.width") ?? 268;
    return h_flex()
      .id(`handle-${edge}`)
      .w(24)
      .h(60)
      .rounded(10)
      .items_center()
      .justify_center()
      .bg(t.popover)
      .border_1()
      .border_color(wash(t.border, "aa"))
      .shadow_sm()
      .text_color(t.muted)
      .cursor_pointer()
      .tooltip("Show the sidebar")
      .hover((s) => s.bg(wash(t.accent, "14")).border_color(wash(t.accent, "66")).text_color(t.accent))
      .on_click(() => {
        run("layout.show", { id: "sidebar" });
        run("layout.resize", { id: "sidebar", px: back });
      })
      .child(svg(`mods/workspace-chrome/${left ? "panel-left" : "panel-right"}.svg`).size(13));
  }
}
