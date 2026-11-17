// The search sheet's rows: a hit comes with what it belongs to.
//
// The failure this guards against: a branch, an agent or a worktree space that
// matched was listed as a bare row, so the same family read as unrelated places —
// and the space someone searched for could be missing from its own result.
//
//   node tests/search.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.SEARCH_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "mods/agents-list/palette.js"), "utf8");
const engine = readFileSync(join(root, "mods/agents-list/workspace-engine.js"), "utf8");

// The scoring rule is the engine's, imported by the sheet. Lift the same text
// so this test exercises the rule the two views actually rank by.
function liftEngine(name) {
  const at = engine.indexOf(`export function ${name}(`);
  if (at >= 0) {
    let depth = 0;
    for (let i = at; i < engine.length; i++) {
      if (engine[i] === "{") depth++;
      else if (engine[i] === "}" && --depth === 0) {
        return engine.slice(at, i + 1).replace(/^export /, "");
      }
    }
  }
  const line = engine.indexOf(`export const ${name} =`);
  if (line < 0) throw new Error(`workspace-engine.js: no ${name}`);
  const end = engine.indexOf(";", line) + 1;
  return engine.slice(line, end).replace(/^export /, "");
}
const termsOf = new Function(`${liftEngine("termsOf")}; return termsOf;`)();
const scoreTerms = new Function(`${liftEngine("scoreTerms")}; return scoreTerms;`)();

function method(name) {
  const at = src.indexOf(`  ${name}(`);
  if (at < 0) throw new Error(`mods/agents-list/palette.js: no method ${name}`);
  const end = src.indexOf("\n  }", at) + 4;
  return src.slice(at, end).replace(`  ${name}(`, `function ${name}(`);
}

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

const search = new Function("spaces", "agents", "pinnedList", "openSpaceFor", "place", "norm", "base", "termsOf", "scoreTerms", "pinLabel",
  `${method("search")}; return search;`);

const norm = (p) => (p ?? "").replace(/\\/g, "/");
const base = (p) => norm(p).replace(/\/+$/, "").split("/").pop() ?? "";

function rows(world, q) {
  const self = {
    worktrees: world.worktrees ?? [],
    parent: world.parent ?? new Map(),
    checkoutParent: world.checkoutParent ?? new Map(),
    filter: q,
    // The sheet hides a checkout the dialog has already taken away; that filter
    // has its own home (tests/pinned.test.mjs), so here every row is live.
    liveSpaces() { return world.spaces ?? []; },
    liveTrees() { return this.worktrees; },
    // The sheet's ordering hooks, without a persisted order: the world's own.
    kidsOf(all, id) { return all.filter((s) => this.parent.get(s.id) === id); },
    checkoutsOf(all, id) {
      return this.worktrees.filter((w) => !w.c.main && this.checkoutParent.get(`${w.on ?? ""}\u0000${w.c.path}`) === id);
    },
    // The row's name: the sheet reads a worktree's checkout, but this world has
    // none, so the space's own name is what every row shows.
    spaceName(s) { return s.name; },
    // A pin's place: the test world says what hangs under it.
    pinChildren(_p) { return { spaces: world.pinSpaces ?? [], trees: world.pinTrees ?? [] }; },
  };
  return search(() => world.spaces ?? [], () => world.agents ?? [], () => world.pins ?? [],
    () => null, (s) => s.folder, norm, base, termsOf, scoreTerms, (p) => p.name).call(self, q);
}

const repo = { id: "r", name: "kleeamp", folder: "/repo", machine: null, status: "idle" };
const wt = { id: "d", name: "desktop", folder: "/repo/desktop", machine: null, status: "working" };
const agent = { address: "t1", space: "d", space_name: "desktop", title: "Desktop via Rune", app: "opencode", status: "working" };
const checkout = { c: { path: "/repo/hotfix", branch: "hotfix", main: false }, repo: { name: "kleeamp" }, on: null };
const world = {
  spaces: [repo, wt],
  agents: [agent],
  worktrees: [checkout],
  parent: new Map([["d", "r"]]),
  checkoutParent: new Map([["\u0000/repo/hotfix", "r"]]),
};

// ---- a branch is shown with the space that holds it --------------------------
let out = rows(world, "hotfix");
check("search: a first row is the space, not the bare checkout",
  out[0]?.kind === "space" && out[0].s.id === "r", JSON.stringify(out.map((r) => [r.kind, r.depth])));
check("search: the matched checkout is nested under that space",
  out.some((r) => r.kind === "worktree" && r.depth === 1 && r.c.branch === "hotfix"), JSON.stringify(out.map((r) => r.depth)));
check("search: the hit is marked, the space it came with is not",
  out.find((r) => r.kind === "worktree")?.hit === true && out[0].hit === false,
  JSON.stringify(out.map((r) => r.hit)));

// ---- a worktree space comes with the space it belongs to ---------------------
out = rows(world, "desktop");
check("search: a worktree space is shown under its repo space",
  out[0]?.kind === "space" && out[0].s.id === "r" && out.some((r) => r.kind === "space" && r.s.id === "d" && r.depth === 1),
  JSON.stringify(out.map((r) => [r.kind, r.s?.name, r.depth])));
check("search: its agents come with it",
  out.some((r) => r.kind === "agent" && r.depth === 2), JSON.stringify(out.map((r) => [r.kind, r.depth])));

// ---- a space comes with its children ----------------------------------------
out = rows(world, "kleeamp");
check("search: a matched space brings its children",
  out[0].s.id === "r" && out.some((r) => r.s?.id === "d") && out.some((r) => r.kind === "agent"),
  JSON.stringify(out.map((r) => [r.kind, r.s?.name ?? r.a?.title])));
check("search: the matched space is the hit", out[0].hit === true, JSON.stringify(out.map((r) => r.hit)));

// ---- an agent comes with the space it runs in ------------------------------
out = rows(world, "rune");
check("search: an agent in a worktree climbs to the repo's space",
  out[0]?.kind === "space" && out[0].s.id === "r"
    && out.some((r) => r.kind === "space" && r.s.id === "d" && r.depth === 1)
    && out.some((r) => r.kind === "agent" && r.depth === 2),
  JSON.stringify(out.map((r) => [r.kind, r.s?.name ?? r.a?.title, r.depth])));
check("search: the agent is the hit, its space is not",
  out.find((r) => r.kind === "agent")?.hit === true && out[0].hit === false,
  JSON.stringify(out.map((r) => r.hit)));

// ---- a pin is the place: its worktrees come with it -------------------------
// Searching the repo of a pin whose space has exited found the pin row and the
// one checkout whose folder happened to carry the word, but not the repo's
// other worktrees. The pin's line is the place, so all of them come with it.
{
  const typing = { id: "tz", name: "typing-autozoom", folder: "/wt/typing", machine: null, status: "idle" };
  const click = { id: "ce", name: "feat/click-effects", folder: "/wt/click", machine: null, status: "working" };
  const closed = {
    spaces: [],
    agents: [],
    worktrees: [],
    pins: [{ id: "r", folder: "/reel", machine: null, name: "reel", named: false, repo: "\u001f/reel" }],
    pinSpaces: [typing, click],
  };
  out = rows(closed, "reel");
  check("search: a pin row is the hit",
    out[0]?.kind === "pin" && out[0].hit === true, JSON.stringify(out.map((r) => [r.kind, r.hit])));
  check("search: a matched pin brings every worktree of its repo",
    out.some((r) => r.kind === "space" && r.s.id === "tz" && r.depth === 1)
      && out.some((r) => r.kind === "space" && r.s.id === "ce" && r.depth === 1),
    JSON.stringify(out.map((r) => [r.kind, r.s?.id ?? r.id, r.depth])));
  check("search: the worktrees that came along are not hits",
    out.filter((r) => r.kind === "space").every((r) => r.hit === false),
    JSON.stringify(out.map((r) => [r.kind, r.hit])));
}

check("search: a folderless active space still loads the other spaces' worktrees",
  !/if \(!this\.folder\) \{ this\.loaded = true; return; \}/.test(src));

console.log(failures ? `\n${failures} failed` : "\nall search checks passed");
process.exit(failures ? 1 : 0);
