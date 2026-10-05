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
 * stretches with machine load. Measured at batch-15's head (`d2db2f9`, 670
 * tests) on an 8-core machine: the Prettier canary took 1.0s isolated and
 * 70.1s when four full suites ran at once, against a 5s budget. Such a test
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
 *   Take the worst duration you have actually MEASURED for that test under the
 *   worst load you can actually produce, and multiply by 4. A budget that is
 *   close to the measurement is a budget that will be crossed by the next
 *   slow machine; a budget that is 4x it still fails a genuinely hung
 *   subprocess, which is what the timeout is for.
 *
 * `SUBPROCESS_X4` exists because one measured case needs more than 30s: under
 * 4x concurrent full suites the Prettier canary ran to 70.1s (it spawns
 * Prettier TWICE -- a negative control, then the real bytes -- so it pays two
 * cold starts, not one). At 30s that case was still red. 60s covers the
 * observed 70.1s only because the observed value is inflated by 4 concurrent
 * suites each running the same test; a single suite has never taken more than
 * 8.0s. That asymmetry is deliberate and is exactly why the multiplier is
 * stated against the SINGLE-suite measurement, not the concurrent one.
 */

/**
 * Budget for a test that spawns a real subprocess (a formatter, a scanner CLI,
 * `git`) and therefore pays a Node/Bun cold start per spawn.
 *
 * Measured worst case: 28.1s (`scripts/__tests__/secret-scan.test.ts` > "the
 * shipped pre-commit HOOK blocks the commit", 4 concurrent suites, 2.2s
 * isolated). 4x the worst single-suite observation (7.7s) is ~30s.
 */
export const LOAD_BEARING_TEST_TIMEOUT = {
  /** Spawns a subprocess; budget scaled from the worst measured run. */
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