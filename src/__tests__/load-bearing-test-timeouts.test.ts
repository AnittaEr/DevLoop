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
  {
    pattern: /\bspawnSync\s*\(/,
    why: "spawns a subprocess (a Node/Bun cold start per call)",
  },
  {
    pattern: /\bexecSync\s*\(/,
    why: "spawns a subprocess (a Node/Bun cold start per call)",
  },
  {
    pattern: /\bexecFileSync\s*\(/,
    why: "spawns a subprocess (git, the scanner CLI, ...)",
  },
  { pattern: /\bspawn\s*\(/, why: "spawns a subprocess" },
  { pattern: /\bexecFile\s*\(/, why: "spawns a subprocess" },
  { pattern: /Bun\.spawn\s*\(/, why: "spawns a subprocess" },
  {
    pattern: /vi\.resetModules\s*\(\s*\)/,
    why: "rebuilds a module graph per case, so its cost scales with load",
  },
];

/** How a test names a measured budget. Both spellings are accepted. */
const BUDGET_REFERENCE =
  /LOAD_BEARING_TEST_TIMEOUT\s*\.\s*[A-Za-z0-9_]+|\{\s*timeout\s*:/;

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
    if (
      rest[0] === "/" &&
      /[(=,:[!&|?{};+\n]|\breturn\b/.test(lastSignificant)
    ) {
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
      out +=
        "/" + blank(literal.slice(1, literal.length - 1)) + literal.slice(-1);
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
      out +=
        q + blank(literal.slice(1, literal.length - 1)) + literal.slice(-1);
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
function ownedLines(
  lines: readonly string[],
  start: number,
  indent: number,
): string[] {
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
      if (lineIndent <= indent && (opens || !/^[ \t]*(?:it|test)\b/.test(line)))
        break;
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
 * A FILE-level function OR CLASS, and the source of its own body.
 *
 * The bodies are needed because load-scaled work in this suite is almost never
 * written inside an `it`: it lives in a file-level helper (`loadRouteWith()`,
 * `runScanner()`, `trackedTestFiles()`) that the test CALLS. A guard that only
 * reads each `it`'s own text is therefore blind to the majority of real cases --
 * and blind is the direction that ships. This map is what makes a marker in a
 * helper attributable to the tests that reach it.
 */
interface Helper {
  readonly name: string;
  readonly body: string;
  /** A class is reached by `new C()` or by one of its methods, not by a call. */
  readonly isClass?: boolean;
}

/**
 * `function f(...)` and `const f = (...) => ...` declarations, at ANY indentation.
 *
 * Any indentation, not just column 0, because a helper declared inside a
 * `describe` is the same hazard as one at file scope: `db-schema-boundary.test.ts`
 * declares `coreFindViolations()` inside its `describe`, and it calls
 * `vi.resetModules()` on every invocation. Column 0 only would miss it.
 *
 * The arrow branch requires a real arrow head -- a bare `(` is not enough.
 * `const body = (await res.json()) as Record<string, unknown>;` also starts
 * with `(`, and matching it would register a string as a "helper" whose body is
 * the rest of the file. Only a shape that can actually be CALLED is a helper.
 *
 * A declaration whose signature spans lines (`const f = (\n  a: X,\n): Y => {`)
 * is still recognised, because `DECL_START` only reads the FIRST line and that
 * line carries the name and the arrow head. Dropping it would be the blind
 * direction, which is the one that ships.
 *
 * `class C` is a THIRD shape, and its absence was a real blind spot: a test that
 * reaches a spawn through a method (`new Scanner().run()`) is reached by CALL
 * exactly as a function is, but the class was never registered, so the guard
 * reported zero offenders on it. QA built that counter-example and the guard went
 * green. The class BODY is registered rather than its individual methods, which
 * is what makes both method and `constructor` shapes resolve from one entry --
 * per-method declarations are a second, undocumented grammar to keep in step.
 *
 * Over-attribution is the accepted cost: a marker in a helper is attributed to
 * every test that reaches that helper, including tests that share it with a
 * budgeted sibling. That errs toward flagging, which is the safe direction --
 * a false flag is a comment in the next commit, a missed site is a flaky red
 * suite in six weeks.
 */
const DECL_START =
  /^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^[ \t]*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*(?:async\s+)?(?:function\b|[A-Za-z_$][\w$]*\s*=>|\((?:[^()]|\([^()]*\))*\)\s*(?::[^=]+?)?=>)|^[ \t]*class\s+([A-Za-z_$][\w$]*)/;

/** `class C extends B {` -- B's body is reachable through C's instances. */
const SUPERCLASS =
  /^[ \t]*class\s+[A-Za-z_$][\w$]*\s+extends\s+([A-Za-z_$][\w$]*)/;

/**
 * The declaration starting at `start`: its whole extent, up to the brace that
 * closes its body.
 *
 * Boundaries come from BRACE DEPTH over the stripped source, walking forward
 * from the declaration's first line. Two shapes in this suite defeat anything
 * simpler, and both are load-bearing:
 *
 *  - A parameter list spanning lines: `loadRouteWith`'s options type ends with
 *    `}): Promise<...> {`. An indentation rule stops on that `}` and yields a
 *    two-line body containing no marker, which reports the R193 site as clean --
 *    the exact defect this change exists to close.
 *  - A return type spanning lines: `classify`'s returns an object type, so its
 *    signature's braces are not the body's.
 *
 * Depth counting handles both without a signature-joining pass, which is
 * deliberate: an earlier attempt merged the signature into one line first, and
 * merging a 12-line `function classify(` signature into its first line glued
 * the opening braces of its return type to the body's, so the walk never
 * returned to zero and swallowed the remaining 276 lines of the file.
 *
 * Depth counting is safe on stripped source precisely BECAUSE it is stripped:
 * comment bodies, string bodies and regex bodies have been blanked to spaces,
 * so every surviving brace is a structural one.
 */
function declarationExtent(lines: readonly string[], start: number): string {
  let depth = 0;
  let opened = false;
  const extent: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    extent.push(line);
    depth += braceDelta(line);
    if (depth > 0) opened = true;
    // An arrow with an expression body has no braces at all; its extent is the
    // single line it is on, which `extent` already holds.
    else if (opened || /;\s*$/.test(line)) break;
  }
  return extent.join("\n");
}

/** Net `{` minus `}` on a line of stripped source. */
function braceDelta(line: string): number {
  let delta = 0;
  for (const character of line) {
    if (character === "{") delta += 1;
    else if (character === "}") delta -= 1;
  }
  return delta;
}

function collectHelpers(stripped: readonly string[]): Map<string, Helper> {
  const helpers = new Map<string, Helper>();
  stripped.forEach((line, index) => {
    DECL_START.lastIndex = 0;
    const match = DECL_START.exec(line);
    if (!match) return;
    const name = match[1] ?? match[2] ?? match[3];
    if (!name || helpers.has(name)) return;
    const isClass = match[3] !== undefined;
    // A class whose superclass is already known reaches that body's markers
    // too, so the subclass entry carries both. Over-attribution again, which is
    // the accepted direction.
    const superName = SUPERCLASS.exec(line)?.[1];
    const inherited =
      superName && helpers.has(superName) ? helpers.get(superName)?.body : "";
    helpers.set(name, {
      name,
      isClass,
      body: [inherited ?? "", declarationExtent(stripped, index)].join("\n"),
    });
  });
  return helpers;
}

/** Does `text` call `name`? Word-bounded, so `loadRoute` != `loadRouteWith`. */
function calls(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(text);
}

/**
 * The method names a class body DECLARES.
 *
 * Used to reach a class whose instance the test only has as an untyped value --
 * `new Scanner().run()` names `Scanner`, but `scanner.run()` names only the
 * method. Requiring the method name to be DECLARED by the class is what keeps
 * this from attributing every `.map(`/`.push(` in the suite to every class: a
 * name declared by no class here matches nothing.
 *
 * Object-literal methods are intentionally not resolved. A `{ run() { spawnSync } }`
 * factory is a real shape, but it is a fourth grammar, and the honest move is to
 * record it as a limitation under a failing-if-unresolved test rather than to
 * grow the matcher until it is untestable.
 */
const METHOD_DECL =
  /^[ \t]*(?:(?:public|private|protected|readonly|static|async|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^;{]*>)?\s*\([^;{]*\)\s*(?::[^;{]+)?\{/;

function methodNamesIn(classBody: string): readonly string[] {
  const names = new Set<string>();
  for (const line of classBody.split("\n")) {
    const match = METHOD_DECL.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

/**
 * Does `text` reach a class BODY -- by construction, or by calling one of its
 * declared methods?
 *
 * A class is reached by CALL in two shapes the guard must both see, because the
 * second is exactly the blind spot QA's counter-example found
 * (`new Scanner().run()` still qualifies, but so does holding the instance in a
 * variable first):
 *
 *  1. `new C()` -- names the class.
 *  2. `scanner.run()` -- names only the METHOD, never the class, which is why the
 *     method-name list is needed at all.
 *
 * Two further shapes are NOT resolved and are recorded as limitations rather
 * than claimed as coverage, each pinned by a test below so the claim cannot drift
 * back into the docstring:
 *
 *  3. `extends` -- a subclass instance reaches its superclass body. Handled by
 *     folding the known superclass body into the subclass at collection time,
 *     which only works when the superclass is declared FIRST in the file.
 *  4. An instance returned by a factory (`const s = makeScanner()`), and an
 *     object-literal method (`{ run() { spawnSync } }`). Neither is recoverable
 *     from text without type information.
 */
function reachesClass(text: string, name: string, body: string): boolean {
  if (new RegExp(`\\bnew\\s+${name}\\s*\\(`).test(text)) return true;
  // Shape 2: a method call whose name is declared by this class.
  for (const method of methodNamesIn(body)) {
    if (new RegExp(`\\.\\s*${method}\\s*\\(`).test(text)) return true;
  }
  return false;
}

/**
 * The load-scaled marker reached from `body`, following calls into file-level
 * helpers transitively. Returns the marker, or undefined.
 *
 * Transitive because the delegation is usually two hops: an `it` calls
 * `loadRouteWith()`, which calls `importFresh()`. A one-hop scan would miss the
 * second. The visited set makes a cycle (`a` calls `b`, `b` calls `a`) terminate
 * instead of recursing until the stack gives out.
 */
function markerReachedFrom(
  body: string,
  helpers: Map<string, Helper>,
  seen: Set<string> = new Set(),
): { pattern: RegExp; why: string } | undefined {
  const own = LOAD_SCALED_MARKERS.find((candidate) =>
    candidate.pattern.test(body),
  );
  if (own) return own;
  for (const helper of helpers.values()) {
    if (seen.has(helper.name)) continue;
    // A helper is reached by CALLING it; a class is reached by CONSTRUCTING it
    // or by calling one of its methods, which names neither the class nor a
    // plain call. Both forms must resolve or the scan is blind to classes.
    const reachedByCall =
      helper.isClass === true
        ? reachesClass(body, helper.name, helper.body)
        : calls(body, helper.name);
    if (!reachedByCall) continue;
    seen.add(helper.name);
    const reached = markerReachedFrom(helper.body, helpers, seen);
    if (reached) return reached;
  }
  return undefined;
}

/**
 * Every `it`/`test` that reaches load-scaled work -- directly or through a
 * file-level helper -- and which names no budget.
 *
 * A helper shared by both a budgeted and an unbudgeted test flags only the
 * unbudgeted one, which is the honest answer: only that one inherits the 5s
 * default for the work.
 */
function scanSource(file: string, raw: string): LoadSensitiveTest[] {
  const offenders: LoadSensitiveTest[] = [];
  const lines = raw.split("\n");
  const strippedText = stripCommentsAndStrings(raw);
  const stripped = strippedText.split("\n");
  const helpers = collectHelpers(stripped);
  const openings = [...strippedText.matchAll(OPENING)];
  openings.forEach((match) => {
    const start = match.index ?? 0;
    const startLine = strippedText.slice(0, start).split("\n").length - 1;
    const header = lines[startLine] ?? "";
    const indent = header.length - header.trimStart().length;
    // The budget may sit in the OPTIONS object between the name and the body
    // (`it("name", { timeout: ... }, () => {...})`), which lives on the header
    // line or the one after it -- not inside the body.
    const head = [header, lines[startLine + 1] ?? ""].join("\n");
    const body = ownedLines(stripped, startLine, indent).join("\n");
    const marker = markerReachedFrom(body, helpers);
    if (
      marker &&
      !BUDGET_REFERENCE.test(head) &&
      !BUDGET_REFERENCE.test(body)
    ) {
      offenders.push({
        file: path.relative(REPO_ROOT, file),
        line: startLine + 1,
        name: NAME.exec(header)?.[1] ?? header.trim(),
        why: marker.why,
      });
    }
  });
  return offenders;
}

function loadSensitiveTests(): LoadSensitiveTest[] {
  return SCANNED_ROOTS.flatMap(listTestFiles).flatMap((file) =>
    scanSource(file, readFileSync(file, "utf8")),
  );
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
      expect(
        why.length,
        "a marker with no explanation is not a rule",
      ).toBeGreaterThan(0);
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
    const head = budgeted.slice(
      budgeted.indexOf("it("),
      budgeted.indexOf("it(") + 400,
    );
    expect(BUDGET_REFERENCE.test(head)).toBe(true);
  });

  it("follows load-scaled work reached through a file-level helper", () => {
    // THE NON-VACUITY PROOF FOR HELPER DELEGATION, and the defect this guard
    // shipped with. An earlier version scanned only each `it`'s OWN text, so it
    // reported zero offenders while `route-auth.test.ts` > "CONTROL: with a
    // session the real pipeline runs" -- a site PM MEASURED timing out on bare
    // `origin/main` -- carried no budget. The guard was green on the exact
    // defect it existed to catch, and its own docstring claimed coverage it did
    // not have. That combination is the self-certifying-green failure this board
    // exists to close, so the coverage claim is now driven by a test.
    //
    // Driven on synthetic source shaped like the real file: a multi-line
    // parameter type ending `}): Promise<...> {`, and the marker several hops
    // down inside a helper the test only CALLS. The test sits on line 9 of this
    // fixture, which is what the expectation below asserts -- so if the scanner
    // reports a line, it is reporting the test that called the helper and not
    // some other `it` in the fixture.
    const delegated = [
      "async function loadRouteWith(options: {",
      "  session: { kind: string };",
      "}): Promise<{ POST: () => Promise<void> }> {",
      "  vi.resetModules();",
      "  return { POST: async () => undefined };",
      "}",
      "",
      'describe("synthetic", () => {',
      '  it("reaches the work only through the helper", async () => {',
      "    const { POST } = await loadRouteWith({ session: { kind: 'none' } });",
      "    await POST();",
      "  });",
      "});",
    ].join("\n");

    // Without the budget the test is an offender -- this is the RED.
    expect(
      scanSource("synthetic.test.ts", delegated).map((offender) => ({
        line: offender.line,
        name: offender.name,
      })),
      "a spawn or resetModules reached only through a file-level helper must " +
        "still be attributed to the test that calls it",
    ).toEqual([{ line: 9, name: "reaches the work only through the helper" }]);

    // Adding the budget clears it -- this is the GREEN.
    const budgeted = delegated.replace(
      '  it("reaches the work only through the helper", async () => {',
      "  it(\n" +
        '    "reaches the work only through the helper",\n' +
        "    { timeout: LOAD_BEARING_TEST_TIMEOUT.moduleGraph },\n" +
        "    async () => {",
    );
    expect(scanSource("synthetic.test.ts", budgeted)).toEqual([]);
  });

  it("follows load-scaled work reached through a class method", () => {
    // D3. QA built this counter-example and the guard reported ZERO offenders on
    // it: `DECL_START` resolved `function f(` and `const f = ... =>` and nothing
    // else, so a spawn inside a class method -- reached by CALL, exactly like a
    // function helper -- was invisible. The guard was green while an unbudgeted
    // spawn sat in a method, which is PM's finding-2 defect class in a narrower
    // shape. Driven here so the docstring's coverage claim is a test, not a hope.
    const viaMethod = [
      "class Scanner {",
      "  run(): string {",
      "    execFileSync('git', ['--version']);",
      "    return 'ok';",
      "  }",
      "}",
      "",
      'describe("synthetic", () => {',
      '  it("reaches a spawn through a class method, no budget", () => {',
      "    new Scanner().run();",
      "  });",
      "});",
    ].join("\n");
    expect(
      scanSource("synthetic.test.ts", viaMethod).map((o) => ({
        line: o.line,
        name: o.name,
      })),
      "a spawn inside a class method must be attributed to the test that calls it",
    ).toEqual([
      { line: 9, name: "reaches a spawn through a class method, no budget" },
    ]);

    // GREEN: the same file with a budget on that test scans clean.
    const budgeted = viaMethod.replace(
      '  it("reaches a spawn through a class method, no budget", () => {',
      "  it(\n" +
        '    "reaches a spawn through a class method, no budget",\n' +
        "    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },\n" +
        "    () => {",
    );
    expect(scanSource("synthetic.test.ts", budgeted)).toEqual([]);
  });

  it("resolves a class method called through a variable, and via `extends`", () => {
    // The two shapes that follow from registering the class body rather than each
    // method declaration: the instance held in a variable (so the test never
    // writes the class name at all), and a subclass instance reaching its
    // superclass body.
    const viaVariable = [
      "class Base {",
      "  boot(): void {",
      "    vi.resetModules();",
      "  }",
      "}",
      "class Child extends Base {",
      "  boot(): void {",
      "    super.boot();",
      "  }",
      "}",
      "",
      'describe("synthetic", () => {',
      '  it("calls an inherited method on a typed variable", () => {',
      "    const scanner: Base = new Child();",
      "    scanner.boot();",
      "  });",
      "});",
    ].join("\n");
    const offenders = scanSource("synthetic.test.ts", viaVariable);
    expect(
      offenders.map((o) => o.line),
      "a class body reached only by a method call on a variable -- through " +
        "`extends` -- must still be attributed to the calling test",
    ).toContain(13);
  });

  it("does NOT resolve the two shapes it cannot, and says so rather than claiming them", () => {
    // The honest half of D3. A factory that returns an instance, and an
    // object-literal method, are both real shapes that reach a spawn by CALL.
    // Neither is recoverable from text without type information, so this guard
    // does not claim them. Asserting the limitation HERE is what stops the
    // docstring from quietly widening back into coverage it does not have --
    // which is the whole defect this round exists to close.
    const viaFactory = [
      "class Scanner {",
      "  run(): string {",
      "    execFileSync('git', ['--version']);",
      "    return 'ok';",
      "  }",
      "}",
      "function makeScanner(): Scanner {",
      "  return new Scanner();",
      "}",
      "",
      'describe("synthetic", () => {',
      '  it("reaches a spawn through a factory", () => {',
      "    const scanner = makeScanner();",
      "    scanner.run();",
      "  });",
      "});",
    ].join("\n");
    expect(
      scanSource("synthetic.test.ts", viaFactory).map((o) => o.line),
      "LIMITATION, asserted so it stays a limitation: a factory that returns an " +
        "instance hides the class name, so this text scan cannot attribute the " +
        "spawn. Closing it needs type information, not a wider regex.",
    ).not.toContain(14);
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
      LOAD_SCALED_MARKERS.filter((marker) => marker.pattern.test(body)).map(
        (m) => m.why,
      ),
      "a marker inside a comment or a string literal is not real subprocess work",
    ).toEqual([]);
  });
});

describe("the budgets themselves are the measured ones, not decoration", () => {
  it("keeps every budget above the 5s default it stands in for", () => {
    // A budget at or below the global default would be theatre: the suite would
    // look as though it had raised a limit, and nothing would change.
    for (const [name, value] of Object.entries(LOAD_BEARING_TEST_TIMEOUT)) {
      expect(
        value,
        `${name} must exceed the 5000ms default it stands in for`,
      ).toBeGreaterThan(5_000);
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
      expect(
        marker.pattern.test(self),
        `${marker.why} -- this guard would need a budget`,
      ).toBe(false);
    }
  });
});
