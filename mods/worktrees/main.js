// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { branch, tab, argv }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, agents, exec, home, setShared, shared, layout, window } from "herdr";

const wash = (c, a = "14") => (/^#[0-9a-fA-F]{6}$/.test(c ?? "") ? c + a : c);

// A pin protects the space it names, and only that space: the close dialog
// refuses it, but a worktree removal still deletes the checkout and stopping an
// agent still ends the agent. A pinned space standing in a checkout that goes
// stays behind (its folder is gone, the space is not). A pin names its space by
// id, or — pins saved before ids — by its machine and folder.
const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const pinnedList = () => (Array.isArray(shared("spaces.pinned")) ? shared("spaces.pinned") : []);
const isPinned = (s) => Boolean(s?.id) && pinnedList().some((p) => (p.id
  ? p.id === s.id
  : (p.machine ?? null) === (s.machine ?? null) && norm(p.folder) === norm(s.folder)));
// Checkouts on their way out. One is hidden the moment the person confirms,
// before git has done any work: removing a big checkout can take a while, and
// the row must not sit there as if nothing happened. The sidebar runs the
// removal and clears the entry when git is done; five minutes is only a safety
// net for an entry left behind by a crash.
const REMOVING = "worktree.removing";
const removing = () => {
  const list = shared(REMOVING);
  if (!Array.isArray(list)) return [];
  const since = Date.now() - 5 * 60_000;
  return list.filter((r) => (r.at ?? 0) > since);
};
// Whether a layout shows a mod anywhere: a block nested in a column counts.
function shownBy(node, mod) {
  if (node?.content?.mod === mod) return true;
  return (node?.children ?? []).some((child) => shownBy(child, mod));
}

const keycap = (t, label) => div().flex_none().h(18).px(5).rounded(4)
  .bg(wash(t.foreground, "0a")).border(1).border_color(wash(t.foreground, "0e"))
  .text_size(9.5).font_medium().text_color(t.dim).flex().items_center().child(label);

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>.
const ROOT = (home) => `${home}/.herdr/worktrees`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it, or it was made in it
// (a shell that cd'd out of its worktree is still the space standing there). The
// deepest checkout wins.
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    const made = (s.folder ?? "").replace(/\\/g, "/");
    const here = at && inside(at, path) ? at : made && inside(made, path) ? made : null;
    if (!here) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(here, c.path));
  })());
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.busy = false;
    this.error = "";
    // Stopping an agent reads nothing: there is no repo, folder or branch in it.
    this.handle = cx.focus_handle();
    if (props()?.agent) {
      this.handle.focus();
      cx.timer.after(80, () => this.handle.focus());
      return;
    }
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.opened = false;
    this.text = props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    // Enter in the filter opens the highlighted checkout; in every other
    // dialog it confirms. (Submitting the filter used to fall through to
    // go(), which creates a worktree named after the query.)
    this.input.on("submit", (_e, cx) => {
      if (this.opening) this.open(this.shown()[this.at]);
      else this.go(cx);
    });
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    const typing = !["remove", "space"].includes(props()?.action);
    if (typing) {
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.mods = 0; // submodules found, so a removal knows whether to force
    this.unpushed = [];
    this.detail = ""; // a removal done here, in place of the dialog's own line
    this.handle = cx.focus_handle();
    if (!typing) this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          const sub = await submodules(repo.top, this.on);
          this.mods = sub.mods.length;
          this.unpushed = sub.unpushed;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        this.repo = repo;
        cx.notify();
        if (props().branch) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  // Every space standing in this checkout. props.space is a menu's hint, never
  // proof: a space whose shell has cd'd away must not be closed for a checkout
  // it no longer sits in. There can be more than one, and one may be pinned.
  spacesIn(top) {
    const dir = norm(top);
    if (!dir) return [];
    const inside = (p) => p === dir || p.startsWith(`${dir}/`);
    return spaces().filter((s) => (s.machine ?? null) === (this.on ?? null) && inside(norm(place(s))));
  }

  // Whether ending this agent would take its space with it: one tab, and that
  // tab's only terminal. Ending the agent then closes the space, which is never
  // what "stop this agent" should mean.
  alone(a) {
    const s = spaces().find((x) => x.id === a?.space) ?? null;
    const tabs = s?.tabs ?? [];
    const last = Boolean(s) && tabs.length <= 1 && panes().filter((p) => p.tab === tabs[0]?.id && p.terminal).length <= 1;
    return { s, last };
  }

  close() {
    closeOverlay(props().overlay);
    // The panel underneath is still open and needs its keyboard back.
    setShared("overlay.closed", Date.now());
  }

  go(cx) {
    if (this.busy) return;
    if (props()?.agent) return this.stop();
    if (props()?.action === "space") return this.removeSpace(cx);
    if (!this.repo) return;
    // Asked and answered: a removal changes the list now and lets git follow.
    if (props().action === "remove") return this.removeNow(cx);
    cx.spawn(async (cx) => this.work(cx));
  }

  // Confirmed: the agent's terminal ends. Its pane if it has one, else the
  // terminal; the space and its other terminals stay. In a pinned space that
  // has nothing else in it, a shell opens first, so closing the last pane
  // cannot take the space with it.
  stop() {
    const a = agents().find((x) => x.address === props()?.agent);
    if (a) {
      // Where the agent is the only thing in its space, a shell opens there
      // first: ending an agent must not take the space with it.
      const { s, last } = this.alone(a);
      if (s && last) run("tab.new", { space: s.id });
      if (a.pane) run("pane.close", { pane: a.pane });
      else run("terminal.kill", { terminal: a.address });
    }
    this.close();
  }

  // Confirmed: the space's terminals end; the folder and branches stay.
  // The space goes for real, and so does its pin: closing it and leaving a pin
  // row behind would only offer to rebuild what you just removed.
  removeSpace(cx) {
    const s = this.space();
    if (isPinned(s)) {
      this.error = "This space is pinned. Unpin it (sidebar or Alt+F), then close it.";
      cx?.notify();
      return;
    }
    if (s?.id) { this.dropPins(s); run("space.close", { id: s.id, confirmed: true }); }
    this.close();
  }

  // Pin list once the given spaces are gone and (with git done) the checkout at
  // `path` is too. A pin whose space still exists stays, even in a folder that
  // no longer does: that is how a pinned space survives a worktree removal. A
  // pin with another id is another space and stays, even in a shared folder; a
  // pin with no id (saved before pins had ids) falls back to the folder and only
  // goes when no space is left there.
  pinsAfter(gone, path) {
    const pins = shared("spaces.pinned");
    if (!Array.isArray(pins) || !pins.length) return null;
    const norm = (p) => (p ?? "").replace(/\/+$/, "");
    const key = (x) => `${x?.machine ?? ""}\u0000${norm(x?.folder)}`;
    const live = spaces();
    const ids = new Set(gone.filter(Boolean).map((s) => s.id).filter(Boolean));
    const top = path ? norm(path) : null;
    const inside = (p) => Boolean(top) && (norm(p.folder) === top || norm(p.folder).startsWith(`${top}/`));
    // A space that is going does not keep its own pin alive.
    const survives = (p) => (p.id
      ? live.some((x) => x.id === p.id && !ids.has(x.id))
      : live.some((x) => key(x) === key(p) && !ids.has(x.id)));
    return pins.filter((p) => {
      if (p.id && ids.has(p.id)) return false;
      if (inside(p)) return survives(p);
      if (p.id) return true;
      return !gone.some((s) => key(p) === key(s) && !live.some((x) => !ids.has(x.id) && key(x) === key(s)));
    });
  }

  // The pins of what is going away, applied. See pinsAfter.
  dropPins(space, path) {
    const pins = shared("spaces.pinned");
    if (!Array.isArray(pins) || !pins.length) return;
    const next = this.pinsAfter(space ? [space] : [], path);
    if (next && next.length !== pins.length) {
      console.log(`worktrees: dropped ${pins.length - next.length} pin(s) (${pins.length} -> ${next.length})`);
      setShared("spaces.pinned", next);
    }
  }

  // Confirmed: the checkout leaves the list at once, and git runs behind it. The
  // job goes to the sidebar, which stays when this dialog closes — a dialog's
  // tasks end with it, so doing git here would hold the dialog open for as long
  // as the removal took. What was checked here is what is applied: the spaces to
  // close, whether git needs --force, and the pins that survive.
  removeNow(cx) {
    const r = this.repo;
    if (!r?.linked) return; // the dialog never offers this
    const closing = this.spacesIn(r.top).filter((s) => !isPinned(s));
    const at = Date.now();
    const job = {
      at,
      top: r.top,
      main: r.main,
      on: this.on ?? null,
      force: this.dirty || this.mods > 0,
      spaces: closing.map((s) => s.id).filter(Boolean),
      pins: this.pinsAfter(closing, r.top),
    };
    setShared(REMOVING, [...removing(), { path: r.top, machine: this.on ?? null, at }]);
    // A layout without the sidebar has nobody to take the job, so this dialog
    // stays and runs it. The checkout is hidden either way.
    if (!shownBy(layout(), "agents-list")) return cx.spawn(async (cx) => this.workJob(job, cx));
    const queued = shared("worktree.jobs");
    setShared("worktree.jobs", [...(Array.isArray(queued) ? queued : []), job]);
    setShared("worktree.job", job);
    this.close();
  }

  // The removal, done here: only when there is no panel to hand it to. Windows
  // closes the spaces first, because a live shell keeps the folder busy there;
  // everywhere else git runs first, so a failure leaves them exactly as they were.
  async workJob(job, cx) {
    this.busy = true;
    this.detail = `Removing ${tilde(job.top, this.userHome ?? "")}…`;
    cx.notify();
    const closeSpaces = () => {
      for (const id of job.spaces ?? []) run("space.close", { id, confirmed: true });
    };
    const windows = window()?.platform === "windows";
    if (windows) closeSpaces();
    const r = await git(job.main, ["worktree", "remove", ...(job.force ? ["--force"] : []), job.top], job.on, 600_000);
    if (!r.ok) {
      this.busy = false;
      this.detail = "";
      this.error = r.err || "git worktree remove failed.";
      setShared(REMOVING, removing().filter((x) => !(norm(x.path) === norm(job.top) && (x.machine ?? null) === job.on)));
      cx.notify();
      return;
    }
    if (!windows) closeSpaces();
    if (Array.isArray(job.pins)) setShared("spaces.pinned", job.pins);
    setShared(REMOVING, removing().filter((x) => !(norm(x.path) === norm(job.top) && (x.machine ?? null) === job.on)));
    this.busy = false;
    this.close();
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create() {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`;
    const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
    const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
    const r = await git(this.repo.top, add, this.on, 600_000);
    if (!r.ok) return r.err || "git worktree add failed.";
    // Created only: the checkout shows as a child of its repo, and opening it
    // (from that tree) is what starts a space, so creating one never adds a space.
    // The panel underneath re-reads its worktrees and selects this one.
    setShared("worktree.created", path);
    setShared("worktree.createdAt", Date.now());
    return "";
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c || this.opened) return;
    this.opened = true;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    // Name the space after the checkout: Herdr names an unnamed space after its
    // shell's live folder, so a `cd` would rename the worktree out from under it.
    const name = c.branch ?? c.path.split("/").pop();
    // "" is this computer. null would be omitted, and the space would open on
    // whichever machine the focused space belongs to.
    if (!s) return run("space.new", { folder: c.path, name, machine: this.on ?? "" });
    // A space with no terminal left (no tabs, or only mod panes) opens a shell.
    const tabs = new Set((s.tabs ?? []).map((t2) => t2.id));
    run("space.select", { id: s.id });
    if (!panes().some((p) => p.terminal && tabs.has(p.tab))) {
      run("tab.new", { space: s.id, folder: place(s) ?? s.folder });
    }
  }

  // true when the dialog took the key, so it doesn't also reach the panel below.
  key(e, cx) {
    if (e.key === "escape" || (e.modifiers.control && e.key === "q")) {
      this.close();
      return true;
    }
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return false;
      cx.notify();
      return true;
    }
    if (e.key === "enter") {
      this.go(cx);
      return true;
    }
    return false;
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(46)
        .px(10)
        .justify_center()
        .rounded(8)
        .cursor_pointer()
        .when(on, (el) => el.bg(wash(t.accent, "16")))
        .when(!on, (el) => el.hover((s) => s.bg(wash(t.foreground, "0b"))))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().px(5).h(16).rounded(4).bg(wash(t.accent, "18")).text_size(9.5).text_color(t.accent).flex().items_center().child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(10).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (this.key(e, cx)) cx.stop_propagation(); })
      .size_full()
      .p(18)
      .gap(11)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().gap(9).items_center()
        .child(div().size(26).flex_none().rounded(8).bg(wash(t.accent, "16")).flex().items_center().justify_center()
          .child(svg("mods/workspace-chrome/branch.svg").size(14).text_color(t.accent)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`))
          .when(Boolean(r), (el) => el.child(div().text_size(10).text_color(t.dim).child(count)))))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(34).px(11).items_center().rounded(8)
            .border(1).border_color(this.inputFocused ? wash(t.accent, "88") : wash(t.border, "88")).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().gap(11).items_center().text_size(10).text_color(t.dim)
        .child(h_flex().gap(5).items_center().child(keycap(t, "↑↓")).child(div().child("choose")))
        .child(h_flex().gap(5).items_center().child(keycap(t, "↵")).child(div().child("open")))
        .child(h_flex().gap(5).items_center().child(keycap(t, "esc")).child(div().child("close"))));
  }

  renderStop(t) {
    const a = agents().find((x) => x.address === props()?.agent) ?? null;
    const { s: home, last } = this.alone(a);
    const name = a?.title || a?.program?.name || a?.app || props()?.agent || "this agent";
    const state = a?.status === "working" ? "It is still working: that work and the conversation end with the terminal."
      : a?.status === "blocked" ? "It is waiting on you, and that question goes with it."
      : a?.status === "done" ? "It finished; its report goes with the terminal."
      : "It is idle; the conversation ends with the terminal.";
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (this.key(e, cx)) cx.stop_propagation(); })
      .size_full()
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(12.5)
      .child(h_flex().gap(9).items_center()
        .child(div().size(26).flex_none().rounded(8).bg(wash(t.blocked, "16")).flex().items_center().justify_center()
          .child(svg("mods/icons/x.svg").size(13).text_color(t.blocked)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13.5).text_color(t.foreground).child(`Stop agent ${name}?`)))
      .child(div().text_size(11.5).text_color(t.muted).child(state))
      .child(div().text_size(11.5).text_color(t.muted)
        .child(last && home
          ? `It is the only terminal in ${home.name}: a shell opens in its place, so the space stays.`
          : "The space and its other terminals stay."))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(11).items_center()
        .child(keycap(t, "\u21b5"))
        .child(div().text_size(10).text_color(t.dim).child("stop"))
        .child(keycap(t, "esc"))
        .child(div().text_size(10).text_color(t.dim).child("cancel")));
  }

  render(cx) {
    const t = theme();
    if (props()?.agent) return this.renderStop(t);
    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove";
    const closeSpace = props()?.action === "space";
    const s = this.space();
    const r = this.repo;
    // A removal ends the spaces standing in that checkout, and only those, and
    // never a pinned one. props.space says which space a menu meant; it is not
    // proof that a space still lives there, and the text must not claim one if
    // none does.
    const inside = remove && r?.linked ? this.spacesIn(r.top) : [];
    const closing = inside.filter((x) => !isPinned(x));
    const staying = inside.filter((x) => isPinned(x));
    const pinnedSpace = closeSpace && isPinned(s) ? s : null;
    const spacesNamed = (list) => (list.length === 1
      ? `the space ${list[0].name}`
      : `the spaces ${list.slice(0, -1).map((x) => x.name).join(", ")} and ${list.at(-1).name}`);
    // An unopened checkout has no space: name it after its folder.
    const name = s?.name || (r ? r.top.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "");
    const title = pinnedSpace ? `Space ${name} is pinned`
      : closeSpace ? `Remove space ${name}?`
      : remove ? `Remove worktree ${name}?`
      : `New worktree${r ? ` of ${r.name}` : ""}`;
    const stayingNote = staying.length
      ? ` Pinned ${staying.length === 1 ? `space ${staying[0].name} stays` : `spaces ${staying.map((x) => x.name).join(", ")} stay`}: the checkout goes, the space does not.`
      : "";
    const detail =
      pinnedSpace
        ? "Pinned spaces are never closed — not when you leave them, not when their folder goes. Unpin it first, then close it."
        : closeSpace
        ? "Ends its terminals and closes the space. The folder and branches stay."
        : r === undefined
        ? "…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : `${closing.length ? `Closes ${spacesNamed(closing)} and deletes` : "Deletes"} ${tilde(r.top, this.userHome)}. The branch stays.${stayingNote}`
            : `A new checkout in ${tilde(ROOT(this.userHome), this.userHome)}/${r.name}/. An existing branch is checked out; a new name starts from here.`;
    const blocked = Boolean(pinnedSpace) || (!closeSpace && (!r || (remove && !r.linked)));
    const warn = remove || Boolean(pinnedSpace);
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (this.key(e, cx)) cx.stop_propagation(); })
      .size_full()
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(12.5)
      .child(h_flex().gap(9).items_center()
        .child(div().size(26).flex_none().rounded(8)
          .bg(warn ? wash(t.blocked, "16") : wash(t.accent, "16")).flex().items_center().justify_center()
          .child(svg("mods/workspace-chrome/branch.svg").size(14).text_color(warn ? t.blocked : t.accent)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13.5).text_color(t.foreground).child(title)))
      .child(div().text_size(11.5).text_color(t.muted).child(this.detail || detail))
      .when(remove && this.dirty, (el) => el.child(div().px(8).py(6).rounded(6).bg(wash(t.blocked, "12")).text_size(10.5).text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
      .when(remove && this.unpushed.length > 0, (el) => el.child(div().px(8).py(6).rounded(6).bg(wash(t.blocked, "12")).text_size(10.5).text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
      .when(!remove && !closeSpace && !blocked, (el) =>
        el.child(
          Input.new(this.input)
            .h(34)
            .px(11)
            .items_center()
            .rounded(8)
            .border(1)
            .border_color(this.inputFocused ? wash(t.accent, "88") : wash(t.border, "88"))
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().px(8).py(6).rounded(6).bg(wash(t.blocked, "12")).text_size(10.5).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .gap(11)
          .items_center()
          .when(this.busy, (el) => el.child(h_flex().gap(6).items_center().text_size(10.5).text_color(t.dim)
            .child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
            .child("working…")))
          .when(!this.busy && blocked, (el) => el.child(h_flex().gap(5).items_center()
            .child(keycap(t, "esc")).child(div().text_size(10).text_color(t.dim).child("close"))))
          .when(!this.busy && !blocked, (el) => el.child(h_flex().gap(5).items_center()
            .child(keycap(t, "↵"))
            .child(div().text_size(10).text_color(t.dim).child(remove || closeSpace ? "remove" : "create"))
            .child(keycap(t, "esc"))
            .child(div().text_size(10).text_color(t.dim).child("cancel")))),
      );
  }
}
