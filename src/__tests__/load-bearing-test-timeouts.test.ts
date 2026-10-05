/**
 * THE REGRESSION GUARD for per-test timeouts (B53).
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────
 *
 * `vitest.config.ts` sets no `testTimeout`, so every test inherits Vitest's
 * built-in 5000ms. That default is correct for the ~600 tests that do in-process
 * work and wrong for the ~20 that spawn a real subprocess or rebuild a real
 * module graph: those pay for a Node/Bun cold start, for a formatter reading
 * `node_modules`, or for `vi.resetModules()` re-importing the route and the
 * Drizzle writer, none of which is the code under test and all of which
 * stretches with machine load.
 *
 * The result is that `bun run test` goes red with
 * `Error: Test timed out in 5000ms.` for reasons that have nothing to do with
 * the code. Measured on this repo, at batch-15's head, four concurrent full
 * suites produced 12-15 timeouts per run, all in tests whose assertions are
 * sound -- the same files pass in isolation. A suite whose red does not mean a
 * broken assertion is a suite nobody can trust, and the failure mode is silent:
 * the next engineer learns to re-run, then to ignore red.
 *
 * B53 fixed the known instances by hand. This guard is what stops the next one
 * from being born: a test that spawns a subprocess, or rebuilds a module graph
 * per case, and does not name one of the measured budgets, FAILS HERE. The
 * author of the next load-sensitive test meets that failure at authoring time
 * rather than at a full-suite run on a loaded machine in six weeks.
 *
 * ── WHY THIS IS A TEXT SCAN AND NOT A RUNTIME CHECK ─────────────────────
 *
 * For the same reason `no-orphaned-test-files.test.ts` parses
 * `vitest.config.ts` as text: executing a config or a test file from inside a
 * running jsdom test drags a module graph into the runner, which is a measured
 * failure in this repo (`db-suite-registry.test.ts` records the exact error).
 * It is also the only way to see the fact that matters: that a test file
 * contains a `spawnSync`, and that the test wrapping it names no budget. The
 * call is usually behind a helper (`runScanner()`, `git()`), so no runtime
 * introspection of the suite could connect the spawn to the timeout.
 *
 * ── WHY IT ASSERTS ON BEHAVIOUR, NOT ON A LIST OF FILE PATHS ────────────
 *
 * A hardcoded list of the files B53 happened to touch would rot on the first
 * new subprocess test: the guard would still be green, still asserting only
 * about files that were already correct, and the new test would inherit 5000ms
 * silently. This guard instead DISCOVERS the load-sensitive tests from the
 * source text, so a file nobody has heard of is covered the day it is written.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LOAD_BEARING_TEST_TIMEOUT } from "@/core/testing/load-bearing-test-timeout";

const THIS_FILE = path.resolve(__dirname, "load-bearing-test-timeouts.test.ts");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Directories whose tests run in the DEFAULT `bun run test` suite. */
const SCANNED_ROOTS: readonly string[] = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "scripts"),
  path.join(REPO_ROOT, "e2e"),
];

const TEST_FILE = /\.test\.[jt]sx?$/;

/**
 * Markers of work whose duration is a property of the MACHINE, not of the code
 * under test. Each is a real subprocess spawn, a real external binary read, or a
 * full module-graph rebuild.
 *
 * `useFakeTimers` is deliberately absent: a fake-timer test does not get slower
 * because the machine is loaded, it gets *deterministic*, which is the opposite
 * problem and is not this guard's business.
 */
const LOAD_SCALED_MARKERS: readonly {
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  { pattern: /\bspawnSync\s*\(/, why: "spawns a subprocess (a Node/Bun cold start per call)" },
  { pattern: /\bexecSync\s*\(/, why: "spawns a subprocess (a Node/Bun cold start per call)" },
  { pattern: /\bexecFileSync\s*\(/, why: "spawns a subprocess (git, the scanner CLI, ...)" },
  { pattern: /\bspawn\s*\(/, why: "spawns a subprocess" },
  { pattern: /\bexecFile\s*\(/, why: "spawns a subprocess" },
  { pattern: /Bun\.spawn\s*\(/, why: "spawns a subprocess" },
  { pattern: /vi\.resetModules\s*\(\s*\)/, why: "rebuilds a module graph per case, so its cost scales with load" },
];

/** How a test names a measured budget. Both spellings are accepted. */
const BUDGET_REFERENCE = /LOAD_BEARING_TEST_TIMEOUT\s*\.\s*[A-Za-z0-9_]+|\{\s*timeout\s*:/;

/**
 * Blank out comments and string/template literal CONTENTS, keeping the
 * characters' positions so offsets stay valid.
 *
 * This is what stops the guard from being satisfiable or trippable by the WORD
 * rather than the call: a file that documents `spawnSync` in a doc comment, or
 * asserts on a string that happens to contain it, must read as clean. A guard
 * that can be satisfied by writing the word is not a guard.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let index = 0;
  let lastSignificant = "";
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  while (index < source.length) {
    const rest = source.slice(index);
    const two = rest.slice(0, 2);
    if (two === "//") {
      const end = rest.indexOf("\n");
      const stop = end === -1 ? rest.length : end;
      out += blank(rest.slice(0, stop));
      index += stop;
      continue;
    }
    if (two === "/*") {
      const end = rest.indexOf("*/", 2);
      const stop = end === -1 ? rest.length : end + 2;
      out += blank(rest.slice(0, stop));
      index += stop;
      continue;
    }
    // A `/` that follows nothing or an operator opens a REGEX literal, not a
    // division. Without this, a pattern like /["'`]([^"'`]*)/ would be read as a
    // string starting at its first quote and every subsequent quote in the file
    // would be paired wrongly, desynchronising the whole scan.
    //
    // Checked AFTER the two comment forms on purpose: a regex literal cannot
    // begin `//` (that is an empty regex) or `/*` (that closes nothing), so
    // comment detection can never shadow a real literal. The reverse order does:
    // with the comment inside the `{` of a describe callback, every `//` comment
    // in the file would be read as an unterminated regex and swallow the code
    // after it -- which is how a comment above an `it(` deleted the test.
    if (rest[0] === "/" && /[(=,:[!&|?{};+\n]|\breturn\b/.test(lastSignificant)) {
      let cursor = 1;
      let inClass = false;
      while (cursor < rest.length) {
        if (rest[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (rest[cursor] === "[") inClass = true;
        else if (rest[cursor] === "]") inClass = false;
        else if (rest[cursor] === "/" && !inClass) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      const literal = rest.slice(0, cursor);
      out += "/" + blank(literal.slice(1, literal.length - 1)) + literal.slice(-1);
      index += cursor;
      lastSignificant = "/";
      continue;
    }
    const quote = /^["'`]/.exec(rest);
    if (quote) {
      const q = quote[0];
      let cursor = 1;
      while (cursor < rest.length) {
        if (rest[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (rest[cursor] === q) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      const literal = rest.slice(0, cursor);
      // Keep the quotes so a template spanning lines still ends on its own
      // line; blank everything between them.
      out += q + blank(literal.slice(1, literal.length - 1)) + literal.slice(-1);
      index += cursor;
      lastSignificant = q;
      continue;
    }
    if (!/\s/.test(rest[0] ?? "")) lastSignificant = rest[0] ?? "";
    out += source[index];
    index += 1;
  }
  return out;
}

/**
 * The lines a test owns: from its `it(`/`test(` line to the line before the
 * next one at the SAME OR SHALLOWER indentation.
 *
 * Deliberately textual rather than brace-balanced. Brace balancing over source
 * that has already had its strings blanked desynchronises on any arrow whose
 * parameter list contains a brace, and when it desynchronises it swallows the
 * REST OF THE FILE into one test's body -- which is how "clears a leftover
 * canary" came to be reported as spawning a subprocess. Indentation is
 * predictable, and it errs in the safe direction: a boundary that is one line
 * too generous makes the guard FLAG a test, never silently pass one, and a
 * false flag is a comment in the next commit rather than a flaky red suite in
 * six weeks.
 */
function ownedLines(lines: readonly string[], start: number, indent: number): string[] {
  const owned: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    if (index > start) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0) {
        owned.push(line);
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      const opens = /^[ \t]*(?:it|test|describe|describe[.]each)\b/.test(line);
      if (lineIndent <= indent && (opens || !/^[ \t]*(?:it|test)\b/.test(line))) break;
    }
    owned.push(lines[index] ?? "");
  }
  return owned;
}

interface LoadSensitiveTest {
  readonly file: string;
  /** 1-based line of the `it(`/`test(` that opens the test. */
  readonly line: number;
  readonly name: string;
  readonly why: string;
}

const OPENING = /^[ \t]*(?:it|test)\s*(?:[.][\w.]+)?\s*\(/gm;
const NAME = /\(\s*["'`]([^"'`]*)/;

/**
 * Every `it`/`test` whose own body contains a load-scaled marker and which names
 * no budget.
 *
 * A marker in a FILE-level helper (`function runScanner()`) is attributed to the
 * tests that reach it through their own call, because the body of each `it` is
 * scanned independently. A helper shared by both a budgeted and an unbudgeted
 * test therefore flags only the unbudgeted one -- which is the honest answer,
 * since only that one inherits the 5s default for the work.
 */
function loadSensitiveTests(): LoadSensitiveTest[] {
  const offenders: LoadSensitiveTest[] = [];
  for (const file of SCANNED_ROOTS.flatMap(listTestFiles)) {
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n");
    const strippedText = stripCommentsAndStrings(raw);
    const stripped = strippedText.split("\n");
    OPENING.lastIndex = 0;
    const openings = [...strippedText.matchAll(OPENING)];
    openings.forEach((match, order) => {
      const start = match.index ?? 0;
      const startLine = strippedText.slice(0, start).split("\n").length - 1;
      const header = lines[startLine] ?? "";
      const indent = header.length - header.trimStart().length;
      // The budget may sit in the OPTIONS object between the name and the body
      // (`it("name", { timeout: ... }, () => {...})`), which lives on the header
      // line or the one after it -- not inside the body.
      const head = [header, lines[startLine + 1] ?? ""].join("\n");
      const body = ownedLines(stripped, startLine, indent).join("\n");
      const marker = LOAD_SCALED_MARKERS.find((candidate) => candidate.pattern.test(body));
      if (marker && !BUDGET_REFERENCE.test(head) && !BUDGET_REFERENCE.test(body)) {
        offenders.push({
          file: path.relative(REPO_ROOT, file),
          line: startLine + 1,
          name: NAME.exec(header)?.[1] ?? header.trim(),
          why: marker.why,
        });
      }
      void order;
    });
  }
  return offenders;
}

function listTestFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTestFiles(full);
    return TEST_FILE.test(entry.name) ? [full] : [];
  });
}

const OFFENDERS = loadSensitiveTests();

describe("every load-scaled test carries a MEASURED timeout, not the 5s default", () => {
  it("finds no test that does real subprocess or module-graph work without a budget", () => {
    // The whole guard. A new `spawnSync` with no timeout does not get a flaky
    // red suite in six weeks' time; it fails here, at authoring time.
    expect(
      OFFENDERS.map((o) => `${o.file}:${o.line} "${o.name}" (${o.why})`),
      "these tests do work whose duration scales with machine load and inherit " +
        "Vitest's 5000ms default, so they go red under full-suite load for " +
        "reasons that have nothing to do with the code. Attach one of the " +
        "budgets from src/core/testing/load-bearing-test-timeout.ts, with the " +
        "measurement that justifies it in a comment.",
    ).toEqual([]);
  });

  it("is not vacuous: the scanner still recognises every marker it claims to", () => {
    // NON-VACUITY. Without this, a scanner whose patterns stopped matching would
    // be green and the guard above would be theatre. Driven on synthetic source,
    // so it cannot pass by finding a real offender elsewhere in the tree.
    for (const marker of LOAD_SCALED_MARKERS) {
      const why = marker.why;
      expect(why.length, "a marker with no explanation is not a rule").toBeGreaterThan(0);
    }
    const samples: readonly [RegExp, string][] = [
      [/\bspawnSync\s*\(/, "spawnSync('git', [])"],
      [/\bexecSync\s*\(/, "execSync('ls')"],
      [/\bexecFileSync\s*\(/, "execFileSync('git', [])"],
      [/\bspawn\s*\(/, "spawn('git')"],
      [/\bexecFile\s*\(/, "execFile('git', [])"],
      [/Bun[.]spawn\s*\(/, "Bun.spawn([])"],
      [/vi[.]resetModules\s*\(\s*\)/, "vi.resetModules();"],
    ];
    const scanned = stripCommentsAndStrings(
      samples.map(([, code]) => `it("t", () => { ${code} });`).join("\n"),
    );
    for (const [pattern, code] of samples) {
      expect(pattern.test(scanned), `scanner missed: ${code}`).toBe(true);
    }
  });

  it("reports a test that spawns with no budget, and clears it once budgeted", () => {
    // NON-VACUITY in the direction that matters: prove the SCAN fires on a real
    // offender and that attaching a budget clears it.
    const offender = stripCommentsAndStrings(
      [
        'describe("synthetic", () => {',
        '  it("spawns without a budget", () => {',
        "    const result = spawnSync('git', ['--version']);",
        "    expect(result.status).toBe(0);",
        "  });",
        "});",
      ].join("\n"),
    );
    const body = offender;
    expect(
      LOAD_SCALED_MARKERS.some((marker) => marker.pattern.test(body)),
      "the scan must fire on a real spawn with no budget",
    ).toBe(true);
    expect(BUDGET_REFERENCE.test(body)).toBe(false);

    // The budget is attached on the RAW source, then stripped -- attaching it
    // after stripping would put it inside a blanked-out literal and the test
    // would prove nothing.
    const budgeted = stripCommentsAndStrings(
      [
        'describe("synthetic", () => {',
        '  it("spawns with a budget", { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess }, () => {',
        "    const result = spawnSync('git', ['--version']);",
        "    expect(result.status).toBe(0);",
        "  });",
        "});",
      ].join("\n"),
    );
    const head = budgeted.slice(budgeted.indexOf("it("), budgeted.indexOf("it(") + 400);
    expect(BUDGET_REFERENCE.test(head)).toBe(true);
  });

  it("does not accept a marker that appears only in a comment or a string", () => {
    // The guard reads CALLS, not words. A file that merely documents spawning, or
    // asserts on a string containing the word, must read as clean -- otherwise
    // the cheapest way to satisfy this guard is to write the word in a comment.
    const prose = stripCommentsAndStrings(
      [
        "/**",
        " * This test spawns a subprocess and calls vi.resetModules() per case,",
        " * and it reads a binary under node_modules.",
        " */",
        'describe("synthetic", () => {',
        '  it("mentions the words", () => {',
        '    expect("spawnSync(vi.resetModules())").toContain("spawnSync");',
        "  });",
        "});",
      ].join("\n"),
    );
    const body = prose.slice(prose.indexOf('it("mentions'));
    expect(
      LOAD_SCALED_MARKERS.filter((marker) => marker.pattern.test(body)).map((m) => m.why),
      "a marker inside a comment or a string literal is not real subprocess work",
    ).toEqual([]);
  });
});

describe("the budgets themselves are the measured ones, not decoration", () => {
  it("keeps every budget above the 5s default it stands in for", () => {
    // A budget at or below the global default would be theatre: the suite would
    // look as though it had raised a limit, and nothing would change.
    for (const [name, value] of Object.entries(LOAD_BEARING_TEST_TIMEOUT)) {
      expect(value, `${name} must exceed the 5000ms default it stands in for`).toBeGreaterThan(
        5_000,
      );
    }
  });

  it("orders the budgets so the larger one is the one for the worst measurement", () => {
    // `subprocessX4` exists for the one measured case that exceeded
    // `subprocess`. Swapping the values would silently re-give that test the
    // smaller budget it has already been measured blowing through.
    expect(LOAD_BEARING_TEST_TIMEOUT.subprocessX4).toBeGreaterThan(
      LOAD_BEARING_TEST_TIMEOUT.subprocess,
    );
    expect(LOAD_BEARING_TEST_TIMEOUT.moduleGraph).toBeGreaterThan(5_000);
  });

  it("names every key the budgets module exports", () => {
    // A typo'd key at a USE SITE typechecks against `as const` no better than a
    // correct one, and the guard would pass while the test kept Vitest's
    // default. This is the check that keeps the exports and their users in step.
    expect(Object.keys(LOAD_BEARING_TEST_TIMEOUT).sort()).toEqual([
      "moduleGraph",
      "subprocess",
      "subprocessX4",
    ]);
  });

  it("is not itself load-sensitive: the guard spawns nothing", () => {
    // If this file ever grew a real `spawnSync`, it would be the next offender
    // and would need its own budget. Asserting that here means the guard cannot
    // quietly acquire the defect it exists to catch.
    const self = stripCommentsAndStrings(readFileSync(THIS_FILE, "utf8"));
    for (const marker of LOAD_SCALED_MARKERS) {
      expect(marker.pattern.test(self), `${marker.why} -- this guard would need a budget`).toBe(
        false,
      );
    }
  });
});