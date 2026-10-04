/**
 * Meta test: the `vitest.db.config.ts` include registry may not silently omit a
 * db-backed test.
 *
 * WHY THIS FILE EXISTS — a measured defect, not a hypothetical.
 *
 * `vitest.config.ts` collects `src/**`, but the CI job that runs it (`verify`,
 * `.github/workflows/ci.yml`) has NO database. A db-backed test under `src/**`
 * therefore gates itself on `DATABASE_URL` and reports its assertions as
 * SKIPPED inside an otherwise green run. That happened twice, in sequence:
 *
 *   - B35 (`t_b38671b6`, commit `dbbb67a`) closed it for
 *     `src/app/sources/__tests__/persist-canonical-events-upsert.test.ts` by
 *     naming that file in `vitest.db.config.ts`'s include list. B35 documented
 *     the residual risk in its own commit message: "this list is now the single
 *     registry of db-backed tests that live outside `db/**`, and it is a list a
 *     human must extend. A future db-backed test under `src/**` that is not
 *     named here reproduces this exact defect."
 *   - B37 (`t_8c73ba34`) is that future test, already live:
 *     `src/lib/db/__tests__/client.test.ts`. Its three `describeWithDb`
 *     assertions never executed in ANY CI job, and one of them — "round-trips a
 *     row through the migrated table" — is the only assertion in the repository
 *     that the shipped `db/migrations` actually produce a usable table.
 *
 * So the registry does not remove the class of defect; it relocates it from
 * "unknown" to "one hand-maintained list". THIS is what polices the list. If the
 * next db-backed test under `src/**` is not named in `vitest.db.config.ts`, this
 * file fails in the DEFAULT suite, in the `verify` job, on the same run that
 * would otherwise report green — no database required to notice.
 *
 * WHY IT FAILS RATHER THAN SKIPS. A skipped guard is a green suite with no
 * registry enforcement in it, which is exactly the condition this file exists to
 * end. See the same argument in `src/core/__tests__/boundary-guard-exists.test.ts`.
 *
 * WHY IT READS BOTH FILES AS TEXT. It does not import the config (a config
 * module has no test-bearing exports, and importing it would make the guard
 * satisfiable by editing the very list it defends), and it does not import the
 * tests. It reads bytes off disk, so moving the registry or the test aside turns
 * this red rather than silently reducing what the suite covers.
 *
 * SCOPE — WHY `composition-root.test.ts` IS NOT FLAGGED, AND HOW THAT IS KNOWN.
 *
 * `src/app/sources/__tests__/composition-root.test.ts` mentions `DATABASE_URL`
 * three times and every mention is a NEGATION: it reads the variable only to
 * `delete` it, proving the db client is lazily constructed and not built at
 * module load. It needs no database, and a detector that flagged it would be
 * over-broad — the card that raised this work says such a detector "will be
 * rejected", and correctly so: a guard that cries wolf on a file which
 * deliberately proves the ABSENCE of a database trains reviewers to ignore it.
 *
 * So the detector does not ask "does this file mention `DATABASE_URL`". It asks
 * "does this file need a REACHABLE DATABASE to assert what it claims", and
 * recognises three concrete, positive signals for that (below). The
 * `composition-root.test.ts` case has none of them, and
 * `composition-root needs no database` is asserted directly below rather than
 * left as a claim in this comment — if a future change makes that file
 * db-requiring, this test says so instead of guessing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DB_CONFIG_PATH = path.join(REPO_ROOT, "vitest.db.config.ts");
const SRC_DIR = path.join(REPO_ROOT, "src");

/**
 * This file names `describeWithDb`, `DATABASE_URL`, `process.env` and the db
 * client on purpose — it is the detector. It must exclude itself, or it reports
 * itself as an unregistered db-backed test and the suite is red for a reason no
 * commit can fix.
 */
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));

/**
 * Every `*.test.ts` under `src/**`, as repo-relative POSIX paths — the same
 * shape `vitest.db.config.ts`'s include patterns are written in. Recurses
 * manually rather than via a glob helper so the guard has no dependency that
 * Vitest could stop shipping transitively: a guard that disappears with a
 * dependency bump is a guard.
 */
function testFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...testFilesUnder(absolute));
    } else if (/\.test\.tsx?$/.test(entry)) {
      found.push(path.relative(REPO_ROOT, absolute).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

/**
 * The include patterns, read back out of `vitest.db.config.ts`.
 *
 * Only the string literals of the `include:` array are taken, so editing this
 * function cannot make the guard pass: the registry is whatever the config
 * actually says. The `db/**` entry is dropped — the db suite collects that
 * directory by design, and this guard is only about tests OUTSIDE `db/**`.
 */
function registeredSrcEntries(): string[] {
  const source = readFileSync(DB_CONFIG_PATH, "utf8");
  const arrayMatch = source.match(/include:\s*\[([^\]]*)\]/);
  if (!arrayMatch) {
    throw new Error(
      `Could not find an \`include: [...]\` array in ${DB_CONFIG_PATH}. ` +
        "If the db config's shape changed, this guard must be updated to read " +
        "it — do not delete the guard.",
    );
  }
  const arrayBody = arrayMatch[1] ?? "";
  return [...arrayBody.matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((pattern): pattern is string => pattern !== undefined)
    .filter((pattern) => !pattern.startsWith("db/"));
}

/**
 * Match a repo-relative path against one registry pattern.
 *
 * Deliberately supports only `**` and `*`, and asserts that it is being handed
 * nothing else. A general glob matcher would be more correct and also quieter:
 * an unhandled token (`?`, `{a,b}`, `[abc]`) would silently stop matching and
 * turn a registered test into an unregistered one — a FALSE POSITIVE, which
 * fails loudly, rather than the false-negative failure mode a half-understood
 * matcher produces. Throwing is the safe direction for this guard.
 */
function matchesPattern(pathToMatch: string, pattern: string): boolean {
  const unsupported = pattern.replace(/\*\*?/g, "");
  if (/[?{}[\]!+@()]/.test(unsupported)) {
    throw new Error(
      `Registry pattern \`${pattern}\` uses a glob token this guard does not ` +
        "implement. Extend matchesPattern rather than loosening the guard.",
    );
  }
  const source = pattern
    .split("**")
    .map((segment) =>
      segment.replace(/[.+^${}|\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`).test(pathToMatch);
}

/**
 * Does this test file need a REACHABLE DATABASE?
 *
 * Three signals, all positive (something the file does), never the mere presence
 * of a string:
 *
 *   1. It uses the repository's `describeWithDb` idiom — a `describe`/`it`
 *      block that collapses to `.skip` when `DATABASE_URL` is unset. This is
 *      THE signal: it is a block of assertions that is silently skipped in the
 *      database-less `verify` job. `client.test.ts` matches here.
 *   2. It selects `describe.skip` / `skipIf` from `DATABASE_URL` directly,
 *      without naming the helper. Same defect, written inline.
 *   3. It imports the db client (`getDb`, `checkDatabaseConnection`, `closeDb`)
 *      and is not itself gated — i.e. it calls into the real driver rather than
 *      only asserting the client is lazy.
 *
 * A file that only DELETES `process.env.DATABASE_URL` to prove laziness matches
 * none of these, which is the intended discrimination.
 */
function requiresDatabase(source: string, relativePath: string): boolean {
  if (relativePath === SELF) return false;

  if (/\bdescribeWithDb\b/.test(source)) return true;

  // `DATABASE_URL ? describe : describe.skip` and friends.
  if (/DATABASE_URL\s*\?[\s\S]{0,40}describe\.skip/.test(source)) return true;
  if (/skipIf\(\s*!\s*!?\s*process\.env\.DATABASE_URL/.test(source))
    return true;
  if (/describe\.skipIf\(\s*!?\s*process\.env\.DATABASE_URL/.test(source)) {
    return true;
  }

  // Calls the real driver, so it needs a server to talk to.
  if (
    /from\s+["'][^"']*lib\/db\/client["']/.test(source) &&
    /\b(getDb|checkDatabaseConnection)\s*\(/.test(source)
  ) {
    return true;
  }

  return false;
}

describe("vitest.db.config.ts registry", () => {
  const entries = registeredSrcEntries();

  it("reads a non-empty registry out of the db config", () => {
    // If this is empty the assertions below are vacuous, so it is its own test.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.includes("client.test.ts"))).toBe(
      true,
    );
  });

  it("collects every db-backed test under src/**", () => {
    const files = testFilesUnder(SRC_DIR);
    // Non-vacuity floor: if the walk returned nothing the check below is
    // trivially satisfied.
    expect(files.length).toBeGreaterThan(10);

    const unregistered = files.filter(
      (relativePath) =>
        requiresDatabase(
          readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
          relativePath,
        ) && !entries.some((pattern) => matchesPattern(relativePath, pattern)),
    );

    expect(
      unregistered,
      unregistered.length === 0
        ? undefined
        : [
            "A db-backed test under src/** is NOT collected by `bun run test:db`,",
            "so its database assertions are collected by `vitest.config.ts` and",
            "reported SKIPPED inside the green `verify` job — which has no",
            "database. Add it to the `include` array in vitest.db.config.ts.",
            "",
            ...unregistered.map((file) => `  - ${file}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("does not flag composition-root.test.ts, which needs no database", () => {
    // The specific over-broad detector this card warned about: that file
    // mentions `DATABASE_URL` only to DELETE it, proving the db client is lazy.
    // Asserted as its own test so the discrimination is measured, not asserted
    // in a comment — if it ever stops holding, this goes red and the detector
    // gets fixed instead of the file getting registered wrongly.
    const source = readFileSync(
      path.join(
        REPO_ROOT,
        "src/app/sources/__tests__/composition-root.test.ts",
      ),
      "utf8",
    );
    expect(source).toContain("DATABASE_URL");
    expect(
      requiresDatabase(
        source,
        "src/app/sources/__tests__/composition-root.test.ts",
      ),
    ).toBe(false);
  });

  it("still detects a db-backed test that is missing from the registry", () => {
    // The guard's own non-vacuity control: a synthetic source that uses the
    // `describeWithDb` idiom must be classified as db-requiring, and a path
    // that is not in the registry must therefore be reported. If the detector
    // ever stops recognising the idiom, this fails before a real test is missed.
    const synthetic =
      "const describeWithDb = url ? describe : describe.skip;\n" +
      "describeWithDb('live', () => { it('works', () => {}); });\n";
    expect(
      requiresDatabase(synthetic, "src/synthetic/__tests__/never.test.ts"),
    ).toBe(true);
    expect(
      entries.some((pattern) =>
        matchesPattern("src/synthetic/__tests__/never.test.ts", pattern),
      ),
    ).toBe(false);
  });

  it("matches registry patterns for the files it already holds", () => {
    expect(
      matchesPattern(
        "src/lib/db/__tests__/client.test.ts",
        "src/lib/db/__tests__/client.test.ts",
      ),
    ).toBe(true);
    expect(
      matchesPattern(
        "src/app/page.test.tsx",
        "src/app/sources/__tests__/*.test.ts",
      ),
    ).toBe(false);
  });
});
