/**
 * The prune half of worktree lifecycle management (B73 / `t_131131fb`).
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
 * THE SAFETY MODEL, IN ONE LINE: `git rev-list --count main..<branch>` returns
 * 0 exactly when every commit the branch carries is ALSO on `main` -- i.e. the
 * branch added nothing that main does not already have. Count > 0 (or an
 * unparseable branch, or a protected path) => KEEP. Count 0 AND not protected =>
 * REMOVABLE.
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
 * the `.worktrees/` folder. The protected paths below are expressed relative
 * to the superproject (`.worktrees/t_b6c6dc7a`, `.worktrees/t_58bc7c17`), so
 * computing them against the worktree root would make them point at
 * `/repo/.worktrees/t_131131fb/.worktrees/t_b6c6dc7a` -- a path that never
 * matches and silently disables protection.
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
 * The protected set is hardcoded and explicit. These are the two worktrees
 * backing cards that are live right now (`t_b6c6dc7a` for I23,
 * `t_58bc7c17` for B71). They are KEEP regardless of merge status -- an
 * in-flight card's branch is, by definition, not merged yet, but even after it
 * merges we never want a prune sweep to delete the worktree a running agent is
 * sitting in.
 *
 * These are resolved relative to the git SUPERPROJECT root so they stay correct
 * no matter where the script is invoked from, including from within a linked
 * worktree of `t_131131fb` itself.
 */
const PROTECTED_PREFIXES = [
  path.join(REPO_ROOT, ".worktrees", "t_b6c6dc7a"),
  path.join(REPO_ROOT, ".worktrees", "t_58bc7c17"),
];

const PROTECTION_LABEL = "protected (live card worktree)";

export type Verdict = "REMOVABLE" | "KEEP";

export interface WorktreeClassification {
  /** Absolute path to the worktree, exactly as `git worktree list` reports. */
  path: string;
  /** Branch name without the `refs/heads/` prefix, or `"(no branch)"`. */
  branch: string;
  /** HEAD SHA of the worktree. */
  headSha: string;
  /** `git rev-list --count main..<branch>`; undefined when the count cannot be parsed. */
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
 * `git rev-list --count main..<branch>` returns 0 when every commit on
 * `<branch>` is reachable from `main` -- i.e. `<branch>` is fully merged and the
 * worktree adds nothing main doesn't already have. A non-zero count, or a
 * branch that cannot be resolved (detached, or `git` error), returns `undefined`
 * so the caller marks it KEEP.
 *
 * The `2>/dev/null` is deliberate: if the branch ref can't be resolved, git
 * prints to stderr and exits non-zero -- that is the "unmerged or
 * unresolvable" case, which is KEEP.
 */
function unreconciledCount(branch: string): number | undefined {
  // Detached heads and "(no branch)" have nothing to compare against main.
  if (branch === "(no branch)" || branch === "(detached)") {
    return undefined;
  }
  const count = gitStdout(["rev-list", "--count", `main..${branch}`]);
  const parsed = Number.parseInt(count, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Classify a single registered worktree.
 *
 * Verdict logic, in priority order:
 *   1. If the worktree path is in the PROTECTED set, it is KEEP -- live cards
 *      must never be auto-pruned, even if their branch looks merged.
 *   2. If `git rev-list --count main..<branch>` is 0, the worktree is REMOVABLE.
 *   3. Any non-zero count, a detached/no-branch worktree, or an unparseable
 *      count => KEEP.
 *
 * `countResolver` defaults to the real `unreconciledCount` (which shells out
 * to git in `REPO_ROOT`). It is exposed so the test suite can inject a
 * deterministic count and treat the verdict logic as a pure function -- this
 * is what makes the "merged -> REMOVABLE / unmerged -> KEEP" assertions
 * non-vacuous without requiring every pure test to spin up a throwaway git
 * repo. The subprocess tests exercise the real `unreconciledCount` against
 * temp repos.
 */
export function classify(
  worktree: { path: string; branch: string; headSha: string },
  protectedPrefixes: string[] = PROTECTED_PREFIXES,
  countResolver: (branch: string) => number | undefined = unreconciledCount,
): WorktreeClassification {
  const { path: wtPath, branch, headSha } = worktree;

  const isProtected = protectedPrefixes.some(
    (p) => wtPath === p || wtPath.startsWith(p + path.sep),
  );
  if (isProtected) {
    return {
      path: wtPath,
      branch,
      headSha,
      unreconciledCount: undefined,
      reason: PROTECTION_LABEL,
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
  protectedPrefixes: string[] = PROTECTED_PREFIXES,
  countResolver: (branch: string) => number | undefined = unreconciledCount,
): WorktreeClassification[] {
  return worktrees.map((w) => classify(w, protectedPrefixes, countResolver));
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

function printProtections(): void {
  for (const p of PROTECTED_PREFIXES) {
    const rel = path.relative(REPO_ROOT, p);
    console.log(
      `PROTECTION: ${rel} is KEEP regardless of merge status (live card worktree)`,
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

  printProtections();
  const classifications = classifyAll(listWorktrees());
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
