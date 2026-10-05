/**
 * Meta test: every TRACKED test file in this repository must be collected by at
 * least one suite — Vitest (unit), Vitest (db-backed), or Playwright.
 *
 * WHY THIS FILE EXISTS — the inverse of `db-suite-registry.test.ts`, and a gap
 * no existing guard covers.
 *
 * The shipped defences are `src/__tests__/db-suite-registry.test.ts` (a
 * db-backed test under `src/**` must be named in `vitest.db.config.ts`) and the
 * CI jobs. Both answer the question "is this file collected by the RIGHT
 * suite?". Neither answers "is this file collected by ANY suite?". A test file
 * that is written, committed, and matches none of the three configs' globs runs
 * nowhere: it is green by absence, and in every report the project produces it
 * is indistinguishable from a passing suite.
 *
 * THIS IS PREVENTION, NOT A FIX. Measured on this branch with this file
 * tracked: 27 tracked test files, 0 orphans. The card that raised this work
 * states the same measurement on `origin/main` at `c6de1d7` (21 collected by
 * the unit config, 6 by the db config, 3 by Playwright, 0 orphans). So nothing
 * is broken today; this guard makes the next orphaned file fail the build
 * instead of passing silently.
 *
 * WHY IT FAILS RATHER THAN SKIPS, AND WHY IT NEEDS NO DATABASE. It runs in the
 * default `verify` job (`.github/workflows/ci.yml`), which has no Postgres. A
 * guard that only ran where a database exists would be the B37 defect repeated:
 * a check that is skipped in the job that must enforce it.
 *
 * WHY THE CONFIGS ARE PARSED AS TEXT AND NEVER IMPORTED — a measured defect,
 * not a preference. `db-suite-registry.test.ts` records, from an executed
 * measurement on this repository, that importing `vitest.db.config.ts` from a
 * default-suite test drags esbuild into the jsdom environment and fails with
 * `Invariant violation: "new TextEncoder().encode("") instanceof Uint8Array" is
 * incorrectly false`, taking the whole `verify` suite red. So every config is
 * read as a string off disk and parsed, and nothing here imports `vitest/config`
 * or `@playwright/test`.
 *
 * WHY COMMENTS ARE STRIPPED BEFORE THE GLOBS ARE LOCATED. The first text parse
 * shipped in this repository's registry guard matched the FIRST `include:`
 * anywhere in the file, comments included. QA executed the probe: one decoy
 * comment line above `defineConfig` with the real entry deleted left the guard
 * green, exit 0, while nothing at all was collected. Comments are not source.
 * Every half of the anchoring is pinned by a test at the bottom of this file,
 * so loosening it fails here rather than being discovered by the defect
 * returning.
 *
 * HOW "COLLECTED" IS DECIDED. Tracked files come from `git ls-files` — an
 * UNTRACKED file is not a defect, it is work in progress, and this guard must
 * not turn a developer's scratch file into a red suite. Collected files are
 * derived by matching each tracked path against the globs as WRITTEN in the
 * three configs: `test.include` in `vitest.config.ts`, `test.include` in
 * `vitest.db.config.ts` (including its `db/**` entry, which is how the three
 * `db/__tests__` files are covered), and Playwright's `testDir` + `testMatch`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const UNIT_CONFIG_PATH = path.join(REPO_ROOT, "vitest.config.ts");
const DB_CONFIG_PATH = path.join(REPO_ROOT, "vitest.db.config.ts");
const PLAYWRIGHT_CONFIG_PATH = path.join(REPO_ROOT, "playwright.config.ts");

/** A tracked file is a test file for this guard if it ends in `.test.*`/`.spec.*`. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Strip JS comments, leaving string literals intact.
 *
 * A walk rather than `source.replace(/\/\/.*$/gm, "")`, because truncating a
 * line at `//` deletes the rest of it — which is exactly how a registry entry
 * would silently vanish. This is the same argument, and the same fix, as
 * `stripComments` in `db-suite-registry.test.ts`; it is duplicated rather than
 * imported because importing another TEST file would collect it into this
 * suite, which is the opposite of what this guard is for.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (i < source.length) {
    const char = source[i] ?? "";
    if (quote) {
      out += char;
      if (char === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += "\n";
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * The `test: { ... }` block, comment-stripped.
 *
 * Anchored on the `test` key so a sibling `include` — a `test.coverage.include`,
 * or any future key that happens to be called `include` — is never read as the
 * collection list. QA measured that failure on the sibling guard: a
 * `test.coverage.include` above `test.include` made a first-match parse read
 * THAT array and pass vacuously. The block ends at the first sibling key at the
 * same brace depth (`resolve:`), with depth tracked so a nested key of the same
 * name cannot terminate it early.
 */
function readTestBlock(source: string, configName: string): string {
  const keyMatch = /(^|[\s,{])test\s*:/.exec(source);
  if (!keyMatch || keyMatch.index === undefined) {
    throw new Error(
      `Could not find a \`test:\` block in ${configName}. If the config's ` +
        "shape changed, this guard must be updated to read it — do not delete " +
        "the guard.",
    );
  }
  const start = source.indexOf("{", keyMatch.index + keyMatch[0].length);
  if (start === -1) {
    throw new Error(`\`test:\` in ${configName} is not an object literal.`);
  }
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`\`test:\` block in ${configName} is never closed.`);
}

/**
 * The body of the `include:` array sitting DIRECTLY inside the `test:` block, or
 * null if there is none. Depth-1 only, for the shadowing reason above.
 */
function findTestIncludeArray(block: string, configName: string): string {
  let depth = 0;
  for (let i = 0; i < block.length; i += 1) {
    const char = block[i];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;
    const match = /(^|[\s,{])include\s*:\s*\[/.exec(block.slice(i));
    if (match && match.index === 0) {
      const open = i + block.slice(i).indexOf("[") + 1;
      const close = block.indexOf("]", open);
      if (close !== -1) return block.slice(open, close);
    }
  }
  throw new Error(
    `Could not find an \`include: [...]\` array directly inside the \`test:\` ` +
      `block of ${configName}. If the config's shape changed, this guard must ` +
      "be updated to read it — do not delete the guard.",
  );
}

/** The include patterns of a Vitest config, read as TEXT. Never imported. */
function vitestIncludes(configPath: string): string[] {
  const source = stripComments(readFileSync(configPath, "utf8"));
  const body = findTestIncludeArray(
    readTestBlock(source, configPath),
    configPath,
  );
  return [...body.matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((pattern): pattern is string => pattern !== undefined);
}

/** A top-level string-valued key of the config object, comment-stripped. */
function topLevelStringValue(source: string, key: string): string {
  const match = new RegExp(`(^|[\\s,{])${key}\\s*:\\s*["']([^"']+)["']`).exec(
    source,
  );
  if (!match || match[2] === undefined) {
    throw new Error(
      `Could not read a top-level \`${key}: "<string>"\` out of ` +
        `${PLAYWRIGHT_CONFIG_PATH}. If the config's shape changed, this guard ` +
        "must be updated to read it — do not delete the guard.",
    );
  }
  return match[2];
}

/**
 * The SOURCE TEXT of Playwright's `testMatch` regex literal, comment-stripped.
 *
 * Read as text for the same reason the includes are: importing
 * `@playwright/test` from a default-suite jsdom test is exactly the import that
 * took `db-suite-registry.test.ts`'s suite red.
 */
function playwrightTestMatchSource(source: string): string {
  const match = /(^|[\s,{])testMatch\s*:\s*\/((?:[^/\\\n]|\\.)*)\/[a-z]*/.exec(
    source,
  );
  if (!match || match[2] === undefined) {
    throw new Error(
      `Could not read \`testMatch: /.../\` out of ${PLAYWRIGHT_CONFIG_PATH}. If ` +
        "the config's shape changed, this guard must be updated to read it — " +
        "do not delete the guard.",
    );
  }
  return match[2];
}

/**
 * Translate one config glob into a matcher for a repo-relative POSIX path.
 *
 * Supports `**`, `*` and `{a,b}` alternation — the three tokens the three
 * configs actually use (`src/` + `**` + `.test.{ts,tsx}` needs the last of
 * them). Any
 * other token THROWS rather than silently failing to match: a token this guard
 * does not implement would stop matching, turn a collected file into an
 * apparent orphan, and produce a false positive. A false positive fails loudly
 * and is fixable; the half-understood-matcher failure mode is a silent
 * false-negative, which is the defect this file exists to catch.
 */
function globToRegExp(pattern: string): RegExp {
  const unsupported = (token: string): never => {
    throw new Error(
      `Config glob \`${pattern}\` uses \`${token}\`, a token this guard does ` +
        "not implement. Extend globToRegExp rather than loosening the guard.",
    );
  };
  const literal = (char: string): string =>
    char.replace(/[.*+?^${}|()\\]/g, "\\$&");

  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        // `**/` may also match zero directories, so `src/**/x.test.ts` matches
        // `src/x.test.ts` exactly as the real globber does.
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) unsupported("{");
      const options = pattern.slice(i + 1, close).split(",");
      source += `(?:${options.map(literal).join("|")})`;
      i = close;
      continue;
    }
    if ("?[]!+@()".includes(char)) unsupported(char);
    source += literal(char);
  }
  return new RegExp(`^${source}$`);
}

/** Do any of these globs collect this repo-relative path? */
function collectedBy(patterns: string[], relativePath: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

/**
 * Every TRACKED test file, repo-relative POSIX, sorted.
 *
 * `git ls-files` on the repo root, so this is the committed index — an untracked
 * file is not a defect, and must not be reported as one. `-z` plus an explicit
 * NUL split, so a path containing a space or a quote cannot split into two
 * entries and half a glob match can never hide behind it.
 */
function trackedTestFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .filter((entry) => TEST_FILE.test(entry))
    .sort();
}

/**
 * Which suite collects each tracked test file. Returns the three collected
 * sets plus the orphan set — `tracked - (unit ∪ db ∪ playwright)`, which is the
 * set that must be empty.
 */
function classify(
  tracked: string[],
  unitPatterns: string[],
  dbPatterns: string[],
  testDir: string,
  testMatch: RegExp,
) {
  const unit: string[] = [];
  const db: string[] = [];
  const playwright: string[] = [];
  const orphans: string[] = [];

  for (const file of tracked) {
    // Playwright matches `testMatch` against the path RELATIVE to `testDir`,
    // which is why the discrimination below is expressed that way.
    const relativeToTestDir = file.startsWith(`${testDir}/`)
      ? file.slice(testDir.length + 1)
      : null;
    const inUnit = collectedBy(unitPatterns, file);
    const inDb = collectedBy(dbPatterns, file);
    const inPlaywright =
      relativeToTestDir !== null && testMatch.test(relativeToTestDir);

    if (inUnit) unit.push(file);
    if (inDb) db.push(file);
    if (inPlaywright) playwright.push(file);
    if (!inUnit && !inDb && !inPlaywright) orphans.push(file);
  }
  return { unit, db, playwright, orphans };
}

/** The shipped classification, computed once from the real configs and index. */
function shippedClassification() {
  const unitPatterns = vitestIncludes(UNIT_CONFIG_PATH);
  const dbPatterns = vitestIncludes(DB_CONFIG_PATH);
  const playwrightSource = stripComments(
    readFileSync(PLAYWRIGHT_CONFIG_PATH, "utf8"),
  );
  const testDir = path
    .normalize(topLevelStringValue(playwrightSource, "testDir"))
    .split(path.sep)
    .join("/");
  const testMatch = new RegExp(playwrightTestMatchSource(playwrightSource));
  return {
    unitPatterns,
    dbPatterns,
    testDir,
    testMatch,
    tracked: trackedTestFiles(),
    ...classify(
      trackedTestFiles(),
      unitPatterns,
      dbPatterns,
      testDir,
      testMatch,
    ),
  };
}

describe("no tracked test file is collected by NO suite", () => {
  const shipped = shippedClassification();

  it("reads a non-empty include array out of BOTH Vitest configs", () => {
    // If either array were empty the difference below would shrink to zero
    // without anything being wrong, and this guard would go green on a config
    // that collects nothing. That is precisely the failure mode measured
    // against the sibling guard (QA's decoy probe: green, exit 0, nothing
    // collected), so it is asserted here rather than left to a comment.
    expect(shipped.unitPatterns.length).toBeGreaterThan(0);
    expect(shipped.dbPatterns.length).toBeGreaterThan(0);
  });

  it("reads testDir and testMatch out of the Playwright config", () => {
    expect(shipped.testDir).toBe("e2e");
    expect(shipped.testMatch.test("home.spec.ts")).toBe(true);
  });

  it("sees more than 20 tracked test files (non-vacuity floor)", () => {
    // If `git ls-files` returned nothing, the orphan assertion below would be
    // trivially satisfied.
    expect(shipped.tracked.length).toBeGreaterThan(20);
  });

  it("has a non-empty collected set per config (non-vacuity floors)", () => {
    // Deleting the whole `include:` array from either Vitest config, or
    // emptying `testDir`/`testMatch`, must turn THIS file red rather than
    // silently reducing the difference to zero.
    expect(shipped.unit.length).toBeGreaterThanOrEqual(10);
    expect(shipped.db.length).toBeGreaterThanOrEqual(1);
    expect(shipped.playwright.length).toBeGreaterThanOrEqual(1);
  });

  it("collects every tracked test file in at least one suite", () => {
    const orphans = shipped.orphans;
    expect(
      orphans,
      orphans.length === 0
        ? undefined
        : [
            "These TRACKED test files are collected by NO suite — no vitest",
            "config and no Playwright config picks them up, so they run",
            "nowhere while looking green by absence:",
            "",
            ...orphans.map((file) => `  - ${file}`),
            "",
            "Add the path to `test.include` in vitest.config.ts, to",
            "`test.include` in vitest.db.config.ts, or rename/move it into a",
            "glob one of them already collects. Do not delete the guard.",
          ].join("\n"),
    ).toEqual([]);
  });

  it("counts a db/** test as collected by the db config, not an orphan", () => {
    // c6: `db/**/__tests__/**/*.test.ts` lives in the db config's include, so
    // those files must never be reported. Asserted against the real config so
    // dropping that glob goes red here rather than as a surprise orphan list.
    const dbGlob = shipped.dbPatterns.find((pattern) =>
      pattern.startsWith("db/"),
    );
    expect(dbGlob).toBeDefined();
    expect(
      collectedBy(
        [dbGlob as string],
        "db/__tests__/canonical-events-persistence.test.ts",
      ),
    ).toBe(true);
    expect(shipped.orphans.some((file) => file.startsWith("db/"))).toBe(false);
  });

  it("distinguishes a unit-collected e2e .test.ts from a Playwright .spec.ts", () => {
    // c5, and the false positive this card warns about: `e2e/**` is in the
    // UNIT config's include, so `e2e/support/__tests__/hydration.test.ts` is a
    // genuinely covered unit test, while `e2e/*.spec.ts` is Playwright's.
    // Reading those two backwards reports a covered file as an orphan.
    const hydration = "e2e/support/__tests__/hydration.test.ts";
    const spec = "e2e/home.spec.ts";

    expect(collectedBy(shipped.unitPatterns, hydration)).toBe(true);
    expect(collectedBy(shipped.dbPatterns, hydration)).toBe(false);
    expect(shipped.testMatch.test(hydration.slice("e2e/".length))).toBe(false);

    expect(collectedBy(shipped.unitPatterns, spec)).toBe(false);
    expect(shipped.testMatch.test(spec.slice("e2e/".length))).toBe(true);

    // And in the real classification both are collected, by exactly one suite.
    expect(shipped.unit).toContain(hydration);
    expect(shipped.playwright).toContain(spec);
    expect(shipped.orphans).not.toContain(hydration);
    expect(shipped.orphans).not.toContain(spec);
  });

  it("reports a deliberately orphaned file BY NAME (the negative control)", () => {
    // The mechanism, exercised against a synthetic file rather than only a real
    // one: c4 additionally runs this for real, by writing an orphaned file to
    // disk and re-running the suite. A path no glob matches must land in the
    // orphan set under its own name.
    const probe = "src/__tests__/orphan-probe.orphan.ts";
    expect(collectedBy(shipped.unitPatterns, probe)).toBe(false);
    expect(collectedBy(shipped.dbPatterns, probe)).toBe(false);

    const classified = classify(
      [...shipped.tracked, probe],
      shipped.unitPatterns,
      shipped.dbPatterns,
      shipped.testDir,
      shipped.testMatch,
    );
    expect(classified.orphans).toEqual([probe]);
    // And adding the orphan must not change what the real suites collect.
    expect(classified.unit).toEqual(shipped.unit);
  });

  it("a decoy include inside a comment collects nothing", () => {
    // The QA probe that defeated the first text parse in this repository,
    // reproduced here as config TEXT: with the real array deleted and only the
    // decoy comment line present, the db config contributes nothing and every
    // `db/**` test becomes an apparent orphan.
    const decoy = [
      '// decoy: include: ["src/lib/db/__tests__/client.test.ts"]',
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({",
      "  test: {",
      "    environment: 'node',",
      "  },",
      "});",
    ].join("\n");
    // The read THROWS rather than reporting an empty registry, which is the
    // louder of the two acceptable outcomes and the same one
    // `db-suite-registry.test.ts` settled on: a config with no `include:` at all
    // is a broken config, and this guard must not read it as "nothing to
    // check". The decoy comment therefore registers nothing AND is not mistaken
    // for an array.
    expect(() => vitestIncludesFromSource(decoy)).toThrow(/include/);

    // And the shipped db config really does carry the entries, so the decoy is
    // the only thing that ever claimed otherwise.
    expect(shipped.dbPatterns.some((p) => p.includes("client.test.ts"))).toBe(
      true,
    );
  });

  it("reads the test block's include, not a shadowing sibling include key", () => {
    // The second instance of the same root cause: a `test.coverage.include`
    // sitting above `test.include` made the earlier first-match parse read
    // THAT array. Here both arrays are in one config source.
    const shadowing = [
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({",
      "  test: {",
      '    coverage: { include: ["src/**/*.ts"] },',
      '    include: ["src/app/api/sync/__tests__/handler.test.ts"],',
      "  },",
      "  resolve: { alias: {} },",
      "});",
    ].join("\n");
    expect(vitestIncludesFromSource(shadowing)).toEqual([
      "src/app/api/sync/__tests__/handler.test.ts",
    ]);
  });

  it("throws rather than reading a glob set out of a shapeless config", () => {
    expect(() =>
      vitestIncludesFromSource("export default { resolve: {} };"),
    ).toThrow(/test:/);
    expect(() =>
      vitestIncludesFromSource(
        "export default { test: { environment: 'node' } };",
      ),
    ).toThrow(/include/);
  });

  it("does not truncate a config line containing // inside a string", () => {
    // Why `stripComments` is a walk: truncating at `//` deletes the rest of the
    // line, which is how a glob would silently vanish.
    const urlConfig = [
      "export default {",
      "  test: {",
      '    include: ["src/legacy.test.ts", "https://example.test/a"],',
      "  },",
      "};",
    ].join("\n");
    expect(vitestIncludesFromSource(urlConfig)).toEqual([
      "src/legacy.test.ts",
      "https://example.test/a",
    ]);
  });

  it("throws on a glob token it does not implement instead of under-matching", () => {
    expect(() => globToRegExp("src/**/*.{test,spec}?.ts")).toThrow(/token/);
    // The tokens it does implement, including the brace form the shipped
    // configs rely on.
    expect(globToRegExp("src/**/*.test.{ts,tsx}").test("src/a.test.tsx")).toBe(
      true,
    );
    expect(
      globToRegExp("db/**/__tests__/**/*.test.ts").test(
        "db/__tests__/canonical-events-persistence.test.ts",
      ),
    ).toBe(true);
    expect(
      globToRegExp("src/**/*.test.{ts,tsx}").test("db/__tests__/x.test.ts"),
    ).toBe(false);
  });
});

/** `vitestIncludes` on already-read source, so the decoy probes can use it. */
function vitestIncludesFromSource(source: string): string[] {
  const body = findTestIncludeArray(
    readTestBlock(stripComments(source), "<inline probe>"),
    "<inline probe>",
  );
  return [...body.matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((pattern): pattern is string => pattern !== undefined);
}
