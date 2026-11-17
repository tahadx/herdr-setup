// The keys both views share: Shift has to be read before plain Ctrl.
//
// The bug this guards against: the plain Ctrl+J/K branch sat above the
// Ctrl+Shift+J/K pair and never asked about Shift, so the reorder keys were
// unreachable — pressing them walked the highlight, which looks like nothing
// happened. The order of two branches in a long else-if chain is invisible in
// review and invisible to every other test, and it costs a person their keys.
//
// Now the map lives once, in workspace-engine.js, and both views call it. A view that wrote
// its own map again — the thing this test exists for — is caught here too.
//
//   node tests/keys.test.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PALETTE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const core = read("mods/agents-list/workspace-engine.js");
const palette = read("mods/agents-list/palette.js");
const side = read("mods/agents-list/sidebar.js");
const foot = read("mods/footer/main.js");
const sheet = read("mods/shortcuts/main.js");
const bindings = JSON.parse(read("keys.json"));

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

// The shared key map: Shift must be asked first.
const at = (needle) => core.indexOf(needle);
const shiftBranch = at('if (m.shift && (k === "j" || k === "k"))');
const walkBranch = at('if (k === "j" || k === "k")');
const pin = at('if (k === "p")');
const rename = at('if (k === "r")');
const close = at('if (k === "d")');
const worktree = at('if (k === "a")');
check("Ctrl+Shift+J/K reorders", shiftBranch > 0);
check("the plain Ctrl+J/K branch comes after it", walkBranch > 0 && shiftBranch < walkBranch,
  "Ctrl+Shift+J/K would be swallowed by the Ctrl+J/K branch");
check("the reorder branch calls beginReorder", /if \(m\.shift[\s\S]{0,420}this\.beginReorder\(/.test(core));
// The OS key repeat is not a second source of steps: `startReorder` repeats the
// held step itself, and counting both made a held key move two rows at a time.
check("a held key does not step twice per repeat", /if \(!e\.is_held\) this\.beginReorder\(/.test(core));
check("the walk branch calls walk", /if \(k === "j" \|\| k === "k"\)[\s\S]{0,80}this\.walk\(/.test(core));
check("the sheet's other chords are in the shared map",
  pin > 0 && rename > 0 && close > 0 && worktree > 0);
check("the shared map is one function, used by both views",
  /this\.chord\(e, cx\)/.test(palette) && /this\.chord\(e, cx\)/.test(side));
check("a shifted Ctrl chord other than J/K is left to the app",
  /if \(m\.shift\) return false;/.test(core),
  "Ctrl+Shift+P and Ctrl+Shift+D would be swallowed by the panel");

// The sheet's key handler runs the shared map before its typing branches.
const sheetChord = palette.indexOf("if (this.chord(e, cx))");
const sheetType = palette.indexOf('k.length === 1 && !ctrl');
check("the sheet reads the shared map before typing", sheetChord > 0 && sheetType > sheetChord);
check("typing does not take the platform chord",
  /k\.length === 1 && !ctrl && !e\.modifiers\.alt && !e\.modifiers\.platform/.test(palette),
  "Cmd+C on macOS would type a c instead of copying");

// The sidebar's plain keys are handled after its modifier return, so the shared
// map must run before that return or the chords fall through to the app.
const sideChord = side.indexOf("if (this.chord(e, cx))");
const sideReturn = side.indexOf("if (m.control || m.alt || m.platform) return;");
check("the sidebar reads the shared map before the modifier return",
  sideChord > 0 && sideReturn > 0 && sideChord < sideReturn,
  "the chords would fall through to the app");

// Ctrl+J/K, the flip, the closes and Ctrl+Shift+B are the sidebar's commands:
// the sidebar is mounted on the rail too, while the footer and the terminals
// list are put away there. The footer keeps the same hand-off for a key someone
// rebound onto it. There is no edge tab to rescue a hidden sidebar any more:
// Ctrl+Shift+B collapses it instead.
check("the sidebar gives Ctrl+J/K to itself while it has the keyboard",
  /if \(shared\("sidebar\.kb"\)\) return setShared\("sidebar\.move"/.test(side));
check("the sidebar handles the layout keys and the collapse",
  /if \(c === "flip_layout"\) return flipLayout\(\)/.test(side)
  && /if \(c === "close_pane" \|\| c === "close_tab"\) return closeFocused\(c\)/.test(side)
  && /if \(c === "toggle_sidebar"\) return toggleSidebar\(\)/.test(side));
check("the layout points the walk, the flip, the closes and the collapse at the sidebar",
  bindings["layout:workspace"]["ctrl-j"] === "agents-list.dir_down"
  && bindings["layout:workspace"]["ctrl-shift-m"] === "agents-list.flip_layout"
  && bindings["layout:workspace"]["ctrl-shift-x"] === "agents-list.close_pane"
  && bindings["layout:workspace"]["ctrl-shift-b"] === "agents-list.toggle_sidebar");
check("Ctrl+Shift+B no longer hides the sidebar",
  bindings.global?.["ctrl-shift-b"] === undefined
  && !/layout\.toggle:sidebar/.test(read("keys.json"))
  && !existsSync(join(root, "mods", "handle", "main.js")));
check("the footer still hands a rebound Ctrl+J/K to the sidebar",
  /else if \(shared\("sidebar\.kb"\)\) setShared\("sidebar\.move"/.test(foot));
check("the keys sheet drops a global binding a layout section replaces",
  /b\.section === "global" && layoutKeys\.has\(b\.keys\)/.test(sheet));
check("a sub-agent fold is painted with the theme it closes over",
  /plainFold\(t, a, subs\)/.test(side) && /this\.plainFold\(t, a, subs\)/.test(side));
check("an agent row never focuses a missing pane",
  !/pane\.focus", \{ pane: a\.pane \}/.test(side) && /this\.focusAgent\(a\)/.test(side));
check("the sidebar says where the keyboard is",
  /setShared\("sidebar\.kb", here\)/.test(side));
check("the sidebar polls for the handed-back walk only while focused",
  /watchMoves\(cx, here\)/.test(side) && /watchWalk\(cx, on, "sidebar\.move"\)/.test(side));
check("the sheet polls the same hand-off",
  /watchWalk\(cx, true, "search\.move"\)/.test(palette));

// Adding or removing a space makes Herdr focus the new terminal. The list asked
// for it, so it takes the keyboard back, in steps as the app settles.
check("a space made from the list keeps the keyboard there",
  /run\("space\.new"\); this\.reclaim\(cx\)/.test(side)
  && /if \(this\.kb\(\)\) this\.reclaim\(cx\)/.test(side));
check("the sidebar claims the keyboard again as the app settles",
  /reclaim\(cx\) \{[\s\S]{0,120}\[40, 140, 340, 700\]/.test(side));
check("a held key ends when it is let go",
  /on_key_up\(\(e\) => \{ if \(e\.key === "j" \|\| e\.key === "k"\) this\.stopReorder\(\); \}\)/.test(palette)
  && /on_key_up\(\(e\) => \{ if \(e\.key === "j" \|\| e\.key === "k"\) this\.stopReorder\(\); \}\)/.test(side));
check("a press outside the sidebar ends keyboard mode",
  /on_mouse_down_out\(\(_e, cx\) => this\.blur\(cx\)\)/.test(side));
check("a press inside it comes back",
  /on_mouse_down\("left", \(_e, cx\) => this\.touch\(cx\)\)/.test(side));
check("a blur wins over a stale focused handle",
  /if \(this\.blurred\) return false;/.test(side));
check("opening a row lets the app's own focus stand, not the pane it came from",
  /afterOpen\(cx\) \{[\s\S]{0,360}this\.release\(cx\)/.test(side)
  && !/afterOpen\(cx\) \{[\s\S]{0,120}this\.leave\(cx\)/.test(side));
check("letting go of the keyboard does not ask for a pane",
  /release\(cx\) \{[\s\S]{0,320}?\n  \}/.test(side) && !/release\(cx\) \{[\s\S]{0,260}pane\.focus/.test(side));
check("the step itself is shared, not copied into a view",
  /startReorder\(s, dir, opts, cx\)/.test(core) && !/startReorder\(s, dir, opts, cx\)/.test(palette)
  && !/startReorder\(s, dir, opts, cx\)/.test(side));

console.log(failures ? `\n${failures} key check(s) failed` : "all key checks passed");
process.exit(failures ? 1 : 0);
