// Open terminals in the current space, as a sidebar list (no tab bar).
// Click a row to jump there; right-click opens the normal pane menu.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, layout, shared, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// A theme colour with alpha, for tints that sit over whatever is beneath.
const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

// The agents header's label treatment: 9 px caps with a thin space between the
// characters, so the two blocks of this column read as one surface.
const spaced = (s) => [...String(s)].join("\u2009");

// A count in a quiet pill, matching the agents header.
const countPill = (t, n) => div().flex_none().min_w(18).h(16).px(5).rounded(5)
  .bg(wash(t.foreground, "0a")).border(1).border_color(wash(t.foreground, "0c"))
  .text_size(9).font_medium().text_color(t.muted).flex().items_center().justify_center().child(String(n));

// The row's mark. An agent carries its program's own tile and glyph. Anything
// else is a terminal, and keeps the app's own terminal icon: Herdr's table
// follows whatever runs in the foreground, so `ls`, `clear` or any unlisted
// command would flash that program's tile (a purple one, for the generic
// "program" entry) for as long as it runs, and back again.
function appTile(t, p, size = 22, glyph = 13.5) {
  const agent = Boolean(p?.app);
  const prog = p?.program;
  const known = agent && /^#[0-9a-fA-F]{6}$/.test(prog?.tile ?? "");
  const pic = agent && prog?.icon
    ? (prog.tint ? svg(prog.icon).size(glyph).flex_none().text_color(prog.color ?? t.foreground)
      : image(prog.icon).w(glyph).h(glyph).flex_none())
    : null;
  return div().size(size).flex_none().rounded(7)
    .bg(known ? wash(prog.tile, "2e") : wash(t.foreground, "08"))
    .border(1).border_color(known ? wash(prog.tile, "3c") : wash(t.foreground, "10"))
    .flex().items_center().justify_center()
    .when(Boolean(pic), (el) => el.child(pic))
    .when(!pic, (el) => el.child(svg("icons/shell.svg").size(glyph).text_color(t.muted)));
}

export default class Terminals extends View {
  init(_props, cx) {
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // Ctrl+Shift+X / Ctrl+Shift+W in this layout (keys.json "layout:workspace").
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try { this.command(c); }
        catch (e) { console.log(`terminals-list: ${c} failed: ${e}`); }
        cx.notify();
      }
    });
  }

  // Closing the last terminal of a space opens a fresh shell in that same
  // space first, so Herdr never jumps to another space's terminal.
  command(name) {
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

  // Changes it showed; closing it is the header button's job, not this one's.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    const entering = space.id !== this.space;
    this.space = space.id;
    if (entering) {
      const stored = this.panels[space.id];
      const want = enabled.includes(stored) ? stored : null;
      if (want && now && want !== now) { run("layout.select", { stack: "panel-body", child: want }); return; }
    }
    if (now == null || this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const tabs = space?.tabs ?? [];
    const order = new Map(tabs.map((tab, i) => [tab.id, i]));
    const rows = space
      ? panes().filter((p) => p.terminal && order.has(p.tab)).sort((a, b) => order.get(a.tab) - order.get(b.tab))
      : [];
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    // On the rail the header keeps one button and the rows keep their icon, so
    // neither the label nor the terminal title can spill out of 44px.
    const side = find(layout(), "sidebar");
    const width = side?.size?.px ?? Infinity;
    const narrow = width < 160;
    const compact = width < 210;
    this.syncPanel(space, panel, body, enabled);
    // Narrowed, the sidebar is the agents rail; this list has nowhere to draw.
    if (narrow) return div().size_full().bg(t.chrome);
    const button = (id, icon, label) => {
      const on = Boolean(panel && !panel.hidden && body?.active === id);
      return div().id(`panel-${id}`).size(24).flex_none().rounded(6).flex().items_center().justify_center()
        .when(on, (el) => el.bg(wash(t.accent, "1a")).text_color(t.accent))
        .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(wash(t.foreground, "0e")).text_color(t.foreground)))
        .tooltip(label)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        })
        .child(svg(icon).size(14));
    };
    // The header's buttons are one block at the right edge; left as separate
    // flex children they drift apart and read as unrelated controls.
    const tools = div().flex().flex_none().items_center().gap(2)
      .when(enabled.includes("files"), (b) => b.child(button("files", "mods/files/file.svg", "Files")))
      .when(enabled.includes("changes"), (b) => b.child(button("changes", "mods/changes/changes.svg", "Changes")))
      .child(div().w(1).h(14).mx(1).flex_none().bg(wash(t.foreground, "10")))
      // A new terminal is the same kind of control as Files and Changes beside
      // it, so it reads the same: quiet at rest, the text colour under the pointer.
      .child(div().id("terminal-new").size(24).flex_none().rounded(6).flex().items_center().justify_center()
        .text_color(t.muted)
        .hover((s) => s.bg(wash(t.foreground, "0e")).text_color(t.foreground))
        .tooltip("New terminal")
        .on_click(() => run("tab.new", {})).child(svg("mods/icons/plus.svg").size(13)));

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(38).pl(narrow ? 0 : 10).pr(narrow ? 0 : 6).gap(5).items_center()
        .when(narrow, (el) => el.justify_center())
        .border_t(1).border_color(wash(t.border, "55"))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "sidebar-menu", kind: "popup", width: 250 }); })
        .when(!compact, (el) => el.child(h_flex().flex_1().min_w(0).gap(7).items_center()
          .child(div().flex_none().text_size(9).font_semibold().text_color(t.dim).child(spaced("TERMINALS")))
          .child(countPill(t, rows.length))))
        .when(compact && !narrow, (el) => el.child(div().flex_1()))
        .when(!narrow, (el) => el.child(tools)))
      .child(v_flex().flex_1().min_h(0).px(narrow ? 4 : 8).pt(2).pb(6).gap(0).overflow_y_scrollbar()
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "sidebar-menu", kind: "popup", width: 250 }); })
        .children(rows.map((p) => {
          const tab = tabs[order.get(p.tab)], multi = tabs.length > 1;
          const title = p.title || p.program?.name || "Terminal";
          return h_flex().id(`term-${p.pane}`).relative().h(narrow ? 26 : 28).flex_none().mx(narrow ? 0 : 3).px(narrow ? 0 : 6).gap(narrow ? 2 : 7).items_center().rounded(7)
            .cursor_pointer()
            .when(narrow, (el) => el.justify_center().tooltip(title))
            .when(p.focused, (e) => e.bg(wash(t.accent, "16")))
            .when(!p.focused, (e) => e.hover((s) => s.bg(wash(t.foreground, "0b"))))
            .on_click(() => { run("tab.select", { id: p.tab }); run("pane.focus", { pane: p.pane }); })
            .on_mouse_down("right", (_e, cx) => {
              cx.stop_propagation();
              openOverlay({ mod: "menu", kind: "popup", width: 230,
                props: { tab: "pane", target: { pane: p.pane, terminal: p.terminal } } });
            })
            .when(p.focused, (el) => el.child(div().absolute().left(-2).top(7).bottom(7).w(2).rounded(1).bg(t.accent)))
            .child(appTile(t, p, 20, 13))
            .when(!narrow, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12)
              .when(p.focused, (d) => d.font_medium())
              .text_color(p.focused ? t.foreground : t.muted)
              .child(title)))
            .when(!narrow && multi && Boolean(tab), (el) => el.child(div().flex_none().max_w(64).truncate().px(5).h(16).rounded(4)
              .bg(wash(t.foreground, "08")).text_size(9.5).text_color(t.dim).flex().items_center().child(tab.name)))
            .when(Boolean(p.status), (el) => el.child(div().size(6).flex_none().rounded(3)
              .bg(p.status === "working" ? t.accent : (t[p.status] ?? t.dim))));
        }))
        .when(!rows.length, (el) => el.child(v_flex().px(narrow ? 0 : 10).pt(narrow ? 12 : 18).gap(6).items_center()
          .child(div().size(30).rounded(8).bg(wash(t.foreground, "06")).border(1).border_color(wash(t.foreground, "0c"))
            .flex().items_center().justify_center()
            .child(svg("mods/icons/terminal.svg").size(15).text_color(t.muted)))
          .when(!narrow, (el) => el.child(div().text_size(12.5).font_medium().text_color(t.muted).child("No terminals")))
          .when(!narrow, (el) => el.child(div().text_size(10.5).text_color(wash(t.muted, "cc")).child("Ctrl+Shift+T opens one"))))));
  }
}
