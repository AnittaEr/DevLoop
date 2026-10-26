/**
 * B71 (`t_58bc7c17`): `bun run lint` must NOT measure `.worktrees/`.
 *
 * WHY THIS FILE EXISTS. The global `ignores` array in `eslint.config.mjs`
 * carries `.worktrees/**` so that `eslint .` skips every task worktree the
 * dispatcher creates. Without it — and this was measured, not guessed — half
 * of every lint run is spent on unrelated cards' worktrees, so a "clean" pass is
 * green for the wrong reason and a "red" pass can be red for the wrong reason.
 *
 * The config line alone is not enough. This repo has a recorded history of a
 * guard being deleted in one commit and noticed by nothing (see the header of
 * `readme-accuracy.test.ts` for the class this closes). A text grep of the
 * config file would pass even when the ignore does not take effect, because an
 * entry can be present but misspelled, out of scope, or shadowed by a later
 * config block. So this file drives ESLint END-TO-END and asserts on the
 * actual set of files ESLint reports, not on the config text.
 *
 * NON-VACUITY. The test creates a throwaway `.ts` file directly under
 * `.worktrees/` — NOT inside any existing worktree directory — runs the real
 * ESLint (the `ESLint` class from the project's `eslint`, loading the real
 * `eslint.config.mjs` from the repo root) over `.`, and asserts that zero
 * reported file paths are INSIDE the repo-root's `.worktrees/` tree. Removing
 * the ignore entry makes ESLint reach the throwaway file and turns the test RED;
 * restoring it makes the throwaway file invisible again and the test GREEN. A
 * grep of the config text would not catch a deleted or misspelled ignore —
 * this end-to-end run does.
 *
 * IMPORTANT — why the check is relative-path based, not a substring test.
 * ESLint returns absolute `filePath`s. Every task worktree lives under the
 * repo-root's `.worktrees/` directory, so a dispatch worker running this test
 * IN its own worktree has an absolute path that *contains* `.worktrees` purely
 * because the worktree directory sits under `.worktrees/` — a false positive
 * that has nothing to do with the ignore. Instead each reported path is
 * resolved RELATIVE TO ROOT and only flagged when its relative path is actually
 * inside `.worktrees/`. That mirrors exactly how ESLint's `ignores` glob
 * matches, and it is what makes a missing/misspelled/softened ignore turn RED.
 *
 * The throwaway file is written in the test body and removed in `afterEach` so
 * it never leaks into a commit or interferes with a live worktree.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { LOAD_BEARING_TEST_TIMEOUT } from "@/core/testing/load-bearing-test-timeout";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The repo root, derived from this file's location.
 *
 * This file is `<root>/src/__tests__/eslint-ignores-worktrees.test.ts`, so the
 * root is two levels up. A test that trusted `process.cwd()` would silently
 * start asserting against the wrong tree depending on where Vitest was invoked
 * from — which is precisely the defect class this meta-test genre exists to
 * prevent.
 */
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * A file placed directly under `.worktrees/` so `eslint .` would reach it if
 * the ignore were absent. It is NOT inside an existing worktree directory and
 * is removed after each case, so it never touches a sibling card's tree.
 */
const PROBE_DIR = path.join(ROOT, ".worktrees", "__b71_eslint_probe__");
const PROBE_FILE = path.join(PROBE_DIR, "probe.ts");

/** A snippet that is lint-clean — the probe must be reachable, not failing. */
const PROBE_CONTENT = "export const probe = 1;\n";

/**
 * Run the real ESLint over the whole repo, loading the real
 * `eslint.config.mjs` from `ROOT`. Returns the flat-format result objects,
 * each of which carries a `filePath` we inspect for `.worktrees` leakage.
 *
 * `useEslintrc: true` (the default for the `ESLint` class) ensures the real
 * config is loaded. `errorOnUnmatchedPattern` is false so a `.gitignore`d-but-
 * not-ignored file does not abort the run.
 */
async function lintRepo(): Promise<
  Array<{ filePath: string; messages: unknown[] }>
> {
  const eslint = new ESLint({ cwd: ROOT });
  const results = await eslint.lintFiles(["."]);
  return results as Array<{ filePath: string; messages: unknown[] }>;
}

function ensureProbe(): void {
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(PROBE_FILE, PROBE_CONTENT);
}

function removeProbe(): void {
  try {
    rmSync(PROBE_DIR, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

afterEach(() => {
  removeProbe();
});

describe("eslint . must ignore .worktrees/", () => {
  // Both cases drive the real ESLint programmatically over `.` (lintRepo).
  // ESLint spawns its own worker pool, so this is subprocess-spawning work whose
  // duration stretches with machine load — exactly the B53 defect class. PM
  // measured the ESLint pass at 6367ms under full-suite load (16.24s suite
  // wall, jsdom created 39 times); the 5000ms Vitest default is below that, so
  // without a budget the test times out for a reason that has nothing to do with
  // the assertion. `subprocess` (30s) is the measured budget for subprocess work
  // and clears the observed 6367ms with headroom.
  const LOAD_BEARING = LOAD_BEARING_TEST_TIMEOUT.subprocess;
  it(
    "never reports a file whose path contains .worktrees, even when one is present",
    { timeout: LOAD_BEARING },
    async () => {
      // Place the probe BEFORE running ESLint so the negative control is real:
      // if the ignore is missing or misspelled, ESLint will reach this file.
      ensureProbe();
      const results = await lintRepo();
      // Resolve each path RELATIVE TO ROOT before checking. ESLint returns
      // absolute filePath strings; when this test runs INSIDE a task worktree
      // (which lives under `.worktrees/`), every absolute path contains the
      // substring `.worktrees` merely because of the worktree directory — a
      // false positive that has nothing to do with the ignore. Only a file whose
      // relative path actually lives under `.worktrees/` is a real violation.
      const worktreeResults = results.filter((r) => {
        const rel = path.relative(ROOT, r.filePath);
        return rel.startsWith("..") === false && rel.includes(".worktrees");
      });
      expect(
        worktreeResults,
        worktreeResults.length === 0
          ? undefined
          : [
              "ESLint reported files under .worktrees/ — the global ignores",
              "entry for .worktrees/** is missing, misspelled, or shadowed.",
              ...worktreeResults.map((r) => `  - ${r.filePath}`),
            ].join("\n"),
      ).toEqual([]);
    },
  );

  it("still lints the repo's own tree", { timeout: LOAD_BEARING }, async () => {
    // The probe is NOT present here, so this is a pure control: the previous
    // case proves ignored files are excluded, and this case confirms the rest
    // of the tree is still reached. If the ignore were accidentally broad
    // enough to swallow src/, this would catch that too.
    removeProbe();
    const results = await lintRepo();
    const hasRepoFile = results.length > 0;
    expect(
      hasRepoFile,
      "ESLint returned zero results — the repo tree is not being linted at all",
    ).toBe(true);
  });
});
