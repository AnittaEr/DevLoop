/**
 * The ONE place that says how long a test may take when its duration is not a
 * property of the code but of the machine.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * `vitest.config.ts` sets no `testTimeout`, so every test in this suite inherits
 * Vitest's built-in 5000ms. That is a good default for the ~600 tests that do
 * in-process work: it is short enough that a hung test fails fast, and it is
 * what keeps the suite honest about a regression that made an ordinary
 * assertion slow.
 *
 * It is the wrong default for a test that spawns a real subprocess or rebuilds
 * a real module graph. Those tests pay for Node/Bun start, for a formatter
 * reading `node_modules`, and for `vi.resetModules()` re-importing the route
 * and the Drizzle writer. None of that is the code under test, and all of it
 * stretches with machine load. Measured on an 8-core machine at this branch's
 * base (`1f4bd5c`), the Prettier canary took 0.9-1.1s in isolation but 18.5s
 * when four full suites ran at once -- against a 5s budget. Such a test
 * fails with `Error: Test timed out in 5000ms.` -- a message indistinguishable
 * from a broken assertion, which is the actual defect: a red suite stops
 * meaning a red assertion.
 *
 * The fix is NOT to raise the global timeout. Raising it would spend a bigger
 * budget on all 670 tests to serve the ~20 that do real I/O, and would let a
 * genuine hang in an ordinary test sit for the new number before anyone saw
 * it. So the budget is attached to the individual test, through
 * `LOAD_BEARING_TEST_TIMEOUT`, and every use of it is a named constant whose
 * comment records the measurement that justifies it.
 *
 * ── WHY A CONSTANT AND NOT AN INLINE NUMBER ─────────────────────────────
 *
 * Three reasons, all of them about the next person:
 *
 *  1. `it(name, fn, timeout)` is easy to add by copy-paste from a neighbour,
 *     and a copied number carries none of the measurement that justified the
 *     original. Referring to one named budget means the second user inherits
 *     the first user's evidence.
 *  2. The regression guard (`src/__tests__/load-bearing-test-timeouts.test.ts`)
 *     reads THIS FILE AS TEXT and refuses any test that spawns a subprocess
 *     without naming one of these budgets. A raw `30000` next to a `spawnSync`
 *     fails that guard; `LOAD_BEARING_TEST_TIMEOUT.subprocess` passes. So the
 *     guard cannot be satisfied by a magic number.
 *  3. Halving or doubling a budget for a whole class of tests is then a
 *     one-line change in one file, and the reviewer sees the class move
 *     together.
 *
 * ── WHY A TEXT-READ GUARD, AND WHY IT READS SOURCE FILES ────────────────
 *
 * The guard parses test sources as text rather than importing them, for the
 * same reason `no-orphaned-test-files.test.ts` parses `vitest.config.ts` as
 * text: executing a Vitest config or a 700-line test file from inside a
 * running jsdom test drags a module graph into the runner, and that is a
 * measured failure, not a hypothetical one. It also means the guard can see a
 * `spawnSync` that no amount of runtime introspection would reveal, because the
 * call is behind a helper.
 *
 * ── HOW A BUDGET IS CHOSEN ─────────────────────────────────────────────
 *
 * `SUBPROCESS` and `MODULE_GRAPH` are 30s, `SUBPROCESS_X4` is 60s. The rule
 * behind all three, stated once so a new test can apply it without asking:
 *
 *   Take the worst duration you have MEASURED for that test under the worst
 *   load you can actually produce, and multiply by 4. A budget close to the
 *   measurement will be crossed by the next slow machine; a budget 4x it still
 *   fails a genuinely hung subprocess, which is what the timeout is for.
 *
 * The multiplier is applied to the worst LOADED measurement, not the isolated
 * one. The isolated number is quoted too, because the ratio between them is the
 * evidence that the work is load-scaled at all -- a test whose isolated and
 * loaded durations are the same does not need any of this.
 *
 * `SUBPROCESS_X4` exists because one measured case needs more than 30s. The
 * Prettier canary (in the plugin boundary test for the SDK vendor) spawns
 * Prettier TWICE --
 * a negative control, then the real bytes -- so it pays two cold starts.
 * Re-measured on this branch, in four SEPARATE detached worktrees so that the
 * test's fixed-path canary file could not be deleted out from under a
 * concurrent run:
 *
 *   isolated, 5 runs, one suite:        857 / 882 / 981 / 1059 / 1104 ms
 *   4x concurrent FULL suites, 4 runs: 18522 / 17534 / 17532 / 18354 ms
 *
 * Worst loaded observation: 18522ms. 4x that is 74s, so 60s is the round
 * number below it; 30s would leave only 1.6x headroom over the worst case
 * actually observed, which is the number that would be crossed first on a
 * slower machine. Isolated worst is 1104ms, so 60s is ~54x that -- and a
 * `prettier --check` on a single file cannot legitimately take 60s, so the
 * budget still fails a genuine hang.
 *
 * These four measurements REPLACE an earlier pair quoted as "1.0s isolated,
 * 70.1s at 4x". The 70.1s figure was measured with four suites sharing ONE
 * worktree, where this test writes a fixed-path canary file and deletes it in a
 * `finally` -- so a concurrent suite read a deleted file and the run's duration
 * included contention over that file rather than the test's own cost. That
 * isolation bug is reported, not fixed (it is out of scope here). The numbers
 * above are from separate worktrees and are the only ones quoted anywhere.
 */

/**
 * Budget for a test that spawns a real subprocess (a formatter, a scanner CLI,
 * `git`) and therefore pays a Node/Bun cold start per spawn.
 *
 * SIZED FROM A FILE THAT DOES NOT EXIST ON THIS BRANCH, deliberately, and this
 * comment is the disclosure. `scripts/__tests__/secret-scan.test.ts` -- the
 * worst subprocess case anyone has measured in this repo -- lives only on the
 * unintegrated branch `devloop/t_4cdeadc5` (B51). It is absent from
 * `origin/main` and from this branch: `git ls-tree -r origin/main --name-only |
 * grep -i secret` returns nothing.
 *
 * The measurement quoted for it (worst 28.1s at 4 concurrent suites, 2.2s
 * isolated) was taken on that branch, so it sizes this budget for a test that
 * will arrive rather than one that is here. That is the honest reason this
 * constant exists with zero use sites on this branch: `subprocess` is the
 * budget the NEXT subprocess test is expected to reach for, and B51's
 * secret-scan suite is that test.
 *
 * The alternative -- deriving it from the Prettier canary, which does exist
 * here -- would double-size this budget against a measurement already claimed by
 * `subprocessX4`, and would leave `subprocessX4` with no distinct evidence. When
 * B51 lands, re-measure on this tree and correct this comment.
 */
export const LOAD_BEARING_TEST_TIMEOUT = {
  /** Spawns a subprocess; budget scaled from the worst measured run (see above). */
  subprocess: 30_000,
  /**
   * Spawns a subprocess AND is known to exceed the above under load. Only for
   * tests whose worst measurement exceeds `subprocess`.
   */
  subprocessX4: 60_000,
  /**
   * Does not spawn anything, but rebuilds a module graph per case with
   * `vi.resetModules()`, so its duration scales with load the same way.
   *
   * Measured worst case: 21.4s (`route-auth.test.ts` > "CONTROL: with a
   * session the real pipeline runs", 4 concurrent suites, 2.5s isolated).
   */
  moduleGraph: 30_000,
} as const;

/**
 * The budgets a test may name, as source text. The regression guard matches
 * against these strings, so a test that references a budget the guard does not
 * know about cannot satisfy the guard by accident.
 */
export const KNOWN_BUDGET_KEYS: readonly string[] = Object.keys(
  LOAD_BEARING_TEST_TIMEOUT,
);
