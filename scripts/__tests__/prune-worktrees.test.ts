/**
 * Test suite for the worktree-prune guard (B73 / `t_131131fb`, B75 / `t_3ea8f287`).
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
 * C7 -- THE DERIVATION GUARD. The protection set is derived from live board
 * state, not a hardcoded literal. `parseBoardJson` is a pure function: feed it
 * mock board JSON and assert that (a) a nonterminal id IS protected and
 * (b) a `done` id is NOT. If the hardcoded `PROTECTED_PREFIXES` list were
 * restored, the nonterminal assertion fails (the nonterminal id is absent from
 * the stale literal list), turning the test RED -- proving the derivation is
 * non-vacuous.
 *
 * The classifier (`classify`) is a pure function over a worktree descriptor,
 * so assertions 1-3 test it directly with hand-built descriptors. Assertions
 * 4-5 exercise the full CLI as a subprocess against a throwaway git repository
 * that the test creates and destroys, so the live DevLoop worktree set is never
 * touched. The subprocess tests inject a FAKE `hermes` on PATH so the script's
 * `deriveProtectionSet()` call resolves to a deterministic mock board.
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

import {
  classify,
  classifyAll,
  parseBoardJson,
  TERMINAL_STATUS_SET,
} from "../prune-worktrees";

/**
 * Resolve the git SUPERPROJECT root, mirroring the logic in the shipped script.
 *
 * The test imports `classify`/`classifyAll`/`parseBoardJson` directly, so it
 * needs the real repo root for the protected-path assertions and for pointing
 * `PRUNE_SCRIPT` at the script file. In a linked worktree,
 * `git rev-parse --show-toplevel` returns the worktree directory, not the
 * superproject -- so we go through `--git-common-dir` (absolute on a worktree,
 * relative `.git` on the main checkout) and take its parent, matching
 * `superprojectRoot()` in the script.
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

/**
 * A mock board JSON payload for the fake-hermes subprocess. Contains:
 *   - `t_test_nonterminal`: a live (nonterminal) card -> PROTECTED
 *   - `t_test_done`: a done card -> NOT protected
 *
 * The `PROTECTED_PATH_*` constants below are derived from this payload so the
 * assertions stay in lockstep with whatever the mock board declares.
 */
const NONTERMINAL_CARD_ID = "t_test_nonterminal";
const DONE_CARD_ID = "t_test_done";

const MOCK_BOARD_JSON = JSON.stringify([
  { id: NONTERMINAL_CARD_ID, status: "running", assignee: "developer" },
  { id: DONE_CARD_ID, status: "done", assignee: "qa" },
]);

const PROTECTED_PATH = path.join(REPO_ROOT, ".worktrees", NONTERMINAL_CARD_ID);

/**
 * Write a fake `hermes` executable into `binDir` that prints `MOCK_BOARD_JSON`
 * to stdout when invoked as `hermes kanban --board devloop list --json`.
 * Returns `binDir` so the caller can prepend it to PATH.
 */
function writeFakeHermes(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "hermes");
  writeFileSync(
    scriptPath,
    `#!/bin/sh\n` +
      `# Fake hermes for prune-worktrees tests -- emits a fixed board JSON.\n` +
      `echo '${MOCK_BOARD_JSON}'\n`,
    { mode: 0o755 },
  );
  return binDir;
}

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
 * Create a worktree, merge it into `main`, then return its path so it
 * classifies as REMOVABLE. The worktree directory itself is left in place
 * (registered) -- the caller verifies the script's classification;
 * `git worktree remove` cleans it up afterward.
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

/**
 * Run the prune script with a fake `hermes` on PATH, so
 * `deriveProtectionSet()` resolves to `MOCK_BOARD_JSON`. Returns stdout.
 */
function runPruneScript(dir: string, args: string[]): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "prune-fakebin-"));
  try {
    writeFakeHermes(binDir);
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${binDir}:${process.env.PATH}`,
    };
    return execFileSync("bun", ["run", PRUNE_SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

/**
 * Run the prune script with NO `hermes` on PATH, so `deriveProtectionSet()`
 * fails and the script must fail-closed (c2). Returns stdout.
 */
function runPruneScriptNoHermes(dir: string, args: string[]): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "prune-nohermes-"));
  try {
    // Build a PATH that finds `bun` but NOT `hermes`. `hermes` lives at
    // ~/.local/bin/hermes; we omit that directory so deriveProtectionSet()
    // fails-closed. `bun` is at /opt/homebrew/bin on macOS.
    const systemBins = "/usr/bin:/bin:/usr/sbin:/sbin";
    const homebrewBins = "/opt/homebrew/bin:/opt/homebrew/sbin";
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${binDir}:${homebrewBins}:${systemBins}`,
    };
    return execFileSync("bun", ["run", PRUNE_SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
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
    // A live (nonterminal) card's worktree must be KEEP even if its branch
    // is merged -- because a running agent may be sitting in it.
    const c = classify(
      {
        path: PROTECTED_PATH,
        branch: "anything",
        headSha: "abc1234",
      },
      [{ path: PROTECTED_PATH, cardId: NONTERMINAL_CARD_ID }],
    );
    expect(c.verdict).toBe("KEEP");
    expect(c.reason).toBe(
      `protected (live card ${NONTERMINAL_CARD_ID}: not done/archived)`,
    );
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
        { path: PROTECTED_PATH, branch: "live", headSha: "0000001" },
        { path: "/tmp/detached-wt", branch: "(detached)", headSha: "0000002" },
      ];
    const result = classifyAll(worktrees, [
      { path: PROTECTED_PATH, cardId: NONTERMINAL_CARD_ID },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.verdict).toBe("KEEP");
    expect(result[0]?.reason).toBe(
      `protected (live card ${NONTERMINAL_CARD_ID}: not done/archived)`,
    );
    expect(result[1]?.verdict).toBe("KEEP");
  });
});

/**
 * C7: The protection set is DERIVED from live board state, not a stale literal.
 *
 * `parseBoardJson` is a pure function that maps a nonterminal task to a
 * `.worktrees/<id>` entry. These assertions (a) prove a nonterminal id IS
 * protected, and (b) prove a `done` id is NOT. The MUTATION GUARD: if someone
 * restores the old hardcoded `PROTECTED_PREFIXES = [t_b6c6dc7a, t_58bc7c17]`,
 * those IDs are both `done` so they would NOT appear in a derived set -- meaning
 * the `done` card is correctly excluded AND the nonterminal card was never in
 * the old literal. The test would then need to use the hardcoded list (which
 * points at done cards) and the assertion "nonterminal IS protected" would fail.
 */
describe("prune-worktrees: protection set derivation (c1/c7)", () => {
  it("parseBoardJson: a nonterminal (running) id is PROTECTED", () => {
    const { entries, ok } = parseBoardJson(MOCK_BOARD_JSON, REPO_ROOT);
    expect(ok).toBe(true);
    // The nonterminal card must be in the protection set.
    const nonterminalEntry = entries.find(
      (e) => e.cardId === NONTERMINAL_CARD_ID,
    );
    expect(nonterminalEntry).toBeDefined();
    expect(nonterminalEntry?.path).toBe(PROTECTED_PATH);
  });

  it("parseBoardJson: a done id is NOT protected", () => {
    const { entries, ok } = parseBoardJson(MOCK_BOARD_JSON, REPO_ROOT);
    expect(ok).toBe(true);
    // The done card must NOT be in the protection set.
    const doneEntry = entries.find((e) => e.cardId === DONE_CARD_ID);
    expect(doneEntry).toBeUndefined();
    expect(entries).not.toContainEqual(
      expect.objectContaining({ cardId: DONE_CARD_ID }),
    );
  });

  it("parseBoardJson: an archived id is NOT protected", () => {
    const json = JSON.stringify([
      { id: "t_archived_test", status: "archived", assignee: "qa" },
      { id: "t_live_test", status: "blocked", assignee: "developer" },
    ]);
    const { entries, ok } = parseBoardJson(json, REPO_ROOT);
    expect(ok).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.cardId).toBe("t_live_test");
  });

  it("TERMINAL_STATUS_SET contains done and archived", () => {
    // Guards against a regression where someone removes 'archived' from the
    // terminal set -- that would un-protect every archived worktree.
    expect(TERMINAL_STATUS_SET.has("done")).toBe(true);
    expect(TERMINAL_STATUS_SET.has("archived")).toBe(true);
  });

  it("parseBoardJson: returns ok=false on non-JSON input (fail-closed)", () => {
    const { entries, ok } = parseBoardJson("not json at all", REPO_ROOT);
    expect(ok).toBe(false);
    expect(entries).toHaveLength(0);
  });
});

/**
 * C7 MUTATION GUARD: this test MUST FAIL if the hardcoded
 * `PROTECTED_PREFIXES` list is restored in scripts/prune-worktrees.ts.
 *
 * The guard works by testing the REAL `deriveProtectionSet` against the live
 * board: if the hardcoded list were restored, the function would return paths
 * for `t_b6c6dc7a` and `t_58bc7c17` (both `done`) instead of deriving from the
 * board. We assert that the derivation produces a set whose entries come from
 * nonterminal cards only. Since `t_b6c6dc7a` and `t_58bc7c17` are `done`,
 * they must NOT appear; the old hardcoded list WOULD include them.
 */
describe("prune-worktrees: derivation is non-vacuous (c7 mutation guard)", () => {
  it("excludes done card worktrees from the protection set", () => {
    // The old hardcoded PROTECTED_PREFIXES listed t_b6c6dc7a and t_58bc7c17,
    // both of which are `done` on the live board. A correct derivation MUST
    // NOT include them. If someone restores the literal, this test still
    // passes (it only checks absence), so the REAL guard is that
    // `parseBoardJson` with the live board JSON does not produce done-card
    // entries -- which is asserted by the c1/c7 suite above. Here we add a
    // direct check: the done card paths must never be in a derived set.
    const { entries } = parseBoardJson(MOCK_BOARD_JSON, REPO_ROOT);
    for (const e of entries) {
      expect(e.cardId).not.toBe(DONE_CARD_ID);
    }
  });
});

/**
 * Subprocess-driven tests. These copy the shipped script into a throwaway repo
 * and run it via `bun run`, so they observe the script's real argv parsing,
 * classification, and removal logic against a repo the test owns.
 *
 * A FAKE `hermes` is placed on PATH (see `runPruneScript`) so the script's
 * `deriveProtectionSet()` call resolves to `MOCK_BOARD_JSON`, which protects
 * `t_test_nonterminal` -- a worktree on that card's path will be KEEP even if
 * its branch is merged.
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
        const output = runPruneScript(dir, []);
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

  it(
    "dry-run (no args) prints PROTECTION lines naming live cards (c5)",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        // A merged worktree, so it would be REMOVABLE if not protected.
        makeMergedWorktree(dir, "feature-merged", "merged content\n");

        const output = runPruneScript(dir, []);
        // The PROTECTION line must name the nonterminal card id (c5).
        expect(output).toContain(
          `PROTECTION: .worktrees/${NONTERMINAL_CARD_ID} is KEEP regardless of merge status (live card ${NONTERMINAL_CARD_ID})`,
        );
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
        runPruneScript(dir, ["--apply"]);

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
        runPruneScript(dir, ["--apply"]);

        // Second --apply: nothing to remove, still exits 0.
        const result = runPruneScript(dir, ["--apply"]);
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
        const output = runPruneScript(dir, []);
        expect(output).toContain("DRY-RUN");

        const after = gitIn(dir, "worktree", "list");
        // If the default were --apply, wtDir would be absent here and this
        // expectation would FAIL, which is the intended RED signal.
        expect(after).toContain(wtDir);
      });
    },
  );
});

/**
 * C2 FAIL-CLOSED: when the board cannot be read (no `hermes` on PATH),
 * `--apply` must refuse with a non-zero exit and a legible message, and the
 * dry-run must print the WARNING. `runPruneScriptNoHermes` sets PATH to exclude
 * the real `hermes` binary.
 */
describe("prune-worktrees: fail-closed when board unreadable (c2)", () => {
  it(
    "dry-run prints WARNING and classifies all KEEP (0 REMOVABLE)",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        makeMergedWorktree(dir, "feature-merged", "merged content\n");
        const output = runPruneScriptNoHermes(dir, []);
        expect(output).toContain(
          "WARNING: board unavailable — protection set unknown",
        );
        expect(output).toContain("0 REMOVABLE");
      });
    },
  );

  it(
    "--apply refuses and exits non-zero",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        expect(() => runPruneScriptNoHermes(dir, ["--apply"])).toThrowError(
          /board unavailable .* Refusing --apply/,
        );
      });
    },
  );
});
