# Herdr Setup

A keyboard-driven [Herdr](https://herdr.dev) layout: one sidebar with every agent
and terminal, a search sheet, and no tab bar. Panes are cards, the footer drags
the window, and a narrow sidebar folds into a rail of icons.

![Herdr Setup](preview.png?v=2)

## What you get

- **A sidebar instead of a tab bar.** `AGENTS` above `TERMINALS` in one 268 px
  column, with a footer on the bottom edge. Agents are grouped by what they need
  (Needs you → Done → Working → Idle); the sort button also offers *Grouped by
  space* and *Spaces with agents*. Terminals show their program's mark, tab and
  status. Pins, sub-agents and multiple machines are handled in place.
- **One search sheet, `Alt+F`.** Pinned places, spaces, worktrees and agents in
  one tree. Typing matches names, branches, folders, titles and states at once —
  `web hotfix` finds a space and its worktree, `needs you` finds what is waiting.
  `↑`/`↓` move, `Enter` goes, `Ctrl+P` pins, `Ctrl+R` renames, `Ctrl+D` closes.
- **A footer you can grab.** Machine on the left (opens Settings → Machines),
  shortcut sheet and settings on the right; the strip itself drags the window.
- **Panes as cards** — 10 px radius, 8 px between them, an accent border on the
  focused pane, and no header eating space.
- **Worktrees from the sidebar.** New, open and remove in dialogs. A pinned
  space never closes, and stopping an agent leaves a shell in its place.
- **A rail when narrow.** Below 160 px the sidebar becomes a column of state
  dots and icons; past nine spaces an ellipsis expands it again.
- **A searchable keys sheet** — every shortcut in one list, one row per command.

## Requirements

- Herdr **0.1.15**.
- `git` for the worktree dialogs. Nothing reaches the network.
- Optional: the `omarchy` theme (see [Theme](#theme)).

## Install

```sh
git clone https://github.com/tahadx/herdr-setup.git
cd herdr-setup
./install.sh
herdr-app do layout.switch --name workspace
```

`install.sh` copies the layout, its ten mods and its theme into
`~/.config/herdr-app`, and merges the layout's keys into `keys.json` (the old
file is kept as `keys.json.bak.<time>`). It touches nothing else. Set
`HERDR_APP_HOME` to install elsewhere.

To install by hand, copy `layouts/workspace.json` and `layouts/workspace.svg`
into `layouts/`, the ten mod folders listed below into `mods/`, and
`themes/omarchy.json` into `themes/`, then add the keys below.

## Keys

These live in the layout's section, so Herdr's other layouts keep `Alt+F` and
`Ctrl+J`/`Ctrl+K` for themselves:

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

`Ctrl+Shift+B` (Herdr's own key) still toggles the sidebar. With it hidden, a
small tab floats at the window edge to bring it back.

## Repository layout

```
layouts/workspace.json    the window
layouts/workspace.svg     its drawn picture (also the settings thumbnail)
preview.png               a screenshot of the layout
mods/<name>/              main.js, mod.json, and the icons that mod draws
themes/omarchy.json       the palette this layout is drawn for
keys.json                 a working example key file
tests/                    plain node, no Herdr needed
install.sh                copies it all into a Herdr home, merging keys
RECIPE.md                 the brief to rebuild this layout from scratch
```

Herdr's own mods live in the same folder but are not part of this repository;
`.gitignore` also keeps live state (`shared.json`, `view.json`, `data/`, the
socket) out of it.

## Mods

The layout ships ten mods as parts of itself, not separate downloads:

| Mod | What it is |
|---|---|
| `agents-list` | The AGENTS list: status groups, pins, sub-agents, sort, search, hide. |
| `terminals-list` | The TERMINALS list for the active space, plus Files / Changes / new terminal. |
| `footer` | The footer strip; `Ctrl+J`/`Ctrl+K`, layout flip, new worktree, closing dead spaces. |
| `icons` | Icons shared by the other mods, and an optional top bar. |
| `search` | The `Alt+F` search sheet. |
| `shortcuts` | The searchable shortcut sheet. |
| `worktrees` | New / open / remove worktree dialogs and stop confirmations. |
| `sidebar-menu` | Right-click the sidebar: move it to the other side, or hide it. |
| `handle` | The floating tab at the window edge while the sidebar is hidden. |
| `pane-header` | An optional pane header. **Unused by this layout.** |

Each folder is self-contained and can be copied into another Herdr home. The
`search` sheet stands alone; `agents-list`, `terminals-list` and `footer` also
open dialogs from `worktrees`, so take that with them. Some icons are borrowed
from Herdr's own mod folders (`workspace-chrome`, `files`, `changes`, `pane`,
`tabs`) and are referenced, never copied.

## Checks

Load each mod after any edit:

```sh
herdr-app check mods/search   # once per mod
```

The tests run the mods' own functions with stubs, so no Herdr is needed:

```sh
for t in tests/*.test.mjs; do node "$t"; done
```

GitHub Actions runs the same set plus a scratch install.

## Theme

`themes/omarchy.json` is the palette this layout is drawn for: background
`#0c0b0c`, foreground `#c1c1c1`, accent `#8a9a7b`. The layout names it for both
appearances, so it looks the same in light and dark.

On Omarchy, `omarchy-theme-set-herdr-app` rewrites this file from the current
theme. Any other theme works too: point the layout's `theme` at a name in
`themes/`, or remove it and let `settings.json` decide.

## How it is put together

The root is two columns: a fixed 268 px `sidebar` and the `work` column. Inside
the sidebar, `agents` and `terminals` share the height by weight over a 32 px
`sidebar-footer`. The work column shows the active tab as cards, with a hidden
368 px `files`/`changes` panel. Two `handle` blocks float on the side edges.

The ids matter: mods find their places by id (`sidebar`, `agents`, `terminals`,
`sidebar-footer`, `main`, `panel`, `panel-body`, `work-body`), so renaming a node
breaks the panels. `RECIPE.md` lists them and everything else a rebuild needs.

## Publishing

This is a layout bundle, listed at herdr.dev/layouts by its `herdr-layout` topic.
`preview.png` is a screenshot; `layouts/workspace.svg` is the drawn thumbnail.
To re-render it:

```sh
rsvg-convert -w 1416 -h 760 layouts/workspace.svg -o layouts/workspace.png
```

## Licence

MIT — see [LICENSE](LICENSE).
