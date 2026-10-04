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
 * HOW IT READS THE REGISTRY — A COMMENT-STRIPPED, `test:`-ANCHORED TEXT PARSE.
 *
 * It does not import the config. That was implemented and measured: importing
 * `vitest.db.config.ts` from a test in the default suite drags esbuild into the
 * jsdom environment and fails the file with `Invariant violation: "new
 * TextEncoder().encode("") instanceof Uint8Array" is incorrectly false`, taking
 * the whole `verify` suite red. So the registry is read out of the file, and
 * the read is anchored tightly because an earlier version of it was not:
 *
 * A first-match parse of `include:` is satisfied by a COMMENT. One line
 * `// decoy: include: ["src/lib/db/__tests__/client.test.ts"]` above
 * `defineConfig`, with the real entry deleted, leaves a config that collects no
 * db-backed test under `src/**` at all — while the guard reads the decoy, sees
 * the file "registered", and stays green. That is B37's own defect reproduced
 * inside the guard written to close it. QA measured it; the two regression
 * tests at the bottom of this file pin both halves of the fix, so the parse bug
 * cannot return unnoticed.
 *
 * The TEST FILES are also read as bytes off disk and never imported — a test
 * file is not a module to be executed for its metadata, and reading it as text
 * is what lets this guard exist without collecting the very tests it polices
 * into the default suite.
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
 * Strip JS comments from config source, leaving string literals intact.
 *
 * A naive `source.replace(/\/\/.*$/gm, "")` corrupts a line whose string
 * contains `//` (a URL, say) by truncating it — and corrupting a LINE is
 * precisely how a registry entry would go missing. So this walks the source
 * once, tracking whether it is inside a string, a template literal or a
 * comment, and only removes comment characters.
 *
 * Regex literals are not tracked: no comment or string delimiter inside one can
 * end this walk early in practice for a config of this shape, and a config with
 * a `/` inside a regex literal would need the comment-only `include:` line to
 * sit in a regex to be affected. `readTestBlock` throws if it cannot find the
 * block, which is the loud direction.
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
      // Preserve newlines so line-anchored reasoning downstream still holds.
      out += "\n";
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * The `test: { ... }` block of `vitest.db.config.ts`, comment-stripped.
 *
 * Anchoring to the `test` key is what keeps a sibling `include` — a
 * `test.coverage.include`, or any future key that happens to be called
 * `include` — from being read as the registry. QA demonstrated that failure:
 * an innocuous `test.coverage.include` upstream of `test.include` made the
 * first-match parse read THAT array, so every `src/**` test looked registered
 * and the guard's main assertion passed vacuously.
 *
 * The block runs from the `test:` key to the first sibling key at the same
 * brace depth (`resolve:` here). Depth is tracked so a nested key of the same
 * name inside `test:` cannot terminate the block early.
 */
function readTestBlock(source: string): string {
  const keyMatch = /(^|[\s,{])test\s*:/.exec(source);
  if (!keyMatch || keyMatch.index === undefined) {
    throw new Error(
      `Could not find a \`test:\` block in ${DB_CONFIG_PATH}. If the db ` +
        "config's shape changed, this guard must be updated to read it — do " +
        "not delete the guard.",
    );
  }
  const start = source.indexOf("{", keyMatch.index + keyMatch[0].length);
  if (start === -1) {
    throw new Error(`\`test:\` in ${DB_CONFIG_PATH} is not an object literal.`);
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
  throw new Error(`\`test:\` block in ${DB_CONFIG_PATH} is never closed.`);
}

/**
 * The body of the `include:` array that sits DIRECTLY inside the `test:`
 * block, or null if there is none.
 *
 * Depth matters as much as the `test:` anchor. `test.coverage.include` is a
 * key named `include` nested INSIDE `test:` — a perfectly innocent thing for a
 * config to have — and QA showed that reading it in place of the registry makes
 * every `src/**` test read as registered, turning the guard's main assertion
 * vacuously true. So this tracks brace depth and only accepts the `include` key
 * at depth 1.
 */
function findTestIncludeArray(block: string): string | null {
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
  return null;
}

/**
 * The include patterns, read back out of `vitest.db.config.ts`.
 *
 * Three defects this read was measured to have, and all are now closed:
 *
 *   1. It matched the FIRST `include:` anywhere in the file, comments included.
 *      QA's probe added `// decoy: include: ["…/client.test.ts"]` above
 *      `defineConfig` and deleted the real entry; `bun run test:db` then
 *      collected nothing from `src/**` while the guard stayed green — 5 passed,
 *      exit 0 — and every suite in the repository reported success. The
 *      repository's only proof that the shipped migration yields a usable table
 *      was not running anywhere. Comments are stripped before the array is
 *      located, so a decoy line is not source.
 *   2. Any earlier `include` key shadowed the registry (see `readTestBlock`).
 *   3. A NESTED `include` — `test.coverage.include` — shadowed it too (see
 *      `findTestIncludeArray`).
 *
 * The alternative QA preferred — importing the config and reading
 * `config.test.include` — was implemented first and REJECTED BY EXECUTION here:
 * importing `vitest.db.config.ts` from a default-suite test drags esbuild into
 * the jsdom environment, which fails that file with
 * `Invariant violation: "new TextEncoder().encode("") instanceof Uint8Array" is
 * incorrectly false` and takes the whole `verify` suite red (18 files, 329
 * passed, 1 FAILED suite, exit 1). That is the trade: a text read must be
 * anchored precisely, and every failure mode above is an asserted test at the
 * bottom of this file, so a future loosening of the anchoring is caught rather
 * than discovered by the defect returning.
 *
 * Test files are read as bytes off disk and never imported, for the same
 * environmental reason plus a second one: reading them as text is what lets
 * this guard exist without collecting the very tests it polices into the
 * default suite.
 *
 * The `db/**` entry is dropped — the db suite collects that directory by design,
 * and this guard is only about tests OUTSIDE `db/**`.
 */
function registeredSrcEntries(
  configSource: string = readFileSync(DB_CONFIG_PATH, "utf8"),
): string[] {
  const arrayBody = findTestIncludeArray(
    readTestBlock(stripComments(configSource)),
  );
  if (arrayBody === null) {
    throw new Error(
      `Could not find an \`include: [...]\` array directly inside the ` +
        `\`test:\` block of ${DB_CONFIG_PATH}. If the db config's shape ` +
        "changed, this guard must be updated to read it — do not delete the " +
        "guard.",
    );
  }
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

  it("a decoy `include: [...]` inside a comment registers nothing", () => {
    // QA found this by executing it against the shipped config: with a decoy
    // line `// decoy: include: ["src/lib/db/__tests__/client.test.ts"]` above
    // `defineConfig` and the real entry deleted, the old first-match text parse
    // read the COMMENT, `bun run test:db` collected nothing from `src/**`, and
    // the guard stayed green — 5 passed, exit 0. The repository's only proof
    // that the shipped migration yields a usable table was not running anywhere
    // and every suite in the repository reported success.
    //
    // QA's exact probe, reproduced here as a config source: the decoy names
    // `client.test.ts` and the real array is GONE, so under the current read
    // nothing is registered and the file must be reported unregistered.
    const decoyConfig = [
      '// decoy: include: ["src/lib/db/__tests__/client.test.ts"]',
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({",
      "  test: {",
      '    include: ["db/**/__tests__/**/*.test.ts"],',
      "  },",
      "});",
    ].join("\n");

    expect(registeredSrcEntries(decoyConfig)).toEqual([]);
    // And the real config still registers it — the decoy is the only thing that
    // ever claimed to, which is why stripping comments is load-bearing.
    expect(
      entries.some((pattern) =>
        matchesPattern("src/lib/db/__tests__/client.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("reads the `test:` block's include, not an earlier sibling include key", () => {
    // The second instance of the same root cause: a `test.coverage.include`
    // sitting above `test.include` made the old first-match parse read THAT
    // array, which made every `src/**` test read as registered and turned the
    // main assertion vacuously true. QA reproduced it against the shipped file.
    //
    // Here the two arrays are in one config source. The registry is the
    // `include` directly inside `test:`, i.e. the named-file list that keeps
    // `composition-root.test.ts` out of the db job — NOT the coverage glob,
    // which would drag it in.
    const shadowingConfig = [
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({",
      "  test: {",
      '    coverage: { include: ["src/**/*.ts"] },',
      '    include: ["src/lib/db/__tests__/client.test.ts"],',
      "  },",
      "  resolve: { alias: {} },",
      "});",
    ].join("\n");

    expect(registeredSrcEntries(shadowingConfig)).toEqual([
      "src/lib/db/__tests__/client.test.ts",
    ]);
    // Same config with the coverage glob placed at the `test:` level — the read
    // is anchored, so only a key INSIDE `test:` named `include` counts.
    const coverageFirst = shadowingConfig.replace(
      '    coverage: { include: ["src/**/*.ts"] },\n',
      "",
    );
    expect(registeredSrcEntries(coverageFirst)).toEqual([
      "src/lib/db/__tests__/client.test.ts",
    ]);
    // And the shipped registry really is a named-file list, not a src glob.
    expect(entries).not.toContain("src/**/*.ts");
  });

  it("throws rather than reading an empty registry out of a shapeless config", () => {
    // A decoy-only config still HAS a real `include:` in `test:`, so the throw
    // cases are a missing `test:` block and a `test:` block with no include.
    expect(() =>
      registeredSrcEntries("export default { resolve: {} };"),
    ).toThrow(/test:/);
    expect(() =>
      registeredSrcEntries("export default { test: { environment: 'node' } };"),
    ).toThrow(/include/);
  });

  it("does not truncate a registry line that contains // inside a string", () => {
    // The reason `stripComments` is a walk and not
    // `source.replace(/\/\/.*$/gm, "")`: truncating at `//` deletes the REST of
    // the line, which is how an entry would silently vanish.
    const urlConfig = [
      "export default {",
      "  test: {",
      '    include: ["src/legacy.test.ts", "https://example.test/a"],',
      "  },",
      "};",
    ].join("\n");
    expect(registeredSrcEntries(urlConfig)).toEqual([
      "src/legacy.test.ts",
      "https://example.test/a",
    ]);
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
