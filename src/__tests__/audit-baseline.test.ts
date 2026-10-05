/**
 * Meta test: the advisory gate (`bun run audit`) must keep its own invariants.
 *
 * WHY THIS FILE EXISTS. B50 (`t_e211ed32`) added a dependency-advisory gate
 * whose entire value is that a NEW advisory is a red check. Three ways that
 * value evaporates silently, none of which any other gate can see:
 *
 *   1. The baseline stops being a baseline. A wildcard (`"*"`), a
 *      package-name key (`"braces"`), or a severity threshold in
 *      `.github/audit-baseline.json` suppresses advisories that have nothing to
 *      do with the one that was measured — including future ones nobody has
 *      seen yet. The file must contain exactly GitHub advisory IDs.
 *   2. An entry loses its reason. The value of a baseline entry is that it
 *      says WHY the advisory is unfixable; without a reason an unexplained
 *      suppression is indistinguishable from a waiver, and a reviewer cannot
 *      tell whether the ID is still justified.
 *   3. The `audit` script stops reading the baseline. The failure mode here is
 *      silent and total: a script that hardcodes an empty baseline, or ignores
 *      its input, either fails forever (removed as flaky) or passes always
 *      (a green gate over an unfixed advisory). Only a text-level assertion
 *      about the script catches it.
 *
 * HOW IT READS ITS INPUTS — AS TEXT, NEVER BY IMPORT.
 *
 * `package.json` is read as text for the `audit` script, not imported, and the
 * baseline file is read as text and parsed with `JSON.parse` (which is what the
 * gate itself does). This is the same constraint
 * `src/__tests__/db-suite-registry.test.ts` records from execution: importing a
 * build-time module into a default-suite test drags build machinery into jsdom
 * and fails the file with
 * `Invariant violation: "new TextEncoder().encode("") instanceof Uint8Array" is
 * incorrectly false`, taking the whole `verify` suite red. `package.json` and a
 * workflow file are exactly that shape.
 *
 * The script's own behaviour — that it fails on an unbaselined advisory, that
 * it passes on a baselined one, that it fails on a transport failure — is NOT
 * asserted here, because asserting it would require running a network
 * subprocess inside the default suite. It was measured directly instead, in both
 * directions, on the tree this commit introduces: removing the real ID turns
 * `bun run audit` red (exit 1), and adding a synthetic ID leaves it green
 * (exit 0). What is pinned HERE is the text-level shape that makes those
 * measurements meaningful.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const BASELINE_PATH = path.join(REPO_ROOT, ".github", "audit-baseline.json");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");

const baselineText = readFileSync(BASELINE_PATH, "utf8");
const packageJsonText = readFileSync(PACKAGE_JSON_PATH, "utf8");

/** `GHSA-xxxx-xxxx-xxxx` — the exact shape an advisory ID takes in a URL. */
const ADVISORY_ID =
  /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;

describe("dependency advisory gate", () => {
  it("parses the baseline as JSON", () => {
    // If this throws, the gate cannot read its own input — and the gate would
    // fail at CI time rather than here, which is the wrong place to learn it.
    expect(() => JSON.parse(baselineText)).not.toThrow();
    expect(typeof JSON.parse(baselineText)).toBe("object");
  });

  it("keys every baseline entry by a GitHub advisory ID", () => {
    const keys = Object.keys(JSON.parse(baselineText) as object);

    // Non-vacuity: an empty baseline would satisfy every assertion below, and
    // would also suppress nothing — so its own emptiness is the defect.
    expect(keys.length).toBeGreaterThan(0);

    const malformed = keys.filter((key) => !ADVISORY_ID.test(key));
    expect(
      malformed,
      malformed.length === 0
        ? undefined
        : [
            "Every key in .github/audit-baseline.json must be a GitHub advisory",
            "ID (GHSA-xxxx-xxxx-xxxx). The three shapes that would pass a looser",
            "check are exactly the ones that turn a baseline into a blanket:",
            '  - a wildcard ("*") suppresses advisories nobody has seen yet;',
            '  - a package name ("braces") suppresses every FUTURE advisory for',
            "    that package, including ones with a fixed release;",
            '  - a severity ("high") suppresses by level rather than by fact.',
            "Found:",
            ...malformed.map((key) => `  - ${key}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("gives every baselined advisory a non-empty reason", () => {
    const entries = Object.entries(JSON.parse(baselineText) as object);

    const unreasoned = entries.filter(
      ([, reason]) => typeof reason !== "string" || reason.trim() === "",
    );
    expect(
      unreasoned.map(([id]) => id),
      unreasoned.length === 0
        ? undefined
        : [
            "Every baselined advisory must state WHY it is unfixable, in a",
            "non-empty reason string. The reason is printed on every run of",
            "`bun run audit`, and it is the only thing that lets a reviewer",
            "re-judge the entry later — an unexplained suppression is a waiver",
            "wearing a baseline's clothes.",
            ...unreasoned.map(([id]) => `  - ${id}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("wires an `audit` script that reads the baseline path", () => {
    const scripts = (
      JSON.parse(packageJsonText) as { scripts?: Record<string, string> }
    ).scripts;
    const auditScript = scripts?.audit;

    // Asserted as its own test: a script that does not exist cannot read the
    // baseline, and every other assertion in this file would be about a gate
    // that is never run.
    expect(auditScript).toBeTypeOf("string");
    expect(auditScript).toContain("scripts/audit.ts");

    // The gate must name the baseline file. A script pointed at a path that does
    // not exist, or at nothing at all, is the silent-total-failure mode.
    const gateSource = readFileSync(
      path.join(REPO_ROOT, "scripts", "audit.ts"),
      "utf8",
    );
    expect(gateSource).toContain("audit-baseline.json");

    // And it must not rewrite the baseline: a gate that absorbs new advisories
    // on each run reproduces the ungated condition this card exists to close.
    expect(gateSource).not.toMatch(/writeFileSync|writeSync|Bun\.write/);
  });
});
