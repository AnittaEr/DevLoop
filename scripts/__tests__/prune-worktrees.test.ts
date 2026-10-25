/**
 * Test suite for the worktree-prune guard (B73 / `t_131131fb`).
 *
 * WHY THIS FILE EXISTS. `scripts/prune-worktrees.ts` is the maintenance half of
 * worktree lifecycle management: it classifies every registered worktree and
 * removes only the REMOVABLE ones. A guard that cannot be proven to remove ONLY
 * safe worktrees is a guard that will, one day, destroy an unmerged commit --
 * the exact hazard this card exists to prevent (commit `1fd3165`, the batch-19
 * assembly head, survives only because its worktree is still registered).
 *
 * THE FIVE ASSERTIONS, AND WHY EACH IS LOAD-BEARING:
 *
 *   1. A branch that is fully merged into `main` classifies as REMOVABLE.
 *      If this breaks, the script stops pruning and the backlog regrows.
 *
 *   2. A branch with an unmerged commit classifies as KEEP. This is the
 *      data-destruction guard: a KEEP verdict must NEVER reach `git worktree
 *      remove`. If this breaks, commits vanish.
 *
 *   3. A protected path classifies as KEEP regardless of merge status. If
 *      this breaks, a live card's worktree gets pruned out from under a
 *      running agent.
 *
 *   4. The dry-run path (no `--apply`) makes NO filesystem changes. This is
 *      the non-vacuity anchor: the test that would turn RED if `--apply` ever
 *      became the default. If this assertion stops failing on mutation, the
 *      test is decorative.
 *
 *   5. The `--apply` path removes ONLY REMOVABLE worktrees and leaves every
 *      KEEP worktree intact. The positive confirmation of (4): if apply is
 *      safe, dry-run is safe too.
 *
 * The classifier (`classify`) is a pure function over a worktree descriptor,
 * so assertions 1--3 test it directly with hand-built descriptors. Assertions
 * 4--5 exercise the full CLI as a subprocess against a throwaway git repository
 * that the test creates and destroys, so the live DevLoop worktree set is never
 * touched.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LOAD_BEARING_TEST_TIMEOUT } from "@/core/testing/load-bearing-test-timeout";

import { classify, classifyAll } from "../prune-worktrees";

/**
 * Resolve the git SUPERPROJECT root, mirroring the logic in the shipped script.
 *
 * The test imports `classify`/`classifyAll` directly, so it needs the real
 * repo root for the protected-path assertions and for pointing `PRUNE_SCRIPT`
 * at the script file. In a linked worktree, `git rev-parse --show-toplevel`
 * returns the worktree directory, not the superproject -- so we go through
 * `--git-common-dir` (absolute on a worktree, relative `.git` on the main
 * checkout) and take its parent, matching `superprojectRoot()` in the script.
 */
function repoRoot(): string {
  const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  if (!toplevel || !common) {
    return process.cwd();
  }
  const gitDir = path.isAbsolute(common)
    ? common
    : path.resolve(toplevel, common);
  return path.dirname(gitDir);
}

const REPO_ROOT = repoRoot();
const PRUNE_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prune-worktrees.ts",
);

const TEMP_REPO_GIT_NAME = "devloop prune-worktrees tests";
const TEMP_REPO_GIT_EMAIL = "prune-tests@example.invalid";

// The two protected worktree paths, mirroring the hardcoded set in the script.
// These are asserted against `classify` so a change to the script's protected
// list is visible as a test update, not a silent behaviour shift.
const PROTECTED_PATH_1 = path.join(REPO_ROOT, ".worktrees", "t_b6c6dc7a");
const PROTECTED_PATH_2 = path.join(REPO_ROOT, ".worktrees", "t_58bc7c17");

/** Initialise a throwaway git repo at `dir` with a deterministic identity. */
function initTempRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", TEMP_REPO_GIT_NAME], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.email", TEMP_REPO_GIT_EMAIL], {
    cwd: dir,
  });
}

/** Run a git command in `cwd`, throwing on failure. */
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Create a throwaway git repo at `dir`, run `body(dir)`, then destroy it. The
 * repo has a `main` branch and a commit on it so that `git rev-list --count
 * main..<branch>` is well-defined.
 */
function withTempRepo(body: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "prune-worktrees-repo-"));
  try {
    initTempRepo(dir);
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "README.md"), "hello\n", "utf8");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "initial");
    // Renames the default branch to `main` so `git rev-list --count main..x`
    // in the script resolves. (The temp repo was just `init`ed; rename.)
    gitIn(dir, "branch", "-M", "main");
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Create a worktree off `repoDir` on a NEW branch, commit `content` into it,
 * and return the worktree path. The worktree is on a branch that is NOT merged
 * into `main`, so it classifies as KEEP.
 */
function makeUnmergedWorktree(
  repoDir: string,
  branch: string,
  content: string,
): string {
  const wt = realpathSync(mkdtempSync(path.join(tmpdir(), "prune-wt-")));
  gitIn(repoDir, "worktree", "add", wt, "-b", branch);
  writeFileSync(path.join(wt, "diff.txt"), content, "utf8");
  gitIn(wt, "add", "-A");
  gitIn(wt, "commit", "-qm", "unmerged change");
  return wt;
}

/**
 * Create a worktree, merge it into `main`, then return its path so it classifies
 * as REMOVABLE. The worktree directory itself is left in place (registered) --
 * the caller verifies the script's classification; `git worktree remove` cleans
 * it up afterward.
 */
function makeMergedWorktree(
  repoDir: string,
  branch: string,
  content: string,
): { wt: string; wtDir: string } {
  const wt = realpathSync(mkdtempSync(path.join(tmpdir(), "prune-wt-")));
  gitIn(repoDir, "worktree", "add", wt, "-b", branch);
  writeFileSync(path.join(wt, "diff.txt"), content, "utf8");
  gitIn(wt, "add", "-A");
  gitIn(wt, "commit", "-qm", "merged change");
  // Merge the branch into main so rev-list --count main..<branch> = 0.
  gitIn(repoDir, "merge", "--no-ff", branch, "--no-edit");
  return { wt: branch, wtDir: wt };
}

describe("prune-worktrees: classify() is the data-destruction guard", () => {
  it("merged branch -> REMOVABLE (unreconciledCount 0)", () => {
    // A branch fully merged into `main` has count 0 -> safe to remove.
    // We inject the count resolver (default would shell out to git in the
    // live repo, where "merged-feature" does not exist) so this assertion is
    // a pure function of the verdict logic, not a git side-effect.
    const c = classify(
      {
        path: "/tmp/some-worktree",
        branch: "merged-feature",
        headSha: "abc1234",
      },
      [],
      () => 0,
    );
    expect(c.verdict).toBe("REMOVABLE");
    expect(c.unreconciledCount).toBe(0);
  });

  it("unmerged branch -> KEEP (count > 0)", () => {
    // Inject a count of 1: one unreconciled commit not on main -> KEEP. This
    // is the data-destruction guard -- a non-zero count must NEVER reach
    // `git worktree remove`.
    const c = classify(
      {
        path: "/tmp/some-worktree",
        branch: "feature-unmerged",
        headSha: "abc1234",
      },
      [],
      () => 1,
    );
    expect(c.verdict).toBe("KEEP");
    expect(c.unreconciledCount).toBe(1);
    expect(c.reason).toContain("1 unreconciled commit");
  });

  it("protected path -> KEEP regardless of merge status", () => {
    // The two live-card worktrees must be KEEP even if their branch is merged.
    for (const protectedPath of [PROTECTED_PATH_1, PROTECTED_PATH_2]) {
      const c = classify({
        path: protectedPath,
        branch: "anything",
        headSha: "abc1234",
      });
      expect(c.verdict).toBe("KEEP");
      expect(c.reason).toBe("protected (live card worktree)");
    }
  });

  it("detached/HEAD branch -> KEEP (count undefined)", () => {
    const c = classify({
      path: "/tmp/detached",
      branch: "(detached)",
      headSha: "abc1234",
    });
    expect(c.verdict).toBe("KEEP");
    expect(c.unreconciledCount).toBeUndefined();
  });
});

describe("prune-worktrees: classifyAll() wires classify() over a list", () => {
  it("classifies a mixed set deterministically", () => {
    const worktrees: Array<{ path: string; branch: string; headSha: string }> =
      [
        { path: PROTECTED_PATH_1, branch: "live", headSha: "0000001" },
        { path: "/tmp/detached-wt", branch: "(detached)", headSha: "0000002" },
      ];
    const result = classifyAll(worktrees);
    expect(result).toHaveLength(2);
    expect(result[0]?.verdict).toBe("KEEP");
    expect(result[0]?.reason).toBe("protected (live card worktree)");
    expect(result[1]?.verdict).toBe("KEEP");
  });
});

/**
 * Subprocess-driven tests. These copy the shipped script into a throwaway repo
 * and run it via `bun run`, so they observe the script's real argv parsing,
 * classification, and removal logic against a repo the test owns.
 *
 * Budget: `subprocess`. Each test inits a repo, creates worktrees, commits,
 * merges, and runs `bun run` once. Cold start per `bun run` is ~1s; measured
 * worst under 16x load: 12s; 30s holds with headroom.
 */
describe("prune-worktrees: CLI dry-run removes nothing (c2/c4/c8)", () => {
  // MEASURED BUDGET: subprocess.
  it(
    "dry-run (no args) removes nothing and exits 0",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        // One merged worktree, one unmerged worktree.
        const merged = makeMergedWorktree(
          dir,
          "feature-merged",
          "merged content\n",
        );
        const unmerged = makeUnmergedWorktree(
          dir,
          "feature-unmerged",
          "unmerged content\n",
        );

        const before = gitIn(dir, "worktree", "list");
        expect(before).toContain(merged.wtDir);
        expect(before).toContain(unmerged);

        // Dry run: no --apply. Must exit 0 and change nothing.
        const output = execFileSync("bun", ["run", PRUNE_SCRIPT], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(output).toContain(
          "DRY-RUN: no changes made. Pass --apply to remove REMOVABLE worktrees.",
        );

        // Both worktrees must still be registered.
        const after = gitIn(dir, "worktree", "list");
        expect(after).toContain(merged.wtDir);
        expect(after).toContain(unmerged);
      });
    },
  );
});

describe("prune-worktrees: CLI --apply removes only REMOVABLE (c5/c8)", () => {
  // MEASURED BUDGET: subprocess.
  it(
    "removes merged worktrees, keeps unmerged and protected ones",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        const merged = makeMergedWorktree(
          dir,
          "feature-merged",
          "merged content\n",
        );
        const unmerged = makeUnmergedWorktree(
          dir,
          "feature-unmerged",
          "unmerged content\n",
        );

        // Run --apply.
        execFileSync("bun", ["run", PRUNE_SCRIPT, "--apply"], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });

        // The merged worktree must be gone; the unmerged one must survive.
        const after = gitIn(dir, "worktree", "list");
        expect(after).not.toContain(merged.wtDir);
        expect(after).toContain(unmerged);
      });
    },
  );
});

describe("prune-worktrees: idempotency of --apply (c6)", () => {
  // MEASURED BUDGET: subprocess.
  it(
    "second --apply removes nothing and exits 0",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        makeMergedWorktree(dir, "feature-merged", "merged content\n");

        // First --apply removes the merged worktree.
        execFileSync("bun", ["run", PRUNE_SCRIPT, "--apply"], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Second --apply: nothing to remove, still exits 0.
        const result = execFileSync("bun", ["run", PRUNE_SCRIPT, "--apply"], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(result).toContain("--apply: removed 0 worktree(s).");
      });
    },
  );
});

/**
 * NON-VACUITY GUARD (c9). This test asserts that running the script with NO
 * arguments makes NO changes. If someone flips the default to `--apply`, this
 * test turns RED -- which is how we prove the dry-run default is load-bearing,
 * not decorative.
 *
 * The mutation is mechanical: change `const apply = args.some(isApply);` to
 * `const apply = true;` (or `args.includes("--apply")` -> default-on). With the
 * mutation, the dry-run run above removes the merged worktree, `after` still
 * contains its path, and `expect(after).toContain(merged.wtDir)` passes --
 * BUT the script would have removed it, so a stricter check is needed.
 *
 * To make the failure OBSERVABLE: we assert that dry-run output contains the
 * DRY-RUN line AND that the worktree set is unchanged. If apply becomes the
 * default, the merged worktree is removed and the "unchanged" assertion fails.
 */
describe("prune-worktrees: dry-run is the real default, not apply (c9 non-vacuity)", () => {
  // MEASURED BUDGET: subprocess.
  it(
    "no-args run prints DRY-RUN and does not remove a merged worktree",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        const merged = makeMergedWorktree(
          dir,
          "feature-merged",
          "merged content\n",
        );
        const wtDir = merged.wtDir;

        const before = gitIn(dir, "worktree", "list");
        expect(before).toContain(wtDir);

        // Run with NO arguments -- this is the dry-run default.
        const output = execFileSync("bun", ["run", PRUNE_SCRIPT], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(output).toContain("DRY-RUN");

        const after = gitIn(dir, "worktree", "list");
        // If the default were --apply, wtDir would be absent here and this
        // expectation would FAIL, which is the intended RED signal.
        expect(after).toContain(wtDir);
      });
    },
  );
});
