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
const src = readFileSync(join(root, "mods/search/main.js"), "utf8");

function method(name) {
  const at = src.indexOf(`  ${name}(`);
  if (at < 0) throw new Error(`mods/search/main.js: no method ${name}`);
  const end = src.indexOf("\n  }", at) + 4;
  return src.slice(at, end).replace(`  ${name}(`, `function ${name}(`);
}

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !extra ? "" : ` — ${extra}`}`);
};

const search = new Function("spaces", "agents", "pinnedList", "openSpaceFor", "place", "norm", "base",
  `${method("search")}; return search;`);

const norm = (p) => (p ?? "").replace(/\\/g, "/");
const base = (p) => norm(p).replace(/\/+$/, "").split("/").pop() ?? "";

function rows(world, q) {
  const self = {
    worktrees: world.worktrees ?? [],
    parent: world.parent ?? new Map(),
    checkoutParent: world.checkoutParent ?? new Map(),
    filter: q,
  };
  return search(() => world.spaces ?? [], () => world.agents ?? [], () => world.pins ?? [],
    () => null, (s) => s.folder, norm, base).call(self, q);
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

console.log(failures ? `\n${failures} failed` : "\nall search checks passed");
process.exit(failures ? 1 : 0);
