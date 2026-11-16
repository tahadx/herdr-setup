# Bindings

Every key this setup binds, what it does, and the file itself. Bindings are
written the way `keys.json` writes them: lowercase modifiers, joined with `-`
(`ctrl-shift-x`, `alt-1`). Herdr's keys sheet — the keyboard icon in the sidebar
footer — lists the same bindings, searchable, inside the app.

The tables group the bindings by what they do. *This layout* is what this setup
adds for itself; `keys.json` also carries the layout's overrides for its own
session (tab and space numbers, agents, the sheet) plus the `global` and
`terminal` keys. The sections after it are keys the panels and dialogs read
themselves, only while they hold the keyboard, so they never shadow a terminal.

## Tabs

| Key | Action |
| --- | --- |
| `alt-1` / `alt-2` / `alt-3` / `alt-4` / `alt-5` / `alt-6` / `alt-7` / `alt-8` / `alt-9` | Show the tab in that position |
| `ctrl-pagedown` / `ctrl-tab` / `alt-]` | Show the next tab |
| `ctrl-pageup` / `ctrl-shift-tab` / `alt-[` | Show the previous tab |
| `ctrl-shift-t` | Make a tab |
| `ctrl-shift-w` | Close the tab |
| `f2` | Rename the tab |

## Spaces and agents

| Key | Action |
| --- | --- |
| `ctrl-1` / `ctrl-2` / `ctrl-3` / `ctrl-4` / `ctrl-5` / `ctrl-6` / `ctrl-7` / `ctrl-8` / `ctrl-9` | Show the space in that position |
| `ctrl-shift-pagedown` / `alt-down` | Show the next space |
| `ctrl-shift-pageup` / `alt-up` | Show the previous space |
| `ctrl-shift-n` | Make a space |
| `shift-f2` | Rename the space |
| `alt-shift-up` | Show the previous agent |
| `alt-shift-down` | Show the next agent |

## Panes

| Key | Action |
| --- | --- |
| `alt-h` / `alt-left` | Focus the pane to the left |
| `alt-j` | Focus the pane below |
| `alt-k` | Focus the pane above |
| `alt-l` / `alt-right` | Focus the pane to the right |
| `alt-shift-h` | Swap the pane with the one to the left |
| `alt-shift-j` | Swap the pane with the one below |
| `alt-shift-k` | Swap the pane with the one above |
| `alt-shift-l` | Swap the pane with the one to the right |
| `ctrl-shift-o` / `alt-shift-enter` | Split the pane to the right |
| `ctrl-shift-e` / `alt-enter` | Split the pane down |
| `ctrl-shift-x` / `alt-escape` | Close the pane |
| `ctrl-shift-z` | Zoom the pane, or all of them again |

## Layout and the app

| Key | Action |
| --- | --- |
| `ctrl-shift-l` | Show the next layout |
| `ctrl-shift-p` | The command palette |
| `alt-f` | Find: spaces, agents, worktrees and branches |
| `ctrl-?` / `ctrl-shift-/` / `ctrl-shift-?` | The keys sheet |
| `ctrl-,` | Settings |
| `ctrl-+` / `ctrl-=` | Bigger |
| `ctrl--` | Smaller |
| `ctrl-0` | Back to normal size |
| `ctrl-q` | Close the dialog or popup on top |

## This layout

| Key | Action |
| --- | --- |
| `ctrl-j` / `ctrl-k` | Move to the pane below or above — or walk the search sheet or the sidebar while it has the keyboard |
| `ctrl-shift-b` | Collapse the sidebar to the rail, or expand it again |
| `ctrl-shift-m` | Move the sidebar to the other side |
| `ctrl-shift-d` | Make a worktree in the active space's repo |
| `alt-b` | Put the keyboard in the sidebar, and back |
| `alt-shift-n` | Make a space |
| `alt-shift-q` | Close the active space |
| `alt-w` | Make a worktree |
| `alt-shift-w` | Open one of the repo's worktrees |
| `alt-shift-r` | Remove a worktree |
| `ctrl-shift-x` | Close this pane (this layout's own, not Herdr's) |
| `ctrl-shift-w` | Close this tab (this layout's own, not Herdr's) |

## The terminal

| Key | Action |
| --- | --- |
| `ctrl-shift-c` | Copy the selection |
| `ctrl-shift-v` | Paste |
| `ctrl-v` | Paste an image as a file |
| `ctrl-insert` | Copy the selection |
| `shift-insert` | Paste |
| `ctrl-shift-f` | Find in the terminal's screen and scrollback |
| `ctrl-left` | Back one word |
| `ctrl-right` | Forward one word |
| `ctrl-backspace` | Delete the word behind the caret |
| `ctrl-q` | Send Ctrl+Q to the program |

## The sidebar, with its keyboard

| Key | Action |
| --- | --- |
| `ctrl-j` / `ctrl-k` | Walk the rows (Up and Down do the same) |
| `home` | The first row |
| `end` | The last row |
| `enter` | Go there: show the space, focus the agent, open the checkout |
| `ctrl-d` | Close the space, stop the agent, or remove the worktree (asks first) |
| `ctrl-p` | Pin or unpin the space |
| `ctrl-r` | Rename the space |
| `ctrl-a` | Make a worktree of the row's repo |
| `ctrl-shift-j` | Move the space a row down (hold to keep moving) |
| `ctrl-shift-k` | Move the space a row up (hold to keep moving) |
| `n` | Make a space |
| `g` | Open one of the repo's worktrees |
| `f` | Fold or unfold the row |
| `escape` | Leave: the keyboard goes back to the pane |

## The search sheet

| Key | Action |
| --- | --- |
| `ctrl-j` / `ctrl-k` | Walk the rows |
| `enter` | Go there |
| `ctrl-a` | Make a worktree of the row's repo |
| `ctrl-p` | Pin or unpin the space |
| `ctrl-r` | Rename the space |
| `ctrl-d` | Close the space, stop the agent, or remove the worktree |
| `ctrl-shift-j` / `ctrl-shift-k` | Move the space down or up |
| `ctrl-backspace` | Delete the word behind the caret |
| `escape` | Close the sheet |

## Dialogs and popups

| Key | Action |
| --- | --- |
| `enter` | Confirm the dialog's action |
| `escape` | Close the dialog or popup |
| `up` / `down` | Walk the worktree picker's checkouts |

## The file

Copy this into `~/.config/herdr-app/keys.json`, or run `install.sh`, which keeps
your other sections and merges this layout's. The three sections are `global`,
`layout:workspace` and `terminal`, in the order Herdr reads them.

```json
{
  "global": {
    "alt-1": "tab.select:1",
    "alt-2": "tab.select:2",
    "alt-3": "tab.select:3",
    "alt-4": "tab.select:4",
    "alt-5": "tab.select:5",
    "alt-6": "tab.select:6",
    "alt-7": "tab.select:7",
    "alt-8": "tab.select:8",
    "alt-9": "tab.select:9",
    "alt-h": "pane.go:left",
    "alt-j": "pane.go:down",
    "alt-k": "pane.go:up",
    "alt-l": "pane.go:right",
    "alt-left": "pane.go:left",
    "alt-right": "pane.go:right",
    "alt-shift-h": "pane.swap:left",
    "alt-shift-j": "pane.swap:down",
    "alt-shift-k": "pane.swap:up",
    "alt-shift-l": "pane.swap:right",
    "ctrl-+": "app.zoom_in",
    "ctrl--": "app.zoom_out",
    "ctrl-0": "app.zoom_reset",
    "ctrl-=": "app.zoom_in",
    "ctrl-1": "space.select:1",
    "ctrl-2": "space.select:2",
    "ctrl-3": "space.select:3",
    "ctrl-4": "space.select:4",
    "ctrl-5": "space.select:5",
    "ctrl-6": "space.select:6",
    "ctrl-7": "space.select:7",
    "ctrl-8": "space.select:8",
    "ctrl-9": "space.select:9",
    "ctrl-pagedown": "tab.next",
    "ctrl-pageup": "tab.prev",
    "ctrl-tab": "tab.next",
    "ctrl-shift-tab": "tab.prev",
    "alt-]": "tab.next",
    "alt-[": "tab.prev",
    "ctrl-shift-pagedown": "space.next",
    "ctrl-shift-pageup": "space.prev",
    "alt-down": "space.next",
    "alt-up": "space.prev",
    "ctrl-?": "app.help",
    "ctrl-shift-/": "app.help",
    "ctrl-shift-?": "app.help",
    "ctrl-shift-n": "space.new",
    "ctrl-shift-t": "tab.new",
    "alt-f": "mod.open:agents-list",
    "ctrl-shift-p": "app.palette",
    "ctrl-,": "app.settings",
    "ctrl-shift-o": "pane.split:right",
    "ctrl-shift-e": "pane.split:down",
    "ctrl-shift-w": "tab.close",
    "ctrl-shift-x": "pane.close",
    "ctrl-shift-z": "pane.zoom",
    "ctrl-shift-l": "layout.switch",
    "f2": "tab.rename",
    "shift-f2": "space.rename",
    "alt-shift-up": "agent.prev",
    "alt-shift-down": "agent.next",
    "alt-enter": "pane.split:down",
    "alt-shift-enter": "pane.split:right",
    "alt-escape": "pane.close",
    "ctrl-q": "overlay.close"
  },
  "layout:workspace": {
    "alt-1": "tab.select:1",
    "alt-2": "tab.select:2",
    "alt-3": "tab.select:3",
    "alt-4": "tab.select:4",
    "alt-5": "tab.select:5",
    "alt-6": "tab.select:6",
    "alt-7": "tab.select:7",
    "alt-8": "tab.select:8",
    "alt-9": "tab.select:9",
    "ctrl-1": "space.select:1",
    "ctrl-2": "space.select:2",
    "ctrl-3": "space.select:3",
    "ctrl-4": "space.select:4",
    "ctrl-5": "space.select:5",
    "ctrl-6": "space.select:6",
    "ctrl-7": "space.select:7",
    "ctrl-8": "space.select:8",
    "ctrl-9": "space.select:9",
    "alt-down": "space.next",
    "alt-up": "space.prev",
    "alt-shift-up": "agent.prev",
    "alt-shift-down": "agent.next",
    "alt-f": "mod.open:agents-list",
    "alt-enter": "pane.split:down",
    "alt-shift-enter": "pane.split:right",
    "alt-escape": "pane.close",
    "ctrl-j": "agents-list.dir_down",
    "ctrl-k": "agents-list.dir_up",
    "ctrl-shift-x": "agents-list.close_pane",
    "ctrl-shift-w": "agents-list.close_tab",
    "ctrl-shift-m": "agents-list.flip_layout",
    "ctrl-shift-d": "agents-list.worktree_new",
    "ctrl-shift-b": "agents-list.toggle_sidebar",
    "alt-b": "agents-list.focus_sidebar",
    "alt-shift-n": "agents-list.new_space",
    "alt-shift-q": "agents-list.close_space",
    "alt-w": "agents-list.worktree_new",
    "alt-shift-w": "agents-list.worktree_open",
    "alt-shift-r": "agents-list.worktree_remove"
  },
  "terminal": {
    "ctrl-backspace": "send:\u0017",
    "ctrl-left": "send:\u001bb",
    "ctrl-right": "send:\u001bf",
    "ctrl-shift-c": "terminal.copy",
    "ctrl-shift-v": "terminal.paste",
    "ctrl-shift-f": "terminal.search",
    "ctrl-v": "terminal.paste_image",
    "ctrl-insert": "terminal.copy",
    "shift-insert": "terminal.paste",
    "ctrl-q": "send:\u0011"
  }
}
```
