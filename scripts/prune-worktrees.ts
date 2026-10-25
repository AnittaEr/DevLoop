/**
 * The prune half of worktree lifecycle management (B73 / `t_131131fb`, B75 /
 * `t_3ea8f287`).
 *
 * WHY THIS EXISTS. The dispatcher creates one git worktree per kanban card and
 * has no removal path: a `git worktree list` taken at this branch's head returns
 * ~124 entries, the bulk of them abandoned. Those worktrees are never collected,
 * so the `.worktrees/` backlog regrows forever unless something reaps it. B71
 * (`t_58bc7c17`) stops NEW lint cost by ignoring `.worktrees/**` in ESLint; this
 * script stops the backlog from ACCUMULATING by removing worktrees whose branch
 * has fully merged into `main`.
 *
 * THE HAZARD THIS AVOIDS. A worktree whose branch is merged into `main` is safe
 * to remove -- the commits it carried live on `main` and are now referenced. But
 * a worktree holding UNMERGED, UNREFERENCED commits destroys work if removed:
 * those commits survive ONLY because the worktree object is still registered,
 * so `git worktree remove` would drop them. PM measured this concretely this
 * tick: commit `1fd3165` (the batch-19 assembly head) exists as an object
 * reachable from NO branch, and it survives solely because its worktree is still
 * registered.
 *
 * So the script CLASSIFIES FIRST and REFUSES ambiguity. It never runs
 * `git worktree prune --force` on the whole directory, never does a bulk
 * `rm -rf`, and only ever passes a worktree to `git worktree remove` when its
 * verdict is unambiguously `REMOVABLE`.
 *
 * THE PROTECTION SET IS DERIVED, NOT HARDCODED. A worktree is protected iff its
 * card is not terminal (not `done` and not `archived`). The set is read live
 * from `hermes kanban --board devloop list --json` at every invocation, so it
 * cannot rot like a stale literal. If the board cannot be read, `--apply`
 * refuses and exits non-zero (c2); a dry-run prints a WARNING and classifies
 * everything as KEEP (fail-closed), because an empty protection set is the exact
 * state that would let `--apply` remove a live card's worktree.
 *
 * THE SAFETY MODEL, IN ONE LINE: `git rev-list --count <ref>..<branch>` returns
 * 0 exactly when every commit the branch carries is ALSO on `<ref>` -- i.e. the
 * branch added nothing that `<ref>` does not already have. `<ref>` is `main`
 * when a local `main` resolves, and `origin/main` when only the remote-tracking
 * ref resolves (so a detached checkout with no local `main` can still classify
 * a genuinely-merged branch). Count > 0 (or an unparseable branch, or a
 * protected path) => KEEP. Count 0 AND not protected => REMOVABLE.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the git SUPERPROJECT root from the current working directory.
 *
 * This distinguishes the *main* working tree from a *linked* worktree. In a
 * linked worktree, `git rev-parse --show-toplevel` returns the worktree's own
 * directory (e.g. `/repo/.worktrees/t_131131fb`), NOT the directory that owns
 * the `.worktrees/` folder. The protected paths produced by
 * `deriveProtectionSet()` are expressed relative to the superproject
 * (`.worktrees/<id>`), so computing them against the worktree root would make
 * them point at `/repo/.worktrees/t_131131fb/.worktrees/<id>` -- a path that
 * never matches and silently disables protection.
 *
 * `git rev-parse --git-common-dir` returns the common `.git` directory: an
 * absolute path for a linked worktree (the superproject's `.git`), or a
 * relative `.git` for the main checkout. Resolving that against the toplevel
 * and taking its parent yields the superproject root in BOTH cases: the parent
 * of `/repo/.git` is `/repo`, and the parent of
 * `/repo/.git/worktrees/t_X` is `/repo/.git/worktrees` -- so we resolve via
 * `common-dir` relative to `show-toplevel` only when it is relative (i.e. the
 * main checkout), and treat it as absolute when it already is (linked
 * worktree).
 *
 * Falls back to `process.cwd()` when git cannot resolve (e.g. an uninitialised
 * directory), so the caller still gets a deterministic path.
 */
function superprojectRoot(): string {
  const toplevelResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  const toplevel = (toplevelResult.stdout ?? "").trim();

  const commonResult = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  const common = (commonResult.stdout ?? "").trim();

  if (!toplevel || !common) {
    return process.cwd();
  }

  // `--git-common-dir` is relative to the toplevel only on the MAIN checkout
  // (where it returns `.git`). On a linked worktree it is absolute (the
  // superproject's real `.git`). Handle both.
  const gitDir = path.isAbsolute(common)
    ? common
    : path.resolve(toplevel, common);

  return path.dirname(gitDir);
}

const REPO_ROOT = superprojectRoot();

/**
 * Terminal statuses: a worktree for a task in one of these states is no longer
 * in use and may be safely pruned. Everything else (running, ready, todo,
 * scheduled, review, triage, blocked, ...) means the card is alive and its
 * worktree must be protected.
 */
const TERMINAL_STATUSES = new Set(["done", "archived"]);

/**
 * A worktree that is protected from pruning because it backs a live kanban card.
 */
export interface ProtectedWorktree {
  /** Absolute path to the worktree directory under `.worktrees/<id>`. */
  path: string;
  /** The kanban card id this worktree belongs to (e.g. `t_131131fb`). */
  cardId: string;
}

/**
 * The single source of truth for terminal statuses. `status` values that do NOT
 * appear here are live (in-flight) cards. Exported so the test suite can assert
 * the classification logic without depending on the kanban CLI.
 */
export const TERMINAL_STATUS_SET = TERMINAL_STATUSES;

/**
 * Parse the JSON output of `hermes kanban --board devloop list --json` and
 * derive the protection set: every task whose status is NOT `done` or
 * `archived` contributes a `.worktrees/<id>` entry.
 *
 * This is split out from `deriveProtectionSet` (which shells out to `hermes`)
 * so the test suite can feed it mock board JSON and assert the derivation
 * logic as a pure function -- including that a `done` id is NOT protected and a
 * nonterminal id IS protected.
 *
 * `repoRoot` is a parameter so the test suite can point it at a fixture tree.
 */
export function parseBoardJson(
  json: string,
  repoRoot: string,
): { entries: ProtectedWorktree[]; ok: boolean } {
  let tasks: unknown;
  try {
    tasks = JSON.parse(json);
  } catch {
    return { entries: [], ok: false };
  }
  if (!Array.isArray(tasks)) {
    return { entries: [], ok: false };
  }
  const entries: ProtectedWorktree[] = [];
  for (const t of tasks) {
    if (
      t &&
      typeof t === "object" &&
      "id" in t &&
      typeof (t as { id: unknown }).id === "string" &&
      "status" in t &&
      typeof (t as { status: unknown }).status === "string" &&
      !TERMINAL_STATUSES.has((t as { status: string }).status)
    ) {
      entries.push({
        path: path.join(repoRoot, ".worktrees", (t as { id: string }).id),
        cardId: (t as { id: string }).id,
      });
    }
  }
  return { entries, ok: true };
}

/**
 * Derive the protection set from live board state.
 *
 * Calls `hermes kanban --board devloop list --json` and maps every non-terminal
 * task to a `.worktrees/<id>` path. Returns `boardAvailable: false` when the
 * board cannot be read at all (no `hermes` on PATH, unknown board slug, parse
 * failure, etc.) -- the caller is then responsible for fail-closed behaviour
 * (refuse `--apply`, warn in dry-run) because an empty protection set is the
 * exact state that would let `--apply` remove a live card's worktree.
 */
export function deriveProtectionSet(): {
  entries: ProtectedWorktree[];
  boardAvailable: boolean;
} {
  const result = spawnSync(
    "hermes",
    ["kanban", "--board", "devloop", "list", "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
  if (result.status !== 0 || !result.stdout) {
    return { entries: [], boardAvailable: false };
  }
  const parsed = parseBoardJson(result.stdout, REPO_ROOT);
  return { entries: parsed.entries, boardAvailable: parsed.ok };
}

export type Verdict = "REMOVABLE" | "KEEP";

export interface WorktreeClassification {
  /** Absolute path to the worktree, exactly as `git worktree list` reports. */
  path: string;
  /** Branch name without the `refs/heads/` prefix, or `"(no branch)"`. */
  branch: string;
  /** HEAD SHA of the worktree. */
  headSha: string;
  /** `git rev-list --count <ref>..<branch>`; undefined when the count cannot be parsed. */
  unreconciledCount: number | undefined;
  /** Why the worktree is held back, when verdict is KEEP. Empty when REMOVABLE. */
  reason: string;
  verdict: Verdict;
}

/**
 * Run `git` with the given args in the repo root, returning stripped stdout.
 * Never throws -- a failed git call is treated as "cannot classify" and surfaces
 * the error text through the return value so the caller can keep going.
 */
function gitStdout(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return (result.stdout ?? "").trim();
}

/**
 * Parse the output of `git worktree list --porcelain` into a list of
 * `{ path, branch, headSha }` records. The porcelain format is stable and
 * line-oriented:
 *
 *   worktree /abs/path/to/wt
 *   HEAD <sha>
 *   branch refs/heads/<branch>
 *   ...
 *
 * Each worktree block is separated by a blank line. This is the only reader of
 * that format; if git ever changes it, classifyAll() surfaces the parse error
 * rather than silently guessing.
 */
function listWorktrees(): Array<{
  path: string;
  branch: string;
  headSha: string;
}> {
  // `--porcelain` gives machine-parseable output. We parse the block header
  // lines rather than the column-aligned `worktree list` output, which breaks
  // on paths containing whitespace.
  const porcelain = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (porcelain.status !== 0) {
    return [];
  }

  const lines = (porcelain.stdout ?? "").split("\n");
  const worktrees: Array<{ path: string; branch: string; headSha: string }> =
    [];
  let current: { path: string; branch: string; headSha: string } | null = null;

  for (const line of lines) {
    if (line === "") {
      if (current) {
        worktrees.push(current);
        current = null;
      }
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      current = { path: value, branch: "(no branch)", headSha: "" };
    } else if (key === "HEAD" && current) {
      current.headSha = value;
    } else if (key === "branch" && current) {
      // `branch refs/heads/foo` -> `foo`; `branch (detached)` -> `(detached)`
      const ref = value.replace(/^refs\/heads\//, "");
      current.branch = ref === "" ? "(detached)" : ref;
    }
  }
  if (current) {
    worktrees.push(current);
  }

  // DROP THE MAIN WORKTREE. `git worktree remove` rejects the repository's
  // primary working tree ("is a main working tree"), so classifying it would
  // only ever surface a REMOVABLE entry that cannot actually be removed --
  // and worse, it would make the script's summary counts misleading on every
  // invocation. The main worktree is identified structurally: its path is the
  // repository top-level. (The main entry may be detached, as it is on this
  // branch, or it may be on `main`; either way, it is never pruned.)
  return worktrees.filter((w) => w.path !== REPO_ROOT);
}

/**
 * Count commits the worktree's branch carries that are NOT on `main`.
 *
 * `git rev-list --count <ref>..<branch>` returns 0 when every commit on
 * `<branch>` is reachable from `<ref>` -- i.e. `<branch>` is fully merged and the
 * worktree adds nothing `<ref>` doesn't already have. A non-zero count, or a
 * branch/ref that cannot be resolved, returns `undefined` so the caller marks it
 * KEEP.
 *
 * `<ref>` is resolved as follows (c3/c4):
 *   - `main` when a local `main` branch resolves.
 *   - `origin/main` when no local `main` exists but the remote-tracking ref does.
 *   - `undefined` (KEEP with a fail-closed reason) when NEITHER resolves -- this
 *     is the detached-checkout-without-main case, where refusing is safer than
 *     guessing.
 *
 * The stderr is captured (not `2>/dev/null`) so that a real git failure -- as
 * opposed to an unresolvable branch -- surfaces through the reason string.
 */
function resolveComparisonRef(): string | undefined {
  // Prefer a local `main` when it exists.
  const hasLocal =
    spawnSync("git", ["rev-parse", "--verify", "--quiet", "main"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    }).status === 0;
  if (hasLocal) {
    return "main";
  }
  // Fall back to the remote-tracking ref so a detached checkout (which often
  // has no local `main`) can still classify a merged branch.
  const hasOriginMain =
    spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    }).status === 0;
  if (hasOriginMain) {
    return "origin/main";
  }
  // Neither resolves: fail closed.
  return undefined;
}

function unreconciledCount(branch: string): number | undefined {
  // Detached heads and "(no branch)" have nothing to compare against main.
  if (branch === "(no branch)" || branch === "(detached)") {
    return undefined;
  }
  const ref = resolveComparisonRef();
  if (ref === undefined) {
    return undefined;
  }
  const count = gitStdout(["rev-list", "--count", `${ref}..${branch}`]);
  const parsed = Number.parseInt(count, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Classify a single registered worktree.
 *
 * Verdict logic, in priority order:
 *   1. If the worktree path is in the PROTECTED set, it is KEEP -- live cards
 *      must never be auto-pruned, even if their branch looks merged.
 *   2. If `git rev-list --count <ref>..<branch>` is 0, the worktree is REMOVABLE.
 *   3. Any non-zero count, a detached/no-branch worktree, or an unparseable
 *      count => KEEP.
 *
 * `protectedEntries` defaults to an empty array -- the real protection set is
 * derived from live board state in `main()` and passed in explicitly. It is
 * exposed as a parameter so the test suite can inject a deterministic set and
 * treat the verdict logic as a pure function -- this is what makes the
 * "merged -> REMOVABLE / unmerged -> KEEP" assertions non-vacuous without
 * requiring every pure test to spin up a throwaway git repo. The subprocess
 * tests exercise the real `unreconciledCount` against temp repos.
 *
 * `countResolver` defaults to the real `unreconciledCount` (which shells out
 * to git in `REPO_ROOT`).
 */
export function classify(
  worktree: { path: string; branch: string; headSha: string },
  protectedEntries: ProtectedWorktree[] = [],
  countResolver: (branch: string) => number | undefined = unreconciledCount,
): WorktreeClassification {
  const { path: wtPath, branch, headSha } = worktree;

  const match = protectedEntries.find(
    (p) => wtPath === p.path || wtPath.startsWith(p.path + path.sep),
  );
  if (match) {
    return {
      path: wtPath,
      branch,
      headSha,
      unreconciledCount: undefined,
      reason: `protected (live card ${match.cardId}: not done/archived)`,
      verdict: "KEEP",
    };
  }

  const count = countResolver(branch);

  if (count === 0) {
    return {
      path: wtPath,
      branch,
      headSha,
      unreconciledCount: 0,
      reason: "",
      verdict: "REMOVABLE",
    };
  }

  const reason =
    count === undefined
      ? "branch not resolvable against main (detached/unmerged/unknown)"
      : `${count} unreconciled commit(s) not on main`;
  return {
    path: wtPath,
    branch,
    headSha,
    unreconciledCount: count,
    reason,
    verdict: "KEEP",
  };
}

/**
 * Classify every registered worktree. Pure over the output of `listWorktrees`,
 * so the test suite feeds it a throwaway repo with its own worktrees and
 * never touches the live DevLoop worktree set.
 */
export function classifyAll(
  worktrees: Array<{ path: string; branch: string; headSha: string }>,
  protectedEntries: ProtectedWorktree[] = [],
  countResolver: (branch: string) => number | undefined = unreconciledCount,
): WorktreeClassification[] {
  return worktrees.map((w) => classify(w, protectedEntries, countResolver));
}

function isApply(arg: string): boolean {
  return arg === "--apply";
}

/**
 * Print a human-readable classification table. Each row carries the columns the
 * ticket's c1 demands: path, branch, HEAD SHA, the rev-list count, and a verdict.
 */
function printTable(classifications: WorktreeClassification[]): void {
  for (const c of classifications) {
    const count =
      c.unreconciledCount === undefined ? "?" : String(c.unreconciledCount);
    console.log(
      `${c.verdict.padEnd(10)} | ${c.path} | ${c.branch} | ${c.headSha.slice(0, 7)} | count=${count} | ${c.reason}`,
    );
  }
}

/**
 * Print one PROTECTION: line per protected worktree, naming the live card id so
 * an operator sees exactly why the path is held back (c5).
 */
function printProtections(protection: ProtectedWorktree[]): void {
  for (const p of protection) {
    const rel = path.relative(REPO_ROOT, p.path);
    console.log(
      `PROTECTION: ${rel} is KEEP regardless of merge status (live card ${p.cardId})`,
    );
  }
}

/**
 * Remove a single REMOVABLE worktree. Uses `git worktree remove --force` so a
 * dirty-but-already-fully-merged worktree is still reclaimed -- the only thing
 * that makes this safe is that the caller has already classified every worktree
 * this function receives and confirmed it as REMOVABLE (count 0, not protected).
 */
function removeWorktree(wt: WorktreeClassification): void {
  const result = spawnSync("git", ["worktree", "remove", "--force", wt.path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) {
    console.error(
      `FAILED to remove ${wt.path}: ${(result.stderr ?? "").trim()}`,
    );
  }
}

/**
 * CLI entry point. Guarded so it only runs when this file is executed directly
 * (e.g. `bun run ./scripts/prune-worktrees.ts`), NOT when it is imported as a
 * module by the test suite. `process.argv[1]` is this file's resolved path only
 * when it is the entrypoint; when imported, `process.argv[1]` is the runner.
 * This keeps `classify`/`classifyAll` importable without tripping
 * `process.exit(0)`.
 */
function main(): void {
  const args = process.argv.slice(2);
  const apply = args.some(isApply);

  // Sanity-gate the argv: anything that is not recognized is rejected. This
  // keeps a typo like `--aplly` from silently running a dry-run when the
  // operator thought they were mutating.
  for (const arg of args) {
    if (!isApply(arg)) {
      console.error(`unknown argument: ${arg}`);
      console.error("usage: bun run worktrees:prune [--apply]");
      process.exit(2);
    }
  }

  // Derive the protection set from live board state (c1). Fail-closed: if the
  // board cannot be read we do NOT proceed with an empty protection set,
  // because that is precisely the state that would let `--apply` remove a
  // live card's worktree (c2).
  const { entries: protectionSet, boardAvailable } = deriveProtectionSet();

  if (!boardAvailable) {
    if (apply) {
      console.error(
        "ERROR: board unavailable — protection set unknown. Refusing --apply to avoid removing a live card's worktree.",
      );
      process.exit(1);
    }
    console.log("WARNING: board unavailable — protection set unknown");
    // Fail-closed: with no reliable protection set, classify every worktree as
    // KEEP so nothing is ever removed on a guess.
    const allWorktrees = listWorktrees();
    const classifications: WorktreeClassification[] = allWorktrees.map((w) => ({
      path: w.path,
      branch: w.branch,
      headSha: w.headSha,
      unreconciledCount: undefined,
      reason: "board unavailable — protection set unknown (fail-closed)",
      verdict: "KEEP",
    }));
    printTable(classifications);
    console.log(
      `\n0 REMOVABLE, ${classifications.length} KEEP.`,
    );
    console.log(
      "DRY-RUN: no changes made. Pass --apply to remove REMOVABLE worktrees.",
    );
    process.exit(0);
  }

  printProtections(protectionSet);
  const classifications = classifyAll(listWorktrees(), protectionSet);
  printTable(classifications);

  const removable = classifications.filter((c) => c.verdict === "REMOVABLE");
  console.log(
    `\n${removable.length} REMOVABLE, ${classifications.length - removable.length} KEEP.`,
  );

  if (!apply) {
    console.log(
      "DRY-RUN: no changes made. Pass --apply to remove REMOVABLE worktrees.",
    );
    process.exit(0);
  }

  for (const wt of removable) {
    removeWorktree(wt);
  }
  console.log(`--apply: removed ${removable.length} worktree(s).`);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
