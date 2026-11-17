# Herdr Workspace

A [Herdr](https://herdr.dev) window with no tab bar, driven entirely from the
keyboard: every action has a key, from anywhere in the window.

![Herdr Workspace](preview.png?v=3)

## The search sheet — `Alt+F`

**One tree over everything.** Pinned places, spaces, worktrees nested under the
repo they belong to, agents with the sub-agents they started under them. The
header counts the tree and chips what needs you, what is working, what is done.

**Found by what you remember.** Typing matches names, branches, folders, tab
titles and states at once, so `web hotfix` finds a space and its checkout and
`needs you` finds what is waiting. A matched space brings its agents and
worktrees with it; a matched agent can be reached through its space.

**It acts, not just jumps.** `↑`/`↓` or `Ctrl+J`/`Ctrl+K` walk, `Enter` switches
to a space, focuses an agent, opens a checkout or a pin's shell. Then `Ctrl+P`
pins the place, `Ctrl+R` renames it, `Ctrl+Shift+J`/`Ctrl+Shift+K` move the
space a row, `Ctrl+A` starts a worktree from it, `Ctrl+D` closes the space,
stops the agent or removes the checkout. `Esc` or `Alt+F` closes the sheet.

## Pins

`Ctrl+P` in the sheet or the sidebar pins the place under the row. A pinned
place keeps its line above the spaces: no dialog closes it, a shell exiting
leaves the row with its checkouts under it, and opening it again comes back to
the same slot. A pin opens its own space by id and falls back to its folder
only when that space is gone. `Ctrl+P` again unpins it.

## The sidebar

The upgraded sidebar: `AGENTS` above `TERMINALS` in one 223 px column — drag
its edge between 44 and 480 px.

- **Agents, by what they need.** Groups run Needs you → Done → Working → Idle,
  each with a count and a chevron that folds it; the sort button also offers
  *Grouped by space* and *Spaces with agents*. Rows carry the program's mark,
  the agent's name, its space, how long it has been in that state and a status
  mark, and a sub-agent sits under the agent that started it. Other machines
  get their own foldable header with its connection state, and a machine that
  needs a login says the command to run.
- **Terminals.** Every terminal of the shown space with its program's mark, its
  title, the tab it lives in when there is more than one, and a status dot.
  `Files` and `Changes` open those panels; `+` starts a tab.
- **Worktrees.** Nested under their repo with branch, ahead/behind and
  uncommitted marks; the row's menu makes, opens and removes them.
- **Pins first**, then the rest. Click a row to go there, right-click for its
  menu.
- **A bar of its own.** When a list outgrows its box, a 3 px accent thumb runs
  down its edge — no track, 4 px under the pointer — and the keyboard keeps its
  row on screen.

**The compact rail.** `Ctrl+Shift+B`, or dragging the sidebar below 160 px,
folds the whole column to a 44 px rail of icons: a chevron to open it again,
then one 26 px
avatar per place in the list's own order, pinned first. Each avatar carries its
state mark in the corner — a spinner while working, `!` when it needs you, a
filled dot when done, a ring when idle — and the active place is lit. Past nine
places an ellipsis opens the sidebar again; `Ctrl+1`…`Ctrl+9` reach the first
nine; a right-click gives the sidebar's menu.

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
`Alt+F` opens the search sheet. Every binding is in
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
