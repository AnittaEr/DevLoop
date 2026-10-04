/**
 * Meta test: the plugin boundary guard must EXIST and be non-trivial.
 *
 * This test exists because of a measured security fact, not a hypothetical.
 * While reviewing t_7a135bf0, QA deleted
 * `src/core/__tests__/plugin-boundary.test.ts` outright and the suite stayed
 * GREEN (32 passed). The plugin boundary -- hard rule 1 of
 * 60-agent-briefs.md, the one genuinely non-negotiable invariant in this
 * project -- rested entirely on that single file, which any ticket could remove
 * in a one-line commit with nothing else in the repository objecting. Deleting
 * or emptying an architecture guard must turn the suite RED, so this test
 * asserts on the guard's existence and substance rather than trusting it to be
 * present.
 *
 * It runs BEFORE the guard's own assertions and is independent of them: it does
 * not import the guard, so it cannot be satisfied by the guard exporting
 * anything. It reads the guard as text off disk, which is what makes it fail
 * when the file is moved aside or emptied rather than quietly reducing what the
 * suite covers.
 *
 * WHY THIS FILE FAILS RATHER THAN SKIPS WHEN THE GUARD IS ABSENT.
 *
 * This test was first written with `describe.skipIf(!GUARD_EXISTS)`, because
 * the guard is not on every base: `src/core/plugins/plugin.ts`,
 * `src/core/events/canonical-event.ts` and the boundary guard itself all arrive
 * with the unmerged core-domain work (T3 / PR #2, cards t_4056bdb5 and
 * t_dd9e67e6). The skip was rejected on review, and the rejection was correct:
 * a skip means the suite is GREEN with no boundary test in it, which is the
 * precise condition this ticket exists to end. "Not landed yet" and "deleted"
 * are indistinguishable from the outside once you skip, so a skip cannot
 * protect the invariant -- only fail loudly on it.
 *
 * So an absent guard is a FAILURE here, deliberately, on every base. That is
 * the intended behaviour, not a bug: a branch without the boundary guard is a
 * branch where hard rule 1 is unpoliced, and the correct response to that is a
 * red suite, not a quiet pass. Once PR #2 lands the guard, these assertions
 * pass on their own merits with no edit to this file. Reviewers re-running this
 * on the pre-PR #2 base should expect exactly one failing file, and the failure
 * message names the missing path.
 *
 * WHY THIS FILE NAMES NO PROVIDER TOKEN (a real constraint, not a preference).
 *
 * First draft of this test listed the required deny-list families as string
 * literals naming each provider namespace. With the guard in place that fails,
 * correctly: the guard scans every file under `src/core/` except itself, so a
 * SECOND file in core naming those tokens is itself a boundary violation. A
 * meta test that can only exist alongside the guard it defends is a meta test
 * that is absent exactly when the guard has been deleted, which defeats its
 * purpose. Hence the assertions below are STRUCTURAL: they read the family
 * names back OUT of the guard and check their number and substance, instead of
 * hardcoding the vocabulary. That keeps this file legal under the guard, and it
 * is also the stronger check -- the guard cannot be gutted to a single family,
 * or to families with no tokens, without failing here.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const THIS_FILE = fileURLToPath(import.meta.url);
const CORE_DIR = path.resolve(path.dirname(THIS_FILE), "..");

/** The architecture guard whose existence this test defends. */
const GUARD_PATH = path.join(CORE_DIR, "__tests__", "plugin-boundary.test.ts");

const GUARD_EXISTS = existsSync(GUARD_PATH);

/**
 * The guard's text, or the empty string when it is absent.
 *
 * Returning "" rather than throwing is deliberate: it lets every assertion fail
 * with its own explanatory message ("declares 0 deny-list families", "no longer
 * declares FORBIDDEN_IMPORT_PATTERNS") instead of crashing in `readFileSync`
 * with an ENOENT stack trace. Every assertion is independently informative, so
 * a reviewer sees which specific property of the boundary was lost.
 */
const guardSource = (): string =>
  GUARD_EXISTS ? readFileSync(GUARD_PATH, "utf8") : "";

/**
 * Pull the deny-list family names out of the guard source, e.g. the first
 * entry's `family` value.
 *
 * Deliberately structural rather than a hardcoded list: see the header note on
 * why this file must not itself contain provider vocabulary.
 */
function denyFamiliesInGuard(source: string): string[] {
  const block = source.match(/const\s+DENY_LIST[^=]*=\s*\[([\s\S]*?)\n\]/);
  if (block === null) return [];
  const families: string[] = [];
  const entry = /\{\s*family:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = entry.exec(block[1] ?? "")) !== null) {
    if (match[1]) families.push(match[1]);
  }
  return families;
}

/** Family names with an accompanying token list in the guard source. */
function familiesWithTokens(source: string): string[] {
  return denyFamiliesInGuard(source).filter((family) =>
    new RegExp(
      `family:\\s*"${family}"[\\s\\S]{0,400}?tokens:\\s*\\[[\\s\\S]{0,400}?"`,
    ).test(source),
  );
}

/**
 * A guard reduced below this is not a guard. One provider's vocabulary is a
 * preference, three is a boundary (PM ruling D-065), so a deny-list that only
 * covers a single namespace has stopped being a boundary check.
 */
const MIN_DENY_FAMILIES = 3;

/** A guard reduced below this is not a guard; it is a stub that tests nothing. */
const MIN_GUARD_LINES = 100;
// Deliberately NOT `describe.skipIf`. Every assertion below runs
// unconditionally, INCLUDING when the guard is absent. A skip is precisely the
// defect this test exists to close: skipping on a missing guard turns the suite
// GREEN with no boundary test anywhere in it, which is exactly what QA measured
// while reviewing t_7a135bf0. An absent guard must be RED.
//
// The substance assertions read the guard via `guardSource`, which returns an
// empty string when the file is absent. That keeps each assertion failing with
// its OWN explanatory message instead of crashing in `readFileSync` and
// reporting an ENOENT stack trace -- a named failure a reviewer can act on.
describe("plugin boundary guard is present and non-trivial", () => {
  it("exists", () => {
    expect(
      GUARD_EXISTS,
      `plugin-boundary.test.ts is MISSING at ${GUARD_PATH}. The plugin boundary (hard rule 1) has no test at all. This is the exact condition measured as leaving the suite GREEN (32 passed) while reviewing t_7a135bf0, so it must not be allowed to pass silently again.`,
    ).toBe(true);
    expect(statSync(GUARD_PATH).isFile()).toBe(true);
  });

  it(`is longer than ${MIN_GUARD_LINES} lines, so it is not a stub`, () => {
    const lineCount = guardSource().split("\n").length;
    expect(
      lineCount,
      `plugin-boundary.test.ts is only ${lineCount} lines; a guard this short is a stub, not a second line of defence.`,
    ).toBeGreaterThan(MIN_GUARD_LINES);
  });

  it("declares a deny-list with multiple provider families, so it is a boundary and not a single-vendor check", () => {
    const families = denyFamiliesInGuard(guardSource());
    expect(
      families.length,
      `plugin-boundary.test.ts declares ${families.length} deny-list families; the boundary needs at least ${MIN_DENY_FAMILIES} (D-065: one provider's vocabulary is a preference, three is a boundary).`,
    ).toBeGreaterThanOrEqual(MIN_DENY_FAMILIES);
  });

  it("gives every deny-list family real tokens, so no family is inert", () => {
    const all = denyFamiliesInGuard(guardSource());
    const tokenless = all.filter(
      (f) => !familiesWithTokens(guardSource()).includes(f),
    );
    expect(
      tokenless,
      `these deny-list families in plugin-boundary.test.ts carry no tokens: ${tokenless.join(", ")}. An empty family matches nothing and defends nothing.`,
    ).toEqual([]);
  });

  it("keeps its forbidden-import patterns, the half that overlaps the lint rule", () => {
    expect(
      guardSource().includes("FORBIDDEN_IMPORT_PATTERNS"),
      "plugin-boundary.test.ts no longer declares FORBIDDEN_IMPORT_PATTERNS; the guard no longer blocks the plugin namespace or provider SDKs, leaving only the lint rule to police it.",
    ).toBe(true);
  });

  it("is a different file from this one, so the guard was not collapsed into the meta test", () => {
    // Guards the bypass where the guard's body is moved here and a pointer
    // file is left behind.
    expect(path.resolve(GUARD_PATH)).not.toBe(path.resolve(THIS_FILE));
  });
});
