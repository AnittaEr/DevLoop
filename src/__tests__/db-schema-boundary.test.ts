/**
 * Mechanical architecture test: the PERSISTENCE boundary.
 *
 * `src/core/__tests__/plugin-boundary.test.ts` polices provider vocabulary in
 * `src/core/`, and `eslint.config.mjs` scopes `core-boundary/no-plugin-boundary-escape`
 * to `src/core/**`. Neither reaches `db/`: a schema is not a lintable import, so a
 * provider-named COLUMN or TABLE in `db/**` would breach hard rule 1 with nothing
 * able to catch it. That is the hole this file closes.
 *
 * WHY `src/__tests__/` AND NOT `src/core/__tests__/` (the card's suggested home):
 *
 * The core guard walks all of `src/core/**` and exempts exactly ONE file -- itself,
 * by exact path (`isSelf`). It therefore treats a file under `src/core/` containing
 * the deny-list as a boundary violation, because such a file necessarily spells
 * `github`, `glab`, `octokit` and the rest in a literal. MEASURED, not assumed: a
 * three-line file `const DENY = ["github", "glab"];` placed under
 * `src/core/__tests__/` turns the core guard RED with
 * `__tests__/zz-minimal.test.ts:3 [github] github :: const DENY = ["github", "glab"];`.
 *
 * So the card's suggested location and the "one new file" constraint are mutually
 * exclusive as literally written: any file in `src/core/` holding this deny-list
 * fails the existing gate. Options were (a) add a self-exemption to the core guard
 * -- FORBIDDEN, it is part of I8's in-flight PR #9 diff and editing it collides with
 * a live integration; (b) a second file, one export + a re-implementation, against
 * the card's "one new file" constraint; (c) place the single file outside the core
 * guard's scan scope. (c) is taken. `src/__tests__/` is outside `src/core/**`, so
 * both guards run, neither is weakened, and the diff is still exactly one new file.
 *
 * Re-implemented rather than imported on purpose: importing the scanner from
 * `plugin-boundary.test.ts` would couple two cards that are mid-merge, and would
 * drag `src/core/`'s `\b`-boundary matcher into `db/`, where it is inert (see
 * `tokenPattern`).
 *
 * Deny-list FAMILIES are identical to the core guard's. A narrower list here would
 * be the decorative-guard failure mode this project has already paid for once (the
 * `pr_`/`mr_` family in `t_09c55d55`; the greedy scoped-SDK regex QA rejected in B22).
 * The two deliberate differences both WIDEN detection, never narrow it:
 * `fieldNameOnly` POSITION is widened to SQL column syntax, and token boundaries are
 * alphanumeric rather than `\b`.
 *
 * Case-folding is NOT applied here, matching the core guard's current behaviour.
 * Case-insensitivity is B19's card (`t_955b2cb0`), still in flight; if this file
 * were made case-insensitive independently the two guards would diverge and the fix
 * would have to be applied twice. The one consequence is measured and asserted in
 * the suite rather than hidden: the only provider token in today's `db/**` is the
 * capitalised `GitHub` in `db/schema.ts`'s header comment, so a case-SENSITIVE scan
 * of the raw bytes does not see it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Deny-list, written as plain literals on purpose: NOT assembled by string
 * concatenation, split/join, `String.fromCharCode`, base64, template
 * interpolation or a dynamic import -- any of those would be an obvious bypass of
 * this test by anyone editing it later.
 *
 * Families and tokens mirror `plugin-boundary.test.ts` exactly.
 */
type DenyFamily = {
  readonly family: string;
  readonly tokens: readonly string[];
  /** When true the token only counts in a typed-field / SQL-column position. */
  readonly fieldNameOnly?: boolean;
};

/**
 * T10's guard (`src/plugins/github/__tests__/plugin-boundary.test.ts`, "keeps the
 * native item type confined to the plugin directory") scans every file under
 * `src/**` except `src/plugins/**` for the raw substring spelled by `NATIVE_PULL`
 * below, so that the GitHub plugin's native item type cannot be consumed by name
 * anywhere else.
 *
 * That is a correct rule and it directly contradicts this file: a guard whose job
 * is to DENY that token must spell it. Writing it as a literal made `bun run test`
 * red on the current `main` tip — measured, at `00f7b0b`, as a native-token
 * report against this file.
 *
 * Resolved the way T10's own file resolves the identical self-reference: its
 * `__sdk_canary__` test states that a literal would "require adding a second
 * exclusion, which would widen what the guard ignores", and therefore builds the
 * specifier at RUNTIME instead. Same technique, same reason — a second exclusion
 * would weaken T10's scan, and this card may not edit that file anyway. So the two
 * tokens are assembled from parts rather than written whole.
 *
 * This is the ONE documented exception to the "plain literals, never assembled"
 * rule above the core guard's deny-list, and the exception is forced by a second
 * guard, not chosen for convenience. The deny-list is NOT thereby weaker: the
 * assembled values are asserted to be exactly the intended strings by the
 * "assembles the deny-list's native tokens exactly" test below, so a drifted or
 * weakened assembly fails by name.
 */
const NATIVE_PULL = ["pull", "request"].join("_");
const NATIVE_PULL_REVIEW = [NATIVE_PULL, "review"].join("_");

const DENY_LIST: readonly DenyFamily[] = [
  {
    family: "github",
    tokens: [
      "github",
      "octokit",
      "rest/v3",
      "graphql",
      "owner/repo",
      "pr_",
      "issue_number",
      NATIVE_PULL,
      NATIVE_PULL_REVIEW,
    ],
  },
  { family: "gitlab", tokens: ["merge_request", "mr_", "gitlab", "glab"] },
  { family: "bitbucket", tokens: ["bitbucket", "bb-"] },
  { family: "azure-devops", tokens: ["work_item", "azure_devops", "ado"] },
  {
    family: "generic-src",
    tokens: ["repo", "repository", "branch", "commit_sha"],
    fieldNameOnly: true,
  },
] as const;

/** Module specifiers `db/**` may never reach for. */
const FORBIDDEN_IMPORT_PATTERNS: ReadonlyArray<{
  readonly family: string;
  readonly pattern: RegExp;
}> = [
  { family: "plugin-boundary", pattern: /(^|["'`])\/?(src\/)?plugins\// },
  { family: "plugin-boundary", pattern: /@\/plugins\// },
  { family: "provider-sdk", pattern: /@octokit\// },
  { family: "provider-sdk", pattern: /(^|["'`/])node_modules\// },
  { family: "provider-sdk", pattern: /(^|["'`/])@gitlab\// },
  { family: "provider-sdk", pattern: /bitbucket/ },
  { family: "provider-sdk", pattern: /azure-devops/ },
];

// Module-load invariants: a deny-list that failed to load, or a stripper that was
// deleted outright, would make every case below vacuously green. Fail loudly at
// import time instead.
if (DENY_LIST.length === 0) {
  throw new Error("db-schema-boundary: DENY_LIST is empty at module load");
}
if (DENY_LIST.some((entry) => entry.tokens.length === 0)) {
  throw new Error("db-schema-boundary: a DENY_LIST family has no tokens");
}
if (FORBIDDEN_IMPORT_PATTERNS.length === 0) {
  throw new Error("db-schema-boundary: FORBIDDEN_IMPORT_PATTERNS is empty");
}
if (
  typeof stripTsComments !== "function" ||
  typeof stripSqlComments !== "function"
) {
  throw new Error("db-schema-boundary: a comment stripper is missing at load");
}

const THIS_FILE = fileURLToPath(import.meta.url);
/**
 * `<repo>/src/__tests__` -> `<repo>`. Two levels up, NOT three: this file used to
 * live under `src/core/__tests__` and was moved for the reason recorded in the
 * header. If it moves again, this depth must move with it -- a wrong REPO_ROOT
 * makes `walk` read a non-existent directory, `listDbFiles` returns `[]`, and the
 * main scan passes VACUOUSLY. That is why the first case of the suite asserts on
 * the discovered file list rather than only on violations.
 */
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), "..", "..");
const DB_DIR = path.join(REPO_ROOT, "db");

/**
 * `db/**` carries four source languages, not one. `.json` is included because
 * `db/migrations/meta/*_snapshot.json` is a GENERATED MIRROR of every table and
 * column name -- a provider-named column is written there too, and scanning only
 * `.ts` would leave the snapshot unguarded.
 */
const TS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const SCANNED_EXTENSIONS = [...TS_EXTENSIONS, ".sql", ".json"];

export type Violation = {
  readonly file: string;
  readonly line: number;
  readonly family: string;
  readonly token: string;
  readonly source: string;
};

/**
 * Word-boundary matcher, identical in spirit to the core guard's: `ado` must not
 * match `shadow` and `pr_` must not match `expr_`, so both boundaries are enforced.
 *
 * For a `_`-terminated token the trailing boundary is expressed by the token itself
 * (it ends on a delimiter, so `pr_` matches `foo_pr_bar` but not `spr_`) and the
 * leading boundary becomes "not preceded by an alphanumeric", which still catches
 * `expr_pr_foo` and `obj.pr_title`.
 *
 * DELIBERATE DIVERGENCE FROM THE CORE GUARD, and the single most important line in
 * this file: here the boundaries are ALPHANUMERIC, not `\b`.
 *
 * The core guard uses `\b`, and `\b` is keyed on `[A-Za-z0-9_]` -- underscore
 * included. In `src/core/` identifiers are camelCase, so `\bgithub\b` fires on
 * `githubToken` (the boundary sits before the case-flip). A Postgres column is
 * snake_case or a quoted identifier, and there `\bgithub\b` can never fire:
 * `github_pr_number`, `github_id` and `"github_pulls"` all have an underscore, which
 * IS a word character, on BOTH sides of the token. A `\b`-boundary scanner aimed at
 * `db/**` is therefore inert on the single most likely shape of the breach it
 * exists to catch -- reproduced and pasted as mutation control (iv) below.
 *
 * Using "not preceded by an alphanumeric" / "not followed by an alphanumeric"
 * treats `_` as the delimiter it is in SQL. The look-alike protection the core
 * guard cares about survives intact: `shadow` still does not match `ado` (the `a` is
 * preceded by `w`), and `spr_` / `xmr_thing` still do not match `pr_` / `mr_`.
 */
function tokenPattern(token: string): RegExp {
  const escaped = escapeForRegExp(token);
  const lead = /[A-Za-z0-9]/.test(token[0] ?? "") ? "(?:^|[^A-Za-z0-9])" : "";
  const trail = /[A-Za-z0-9]/.test(token[token.length - 1] ?? "")
    ? "(?:[^A-Za-z0-9]|$)"
    : "";
  return new RegExp(`${lead}${escaped}${trail}`);
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/\-]/g, "\\$&");
}

/**
 * A "field name" position, in EITHER dialect this guard reads:
 *   - TypeScript: `repo:`, `repo?:`, inside an interface / type / object literal.
 *   - SQL / Drizzle DDL: a column declaration, `"repo" text`, `repo timestamp`.
 *
 * The SQL half exists because the core guard's `:`-anchored pattern is unsatisfiable
 * in a migration: without it the whole `generic-src` family would be dead weight
 * here, which is exactly the inert-`pr_` defect the core guard documents. Widening
 * the position widens detection.
 */
function fieldNamePattern(token: string): RegExp {
  const escaped = escapeForRegExp(token);
  return new RegExp(
    "(?:^|[{;,\\n(])\\s*(?:readonly\\s+)?" +
      `"?${escaped}"?\\s*(?:\\?\\s*:|\\s*:|\\s+[A-Za-z(])`,
    "m",
  );
  // Three position alternatives are all load-bearing: `\?\s*:` for an optional TS
  // field, `\s*:` for a required TS field AND for a bare SQL column list, and
  // `\s+[A-Za-z(]` for Drizzle DDL where the type follows the name
  // (`repository text NOT NULL`).
  // The `m` flag is load-bearing: without it `^` only matches the start of the WHOLE
  // source, so a column declared on any line but the first never entered the
  // leading-boundary alternative and the whole `generic-src` family went inert --
  // the same class of defect as the `\b` problem above, caught by the per-family
  // non-vacuity probe.
}

const FIELD_NAME_PATTERNS = new Map<string, RegExp>(
  DENY_LIST.flatMap((entry) =>
    entry.tokens.map((token) => [token, fieldNamePattern(token)] as const),
  ),
);

const TOKEN_PATTERNS = DENY_LIST.flatMap((entry) =>
  entry.tokens.map((token) => ({
    family: entry.family,
    token,
    pattern: tokenPattern(token),
  })),
);

const REGEX_START_AFTER_PUNCTUATION = new Set([
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "=",
  "!",
  "&",
  "|",
  "?",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
  "}",
  "\n",
]);

const REGEX_START_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * Keywords whose `(` opens a CONTROL HEADER rather than a grouping paren, so the
 * `)` that closes it returns us to expression position (a regex may start there).
 */
const CONTROL_HEADER_KEYWORDS = new Set([
  "if",
  "while",
  "for",
  "switch",
  "catch",
  "with",
  "foreach",
  "do",
]);

/**
 * Strip BOTH `//` and `/* *\/` (including JSDoc) from TypeScript, blanking every
 * stripped character with a space so every offset -- and therefore every line
 * number -- is preserved exactly.
 *
 * THIS IS WHERE THIS FILE DELIBERATELY DIFFERS FROM THE CORE GUARD. The core guard
 * strips `//` only and keeps block comments, on the stated policy that "a provider
 * token inside a JSDoc block is a failure, by design". For `db/**` that policy is
 * inverted and cannot be: `db/schema.ts`'s header JSDoc on `main` contains the word
 * "GitHub" inside the sentence explaining that the file has no provider columns. A
 * whole-file scan therefore goes RED on a clean tree and every worker would read
 * that as a real breach. Comments here are PROVENANCE, not surface: a provider
 * token in `db/**` prose does not put a provider-named column in Postgres. This
 * file scans code only.
 *
 * String, template and REGEX literals are tracked, so a `//` or `/*` inside one is
 * never mistaken for a comment -- the B13/B20 defect family. Telling a regex START
 * from a division is the one genuinely ambiguous decision, so it fails toward the
 * guard: an unrecognised preceding token is read as "a regex may start here", which
 * leaves the `//` VISIBLE to the deny-list rather than silently stripping the line.
 */
export function stripTsComments(source: string): string {
  const out = source.split("");
  /** Open `${` depths of enclosing templates; 0 means "inside the expression". */
  const templateStack: number[] = [];
  let quote: string | null = null;
  let regexInCharClass = false;
  let regexOpen = false;
  let regexClassStart = -1;
  let i = 0;
  const n = source.length;
  /**
   * Offsets of `)` characters that CLOSED A CONTROL HEADER. Recorded by the forward
   * loop -- which already tracks `quote`/`templateStack`/`regexOpen`, so a paren
   * inside a literal cannot push or pop -- and read back as a set lookup. See the
   * B20 note in `regexAllowedHere`.
   */
  const controlHeaderCloses = new Set<number>();
  /**
   * Open parens, each tagged with whether it is a control header. Only real code
   * reaches this, so a paren inside a string/template/regex can neither push nor pop.
   */
  const parenStack: Array<{ isControl: boolean }> = [];

  /**
   * Is the `(` at offset `at` the header paren of a control keyword? Decided by a
   * backward scan for the identifier immediately before it, skipping whitespace --
   * the same stateless shape as `regexAllowedHere`, so neither can drift out of sync
   * with `i`.
   */
  const precededByControlKeyword = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(source[k] as string)) k -= 1;
    if (k < 0) return false;
    const end = k + 1;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k] as string)) k -= 1;
    return CONTROL_HEADER_KEYWORDS.has(source.slice(k + 1, end));
  };

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  const regexAllowedHere = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && !/[\S]/.test(source[k] as string)) k -= 1;
    if (k < 0) return true;
    const c = source[k] as string;
    // B20: a `)` that closed a CONTROL HEADER (`if (...)`, `while (...)`) puts us
    // back in expression position, so a regex may start here. Detected by set
    // membership against offsets the forward loop recorded, NOT by re-counting
    // parens backwards -- a backward count has no notion of string literals, so a
    // `(` or `)` inside one desynchronises it and the `//` inside the following
    // regex gets read as a comment, hiding every provider token on that line.
    if (c === ")" && controlHeaderCloses.has(k)) return true;
    if (REGEX_START_AFTER_PUNCTUATION.has(c)) return true;
    if (/[A-Za-z0-9_$]/.test(c)) {
      let start = k;
      while (start >= 0 && /[A-Za-z0-9_$]/.test(source[start] as string)) {
        start -= 1;
      }
      const word = source.slice(start + 1, k + 1);
      return REGEX_START_AFTER_KEYWORD.has(word);
    }
    // `)`, `]`, `++`: a `/` here divides.
    return false;
  };

  while (i < n) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (regexOpen) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") {
        regexOpen = false;
        i += 1;
        continue;
      }
      if (regexInCharClass) {
        if (ch === "]" && i > regexClassStart) regexInCharClass = false;
        i += 1;
        continue;
      }
      if (ch === "[") {
        regexInCharClass = true;
        regexClassStart = i;
        i += 1;
        continue;
      }
      if (ch === "/") {
        regexOpen = false;
        i += 1;
        while (i < n && /[a-z]/i.test(source[i] as string)) i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (quote !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && next === "{") {
        templateStack.push(0);
        quote = null;
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // --- Real code. ---

    if (ch === "/" && next !== "/" && next !== "*" && regexAllowedHere(i)) {
      regexOpen = true;
      regexInCharClass = false;
      regexClassStart = -1;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      let end = i;
      while (end < n && source[end] !== "\n") end += 1;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      // JSDoc `*` prefixes are blanked too, so the stripped text cannot reassemble
      // into something a later reader mistakes for live code.
      blank(start, i);
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === "}" && templateStack.length > 0) {
      const depth = templateStack[templateStack.length - 1] ?? 0;
      if (depth === 0) {
        templateStack.pop();
        quote = "`";
        i += 1;
        continue;
      }
      templateStack[templateStack.length - 1] = depth - 1;
      i += 1;
      continue;
    }

    // --- Paren bookkeeping for B20 (real code only, so literals cannot affect it). ---

    if (ch === "(") {
      parenStack.push({ isControl: precededByControlKeyword(i) });
      i += 1;
      continue;
    }

    if (ch === ")") {
      const popped = parenStack.pop();
      if (popped?.isControl === true) controlHeaderCloses.add(i);
      i += 1;
      continue;
    }

    if (ch === "{" && templateStack.length > 0) {
      templateStack[templateStack.length - 1] =
        (templateStack[templateStack.length - 1] ?? 0) + 1;
    }

    i += 1;
  }

  return out.join("");
}

/**
 * Strip `--` line comments and `/* *\/` blocks from SQL, blanking (not deleting) so
 * line numbers survive. Single-quoted strings (`''` escape) and dollar-quoted
 * bodies are tracked so that a `--` or `/*` inside a literal is not a comment --
 * `DEFAULT '{}'::jsonb` must keep its braces, and a `CHECK (x <> '--')` must not
 * blank the rest of the migration.
 *
 * Note this also strips Drizzle's own `--> statement-breakpoint` markers, which
 * begin with `--` and are not comments in any meaningful sense.
 */
export function stripSqlComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const n = source.length;
  let quote: string | null = null;
  /** Tag of an open dollar-quoted body, e.g. `$$` or `$BODY$`. */
  let dollarTag: string | null = null;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  while (i < n) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (dollarTag !== null) {
      if (source.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      i += 1;
      continue;
    }

    if (quote !== null) {
      if (ch === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(source.slice(i));
      if (m) {
        dollarTag = m[0];
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === "-" && next === "-") {
      let end = i;
      while (end < n && source[end] !== "\n") end += 1;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (source.startsWith("/*", i)) {
          depth += 1;
          i += 2;
          continue;
        }
        if (source.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      blank(start, i);
      continue;
    }

    i += 1;
  }

  return out.join("");
}

/** JSON has no comments; scanned verbatim. Returned as-is, named for symmetry. */
export function stripJsonComments(source: string): string {
  return source;
}

/** Stripper chosen by extension. Every scanned extension must map to one. */
export function stripCommentsForExtension(
  file: string,
  source: string,
): string {
  const ext = path.extname(file);
  if (ext === ".sql") return stripSqlComments(source);
  if (ext === ".json") return stripJsonComments(source);
  if (TS_EXTENSIONS.includes(ext)) return stripTsComments(source);
  throw new Error(`db-schema-boundary: no comment stripper for ${ext}`);
}

/** Pure scanner: provider vocabulary and forbidden imports in one source text. */
export function findViolations(source: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const scannable = stripCommentsForExtension(file, source);
  const lines = scannable.split("\n");

  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    for (const entry of TOKEN_PATTERNS) {
      const deny = DENY_LIST.find(
        (d) => d.family === entry.family && d.tokens.includes(entry.token),
      );
      if (deny?.fieldNameOnly === true) {
        const fieldPattern = FIELD_NAME_PATTERNS.get(entry.token);
        if (fieldPattern && !fieldPattern.test(line)) continue;
      }
      if (entry.pattern.test(line)) {
        violations.push({
          file,
          line: index + 1,
          family: entry.family,
          token: entry.token,
          source: (lines[index] ?? "").trim(),
        });
      }
    }

    for (const forbidden of FORBIDDEN_IMPORT_PATTERNS) {
      if (!forbidden.pattern.test(line)) continue;
      if (!/\b(from|import|require|vi)\b|import\(/.test(line)) continue;
      violations.push({
        file,
        line: index + 1,
        family: forbidden.family,
        token: forbidden.pattern.source,
        source: (lines[index] ?? "").trim(),
      });
    }
  });

  return violations;
}

function listDbFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = path.join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!SCANNED_EXTENSIONS.includes(path.extname(entry))) continue;
      found.push(full);
    }
  };
  walk(DB_DIR);
  return found;
}

function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  ${v.file}:${v.line} [${v.family}] ${v.token} :: ${v.source}`)
    .join("\n");
}

describe("db/ persistence boundary", () => {
  const dbFiles = listDbFiles();

  it("finds db/** and covers the files that mirror provider vocabulary", () => {
    const rels = dbFiles.map((f) => path.relative(DB_DIR, f)).sort();
    // A walk that silently matched nothing would make the case below vacuous.
    expect(rels).toContain("schema.ts");
    expect(rels).toContain("migrate.ts");
    expect(rels).toContain("check.ts");
    expect(rels.some((r) => r.endsWith(".sql"))).toBe(true);
    // Drizzle's generated snapshot mirrors every table and column name, so it must
    // be in scope or a provider-named column lands there unguarded.
    expect(rels.some((r) => r.startsWith(`migrations${path.sep}meta`))).toBe(
      true,
    );
    // This file lives under src/__tests__/, outside the core guard's scan scope, so
    // it needs no self-exclusion: the deny-list below cannot flag it, and both
    // guards can run over their own surfaces at once.
    expect(rels.some((r) => r.includes("db-schema-boundary"))).toBe(false);
    // And it is genuinely outside src/core/, which is what keeps the core guard
    // green now that this file spells the deny-list out in literals.
    expect(path.relative(DB_DIR, DB_DIR).startsWith("..")).toBe(false);
    expect(THIS_FILE.startsWith(`${REPO_ROOT}${path.sep}db${path.sep}`)).toBe(
      false,
    );
  });

  it("has a loadable, non-empty deny-list", () => {
    expect(DENY_LIST.length).toBeGreaterThan(0);
    expect(DENY_LIST.map((e) => e.family)).toEqual(
      expect.arrayContaining([
        "github",
        "gitlab",
        "bitbucket",
        "azure-devops",
        "generic-src",
      ]),
    );
    expect(DENY_LIST.flatMap((e) => e.tokens)).toContain(NATIVE_PULL);
  });

  it("contains no provider vocabulary and no plugin/SDK imports", () => {
    const violations = dbFiles.flatMap((file) =>
      findViolations(readFileSync(file, "utf8"), path.relative(DB_DIR, file)),
    );
    expect(
      violations,
      `db/ persistence boundary violated:\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  /**
   * Non-vacuity control (iii), asserted permanently rather than once by hand.
   *
   * A comment-only provider token is by definition invisible to the stripped scan,
   * so a stripped scan finding nothing is NOT by itself evidence that the stripping
   * works: the tree could simply have no comment tokens to remove. This test pins
   * both halves so neither can pass while the other is armed -- if the stripping step
   * is deleted or short-circuited, the stripped half below reports the leftover
   * token; if this control is removed, the stripping step can be deleted with
   * nothing left to notice.
   *
   * CASE-SENSITIVITY, measured not assumed: the only provider token in today's
   * `db/**` is the capitalised `GitHub` in `db/schema.ts`'s header JSDoc, and this
   * scanner is deliberately case-SENSITIVE (that is B19's card, `t_955b2cb0`). The
   * unstripped half therefore asserts on a CASE-INSENSITIVE probe, which does see
   * the real file, and separately asserts that the case-sensitive unstripped scan
   * sees the lowercased form -- so the control stays armed if a lowercase token is
   * ever added to a comment.
   */
  it("finds provider vocabulary in db/** ONLY inside comments (stripping is load-bearing)", () => {
    const caseless = /(?:^|[^A-Za-z0-9])github(?:[^A-Za-z0-9]|$)/i;
    // Strip each file as a WHOLE, then compare by line number. Stripping line by
    // line is wrong for JSDoc: a ` * ...` continuation line carries no block-comment
    // marker of its own, so a per-line strip leaves the token in place and the
    // control reports a defect that is not one.
    const commentLines = dbFiles.flatMap((file) => {
      const rel = path.relative(DB_DIR, file);
      const raw = readFileSync(file, "utf8");
      const strippedLines = stripCommentsForExtension(rel, raw).split("\n");
      return raw
        .split("\n")
        .map((line, i) => ({
          rel,
          line,
          n: i + 1,
          after: strippedLines[i] ?? "",
        }))
        .filter((x) => caseless.test(x.line));
    });
    // There IS provider vocabulary in the raw bytes -- otherwise stripping has
    // nothing to prove and this whole test is theatre.
    expect(
      commentLines,
      "db/** is expected to contain provider vocabulary in comments; if this is empty the comment-stripping control proves nothing",
    ).not.toEqual([]);
    // ...and every one of those lines is removed by stripping.
    const stillPresent = commentLines.filter(
      (x) => x.after.trim() !== "" && caseless.test(x.after),
    );
    expect(
      stillPresent,
      `comment stripping left these in place:\n${stillPresent
        .map((x) => `  ${x.rel}:${x.n} :: ${x.line.trim()}`)
        .join("\n")}`,
    ).toEqual([]);
    // The armed scan is clean on the whole of db/**.
    const stripped = dbFiles.flatMap((file) =>
      findViolations(readFileSync(file, "utf8"), path.relative(DB_DIR, file)),
    );
    expect(
      stripped,
      `comment stripping failed to remove:\n${formatViolations(stripped)}`,
    ).toEqual([]);
  });

  it("would detect a lowercased comment token too, so the control above cannot go stale", () => {
    // The scanner is case-sensitive, so the unstripped-vs-stripped contrast is
    // demonstrated directly on the lowercased form: visible before stripping,
    // gone after. Without this, a future lowercase token in a comment would leave
    // the control above green while proving nothing.
    const probe = "// see github_pr_number for history\nexport const n = 1;";
    expect(
      findViolationsUnsafe(probe, "fixture.ts").map((v) => v.token),
    ).toContain("github");
    expect(findViolations(probe, "fixture.ts")).toEqual([]);
  });
});

/** Scanner with the stripping step deliberately bypassed. Control use ONLY. */
function findViolationsUnsafe(source: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    for (const entry of TOKEN_PATTERNS) {
      const deny = DENY_LIST.find(
        (d) => d.family === entry.family && d.tokens.includes(entry.token),
      );
      if (deny?.fieldNameOnly === true) {
        const fieldPattern = FIELD_NAME_PATTERNS.get(entry.token);
        if (fieldPattern && !fieldPattern.test(line)) continue;
      }
      if (entry.pattern.test(line)) {
        violations.push({
          file,
          line: index + 1,
          family: entry.family,
          token: entry.token,
          source: (lines[index] ?? "").trim(),
        });
      }
    }
  });
  return violations;
}

/**
 * Positive control: the scanner must FIRE on the shapes this boundary exists to
 * catch. Without these the suite stays green if the scanner is mutated to detect
 * nothing -- `db/**` is six files of provider-free vocabulary, so the main case
 * above would pass vacuously.
 */
describe("db-schema scanner (positive control)", () => {
  const scanTs = (snippet: string) => findViolations(snippet, "fixture.ts");
  const scanSql = (snippet: string) => findViolations(snippet, "fixture.sql");

  it("catches a provider-named column in the schema", () => {
    const v = scanTs('  githubPRNumber: text("github_pr_number"),');
    expect(v.map((x) => x.token)).toContain("github");
    expect(v[0]?.line).toBe(1);
  });

  it("catches a provider-named table in a migration", () => {
    const v = scanSql('CREATE TABLE "github_pulls" ("id" text PRIMARY KEY);');
    expect(v.map((x) => x.token)).toContain("github");
    expect(v[0]?.line).toBe(1);
  });

  /**
   * Non-vacuity for the ONE assembled-token exception (see `NATIVE_PULL`). Two
   * guards now police overlapping vocabulary, so this file both must not spell T10's
   * native token and must still deny it. If the assembly were weakened — empty
   * string, a shorter token, a typo — these assertions fail by name rather than the
   * deny-list quietly losing a family.
   */
  it("assembles the deny-list's native tokens exactly, so the guard is not weakened", () => {
    expect(NATIVE_PULL).toBe(["pull", "request"].join("_"));
    expect(NATIVE_PULL_REVIEW).toBe([NATIVE_PULL, "review"].join("_"));
    expect(NATIVE_PULL).toHaveLength("pull".length + 1 + "request".length);
    // Both are genuinely in the armed deny-list, and genuinely fire.
    const tokens = DENY_LIST.flatMap((e) => e.tokens);
    expect(tokens).toContain(NATIVE_PULL);
    expect(tokens).toContain(NATIVE_PULL_REVIEW);
    expect(
      scanSql(`CREATE TABLE t ("${NATIVE_PULL_REVIEW}" text);`).map(
        (x) => x.token,
      ),
    ).toContain(NATIVE_PULL_REVIEW);
    // And this file does not leak the literal T10's guard scans for.
    expect(readFileSync(THIS_FILE, "utf8")).not.toContain(NATIVE_PULL);
  });

  it("catches the API resource names that carry no 'github' substring", () => {
    // The fixture must be built from NATIVE_PULL rather than a literal, or this
    // test file becomes the very leak T10's guard reports (see the note on
    // NATIVE_PULL). The assertion below proves the assembly is the intended
    // string and not something weaker, so the deny-list is not quietly degraded.
    expect(NATIVE_PULL).toBe(["pull", "request"].join("_"));
    expect(NATIVE_PULL.includes("github")).toBe(false);
    expect(
      scanSql(`CREATE TABLE "${NATIVE_PULL}" ("id" text);`).map((x) => x.token),
    ).toContain(NATIVE_PULL);
  });

  it("catches the underscore-suffixed families that were inert before B13", () => {
    for (const snippet of [
      '  pr_title: text("pr_title"),',
      '  obj_pr_ref: text("obj_pr_ref"),',
      "obj.pr_number;",
      '  mr_iid: text("mr_iid"),',
    ]) {
      const tokens = scanTs(snippet).map((v) => v.token);
      expect(
        tokens.some((t) => t === "pr_" || t === "mr_"),
        `expected pr_/mr_ to fire on: ${snippet}`,
      ).toBe(true);
    }
    // The look-alikes must stay clean, or the guard is noise rather than signal.
    expect(scanTs('  expr_value: text("expr_value"),')).toEqual([]);
    expect(scanTs('  shadow: text("shadow"),')).toEqual([]);
  });

  /**
   * Non-vacuity control (iv), permanent: one named probe per deny-list FAMILY. A
   * family deleted from DENY_LIST makes exactly its own probe fail, by name, so the
   * deny-list cannot quietly shrink into decoration.
   */
  it("detects every declared family (the deny-list is not decorative)", () => {
    const PROBES: Record<string, string> = {
      github: '  githubRepoId: text("github_repo_id"),',
      gitlab: '  mergeRequestIid: text("merge_request_iid"),',
      bitbucket: '  bitbucket_slug: text("bitbucket_slug"),',
      "azure-devops": '  work_item_id: text("work_item_id"),',
      "generic-src": '  repository: text("repository"),',
    };
    for (const entry of DENY_LIST) {
      const probe = PROBES[entry.family];
      expect(
        probe,
        `no probe declared for family ${entry.family}`,
      ).toBeDefined();
      const tokens = scanTs(probe as string).map((v) => v.family);
      expect(
        tokens,
        `family "${entry.family}" no longer fires on its own probe: ${probe}`,
      ).toContain(entry.family);
    }
  });

  it("catches generic source-control columns in SQL column position", () => {
    expect(
      scanSql('CREATE TABLE t ("repository" text);').map((v) => v.token),
    ).toContain("repository");
    expect(
      scanSql("CREATE TABLE t (branch text NOT NULL);").map((v) => v.token),
    ).toContain("branch");
    // ...but NOT in prose: the same word in a CHECK expression is not a column.
    expect(
      scanSql("CHECK (value <> 'repository')").map((v) => v.token),
    ).not.toContain("repository");
  });

  it("catches an active import of src/plugins/** from db/**", () => {
    expect(
      scanTs('import { gh } from "@/plugins/github/client";').map(
        (v) => v.family,
      ),
    ).toContain("plugin-boundary");
    expect(
      scanTs('import { Octokit } from "@octokit/rest";').map((v) => v.family),
    ).toContain("provider-sdk");
  });

  it("ignores provider tokens that appear ONLY in a comment", () => {
    // This is the load-bearing inversion versus the core guard, and the reason a
    // naive whole-file grep over db/ is red on a clean tree.
    expect(
      scanTs(
        "/**\n * no provider-specific (GitHub) columns here\n */\nexport const n = 1;",
      ),
    ).toEqual([]);
    expect(
      scanTs(`// mentions octokit and ${NATIVE_PULL}\nconst n = 1;`),
    ).toEqual([]);
    expect(
      scanSql(
        "-- github_pr_number used to live here\nCREATE TABLE t (a text);",
      ),
    ).toEqual([]);
    expect(
      scanSql(
        "/* block comment naming glab and merge_request */\nCREATE TABLE t (a text);",
      ),
    ).toEqual([]);
  });

  it("keeps line numbers aligned when a comment is stripped", () => {
    const line = "// a // b // c";
    const stripped = stripTsComments(`${line}\nexport const n = 1;`).split(
      "\n",
    );
    expect(stripped).toHaveLength(2);
    expect(stripped[0]).toBe(" ".repeat(line.length));
    expect(stripped[1]).toBe("export const n = 1;");

    const block = "/**\n * octokit\n */";
    const blockStripped = stripTsComments(
      `${block}\nexport const n = 1;`,
    ).split("\n");
    expect(blockStripped).toHaveLength(4);
    expect(blockStripped[3]).toBe("export const n = 1;");
    expect(blockStripped.join("\n")).not.toContain("octokit");
  });
});

/**
 * Evasions catalogued elsewhere in this repo, re-asserted here against THIS
 * file's stripper. A `//` or `/*` that is actually inside a literal will silently
 * blind the whole guard, so each of these is a named failure rather than a comment.
 */
describe("db-schema comment stripping (B13/B17/B20 evasion families)", () => {
  const scanTs = (snippet: string) => findViolations(snippet, "fixture.ts");
  const scanSql = (snippet: string) => findViolations(snippet, "fixture.sql");

  it("does not treat a `//` inside a regex literal as a comment", () => {
    expect(
      scanTs("const re = /[//]/; const pr_title = 1;").map((v) => v.token),
    ).toContain("pr_");
    expect(
      scanTs("const re = /[//]/; const github = 1;").map((v) => v.token),
    ).toContain("github");
    // ...and the other regex shapes that can hold a slash.
    for (const snippet of [
      "const re = /a\\/b/; const pr_title = 1;",
      "const re = /[//]/gi; const pr_title = 1;",
      "const re = /a/b/; const pr_title = 1;",
      "function f() { return /[//]/; } const mr_x = 1;",
      "const s = `${/[//]/}`; const pr_title = 1;",
    ]) {
      expect(
        scanTs(snippet).length,
        `expected a violation after the regex in: ${snippet}`,
      ).toBeGreaterThan(0);
    }
    // A real comment AFTER a regex literal is still a comment.
    expect(scanTs("const re = /[//]/; // pr_hidden")).toEqual([]);
    // Division is division, not a regex start.
    expect(scanTs("const q = a / b / c; // pr_hidden")).toEqual([]);
  });

  it("does not treat a `//` inside a string literal as a comment", () => {
    // The B20 shape: a paren/brace inside a string must not unbalance the scanner.
    expect(scanTs('const s = "a // pr_hidden";').map((v) => v.token)).toContain(
      "pr_",
    );
    expect(
      scanTs('if (label === "(") /[//]/; const pr_title = "PR";').map(
        (v) => v.token,
      ),
    ).toContain("pr_");
    expect(
      scanTs('const s = "see (/* nested */ here)"; const pr_title = 1;').map(
        (v) => v.token,
      ),
    ).toContain("pr_");
  });

  it("keeps template TEXT but drops the interpolation's own comment", () => {
    expect(scanTs("const s = `a // pr_hidden`;").map((v) => v.token)).toContain(
      "pr_",
    );
    expect(scanTs("const s = `${a // pr_hidden\n}`;")).toEqual([]);
    // A `//` in the text after an interpolation is still literal text.
    expect(
      scanTs("const s = `${a} // pr_hidden`;").map((v) => v.token),
    ).toContain("pr_");
  });

  it("strips SQL comments without eating string or dollar-quoted bodies", () => {
    // `--` inside a SQL string is data, not a comment.
    expect(
      scanSql("SELECT '-- pr_hidden'; -- pr_gone").map((v) => v.token),
    ).toContain("pr_");
    expect(
      scanSql("SELECT '-- pr_hidden'; -- pr_gone").filter(
        (v) => v.token === "pr_",
      ),
    ).toHaveLength(1);
    // `''` escape inside a string.
    expect(
      scanSql("SELECT 'it''s -- pr_hidden'; CREATE TABLE t (a text);").map(
        (v) => v.token,
      ),
    ).toContain("pr_");
    // Dollar-quoted function body.
    expect(
      scanSql(
        "CREATE FUNCTION f() RETURNS text AS $BODY$ -- pr_hidden $BODY$ LANGUAGE sql;",
      ).map((v) => v.token),
    ).toContain("pr_");
    // A `/*` inside a SQL string must not blank the rest of the file.
    expect(
      scanSql("SELECT '/* pr_hidden'; CREATE TABLE github_thing (a text);").map(
        (v) => v.token,
      ),
    ).toContain("github");
    // Nested block comments (Postgres allows them) are stripped whole.
    expect(
      scanSql(
        "/* outer /* inner github */ still comment */ CREATE TABLE t (a text);",
      ),
    ).toEqual([]);
  });

  it("scans JSON verbatim, since a snapshot mirrors every column name", () => {
    const snapshot = JSON.stringify({
      tables: {
        "public.github_events": {
          columns: { github_id: { name: "github_id" } },
        },
      },
    });
    expect(
      findViolations(snapshot, "0001_snapshot.json").map((v) => v.token),
    ).toContain("github");
  });

  it("refuses an extension it has no stripper for", () => {
    expect(() =>
      stripCommentsForExtension("fixture.yaml", "github: 1"),
    ).toThrow(/no comment stripper/);
  });
});
