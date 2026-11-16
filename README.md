# Herdr Workspace

A [Herdr](https://herdr.dev) layout driven entirely from the keyboard: every
action has a key, from anywhere in the window. `Alt+F` opens the find palette:
every space, worktree, agent and terminal in one tree, searched by name,
branch, folder, title or state, and it acts too — go, pin, rename, reorder,
close, make a space or a worktree. The sidebar is the upgraded one: pins that
keep their slot, agents grouped by what they need, every terminal's program and
status, worktrees and sub-agents nested, a thin accent scrollbar, and a compact
rail when narrow. No tab bar, no title bar; panes are cards, and focus follows
the pointer.

![Herdr Workspace](preview.png?v=3)

## What you get

- **Pins that hold their place.** `Ctrl+P` in the sidebar or the find palette; the
  line stays where you put it, and opening the space again comes back to it.
- **Worktrees from the sidebar.** New, open and remove in dialogs; the checkout
  is a space under its repo, and removing it closes that space.
- **A searchable keys sheet.** Every shortcut in one list, one row per command,
  from the keyboard icon in the footer.
- **A footer you can grab.** Machine on the left, keys and settings on the right;
  the strip itself drags the window.

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
`Alt+F` opens the find palette. Every binding is in
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
