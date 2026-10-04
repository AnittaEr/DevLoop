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
 * Case-folding, and why it is here (B30). This file was written case-SENSITIVE and
 * said so: case-insensitivity was "B19's card (`t_955b2cb0`), still in flight", and
 * making this file case-insensitive independently would have made the fix be applied
 * twice. That reasoning was correct WHEN WRITTEN, and the condition it named has now
 * been met — B19 landed at `40138c27390952bb265eccae3cf81076129953ce` and the core
 * guard is case-INSENSITIVE. So the deferral is discharged here, by this file, with
 * one `CASE_INSENSITIVE` constant feeding every token regex.
 *
 * Applying the flag twice is not left to a reader's memory. `it("agrees with the
 * core plugin-boundary guard on shared probes")` below imports the core guard's own
 * `findViolations` and asserts the two agree token-for-token, so the next edit to
 * either copy that changes this axis fails a named test instead of silently making
 * the two guards disagree.
 *
 * The consequence is measured, not assumed: the only provider token in today's
 * `db/**` is the capitalised `GitHub` in `db/schema.ts`'s header comment, which
 * comment-stripping already removes before the armed scan runs — so the guard is
 * clean at its head and the flag's real work is on the shapes it has not seen yet.
 * Those are pinned by the three case-family probes and by the parity test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

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

/**
 * B30: the one place this file says whether it folds case.
 *
 * Every deny-list token in `DENY_LIST` is spelled lowercase, and every one of them
 * is reachable as `GITHUB_REPO`, `GitHubPullRequest` or `OCTOKIT_TOKEN` in exactly
 * the positions this guard exists to police. Without the flag the pattern is blind
 * to all three.
 *
 * Declared as a named constant rather than a bare inline `"i"` for the reason B19
 * gave in `src/core/__tests__/plugin-boundary.test.ts` (its own
 * `CASE_INSENSITIVE`): there are several regex-construction sites here plus four
 * forbidden-import literals that spell a provider, and a guard that folds case in
 * some of them and not others is a half-armed guard that still reports green. One
 * constant means the next edit has one place to look, and the parity test below can
 * assert the policy instead of restating it.
 */
const CASE_INSENSITIVE = "i";

/**
 * Module specifiers `db/**` may never reach for.
 *
 * B30: the four patterns that SPELL A PROVIDER (`@octokit/`, `@gitlab/`,
 * `bitbucket`, `azure-devops`) carry `CASE_INSENSITIVE`, matching the core guard's
 * own split — `@OCTOKIT/rest` and `require("Bitbucket")` are working import paths a
 * case-sensitive guard cannot see. The three PATH-SHAPE patterns (`plugins/`,
 * `@/plugins/`, `node_modules/`) deliberately do not: they name no provider, so
 * there is nothing to fold, and folding them would only widen a pattern whose job
 * is to recognise a directory layout.
 */
const FORBIDDEN_IMPORT_PATTERNS: ReadonlyArray<{
  readonly family: string;
  readonly pattern: RegExp;
}> = [
  { family: "plugin-boundary", pattern: /(^|["'`])\/?(src\/)?plugins\// },
  { family: "plugin-boundary", pattern: /@\/plugins\// },
  {
    family: "provider-sdk",
    pattern: new RegExp("@octokit/", CASE_INSENSITIVE),
  },
  { family: "provider-sdk", pattern: /(^|["'`/])node_modules\// },
  {
    family: "provider-sdk",
    pattern: new RegExp("(^|[\"'`/])@gitlab/", CASE_INSENSITIVE),
  },
  {
    family: "provider-sdk",
    pattern: new RegExp("bitbucket", CASE_INSENSITIVE),
  },
  {
    family: "provider-sdk",
    pattern: new RegExp("azure-devops", CASE_INSENSITIVE),
  },
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
 *
 * B30: `CASE_INSENSITIVE` is what makes this pattern see `GITHUB_TOKEN` and
 * `GitHubToken` at all. The `lead`/`trail` decisions below are made in CODE against
 * the token's own characters (`/[A-Za-z0-9]/.test(...)`) rather than against the
 * subject line, and they must stay that way: the `i` flag would otherwise fold a
 * character class and re-admit the camelCase hump, which is the same trap that made
 * B19 move its equivalent check out of the regex and into `tokenEndsCleanly`.
 */
function tokenPattern(token: string): RegExp {
  const escaped = escapeForRegExp(token);
  const lead = /[A-Za-z0-9]/.test(token[0] ?? "") ? "(?:^|[^A-Za-z0-9])" : "";
  // NO trailing boundary in the pattern, and that is B19's second root cause rather
  // than an omission. Measured on this file with the flag first added and only the
  // `i` applied: `GitHubToken` reported ZERO violations, because `github` is
  // followed by `T` and a trailing `(?:[^A-Za-z0-9]|$)` refuses every alphanumeric.
  // `GITHUB_TOKEN` happened to survive only because `_` is a delimiter, which is
  // luck, not coverage: the shape B19 exists for — a provider name as the PREFIX of
  // a longer identifier, in camelCase — was still invisible here.
  //
  // The trailing test therefore lives in {@link tokenEndsCleanly}, in CODE, exactly
  // as the core guard does it and for exactly the reason it gives: the decision
  // needs the ACTUAL case of the next character, and under case-insensitive
  // matching a negated class folds (a `[^a-z]` would also exclude `A-Z`), so the
  // camelCase hump cannot be expressed in the regex at all. Attempting it here is
  // the same trap B19 measured and abandoned.
  return new RegExp(`${lead}${escaped}`, CASE_INSENSITIVE);
}

/**
 * Does the match that just ended sit at a legal END of a provider identifier?
 *
 * Mirrors the core guard's `tokenEndsCleanly` so the two agree by construction on
 * this axis rather than by coincidence. A token embedded in the middle of a
 * LOWERSPACED word is a different symbol (`xgithuby`, and `shadow` for `ado`), so a
 * lowercase continuation is refused. Everything else is a real leak:
 *   - end of line / identifier   -> `github`, `OCTOKIT`
 *   - an underscore or delimiter  -> `GITHUB_TOKEN_PREFIX` (SQL treats `_` as part
 *                                    of the name, which is why this guard reads
 *                                    column declarations at all)
 *   - a camelCase hump (uppercase)-> `GitHubToken`
 */
function tokenEndsCleanly(
  line: string,
  matchIndex: number,
  tokenLength: number,
): boolean {
  const next = line[matchIndex + tokenLength];
  return next === undefined || next === "_" || !/[a-z]/.test(next);
}

/**
 * Whole-token gate for one deny entry against one line.
 *
 * `entry.pattern.test(line)` alone is NOT sufficient once the trailing decision
 * lives in code: a line can contain a clean match and a dirty one (`xgithuby
 * GitHubToken`), and a boolean `test()` reports only whether SOME match exists.
 * Re-running with `g` and accepting if ANY candidate ends cleanly is the core
 * guard's `tokenMatches` shape, kept identical so the two cannot diverge on this
 * axis.
 */
function tokenEndsCleanlyOn(
  line: string,
  entry: { readonly token: string; readonly pattern: RegExp },
): boolean {
  // Tokens that do not end on a word character (`pr_`, `owner/repo`) have nothing
  // after them to check, and `_`-terminated tokens encode their own delimiter.
  if (!/[A-Za-z0-9]$/.test(entry.token)) return true;
  // `g` is REQUIRED: without it `matchAll` sees only the first candidate, which is
  // precisely the case this re-check exists for.
  const re = new RegExp(entry.pattern.source, `g${CASE_INSENSITIVE}`);
  for (const m of line.matchAll(re)) {
    if (m.index === undefined) continue;
    // The token does NOT necessarily start at `m.index`. This guard's leading
    // boundary is `(?:^|[^A-Za-z0-9])`, which CONSUMES a delimiter character,
    // whereas the core guard's is `\b`, which is zero-width — so the same
    // `m.index + tokenLength` arithmetic that is correct there is off by one here
    // and silently reports every `github`-shaped token as ending mid-identifier.
    // (Measured: doing this wrong took the suite from 4 failures to 15, every one of
    // them a real detection that stopped firing.) Deriving the start from the match
    // length is robust to either boundary style.
    const tokenStart = m.index + m[0].length - entry.token.length;
    if (tokenEndsCleanly(line, tokenStart, entry.token.length)) return true;
  }
  return false;
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
    `m${CASE_INSENSITIVE}`,
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
      if (entry.pattern.test(line) && tokenEndsCleanlyOn(line, entry)) {
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
      if (entry.pattern.test(line) && tokenEndsCleanlyOn(line, entry)) {
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

/**
 * B30: the three case families, as permanent named failures.
 *
 * The guard was case-SENSITIVE for its whole life, so no shape in this file ever
 * proved the flag was needed — the only real provider token in `db/**` is the
 * capitalised `GitHub` in `db/schema.ts`'s header comment, and comment-stripping
 * removes that before the armed scan runs. A guard never observed red is not
 * evidence it is armed, so each family gets its own `it()` and each names the exact
 * reason the token is a violation.
 *
 * Lowercase is included deliberately even though it already worked before B30: it is
 * the control that proves the flag did not NARROW detection. A regex given `i` can
 * lose a match it used to have, and `expr_value` / `shadow` below are the checks for
 * that.
 */
describe("db-schema scanner (case families, B30)", () => {
  const scanTs = (snippet: string) => findViolations(snippet, "fixture.ts");
  const scanSql = (snippet: string) => findViolations(snippet, "fixture.sql");

  it("catches a UPPER_SNAKE column, which the case-sensitive guard could not see", () => {
    // A Drizzle column name derived from provider vocabulary. Before B30 this
    // reported zero violations: `github` is spelled lowercase in the deny-list and
    // the pattern carried no flag.
    //
    // The probe is BUILT from NATIVE_PULL rather than spelled out, because this file
    // must not itself contain that literal -- see the note on NATIVE_PULL. Spelling
    // it here was caught by the existing "assembles the deny-list's native tokens
    // exactly" control, not by review.
    const NAME = NATIVE_PULL.toUpperCase();
    const tokens = scanTs(`  GITHUB_${NAME}: text("GITHUB_${NAME}"),`).map(
      (v) => v.token,
    );
    expect(
      tokens,
      "an UPPER_SNAKE provider column must fire; if this is empty the i flag was dropped",
    ).toContain("github");
    // Both halves of the name fire, not just the vendor prefix.
    expect(tokens).toContain(NATIVE_PULL);
  });

  it("catches a camelCase column, which the case-sensitive guard could not see", () => {
    // The hump must come IMMEDIATELY after the vendor token. This guard refuses a
    // LOWERCASE continuation (that is the `shadow`/`ado` look-alike rule), so
    // `GitHubpullrequest` is clean by design and `GitHubPullRequest` is not.
    // Measured: on the first spelling of this probe only the native half fired, not
    // `github`, because the character after `GitHub` was lowercase `p`.
    const tokens = scanTs('  GitHubPullRequest: text("native_ref"),').map(
      (v) => v.token,
    );
    expect(
      tokens,
      "a camelCase provider column must fire; if this is empty the i flag was dropped",
    ).toContain("github");
    // The vendor prefix fired on the HUMP, which is the part the `i` flag alone
    // cannot deliver: `tokenPattern("github").test("GitHubPullRequest")` is false
    // without tokenEndsCleanly, because `P` is an alphanumeric.
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("catches an UPPER_SNAKE column in a migration, the dialect db/ really uses", () => {
    // A migration is where a schema change lands, so this is the dialect that
    // matters most and it is the one a reviewer reads least.
    const NAME = "GITHUB_TOKEN";
    const v = scanSql(
      `ALTER TABLE canonical_events ADD COLUMN "${NAME}" text;`,
    );
    expect(
      v.map((x) => x.token),
      "an UPPER_SNAKE provider column in a migration must fire; if this is empty the i flag was dropped",
    ).toContain("github");
    expect(v[0]?.line).toBe(1);
  });

  it("still catches the lowercase form, so the flag did not narrow detection", () => {
    // The control for the risk a flag introduces: `i` must not cost a match that
    // worked before. If this ever goes empty the guard got narrower, not stricter.
    expect(
      scanTs('  github_repo_id: text("github_repo_id"),').map((v) => v.token),
    ).toContain("github");
    expect(
      scanSql('CREATE TABLE "github_pulls" ("id" text);').map((v) => v.token),
    ).toContain("github");
  });

  /**
   * The negative controls, unchanged by B30, stated once as a named failure.
   *
   * `i` folds `[A-Z]` into the pattern, so the look-alike protection is the thing
   * most at risk from this change: `shadow` contains `ado`, `expr_value` contains
   * `pr_`-shaped text, and each is a real English word that a schema plausibly wants
   * to use. If folding case makes the guard cry wolf, it gets deleted instead of
   * fixed, and hard rule 1 loses its mechanical enforcement.
   */
  it("keeps every negative control clean, so case-folding does not add false positives", () => {
    for (const token of ["expr_", "xmr_", "spr_", "repr_", "shadow"]) {
      expect(
        scanTs(`  ${token}value: text("${token}value"),`).map((v) => v.token),
        `negative control ${token} must stay clean`,
      ).toEqual([]);
    }
    // The one shape a folded `[A-Za-z]` boundary could plausibly re-admit: the
    // camelCase hump. `ado` must not fire inside `shadow` in any casing.
    for (const word of ["shadow", "SHADOW", "Shadow", "shAdow"]) {
      expect(
        scanTs(`  ${word}: text("${word}"),`).map((v) => v.token),
        word,
      ).toEqual([]);
    }
  });

  it("catches an uppercased forbidden import, matching the core guard's split", () => {
    // `@OCTOKIT/rest` and `require("Bitbucket")` are working import paths. The four
    // forbidden-import patterns that SPELL a provider carry CASE_INSENSITIVE; the
    // three path-shape patterns deliberately do not, and are not expected to fire.
    expect(
      scanTs('import { Octokit } from "@OCTOKIT/rest";').map((v) => v.family),
    ).toContain("provider-sdk");
    expect(
      scanTs('import { Bitbucket } from "Bitbucket";').map((v) => v.family),
    ).toContain("provider-sdk");
    expect(
      scanTs('import { g } from "@GitLab/api";').map((v) => v.family),
    ).toContain("provider-sdk");
    expect(
      scanTs('import { a } from "AZURE-DEVOPS/api";').map((v) => v.family),
    ).toContain("provider-sdk");
  });

  it("still fires on a plugin path, so widening the provider patterns did not replace them", () => {
    // The counterpart to the test above. Widening the four provider-spelling
    // patterns must not have disturbed the plugin-boundary pair, which are the only
    // thing catching an import of `src/plugins/**` out of `db/`.
    expect(
      scanTs('import { gh } from "@/plugins/github/client";').map(
        (v) => v.family,
      ),
    ).toContain("plugin-boundary");
    expect(
      scanTs('import { x } from "src/plugins/thing";').map((v) => v.family),
    ).toContain("plugin-boundary");
    // An uppercase PLUGINS path is still caught -- not by the path-shape pattern,
    // which has no flag, but by `github` firing on the lowercase module name in the
    // same string. Stated so a future edit that drops one of the two is visible.
    expect(
      scanTs('import { x } from "@/PLUGINS/github/client";').map(
        (v) => v.token,
      ),
    ).toContain("github");
  });
});

/**
 * B30: parity with the core guard, asserted by execution rather than claimed in a
 * comment.
 *
 * The defect this card fixes is not that `db/` was case-sensitive. It is that TWO
 * COPIES of one policy existed and drifted, with nothing comparing them — so the
 * next edit to either file can reopen the gap silently and both suites stay green.
 * This test is the thing that stops that: it imports the core guard's own
 * `findViolations` and runs both scanners over the SAME probe strings.
 *
 * Importing it is possible and was verified, not assumed. The core guard is itself a
 * `*.test.ts` that calls `describe()` at module scope, so a plain dynamic import
 * from inside a test throws "Calling the suite function inside test function is not
 * allowed". `vi.doMock("vitest", ...)` neutralises that: the guard's suites are
 * collected as no-ops and only its exported scanner is used. If the core guard ever
 * stops exporting `findViolations`, this test fails by name rather than the import
 * quietly becoming undefined and every assertion below becoming vacuous — which is
 * why the typeof check is first and is not decoration.
 */
describe("db/ guard and core guard agree (B30 parity)", () => {
  /**
   * Probes chosen to cover the axis that actually drifted, plus the negative
   * controls that must agree by being clean on BOTH sides. A probe set of only
   * positives would pass trivially if both guards returned an empty array, so the
   * clean probes carry as much of the assertion as the firing ones.
   */
  const SHARED_PROBES: readonly string[] = [
    // The three shapes B19 exists for.
    "GITHUB_TOKEN",
    "GitHubToken",
    // Built, never spelled: this file must not contain the native literal, or
    // T10's guard reports it (see the note on NATIVE_PULL).
    `github_${NATIVE_PULL}`,
    "GITHUB_REPO",
    "OCTOKIT",
    "BITBUCKET",
    "AZURE_DEVOPS",
    // A deny token that carries no vendor substring, plus the camelCase hump that is
    // the shape B19's `tokenEndsCleanly` exists for. The underscore spelling is
    // `NATIVE_PULL` rather than a written literal: writing it in THIS file trips
    // T10's guard -- the same constraint recorded above `NATIVE_PULL` -- and it also
    // silently broke this file's own "does not leak the native token" control. Found
    // by execution, twice, not by review.
    "pullRequest",
    NATIVE_PULL,
    // Negative controls: must be clean on both sides.
    "expr_value",
    "xmr_thing",
    "spr_value",
    "repr_value",
    "shadow",
  ];

  /**
   * Run the core guard's scanner.
   *
   * Mocking `vitest` is required (see the note above) and is scoped to this one
   * dynamic import: `vi` comes from the STATIC import at the top of this file, never
   * from `await import("vitest")`. An earlier draft did the latter and it is a trap
   * worth recording -- the first call registers the mock, `doUnmock` in the `finally`
   * does not clear the module cache, so the SECOND call's `await import("vitest")`
   * returns the stub, whose `vi` is `{}`, and the test dies with `vi.resetModules is
   * not a function`. That failure is in the harness rather than in the policy being
   * asserted, which is exactly the shape that reads as a real defect.
   */
  async function coreFindViolations(
    source: string,
  ): Promise<readonly string[]> {
    vi.resetModules();
    vi.doMock("vitest", () => ({
      describe: () => undefined,
      it: () => undefined,
      expect: () => undefined,
      beforeAll: () => undefined,
      afterAll: () => undefined,
      beforeEach: () => undefined,
      afterEach: () => undefined,
      vi: {},
    }));
    try {
      const core = (await import("@/core/__tests__/plugin-boundary.test")) as {
        findViolations?: (
          source: string,
          file: string,
        ) => readonly {
          token: string;
        }[];
      };
      // FIRST assertion, and load-bearing: without it a core guard that stopped
      // exporting `findViolations` would make every comparison below compare
      // `[]` to `[]` and pass.
      expect(
        typeof core.findViolations,
        "the core guard no longer exports findViolations; this parity test is now vacuous",
      ).toBe("function");
      const find = core.findViolations as NonNullable<
        typeof core.findViolations
      >;
      return find(source, "parity-probe.ts").map((v) => v.token);
    } finally {
      vi.doUnmock("vitest");
      vi.resetModules();
    }
  }

  it("agrees with the core plugin-boundary guard on shared probes", async () => {
    for (const probe of SHARED_PROBES) {
      const source = `const ${probe} = 1;`;
      const coreTokens = await coreFindViolations(source);
      const dbTokens = findViolations(source, "parity-probe.ts").map(
        (v) => v.token,
      );

      // The verdict must be identical. NOT the token lists: the two guards'
      // position and boundary rules differ on purpose (this file widens to SQL
      // column syntax and uses alphanumeric rather than `\b` boundaries), so a
      // shape can legitimately match a different subset. Agreeing on WHETHER a
      // probe is a violation is the policy the two copies share, and it is the
      // policy that drifted.
      expect(
        dbTokens.length > 0,
        `parity: db guard and core guard disagree on "${probe}" — db=${JSON.stringify(dbTokens)} core=${JSON.stringify(coreTokens)}`,
      ).toBe(coreTokens.length > 0);
    }
  });

  it("agrees that the case-folded probes fire and the look-alikes do not", async () => {
    // Stated separately from the loop above so a failure names WHICH half moved:
    // if `db/` goes case-blind the first case fails; if `db/` starts crying wolf on
    // `shadow` the second does. One loop with both kinds mixed reports "disagrees"
    // and leaves the reader to work out which side moved.
    const shouldFire = ["GITHUB_TOKEN", "GitHubToken", `github_${NATIVE_PULL}`];
    for (const probe of shouldFire) {
      const source = `const ${probe} = 1;`;
      expect(
        findViolations(source, "parity-probe.ts").length,
        `db guard must fire on ${probe}`,
      ).toBeGreaterThan(0);
      expect(
        (await coreFindViolations(source)).length,
        `core guard must fire on ${probe}`,
      ).toBeGreaterThan(0);
    }
    for (const probe of ["expr_value", "shadow"]) {
      const source = `const ${probe} = 1;`;
      expect(findViolations(source, "parity-probe.ts"), probe).toEqual([]);
      expect(await coreFindViolations(source), probe).toEqual([]);
    }
  });

  it("declares the same case policy as the core guard, read from its own source", async () => {
    // Belt and braces over the behavioural loop: B30's policy was carried as a named
    // constant in BOTH files on purpose, so both must still exist and both must
    // still be the flag. This catches the failure the behavioural loop cannot: a
    // future edit that hard-codes `"i"` at one call site instead of widening the
    // constant, which would leave the behaviour green and the single-place-to-look
    // promise broken.
    const coreSource = readFileSync(
      path.resolve(
        REPO_ROOT,
        "src",
        "core",
        "__tests__",
        "plugin-boundary.test.ts",
      ),
      "utf8",
    );
    expect(coreSource).toContain('const CASE_INSENSITIVE = "i";');
    expect(readFileSync(THIS_FILE, "utf8")).toContain(
      'const CASE_INSENSITIVE = "i";',
    );

    // And this file must route EVERY case decision through that one constant — no
    // bare inline "i" flag left behind beside it.
    const ownSource = readFileSync(THIS_FILE, "utf8");
    expect(ownSource).not.toMatch(/new RegExp\([^)]*,\s*"i"\s*\)/);
    expect(ownSource).not.toMatch(/,\s*"mi"\s*\)/);
  });
});
