# Herdr Workspace

A keyboard-driven [Herdr](https://herdr.dev) layout: every agent and terminal in
one sidebar, one find sheet over everything, and no tab bar.

![Herdr Workspace](preview.png?v=3)

## What you get

- **One sidebar, no tab bar.** `AGENTS` above `TERMINALS`, pinned places that
  keep their slot, worktrees nested under their repo, and a rail of avatars when
  the sidebar is narrow.
- **One find sheet, `Alt+F`.** Spaces, worktrees and agents in one tree; typing
  matches names, branches, folders, titles and states.
- **Worktrees from the sidebar.** New, open and remove in dialogs; the checkout
  is a space under its repo, and removing it closes that space.
- **Panes as cards.** 10 px cards with an accent border on the focused pane, no
  title bar, the footer drags the window, and focus follows the pointer.
- **A bar of its own.** A thin accent scrollbar when a list overflows — no
  track, a little wider under the pointer.

## Install

Herdr **0.1.15+** and `git`; the machine list uses `hc`, which ships with Herdr.

```sh
git clone https://github.com/tahadx/workspace.git
cd workspace
./install.sh
herdr-app do layout.switch --name workspace
```

`install.sh` copies the layout, its nine mods and its theme into
`~/.config/herdr-app`, then merges this layout's keys into `keys.json`, adding
only the bindings your file is missing. `HERDR_APP_HOME` installs elsewhere.

## Keys

`Ctrl+Shift+B` folds the sidebar to its rail, `Alt+B` puts the keyboard in it,
`Alt+F` opens the find sheet. Every binding is in
[docs/bindings.md](docs/bindings.md).

## Theme

`themes/omarchy.json` is the palette it is drawn for; any theme works by
pointing the layout's `theme` at a name in `themes/`.

## More

`RECIPE.md` is the brief another agent can rebuild it from, and
`layouts/workspace.json` is the window. The checks are
`node tests/*.test.mjs` and `herdr-app check mods/<name>`. Listed at
[herdr.dev/layouts/tahadx/workspace](https://herdr.dev/layouts/tahadx/workspace).
MIT — see [LICENSE](LICENSE).
