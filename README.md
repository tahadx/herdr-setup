# Herdr Setup

A keyboard-driven [Herdr](https://herdr.dev) setup: one sidebar with every agent
and terminal, one search sheet, and no tab bar or top bar.
Panes are cards, the footer is the window's drag handle, and a narrow sidebar
folds into a rail of icons.

![Herdr Setup](preview.png?v=2)

## What you get

- **A sidebar instead of a tab bar.** `AGENTS` on top, `TERMINALS` below, in one
  268 px column: agents grouped by what they need (Needs you → Done → Working →
  Idle), terminals as rows with their program's own mark, the tab they live in
  and their status dot. The agents header's sort button also gives *Grouped by
  space* and *Spaces with agents*. The first two are Herdr's own list, drawn as it
  ships them; the third is this mod's — the search sheet's tree on screen, with
  rows drawn like Herdr's own spaces list: the avatar and name, the branch or the
  ahead/behind count only where it is unusual, worktrees (branch icon) under
  their checkout, each space's agents nested under it, right-click for the space
  menu (rename, worktrees, close) or an unopened checkout's own menu, and drag to
  reorder inside a section. Rows hang off a hairline gutter, the space in use
  wears an accent spine and ring, pins are a quiet column rather than five
  buttons, and each section ribbon carries its count. A folded space still says
  how many rows it hides and how urgent they are. Several machines are grouped by name with their
  connection state, login command and Connect.
- **One search sheet, Alt+F.** Pinned places first, then spaces (the active one
  wears a `current` badge), worktrees nested under their space, agents under
  theirs. Its subtitle counts the spaces and their states as clickable chips;
  typing searches every term against names, branches, folders, titles and states
  at once — `kleeamp desk` is the space and its desktop checkout, `needs you`
  finds what is waiting — and the matched characters are drawn forward in the
  row. `↑`/`↓` (or `Ctrl+J`/`Ctrl+K`) move, `Enter` goes, `Ctrl+P` pins, `Ctrl+R`
  renames, `Ctrl+D` closes. `Ctrl+J`/`Ctrl+K` are the pane keys while the sheet is
  shut; inside it they mean the sheet.
- **A footer you can grab.** Machine on the left (opens Settings → Machines),
  keyboard and settings on the right; the strip itself drags the window.
- **Panes as cards** — 10 px radius, 8 px between them, an accent border on the
  pane that has the keyboard, and no header to eat the space.
- **Worktrees from the sidebar** — new, open and remove in dialogs, plus removing
  the space's worktree and stopping an agent from the same dialog. A removal names
  the space it will close and says nothing about one it will not; stopping an agent
  never takes its space: where the agent is the only thing there, a shell opens in
  its place.
- **A pinned space never closes.** The pin is the point. The sidebar's sweep keeps
  a pinned space even when its folder is gone (it stays, named `(deleted)`), the
  space menu does not offer to close one, the sheet says so instead of opening a
  dialog that could only refuse, and a worktree removal refuses rather than ending
  one. Unpin it first, then close it.
- **A rail when narrow** — below 160 px the sidebar is a column of numbered
  spaces with their state dots, an unfold chevron above them, and search,
  shortcuts and settings on the window's bottom edge; worktree checkouts stay in
  the expanded tree and search, and past nine spaces an ellipsis stands in for
  the rest and expands the sidebar. The blocks below have
  nothing to draw at that width, so the rail takes the column and gives it back
  when you drag the sidebar wider.
- **A searchable keys sheet** — every shortcut in one list, one row per command,
  all of its keys together.

## Requirements

- Herdr **0.1.15** (built against that version's shipped layout, mods and icons).
- `git` on the machine for the worktree dialogs; nothing else is run and nothing
  reaches the network.
- Optional: the `omarchy` theme file (see [Theme](#theme)).

## Install

```sh
git clone https://github.com/tahadx/herdr-setup.git
cd herdr-setup
./install.sh                       # into ~/.config/herdr-app
herdr-app do layout.switch --name workspace
```

`install.sh` copies the layout, its ten mods and its theme into your Herdr home,
merges the keys the layout needs into `keys.json` (the previous file is kept as
`keys.json.bak.<time>`), and touches nothing else. Set `HERDR_APP_HOME` to
install somewhere else. To do it by hand, copy `layouts/workspace.json` +
`layouts/workspace.svg` into `layouts/`, the ten folders listed below into
`mods/`, and `themes/omarchy.json` into `themes/`.

The bundle ships **all ten mods**: they are parts of this layout, not separate
downloads and not separate listings.

Then merge the keys it expects into `keys.json` (the rest are Herdr's defaults):

```json
{
  "layout:workspace": {
    "alt-f": "mod.open:search",
    "ctrl-j": "footer.dir_down",
    "ctrl-k": "footer.dir_up",
    "ctrl-shift-x": "terminals-list.close_pane",
    "ctrl-shift-w": "terminals-list.close_tab",
    "ctrl-shift-m": "footer.flip_layout",
    "ctrl-shift-d": "footer.worktree_new"
  }
}
```

Every one of them is in the layout section, not `global`: these mods only exist
while this layout is shown, so `Alt+F` and `Ctrl+J`/`Ctrl+K` should keep their
Herdr meaning in Herdr's own layouts. (In your own `keys.json` they may live in
`global`; that only takes the keys away everywhere else.) `ctrl-shift-b` (Herdr's own key)
still toggles the sidebar; with it hidden, a small tab floats at the window edge
to bring it back.

## Repository layout

```
layouts/workspace.json           the window
layouts/workspace.svg            its picture (also the settings thumbnail)
preview.png                   a screenshot of the layout, for the listing
mods/<name>/                  main.js, mod.json, and the icons that mod draws
themes/omarchy.json           the palette this layout is drawn for
keys.json                     this author's own key file, a working example
tests/                        plain node, no Herdr needed (see Checks)
install.sh                    copies it all into a Herdr home, merging keys
RECIPE.md                     the brief another agent could rebuild it from
```

Nothing in `mods/` is Herdr's: the app ships its own mods into the same folder,
and `.gitignore` keeps those (and every piece of live state — `shared.json`,
`view.json`, `windows.json`, `data/`, the socket) out of this repository.

## The mods

The layout ships ten mods; they are parts of it, not separate packages.

| Mod | What it is |
|---|---|
| `agents-list` | The AGENTS list: status groups, pins, sub-agents, sort, search, hide. |
| `terminals-list` | The TERMINALS list for the active space, plus Files / Changes / new terminal. |
| `footer` | The footer strip; also `Ctrl+J`/`Ctrl+K`, the flip, new worktree, and closing spaces whose folder is gone. |
| `icons` | Icons shared by the other mods, and an optional top bar (space chip, search, settings, sidebar toggle) for layouts that want one. |
| `search` | The Alt+F search sheet. |
| `shortcuts` | The searchable shortcut sheet, opened from the keyboard icon in the footer. |
| `worktrees` | New / open / remove worktree dialogs; also the space and agent stop confirmations. |
| `sidebar-menu` | Right-click anywhere in the sidebar: move it to the other side, or hide it. |
| `handle` | The floating tab at the window edge while the sidebar is hidden. |
| `pane-header` | An optional pane header (program, folder, status, split/zoom/close). **Unused by this layout** — this layout's panes are bare cards. |

Everything else the layout shows is Herdr's own and ships with the app: the
`files` and `changes` panels, the `menu` popup, and the icons the mods borrow —
`mods/workspace-chrome/*.svg` (search, branch, plus, spinner, chevron, check,
sidebar), `mods/files/file.svg`, `mods/changes/changes.svg`, `mods/pane/close.svg`,
`mods/tabs/win-*.svg`. They are not copied into this repository.

### Taking one mod on its own

Each folder in `mods/` is self-contained: `main.js`, `mod.json`, and the icons it
draws live together, so a mod can be copied into another Herdr home by itself.
What it borrows is listed here, so nothing is a surprise later.

| Mod | Icons from Herdr's folders | Opens dialogs from | Keys it wants |
|---|---|---|---|
| `search` | `workspace-chrome/branch,search,spinner` | `worktrees` | `alt-f` |
| `agents-list` | `workspace-chrome/branch,check,chevron-right,plus,spinner` | `sidebar-menu`, `worktrees` | — |
| `terminals-list` | `changes/changes`, `files/file` | `sidebar-menu`, Herdr's `menu` | `ctrl-shift-x`, `ctrl-shift-w` |
| `footer` | — | `sidebar-menu`, `worktrees` | `ctrl-j`, `ctrl-k`, `ctrl-shift-m`, `ctrl-shift-d` |
| `worktrees` | `workspace-chrome/branch` | — | — |
| `shortcuts` | `workspace-chrome/search` | — | — |
| `sidebar-menu` | — | — | — |
| `handle` | — | — | — |
| `pane-header` | `workspace-chrome/spinner` | — | — |
| `icons` | — | `sidebar-menu`, `worktrees` | — |

Two consequences worth knowing before splitting anything:

- **The search sheet is the one that stands alone.** Its icons are its own, and
  the two actions that need `worktrees` (new worktree, close/remove/stop)
  are the only thing you lose. Search, families, pin, rename, reorder and
  worktree rows are the search sheet alone.
- **`agents-list`, `terminals-list` and `footer` lean on each other's
  dialogs and on `worktrees`.** They are also written for this layout's node
  ids. A separate listing of any of them means either shipping `worktrees`
  beside it or accepting a smaller mod.

Icons under `mods/workspace-chrome/`, `mods/files/` and `mods/changes/` ship with
Herdr and are referenced, never copied: they are Herdr's art, not this repo's.

## Checks

Each mod loads on its own; do this after any edit:

```sh
herdr-app check mods/search   # once per mod
```

The rules that are easy to get wrong — and that review cannot see — are covered
by tests that run the mods' own functions with stubs, so no Herdr is needed.
GitHub Actions runs the same seven:

```sh
node tests/pins.test.mjs       # a pin is its space's id; one place is one space
node tests/pinned.test.mjs     # a pinned space is never closed; an agent's space stays
node tests/reorder.test.mjs    # a step is one place, even before the app lands it
node tests/search.test.mjs     # a hit comes with the space that holds it
node tests/keys.test.mjs       # Shift is read before plain Ctrl in the sheet
node tests/methods.test.mjs    # every this.* call exists, and is defined once
node tests/rail.test.mjs       # past nine spaces the rail folds them into one ellipsis
```

## Theme

`themes/omarchy.json` is the palette this layout is drawn for: background
`#0c0b0c`, foreground `#c1c1c1`, accent `#8a9a7b`. The layout names it for both
appearances (`"theme": { "light": "omarchy", "dark": "omarchy" }`), so it looks
the same whichever way the desktop is set.

The file is the one Omarchy's `omarchy-theme-set-herdr-app` publishes from the
current Omarchy theme, so on Omarchy it is rewritten on every theme switch —
that is the point. Any other theme works too: point the layout's `theme` at a
name in `themes/`, or delete the root `theme` key and let `settings.json` decide.

Intended font settings (`settings.json`): `font_size: 16`, `ui_font: "Geist"`,
`font_ligatures: false`. Terminal padding comes from the layout: 14 px vertical,
12 px horizontal.

## How it is put together

The layout is a two-column root: a fixed 268 px `sidebar` and the `work` column.
Inside the sidebar, `agents` and `terminals` share the height by weight (2.15 to
0.85, both at least 90 px) over a 32 px `sidebar-footer`. The work column holds
the active tab as cards, with a hidden 368 px `files`/`changes` panel that the
Files and Changes buttons reveal. Two `handle` blocks float on the left
and right edges.

The ids matter: the mods find their places by id (`sidebar`, `agents`,
`terminals`, `sidebar-footer`, `main`, `panel`, `panel-body`, `work-body`), so
rename nodes in the layout and the panels stop working. `RECIPE.md` lists them
along with everything else a rebuild has to get right.

## Publishing

This repository is a layout bundle — `layouts/workspace.json`, the `mods/` it
needs, `themes/omarchy.json`, `RECIPE.md` and `preview.png` at the root. It is
listed at herdr.dev/layouts by its `herdr-layout` topic.

`preview.png` is a screenshot of the layout; `layouts/workspace.svg` is the
drawn version Herdr uses as the settings thumbnail. To re-render that drawing:

```sh
rsvg-convert -w 1416 -h 760 layouts/workspace.svg -o layouts/workspace.png
```

## Licence

MIT — see [LICENSE](LICENSE).
