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
 * base (`1f4bd5c`), the Prettier canary took 0.6s in isolation but 31.6s
 * when SEVEN full suites ran at once -- against a 5s budget. Such a test
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
 *     without naming one of these budgets BY NAME. A raw `30000` next to a
 *     `spawnSync` fails that guard; so does `5000`, which is worse -- it is the
 *     exact budget this exists to prevent, written by hand and passing. So does
 *     a MISSPELLED key such as `.subprocses`, which reaches Vitest as
 *     `undefined` and typechecks clean behind a cast. The guard validates the
 *     named key against this object, so the guard cannot be satisfied by a magic
 *     number, and it is driven by tests that prove each rejection fires.
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
 *   load you can actually produce, then round UP to the next round number.
 *
 * That rule was previously "multiply by 4", and the 7x measurement below shows
 * why 4x is the wrong shape rather than merely a conservative choice: the canary
 * moves 621ms -> 10934ms -> 31563ms as concurrency goes 1x -> 4x -> 7x, which is
 * roughly LINEAR in the number of competing suites. So the multiplier that
 * matters is "how many suites could plausibly run at once on a busier machine",
 * not a constant, and 4x silently under-budgets anything that scales that way. An
 * earlier revision also applied 4x to the 4x row and got 60s while claiming 74s
 * was the requirement -- the arithmetic was doing the work the evidence could
 * not. Stated honestly: the budget must clear the worst number you can MEASURE,
 * and the roundness is a convenience, not the safety margin.
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
 * Re-measured on this branch at head `30391bc` with the budget applied, in
 * SEPARATE detached worktrees so that the test's fixed-path canary file could
 * not be deleted out from under a concurrent run:
 *
 *   isolated, 5 runs, one suite:      589 / 594 / 597 / 617 / 621 ms
 *   4x concurrent FULL suites, 12 obs: worst 10934 ms (median 7510 ms)
 *   7x concurrent FULL suites,  7 obs: worst 31563 ms (median 30170 ms)
 *
 * THE WORST LOADED OBSERVATION IS 31563ms, at 7x, and the 60s budget is sized
 * from it: 30s would be BELOW an observation this machine actually produced,
 * which is precisely how a budget gets crossed on the next slower machine, so
 * 60s is the round number above the worst case (1.9x). Isolated worst is 621ms,
 * so 60s keeps ~97x headroom over that and still fails a genuinely hung
 * formatter (`prettier --check` on one file cannot legitimately take 60s).
 *
 * THE 7x ROW IS WHY `subprocessX4` EXISTS AT ALL, and it is a correction to
 * what this file claimed before. An earlier revision dismissed the discarded
 * "37.8s" figure as an artefact of four suites sharing ONE worktree, where the
 * canary's `finally` deletes the file out from under a concurrent run, and said
 * the separate-worktree numbers were the only real ones. That explanation does
 * not hold up: at 7x in separate worktrees this test reaches 31563 ms, the same
 * order as 37.8s, so the discarded figure is not explained by the file race at
 * all. The claim is WITHDRAWN rather than restated, because the honest position
 * is the weaker one -- what is reproducible is the 7x row above, and the 4x row
 * is not the ceiling.
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
   * Measured worst case: 6936ms (`route-auth.test.ts` > "CONTROL: with a
   * session the real pipeline runs", 7 concurrent suites in separate worktrees;
   * 2662ms at 4x, 1.0-2.7s across 12 observations there). 30s is ~4.3x that
   * worst case. An earlier "21.4s" for this budget did not reproduce at its
   * stated condition and is withdrawn.
   */
  moduleGraph: 30_000,
} as const;

/**
 * The keys above are the WHOLE vocabulary of budgets, and the regression guard
 * reads them off this object at runtime rather than from a second exported list.
 *
 * An exported mirror of these keys used to live here. It was deleted rather than
 * wired up, and the reason is worth keeping: nothing referenced it, so it could
 * not have caught the misspelling it was documented as catching, while looking
 * exactly like the thing that would. The guard now derives them with
 * `Object.keys(LOAD_BEARING_TEST_TIMEOUT)`, which cannot drift from this
 * declaration because it IS this declaration.
 */
