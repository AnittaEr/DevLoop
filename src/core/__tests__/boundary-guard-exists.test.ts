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
 * WHY THIS FILE SKIPS WHEN THE GUARD IS ABSENT (and why that is honest).
 *
 * `src/core/plugins/plugin.ts`, `src/core/events/canonical-event.ts` and the
 * boundary guard itself all arrive with the unmerged core-domain work (T3 /
 * PR #2, owned by cards t_4056bdb5 and t_dd9e67e6). This card's lint rule is
 * independent of that, but the meta test asserts on the guard, which does not
 * exist on this base. A skip is used rather than a failure because a red suite
 * blocks the whole queue (hard rule 6), and because a test that fails merely
 * because its subject has not landed yet is testing the schedule rather than
 * the code. The skip is asserted explicitly by the second `describe` below, so
 * the day the guard lands this test begins asserting for real and nobody has
 * to remember to come back.
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

const readGuard = (): string => readFileSync(GUARD_PATH, "utf8");

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

describe.skipIf(!GUARD_EXISTS)(
  "plugin boundary guard is present and non-trivial",
  () => {
    it(`exists at ${path.relative(CORE_DIR, GUARD_PATH)}`, () => {
      expect(GUARD_EXISTS).toBe(true);
      expect(statSync(GUARD_PATH).isFile()).toBe(true);
    });

    it(`is longer than ${MIN_GUARD_LINES} lines, so it is not a stub`, () => {
      const lineCount = readGuard().split("\n").length;
      expect(
        lineCount,
        `plugin-boundary.test.ts is only ${lineCount} lines; a guard this short is a stub, not a second line of defence.`,
      ).toBeGreaterThan(MIN_GUARD_LINES);
    });

    it("declares a deny-list with multiple provider families, so it is a boundary and not a vendor check", () => {
      const families = denyFamiliesInGuard(readGuard());
      expect(
        families.length,
        `plugin-boundary.test.ts declares ${families.length} deny-list families; the boundary needs at least ${MIN_DENY_FAMILIES} (D-065).`,
      ).toBeGreaterThanOrEqual(MIN_DENY_FAMILIES);
    });

    it("gives every deny-list family real tokens, so no family is inert", () => {
      const all = denyFamiliesInGuard(readGuard());
      const withTokens = familiesWithTokens(readGuard());
      expect(
        all.filter((f) => !withTokens.includes(f)),
        `these deny-list families in plugin-boundary.test.ts carry no tokens: ${all
          .filter((f) => !withTokens.includes(f))
          .join(", ")}. An empty family matches nothing and is not a defence.`,
      ).toEqual([]);
    });

    it("keeps its forbidden-import patterns, the half that overlaps the lint rule", () => {
      const source = readGuard();
      expect(
        source.includes("FORBIDDEN_IMPORT_PATTERNS"),
        "plugin-boundary.test.ts no longer declares FORBIDDEN_IMPORT_PATTERNS; the guard no longer blocks the plugin namespace or provider SDKs.",
      ).toBe(true);
    });

    it("is a different file from this one, so the guard was not collapsed into the meta test", () => {
      // Guards against the bypass where someone moves the guard's body here and
      // leaves a pointer file behind.
      expect(path.resolve(GUARD_PATH)).not.toBe(path.resolve(THIS_FILE));
    });
  },
);

/**
 * Runs unconditionally, including when the guard is absent. Its job is to make
 * the skip above visible and self-describing rather than a silent hole:
 * `describe.skipIf` reports as skipped with no output, and a skip nobody reads
 * is how "32 passed, no boundary test anywhere" happens.
 */
describe("plugin boundary guard presence (always runs)", () => {
  it("either the guard exists and the meta assertions ran, or the skip is explicit and explained", () => {
    if (GUARD_EXISTS) {
      expect(readGuard().split("\n").length).toBeGreaterThan(MIN_GUARD_LINES);
      return;
    }

    // Guard absent. This must be the documented "guard has not landed on this
    // base yet" state, not a deleted guard. The distinguishing signal is whether
    // the core SOURCE files the guard was written against are present too: if
    // core exists but the guard does not, the guard was DELETED, and that is a
    // defect this test must fail on rather than skip.
    const coreSourceFiles = [
      path.join(CORE_DIR, "plugins", "plugin.ts"),
      path.join(CORE_DIR, "events", "canonical-event.ts"),
    ];
    const present = coreSourceFiles.filter(existsSync);

    expect(
      present,
      `plugin-boundary.test.ts is MISSING while core sources exist at ${present
        .map((f) => path.relative(CORE_DIR, f))
        .join(
          ", ",
        )}. The boundary guard was deleted; the plugin boundary now has no test at all (hard rule 1, and the risk recorded while reviewing t_7a135bf0).`,
    ).toEqual([]);
  });
});
