/**
 * Mechanical architecture test: the core/plugin boundary.
 *
 * `src/core/` holds provider-agnostic domain logic. Provider vocabulary
 * (GitHub, GitLab, Bitbucket, Azure DevOps) belongs in `src/plugins/`.
 * "One provider's vocabulary is a preference; three is a boundary" (PM ruling
 * D-065), so the deny-list below is multi-provider rather than keyed on any
 * single vendor.
 *
 * The generic family (`repo`, `repository`, `branch`, `commit_sha`) is
 * deliberately over-inclusive when it appears as a typed field name: a false
 * positive costs a rename, a false negative lets the boundary rot. There is
 * deliberately NO allowlist for pre-existing violations -- a boundary test
 * tuned to pass against the code it polices is worse than no test.
 *
 * Comment policy: `//` line comments are stripped. Block comments (slash-star and
 * JSDoc, which use the opposite markers) are deliberately NOT stripped: a
 * provider token inside one of those comments is therefore a failure, by design.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Deny-list, written as plain literals on purpose. It is deliberately NOT
 * assembled by string concatenation, split/join, `String.fromCharCode`, base64,
 * template interpolation or a dynamic import -- any of those would be an obvious
 * bypass of this test by anyone editing it later.
 *
 * `pull_request` / `pull_request_review` are here because they are GitHub API
 * resource names that carry no `github` substring: a detector keyed on
 * `github` runs, finds nothing and goes green over a provider-bound core
 * (proven against T3 Stage 1, commit 1fba431: `grep -ri github src/core/`
 * returned zero matches while `grep -rn pull_request src/core/` returned four).
 */
type DenyFamily = {
  readonly family: string;
  readonly tokens: readonly string[];
  /** When true the token only counts in a typed field position. */
  readonly fieldNameOnly?: boolean;
};

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
      "pull_request",
      "pull_request_review",
    ],
  },
  { family: "gitlab", tokens: ["merge_request", "mr_", "gitlab", "glab"] },
  { family: "bitbucket", tokens: ["bitbucket", "bb-"] },
  { family: "azure-devops", tokens: ["work_item", "azure_devops", "ado"] },
  {
    family: "generic-src",
    tokens: ["repo", "repository", "branch", "commit_sha"],
    // Only flagged as a typed FIELD name, not as prose or an import path.
    fieldNameOnly: true,
  },
] as const;

/**
 * B19: deny-list matching is case-insensitive everywhere.
 *
 * Declared once so the token matcher, the typed-field-name matcher and the
 * forbidden-import gate cannot drift apart on this axis: a guard that folds case
 * in one place and not another is exactly the half-fixed hole B19 closed.
 */
const CASE_INSENSITIVE = "i";

/**
 * Module specifiers `src/core/` may never reach for.
 *
 * B19: the patterns that spell a provider in lowercase carry the
 * case-insensitive flag for the same reason the deny tokens do. `@OCTOKIT/rest`
 * or `require("Bitbucket")` would otherwise be a working import path that the
 * guard cannot see. The path-shape patterns (`plugins/`, `node_modules/`) are
 * provider-neutral and do not need it.
 */
const FORBIDDEN_IMPORT_PATTERNS: ReadonlyArray<{
  readonly family: string;
  readonly pattern: RegExp;
}> = [
  { family: "plugin-boundary", pattern: /(^|["'`])\/?(src\/)?plugins\// },
  { family: "plugin-boundary", pattern: /@\/plugins\// },
  { family: "provider-sdk", pattern: /@octokit\//i },
  { family: "provider-sdk", pattern: /(^|["'`/])node_modules\// },
  { family: "provider-sdk", pattern: /(^|["'`/])@gitlab\//i },
  { family: "provider-sdk", pattern: /bitbucket/i },
  { family: "provider-sdk", pattern: /azure-devops/i },
];

// Module-load invariant: a deny-list that failed to load would make every case
// below vacuously green. Fail loudly, at import time, if that ever happens.
if (DENY_LIST.length === 0) {
  throw new Error("plugin-boundary: DENY_LIST is empty at module load");
}
if (DENY_LIST.some((entry) => entry.tokens.length === 0)) {
  throw new Error("plugin-boundary: a DENY_LIST family has no tokens");
}
if (FORBIDDEN_IMPORT_PATTERNS.length === 0) {
  throw new Error("plugin-boundary: FORBIDDEN_IMPORT_PATTERNS is empty");
}

const THIS_FILE = fileURLToPath(import.meta.url);
const CORE_DIR = path.resolve(path.dirname(THIS_FILE), "..");
const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export type Violation = {
  readonly file: string;
  readonly line: number;
  readonly family: string;
  readonly token: string;
  readonly source: string;
};

/**
 * Word-boundary matcher. `ado` must not match `shadow` and `pr_` must not match
 * `expr_`, so both a leading and a trailing boundary are enforced.
 *
 * A trailing `\b` is only satisfiable when the token's last character is NOT a
 * word character: `_` IS one, so `\b<token ending in _>\b` demands a boundary
 * between `_` and the next character, and in any real identifier that next
 * character is itself a word character. `pr_`/`mr_` were therefore inert: they
 * sat in the deny-list on paper and could never fire in real code.
 *
 * For a `_`-terminated token the trailing boundary is instead expressed by the
 * token itself (it ends on a delimiter, so `pr_` matches `foo_pr_bar` but not
 * `spr_`), and the leading boundary becomes "not preceded by an alphanumeric":
 * `_` and `.` are legitimate delimiters, so `expr_pr_foo` and `obj.pr_title`
 * are caught while `expr_`/`xmr_` stay clean.
 *
 * B19 ROOT CAUSE — there were TWO independent defects, and fixing only the
 * first would have shipped a guard that still could not see the leak it was
 * written for. Both are fixed here; both were measured, not assumed.
 *
 * (1) CASE. Every deny token is written in lowercase (`github`, `octokit`,
 * `pr_`, `mr_`, ...) and the pattern carried no `i` flag, so `GITHUB_TOKEN`,
 * `OCTOKIT` and `PR_TITLE` were all invisible. Matching is now
 * case-insensitive.
 *
 * (2) BOUNDARY — the half that mattered most. The trailing `\b` on a
 * word-terminated token is unsatisfiable in the middle of an identifier: in
 * `GITHUB_TOKEN` the character after `GITHUB` is `_`, and `_` is a word
 * character, so no boundary exists there. Case-folding ALONE still left
 * `GITHUB_TOKEN`, `GitHubToken` and the real `GITHUB_TOKEN_PREFIX` export
 * reporting ZERO violations — measured, not assumed. Provider vocabulary nearly
 * always appears as a PREFIX of a longer constant (`GITHUB_TOKEN_PREFIX`,
 * `GITHUB_TOKEN_ENV_VAR`), which is exactly the shape a hard `\b` cannot see.
 *
 * The trailing test is therefore NOT part of the pattern. It is
 * {@link tokenEndsCleanly}, which decides in code because the decision needs to
 * see the ACTUAL case of the next character, and the `i` flag destroys exactly
 * that: under case-insensitive matching a negated class `[^a-z]` also excludes
 * `A-Z`, so expressing "the next character is not a lowercase letter" as
 * `[^a-z]` rejects the camelCase hump and silently re-opens the hole. That was
 * attempted and measured here before being abandoned.
 *
 * This only ever ADDS detection; the lowercase spellings matched before and
 * still do (see the "adds detection and removes none" control).

 *
 * B26 ROOT CAUSE: the trailing `\b` was the whole trailing rule, and a
 * camelCase hump supplies no boundary -- `\bgithub\b` cannot match anywhere in
 * `githubPullRequest`, `githubIssue` or `githubWebhookDelivery`, so the deny-list
 * token was inert in exactly the shape real TypeScript uses. Measured at
 * fa8f753: `export const githubPullRequest = "review";` under `src/core/`
 * reported zero violations.
 *
 * The trailing rule is therefore now "the token is not continued by a LOWER
 * case letter, digit or underscore" -- `(?![a-z0-9_])`. An uppercase letter
 * after the token is a camelCase hump and is provider vocabulary continuing;
 * a lowercase one is a longer word that merely starts the same way, so
 * `repo` still does not fire on `repository` and `ado` still does not fire on
 * `shadow`. The LEADING boundary is untouched, so a token that merely appears
 * mid-word (`spr_`, `repr_`, `shadow`) stays clean either way.
 *
 * Separately, a deny-list token is written in snake_case
 * (`pull_request`, `azure_devops`, `work_item`) while the identifiers TypeScript
 * code actually uses are camelCase (`pullRequest`, `azureDevopsWorkItem`), so
 * the body is built case-tolerantly and with the internal `_` optional:
 * `pull_request` -> `[pP]ull[_]?[rR]equest`. That is a MATCHER change, not a
 * deny-list change -- no token is added, removed or renamed, and the deny-list
 * itself is out of scope for this card.
 *
 * Case tolerance is spelled as explicit `[cC]` classes, NOT the `i` flag: under
 * `i` the trailing lookahead `(?![a-z0-9_])` would also accept an uppercase
 * letter and would then reject `githubPullRequest` again. The two rules need
 * OPPOSITE case sensitivity, so the body cannot carry the flag.
 *
 * Case tolerance applies to every character AFTER the first and never to the
 * first one. The hump inside a token is where camelCase capitalises
 * (`pullRequest`, `azureDevopsWorkItem`); the token's own first letter is
 * lowercase in every camelCase shape, so tolerating case there buys nothing and
 * costs a real false positive: prose writing "GitHub" with a capital G is
 * everywhere in `src/core/credentials/**` (measured at fa8f753, 7 lines across
 * env-provider.ts / fakes.ts / provider.ts), and capitalising the FIRST letter of
 * the deny-list's first token turns every one of those comments into a
 * violation.
 *
 * ---------------------------------------------------------------------------
 * B27 RECONCILIATION (this card merges B19 `40138c2` and B26 `1228acc`, which
 * are siblings off `fa8f753` and conflict in three hunks of this file).
 *
 * B26's block above is RETAINED IN FULL, verbatim, as the record of the root
 * cause it found. Its finding is correct and is implemented here. Three of its
 * DERIVED PRESCRIPTIONS are SUPERSEDED by the merge, are NOT implemented, and
 * must not be re-derived from this comment by a later reader:
 *
 *   (S1) "Case tolerance is spelled as explicit `[cC]` classes, NOT the `i`
 *        flag", and (S2) "Case tolerance applies to every character AFTER the
 *        first and never to the first one."
 *        Both are the same rule seen from two sides: keep the FIRST character of
 *        a token case-SENSITIVE, and therefore never let the whole token fold.
 *        That is irreconcilable with B19 criterion (i), which requires
 *        `GITHUB_TOKEN`, `github_token` and `GitHubToken` all to fire. Under `i`
 *        the deny token `github` IS `GitHub` IS `GITHUB`, so a rule that fires on
 *        the standalone upper-case spelling necessarily fires on the prose
 *        spelling; there is no intermediate spelling to carve out. Measured
 *        here: conditioning the exception on a hump continuation does not rescue
 *        it either, because the required probe `const OCTOKIT = 1;` has a SPACE
 *        after the match, so the exception cannot engage. B19's `i` +
 *        {@link tokenEndsCleanly} is kept; B26's `[cC]` helper `caseTolerant` is
 *        consequently unused and removed, since `i` subsumes it.
 *
 *   (S3) The false positive those prescriptions existed to avoid -- prose
 *        writing "GitHub" with a capital G in `src/core/credentials/**`. It no
 *        longer exists on this tree, and it is B19 that removed it: B19 deleted
 *        `GITHUB_TOKEN_PREFIX` and `GITHUB_TOKEN_ENV_VAR` from
 *        `src/core/credentials/provider.ts` as the leak it was fixing, and with
 *        them the vendor prose. Measured on the assembled tree of this card at
 *        `origin/main` `1e62702` + `40138c2` + `1228acc`:
 *          grep -rn 'GITHUB\|GitHub\|github' src/core --include=*.ts \
 *            | grep -v 'core/__tests__/plugin-boundary'   -> 0 lines
 *          grep -rn 'GITHUB_TOKEN_PREFIX' src e2e db docs \
 *            | grep -v plugin-boundary                      -> 0 lines
 *        So B26's premise was dissolved by the very sibling commit being merged
 *        into it, and its "does NOT flag prose that merely capitalises" control
 *        was dropped rather than satisfied. It is recorded as SUPERSEDED in the
 *        test block too, not silently deleted.
 *
 * WHAT B26 CONTRIBUTED AND IS KEPT:
 *   - the camelCase-hump trailing semantics (uppercase continuation is provider
 *     vocabulary, lowercase is a longer unrelated word). B26 spelled this as
 *     `(?![a-z0-9_])`; it is spelled {@link tokenEndsCleanly} here, which is
 *     strictly WIDER -- it additionally admits `_` and digits, which is what
 *     makes `GITHUB_TOKEN_PREFIX` fire. B19's spelling subsumes B26's; B26's
 *     `lead` boundary is identical to B19's and is kept verbatim.
 *   - the snake_case -> camelCase bridge: the internal `_` becomes optional, so
 *     `pull_request` also matches `pullRequest`. The `[cC]` classes are not
 *     needed for this, because the `i` flag already folds case -- only the
 *     `[_]?` part of B26's body builder is load-bearing here, and it is.
 *   - the leading-boundary discipline, which both sides agree on and which is
 *     what keeps `shadow` (`ado`), `xgithuby` (`github`) and `spr_`/`repr_`
 *     (`pr_`) clean. These are the negative controls this card's criteria name.

 */
function tokenPattern(token: string): RegExp {
  const bare = escapeForRegExp(token);
  if (token.endsWith("_")) {
    return new RegExp(`(?:^|[^A-Za-z0-9])${bare}`, CASE_INSENSITIVE);
  }
  const body = [...token]
    .map((char) => {
      // B27: `[_]?` is B26's snake_case -> camelCase bridge and is load-bearing
      // under any case policy. The `[cC]` classes B26 paired it with are NOT,
      // because the `i` flag already folds case -- see the B27 reconciliation in
      // this header. Every character other than the optional `_` is taken
      // literally and folded by the flag.
      if (char === "_") return "[_]?";
      return escapeForRegExp(char);
    })
    .join("");
  const lead = /[A-Za-z0-9]/.test(token[0] ?? "") ? "\\b" : "";
  return new RegExp(`${lead}${body}`, CASE_INSENSITIVE);
}

/**
 * Does the match that just ended sit at a legal END of a provider identifier?
 *
 * `matchLength` is the length of the text the pattern ACTUALLY matched, which
 * is NOT `token.length`: B26's `[_]?` makes the internal underscore optional, so
 * the deny-list token `azure_devops` (11 chars) matches the 10 characters of
 * `azureDevops`. Reading the character after `token.length` would land one past
 * the real end of the match and ask about the wrong character. Measured: with
 * `token.length` here, `azureDevopsWorkItem` and `mergeRequestState` reported
 * zero violations.
 *
 * A token embedded in the middle of a LOWERSPACED word is a different symbol
 * (`xgithuby`, and `shadow` for `ado`), so a lowercase continuation is
 * refused. Everything else is a real leak and is admitted:
 *   - end of the line / identifier   -> `github`, `OCTOKIT`
 *   - an underscore or delimiter     -> `GITHUB_TOKEN_PREFIX`
 *   - a camelCase hump (uppercase)   -> `GitHubToken`, `githubPullRequest`
 *
 * This is also where B26's hump rule lives. B26 expressed it as the lookahead
 * `(?![a-z0-9_])` and explained in its header why the `i` flag cannot carry it:
 * under `i` a negated lowercase class also excludes `A-Z`. That reasoning is
 * exactly why this decision is made in CODE, on the real character, instead of
 * inside the pattern -- see the B27 reconciliation in the {@link tokenPattern}
 * header for what was kept and what was superseded.
 */
function tokenEndsCleanly(
  line: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const next = line[matchIndex + matchLength];
  return next === undefined || next === "_" || !/[a-z]/.test(next);
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/\-]/g, "\\$&");
}

/**
 * A typed field position: `repo:`, `repo?:`, inside an interface / type / object type.
 */
function fieldNamePattern(token: string): RegExp {
  return new RegExp(
    `(?:^|[{;,\\n])\\s*(?:readonly\\s+)?${escapeForRegExp(token)}\\s*\\??\\s*:`,
    `m${CASE_INSENSITIVE}`,
  );
}

const FIELD_NAME_PATTERNS = new Map<string, RegExp>(
  DENY_LIST.flatMap((entry) =>
    entry.tokens.map((token) => [token, fieldNamePattern(token)] as const),
  ),
);

const TOKEN_PATTERNS: ReadonlyMap<string, { family: string; pattern: RegExp }> =
  new Map(
    DENY_LIST.flatMap((entry) =>
      entry.tokens.map(
        (token) =>
          [
            token,
            { family: entry.family, pattern: tokenPattern(token) },
          ] as const,
      ),
    ),
  );

/**
 * Does `line` contain `token` in a position that means "provider identifier"?
 *
 * Every candidate match is inspected, not just the first: `RegExp.test` stops at
 * the first hit, which may be the illegal embedded one, so a line carrying both
 * an embedded and a legal occurrence would otherwise be missed.
 */
function tokenMatches(line: string, token: string): boolean {
  const entry = TOKEN_PATTERNS.get(token);
  if (entry === undefined) return false;
  if (!entry.pattern.test(line)) return false;
  // `_`-terminated tokens already encode their trailing delimiter, and tokens
  // ending in a non-word character have nothing to check after them.
  if (!/[A-Za-z0-9]$/.test(token)) return true;
  // `g` is required by matchAll, and dropping it would make the loop see only
  // the first candidate — the exact case this re-checks.
  const re = new RegExp(entry.pattern.source, `g${CASE_INSENSITIVE}`);
  for (const m of line.matchAll(re)) {
    if (m.index === undefined) continue;
    // `m[0].length`, not `token.length`: B26's `[_]?` makes the matched span
    // shorter than the deny-list token whenever the underscore was absent
    // (`azure_devops` matching `azureDevops`). See {@link tokenEndsCleanly}.
    if (tokenEndsCleanly(line, m.index, m[0].length)) return true;
  }
  return false;
}

/**
 * Strip `//` line comments ONLY, replacing each stripped character with a space
 * so that every offset -- and therefore every line number -- is preserved.
 *
 * String, template and REGEX literals are tracked so that a `//` inside them is
 * not mistaken for a comment. Block comments are deliberately NOT stripped: the
 * comment policy requires a provider token inside `/* *\/` or JSDoc to fail.
 *
 * (Base f07b894's header claimed "String, template and regex literals are
 * tracked" while its code tracked only strings and templates -- a false claim.
 * Regex tracking is now actually implemented; this header describes what the
 * scanner does.)
 *
 * T6b ROOT CAUSE: the `//` branch used to be tested FIRST and unconditionally,
 * so a `//` inside template-literal TEXT blanked the rest of the line -- provider
 * tokens and all -- and the guard went green over them. Template state was NOT
 * lost after an interpolation; the `//` strip simply ignored the literal state.
 * The fix is to track the enclosing literal (`quote`) and honour `//` as a
 * comment only in real code. Inside `${...}` we are back in real code, so a
 * `//` there is still a genuine comment and is still stripped.
 *
 * B13 ROOT CAUSE: regex literals were not tracked at all, so
 * `const re = /[//]/; const pr_title = 1;` blanked everything after the `//`
 * and reported ZERO violations -- a `//` inside a regex literal (very commonly
 * written as a character class matching a slash) hid provider vocabulary, and
 * hid the bare `github` token too. Regex bodies are therefore scanned like any
 * other literal text: entered on an expression-position `/`, exited on an
 * unescaped `/` outside a character class, with trailing flags consumed.
 *
 * Telling a regex START from a division is the only genuinely ambiguous decision
 * in this scanner. It fails toward the guard on an unrecognised preceding token
 * (an empty line, or the start of the file): that keeps a `//` inside a regex
 * literal VISIBLE (more detection) rather than stripping a line that should not
 * be stripped.
 *
 * ONE DELIBERATE CARVE-OUT runs the other way, and B18 is about it. A `/` is read
 * as a DIVISION -- a false negative for the guard -- when the preceding character
 * is `]`, `++`, `--`, or a `)` that closes a grouping or call paren. That is the
 * safe-looking reading of the syntax but the dangerous one for this test, because
 * misreading a regex as a division lets a `//` blank the line. B18 closed the
 * `)` half of that carve-out for control-statement headers (`if (x) /[//]/;`,
 * where the body really can be a regex-literal statement); `]`/`++`/`--` remain
 * carve-outs, and a value-expression `)` remains one too.
 */
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

/** Keywords after which a `/` starts a regex, not a division. */
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
 * Keywords whose header paren is a CONTROL paren, not a grouping or call paren.
 *
 * B18: after `if (x)` a `/` opens a regex-literal STATEMENT; after the `)` of
 * `(a / b)` or `f(a)` it divides. The `)` character alone cannot tell the two
 * apart, so the decision is delegated to the keyword owning the matching `(`.
 */
const CONTROL_PAREN_KEYWORDS = new Set([
  "if",
  "while",
  "for",
  "with",
  "switch",
  "catch",
]);

export function stripLineComments(source: string): string {
  const out = source.split("");
  /** Open `${` depths of enclosing templates; 0 means "inside the expression". */
  const templateStack: number[] = [];
  /** Enclosing literal delimiter, or null when we are in real code. */
  let quote: string | null = null;
  /** True while scanning a regex body; `regexInCharClass` is true inside `[...]`. */
  let regexInCharClass = false;
  let regexOpen = false;
  /** Offset of the `[` that opened the current character class. */
  let regexClassStart = -1;
  /**
   * B20: paren nesting as SEEN BY THE MAIN LOOP, not re-derived by a second
   * backward pass. Each entry is one unclosed `(` with the keyword that owned it,
   * plus the `lastTopLevelSemi` value in force when it was pushed.
   *
   * Because the main loop only reaches this code in REAL CODE, parens inside
   * strings, template text, interpolations, regex bodies and comments never
   * enter the stack -- they are consumed by the `quote` / `templateStack` /
   * `regexOpen` branches above. That is the whole point: one lexical model, so
   * a `(` or `)` in literal text cannot desynchronise the count.
   */
  const parenStack: { keyword: string }[] = [];
  /**
   * B20: offsets of the `)` characters that closed a CONTROL header paren. This
   * is the recorded answer `closesControlHeaderParen` reads.
   */
  const controlCloseParens = new Set<number>();
  /**
   * B20: offsets of EVERY `)` the main loop saw in real code. Its purpose is to
   * let `closesControlHeaderParen` distinguish "this `)` is real code and closed a
   * non-control paren, so `/` divides" (a definite `false`) from "the main loop
   * never saw this `)` as code at all" (the defensive fallback).
   */
  const recordedCloseParens = new Set<number>();
  let i = 0;
  const n = source.length;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  /**
   * Does a `/` at offset `at` open a regex literal, or divide two values?
   *
   * Decided by a BACKWARD scan of the current line for the last significant
   * character, rather than by threading state through the main loop. The
   * backward scan is stateless, so it cannot drift out of sync with `i`, and it
   * cannot be desynchronised by a construct the main loop handles specially.
   *
   * Fails toward the guard: if no significant character is found on the line
   * (or the file starts), a regex is assumed -- that keeps a `//` inside the
   * literal VISIBLE to the deny-list instead of silently stripping the line.
   */
  const regexAllowedHere = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && !/[\S]/.test(source[k] as string)) k -= 1;
    if (k < 0) return true;
    const c = source[k] as string;
    if (REGEX_START_AFTER_PUNCTUATION.has(c)) return true;
    // An identifier-ish character means we are after a VALUE; a regex may only
    // follow one of the keywords listed (e.g. `return /[//]/`).
    if (/[A-Za-z0-9_$]/.test(c)) {
      let start = k;
      while (start >= 0 && /[A-Za-z0-9_$]/.test(source[start] as string)) {
        start -= 1;
      }
      const word = source.slice(start + 1, k + 1);
      return REGEX_START_AFTER_KEYWORD.has(word);
    }
    // `)`, `]`, `++`, `--`: a `/` here divides -- unless the `)` closes a
    // CONTROL header paren, whose body may be a regex-literal statement.
    if (c === ")") return closesControlHeaderParen(k);
    return false;
  };

  /**
   * Does the `)` at `closeAt` close the header paren of a control statement
   * (`if (...)`, `while (...)`, `for (...)`, `with (...)`, `switch (...)`,
   * `catch (...)`)?
   *
   * B18 ROOT CAUSE: the `)` branch of `regexAllowedHere` was an unconditional
   * "this divides". In a control statement's BODY a `/` opens a regex-literal
   * statement -- `if (x) /[//]/;` -- so the `//` inside the character class was
   * read as a line comment and blanked the rest of the line, hiding every
   * deny-listed token after it. Nothing about the `)` itself distinguishes the
   * two cases, so this walks back to the matching `(` and reads the keyword
   * that owns it: a control keyword means "statement body", anything else
   * (grouping, call, arrow params) means "a value just ended, so `/` divides".
   *
   * Matching is no longer RE-DERIVED here. B20: the function used to walk
   * backward over raw characters counting `(`/`)`, which had no notion of string
   * or template literals. A `(` inside a string pushed the count off and the walk
   * landed on the wrong paren or ran out of line and fell through to the
   * `return true` fallback below -- which is what produced BOTH of B20's
   * defects:
   *
   *   if (label === "(") /[//]/; const pr_title = "PR";   ->  []   (missed)
   *   const x = (")") / c; // pr_hidden                   ->  ["pr_"] (false +)
   *
   * The main loop now records, for every `)` in real code, whether the paren it
   * closed was a control header -- so this is a set lookup, not a second lexer.
   * A `)` in a string, template, interpolation, regex or comment never reaches
   * the main loop's paren handling, so it can neither push nor pop the stack.
   *
   * Fails toward the guard: an offset the main loop never recorded (only
   * reachable if this is called on a `)` that was inside literal text, which the
   * main loop cannot do) returns `true`, so a `//` stays visible.
   */
  const closesControlHeaderParen = (closeAt: number): boolean => {
    if (controlCloseParens.has(closeAt)) return true;
    if (recordedCloseParens.has(closeAt)) return false;
    return true;
  };

  while (i < n) {
    const ch = source[i] as string;
    const next = source[i + 1];

    // --- Regex body: nothing here is a comment or a delimiter. ---
    if (regexOpen) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") {
        // Unterminated (illegal JS, but recovery must not eat the rest of the
        // file): leave regex mode and reprocess this character as real code.
        regexOpen = false;
        i += 1;
        continue;
      }
      if (regexInCharClass) {
        // Inside `[...]` a `]` in FIRST position is a literal member, not a close
        // (so `/[]/]/` is scanned as one literal), and `[` / `/` are members too.
        if (ch === "]" && i > regexClassStart) {
          regexInCharClass = false;
        }
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
        // Flags (gimsuyvd) belong to the literal and can never open a comment.
        while (i < n && /[a-z]/i.test(source[i] as string)) i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // --- Literal text: nothing here is a comment or a delimiter. ---
    if (quote !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && next === "{") {
        // Interpolated expression: its contents ARE real code.
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

    // regex literal -> its body is literal text, not code
    if (ch === "/" && next !== "/" && next !== "*" && regexAllowedHere(i)) {
      regexOpen = true;
      regexInCharClass = false;
      regexClassStart = -1;
      i += 1;
      continue;
    }

    // line comment -> strip to end of line
    if (ch === "/" && next === "/") {
      let end = i;
      while (end < n && source[end] !== "\n") end += 1;
      blank(i, end);
      i = end;
      continue;
    }

    // block comment -> contents KEPT verbatim, but parsed so that nested
    // markers and terminators do not desynchronise the scanner
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }

    // --- Paren nesting (B20). Reached only in REAL CODE: the literal-text,
    // regex and comment branches above `continue` before this point, so a
    // paren inside a string, template, interpolation, regex body or comment can
    // neither push nor pop here. `closesControlHeaderParen` reads the two sets
    // this fills, which is how the control-header decision and the nesting
    // count share ONE lexical model instead of two.
    if (ch === "(") {
      // The keyword immediately owning this `(` decides what a `/` after its
      // `)` means. Same identifier scan the forward loop has always used.
      let wordEnd = i - 1;
      while (wordEnd >= 0 && !/\S/.test(source[wordEnd] as string)) {
        wordEnd -= 1;
      }
      let wordStart = wordEnd;
      while (
        wordStart >= 0 &&
        /[A-Za-z0-9_$]/.test(source[wordStart] as string)
      ) {
        wordStart -= 1;
      }
      const word = source.slice(wordStart + 1, wordEnd + 1);
      parenStack.push({
        keyword: CONTROL_PAREN_KEYWORDS.has(word) ? word : "",
      });
      i += 1;
      continue;
    }

    if (ch === ")") {
      recordedCloseParens.add(i);
      const popped = parenStack.pop();
      // An unmatched `)` (illegal JS, or a `)` the main loop reached without a
      // matching `(`) leaves nothing popped; treat it as non-control so a `/`
      // here divides, rather than guessing "control".
      if (popped?.keyword) controlCloseParens.add(i);
      i += 1;
      continue;
    }

    if (ch === "}" && templateStack.length > 0) {
      const depth = templateStack[templateStack.length - 1] ?? 0;
      if (depth === 0) {
        // Interpolation closes: resume the enclosing template's TEXT. Without
        // this, a `//` in that text would be honoured as a real comment.
        templateStack.pop();
        quote = "`";
        i += 1;
        continue;
      }
      templateStack[templateStack.length - 1] = depth - 1;
      i += 1;
      continue;
    }

    if (ch === "{") {
      // A nested object/brace inside an interpolation, not the end of it.
      if (templateStack.length > 0) {
        templateStack[templateStack.length - 1] =
          (templateStack[templateStack.length - 1] ?? 0) + 1;
      }
    }

    i += 1;
  }

  return out.join("");
}

function lineAt(lines: readonly string[], index: number): string {
  return (lines[index] ?? "").trim();
}

/** Pure scanner: provider vocabulary and forbidden imports in one source text. */
export function findViolations(source: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const scannable = stripLineComments(source);
  const lines = scannable.split("\n");

  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    for (const [token, entry] of TOKEN_PATTERNS) {
      const deny = DENY_LIST.find(
        (d) => d.family === entry.family && d.tokens.includes(token),
      );
      if (deny?.fieldNameOnly === true) {
        const fieldPattern = FIELD_NAME_PATTERNS.get(token);
        if (fieldPattern && !fieldPattern.test(line)) continue;
      }
      if (tokenMatches(line, token)) {
        violations.push({
          file,
          line: index + 1,
          family: entry.family,
          token,
          source: lineAt(lines, index),
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
        source: lineAt(lines, index),
      });
    }
  });

  return violations;
}

function listCoreFiles(): string[] {
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
  walk(CORE_DIR);
  return found;
}

/** This file necessarily contains the deny-list, so it is the one file skipped. */
function isSelf(file: string): boolean {
  return path.resolve(file) === path.resolve(THIS_FILE);
}

function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  ${v.file}:${v.line} [${v.family}] ${v.token} :: ${v.source}`)
    .join("\n");
}

describe("core/plugin boundary", () => {
  const coreFiles = listCoreFiles();
  const scanned = coreFiles.filter((file) => !isSelf(file));
  const skipped = coreFiles.filter(isSelf);

  it("scans src/core/ recursively, skipping exactly this test file", () => {
    // A mutation that broadened the self-exclusion (a whole directory, a glob,
    // "everything under __tests__") would show up here.
    expect(skipped).toEqual([THIS_FILE]);
  });

  it("has a loadable, non-empty deny-list", () => {
    expect(DENY_LIST.length).toBeGreaterThan(0);
    expect(DENY_LIST.map((e) => e.family)).toContain("github");
    expect(DENY_LIST.flatMap((e) => e.tokens)).toContain("pull_request");
  });

  it("contains no provider vocabulary and no plugin/SDK imports", () => {
    const violations = scanned.flatMap((file) => {
      const rel = path.relative(CORE_DIR, file);
      return findViolations(readFileSync(file, "utf8"), rel);
    });
    expect(
      violations,
      `core/plugin boundary violated:\n${formatViolations(violations)}`,
    ).toEqual([]);
  });
});

/**
 * Positive control: the scanner must FIRE on the shapes this boundary exists to
 * catch. Without these the suite would stay green if the scanner were mutated to
 * detect nothing -- and `src/core/` is currently near-empty, which would make the
 * main case above pass vacuously.
 */
describe("plugin-boundary scanner (positive control)", () => {
  const scanOne = (snippet: string) => findViolations(snippet, "fixture.ts");

  it("catches vendor names in identifiers", () => {
    expect(scanOne('const owner = "octokit";').map((v) => v.token)).toContain(
      "octokit",
    );
    expect(scanOne("export const glab = 1;")[0]?.family).toBe("gitlab");
  });

  it("catches the github API resource names that carry no 'github' substring", () => {
    expect(
      scanOne("type Un = { pull_request: string };").map((x) => x.token),
    ).toContain("pull_request");
    expect(
      scanOne("type Un = { pull_request_review: string };").map((x) => x.token),
    ).toContain("pull_request_review");
    // Neither token contains "github", which is why a github-keyed detector is
    // insufficient.
    expect("pull_request".includes("github")).toBe(false);
  });

  it("catches the underscore-suffixed families that were previously inert", () => {
    // `pr_` / `mr_` are the provider abbreviation prefixes. Before this fix the
    // matcher produced /\bpr_\b/, which is unsatisfiable inside an identifier,
    // so both families were dead weight in the deny-list.
    for (const snippet of [
      "const foo_pr_bar = 1;",
      "const expr_pr_foo = 1;",
      "type T = { obj_pr_title: string };",
      "obj.pr_title;",
      "const a1_mr_b = 1;",
      "type T = { x_mr_ref: string };",
      "const _pr_ = 1;",
      "const pr_queue = [];",
    ]) {
      const tokens = scanOne(snippet).map((v) => v.token);
      expect(
        tokens.some((t) => t === "pr_" || t === "mr_"),
        `expected pr_/mr_ to fire on: ${snippet}`,
      ).toBe(true);
    }
    // Spell the two families out explicitly so a family that stops being
    // detected is a named failure rather than a generic non-empty check.
    expect(scanOne("const foo_pr_bar = 1;").map((v) => v.token)).toContain(
      "pr_",
    );
    expect(scanOne("const a1_mr_b = 1;").map((v) => v.token)).toContain("mr_");
  });

  it("still keeps prefixed look-alikes clean for the fixed families", () => {
    // The fix widens the LEADING boundary for `_`-terminated tokens to
    // "not preceded by an alphanumeric". `_` and `.` are legitimate delimiters,
    // so these must NOT match: `expr_` and `xmr_` are different symbols.
    expect(scanOne("const expr_value = 1;")).toEqual([]);
    expect(scanOne("const xmr_thing = 1;")).toEqual([]);
    expect(scanOne("const spr_ = 1;")).toEqual([]);
    expect(scanOne("const repr_ = 1;")).toEqual([]);
    // And the unrelated `ado` / `shadow` protection is untouched.
    expect(scanOne("const shadow = 1;")).toEqual([]);
    expect(scanOne("const ado = 1;").map((v) => v.token)).toContain("ado");
  });

  it("catches a provider token at the START of a camelCase identifier", () => {
    // B26. `\bgithub\b` cannot match anywhere inside `githubPullRequest` --
    // camelCase supplies no word boundary after the token -- so the deny-list
    // entry was inert in exactly the shape real TypeScript uses. Measured at
    // fa8f753: all six of these reported zero violations.
    for (const [snippet, family] of [
      ["export const githubPullRequest = 1;", "github"],
      ["export const githubIssue = 1;", "github"],
      ["export const githubWebhookDelivery = 1;", "github"],
      ["export const gitlabMergeRequest = 1;", "gitlab"],
      ["export const bitbucketWorkspace = 1;", "bitbucket"],
      ["export const azureDevopsWorkItem = 1;", "azure-devops"],
    ] as const) {
      expect(
        scanOne(snippet).map((v) => v.family),
        `expected family ${family} to fire on: ${snippet}`,
      ).toContain(family);
    }
  });

  it("catches a snake_case deny-list token written in camelCase", () => {
    // The deny-list is written in snake_case and TypeScript is not, so the
    // matcher has to bridge the gap without the deny-list changing. Asserted
    // per token so a token that stops bridging is a named failure.
    for (const [snippet, token] of [
      ["export const pullRequest = 1;", "pull_request"],
      ["export type S = { pullRequest: string };", "pull_request"],
      ["export const mergeRequestState = 1;", "merge_request"],
      ["export const workItemId = 1;", "work_item"],
      ["export const issueNumber = 1;", "issue_number"],
    ] as const) {
      expect(
        scanOne(snippet).map((v) => v.token),
        `expected ${token} to fire on: ${snippet}`,
      ).toContain(token);
    }
  });

  it("keeps the trailing rule case-sensitive while the body is tolerant", () => {
    // The body tolerates case (`pullRequest`) but the trailing lookahead must
    // NOT: an uppercase letter is a camelCase hump continuing the provider
    // vocabulary, a lowercase one is a longer unrelated word. So `repo` still
    // does not fire on `repository` or `report`, and `ado` still does not fire on
    // `shadow` -- now via a lookahead rather than the old trailing `\b`.
    expect(scanOne("const repository = 1;").map((v) => v.token)).not.toContain(
      "repo",
    );
    expect(scanOne("const report = 1;").map((v) => v.token)).not.toContain(
      "repo",
    );
    expect(scanOne("const shadow = 1;")).toEqual([]);
    expect(scanOne("const ado = 1;").map((v) => v.token)).toContain("ado");
  });

  it("SUPERSEDED (B27): prose capitalising a deny-list token IS a violation", () => {
    // B26 asserted its four prose snippets stay CLEAN, and asserted that the
    // guard must never case-tolerate a token's first character in order to keep
    // them clean. B27 merged that with B19, which requires `GITHUB_TOKEN` and
    // `GitHubToken` to fire. The two are the SAME MATCH -- under the `i` flag
    // the deny token `github` IS `GitHub` IS `GITHUB` -- so no matcher can
    // satisfy both.
    //
    // ONE measurement table, every row reproduced by running the real
    // `findViolations` over the snippet at this head (B19 required these to
    // FIRE; B26 required the first four to stay CLEAN):
    //
    //   "/**\n * Resolve the GitHub token.\n */\nexport const x = 1;"
    //       -> github   (FIRES -- B26 required CLEAN, B19 requires FIRE)
    //   'const s = "Reads the GitHub fine-grained PAT.";'
    //       -> github   (FIRES -- same conflict)
    //   "const GitHub = 1;"
    //       -> github   (FIRES -- same conflict)
    //   "// the GitHub plugin\nexport const y = 1;"
    //       -> CLEAN    (B26's FOURTH snippet, and it is NOT part of the
    //                    conflict at all: `//` line comments are stripped by
    //                    this scanner's documented comment policy --
    //                    `stripLineComments`, policy header lines 16-18 -- so
    //                    it is clean under ANY case policy. Listed here so the
    //                    row is not silently re-counted as a B26 silence.)
    //   "const GitHubToken = 1;"
    //       -> github   (FIRES -- B19 REQUIRED; asserted by this test)
    //   "export const GITHUB_TOKEN = 1;"
    //       -> github   (FIRES -- B19 REQUIRED; asserted elsewhere)
    //   "const OCTOKIT = 1;"
    //       -> octokit  (FIRES -- B19 REQUIRED; asserted elsewhere)
    //
    // So the FIRES rows are B19's REQUIRED detections and the prose rows among
    // them are exactly B26's required silences. There is no spelling that
    // separates them, and conditioning the exception on a hump continuation does
    // not help either: `const OCTOKIT = 1;` has a SPACE after the match, so the
    // exception can never engage there.
    //
    // B19's side is kept, because this card's ACCEPTANCE CRITERIA (i) names
    // `GITHUB_TOKEN` / `github_token` / `GitHubToken` as required, and names the
    // negative controls as `expr_` / `xmr_` / `spr_` / `repr_` / `shadow` --
    // prose capitalisation is not among them.
    //
    // What makes this safe is the compensating control below: the false positive
    // only ever existed against prose that is no longer on the tree. This test is
    // therefore ARMED rather than merely commented -- it asserts the deliberate
    // direction of the tradeoff, so if a later reader "fixes" the prose case by
    // dropping the `i` flag, this goes red too.
    for (const snippet of [
      "/**\n * Resolve the GitHub token.\n */\nexport const x = 1;",
      'const s = "Reads the GitHub fine-grained PAT.";',
      "const GitHub = 1;",
    ]) {
      expect(
        scanOne(snippet).map((v) => v.token),
        `expected B19 case-blindness to fire on: ${snippet}`,
      ).toContain("github");
    }
  });

  it("has zero false positives on the real src/core tree (B27 compensating control)", () => {
    // The whole reason B26's prose rule existed: case-blindness produces
    // false positives against prose capitalising a vendor name. B27 keeps
    // case-blindness, so this is the control that keeps it honest.
    //
    // The pressure is GONE because B19 -- the sibling commit merged into B26
    // here -- deleted the vendor prose it was fixing: `GITHUB_TOKEN_PREFIX` and
    // `GITHUB_TOKEN_ENV_VAR` are removed from `src/core/credentials/provider.ts`
    // and the provider is now constructed from a `TokenProfile`. Measured on this
    // assembled tree:
    //   grep -rn 'GITHUB\\|GitHub\\|github' src/core --include=*.ts
    //     | grep -v 'core/__tests__/plugin-boundary'   -> 0 lines
    //
    // So the guard is case-blind AND the real tree has nothing for it to be
    // wrong about. If a future change reintroduces vendor prose into src/core,
    // this reports the exact file:line instead of letting the guard silently
    // start failing on the project's own code.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) return [];
        return full === THIS_FILE ? [] : [full];
      });
    const found = walk(CORE_DIR).flatMap((file) =>
      findViolations(readFileSync(file, "utf8"), path.relative(CORE_DIR, file)),
    );
    expect(
      found.map((v) => `${v.file}:${v.line} ${v.token}`),
      "case-blindness must not produce a false positive on the real src/core tree",
    ).toEqual([]);
  });

  it("catches generic source-control field names in a type literal", () => {
    expect(
      scanOne("type Meta = { repository: string };").map((v) => v.token),
    ).toContain("repository");
    expect(
      scanOne("interface T { branch?: string }").map((v) => v.token),
    ).toContain("branch");
  });

  it("catches a provider token inside a block / JSDoc comment", () => {
    const v = scanOne(
      "/**\n * Syncs an issue_number from the provider.\n */\nexport const x = 1;",
    );
    expect(v).not.toEqual([]);
    expect(v[0]?.token).toBe("issue_number");
    expect(v[0]?.line).toBe(2);
  });

  it("catches an active import of src/plugins/**", () => {
    const v = scanOne('import { gh } from "@/plugins/github/client";');
    expect(v.map((x) => x.family)).toContain("plugin-boundary");
  });

  it("catches an active import of a provider SDK", () => {
    const v = scanOne('import { Octokit } from "@octokit/rest";');
    expect(v.map((x) => x.family)).toContain("provider-sdk");
    expect(v.map((x) => x.token)).toContain("octokit");
  });

  it("ignores provider tokens that appear only in a // line comment", () => {
    expect(
      scanOne("// mentions octokit and pull_request\nconst n = 1;"),
    ).toEqual([]);
  });

  it("keeps line numbers aligned when a line comment is stripped", () => {
    const line = "// a // b // c";
    const stripped = stripLineComments(`${line}\nexport const n = 1;`).split(
      "\n",
    );
    expect(stripped).toHaveLength(2);
    expect(stripped[0]).toBe(" ".repeat(line.length));
    expect(stripped[1]).toBe("export const n = 1;");
  });
});

/**
 * B13 regression: a `//` inside a REGEX literal must not be read as a line
 * comment. Before this, `const re = /[//]/; const pr_title = 1;` blanked the
 * whole rest of the line and reported ZERO violations -- the `//` inside a
 * character class (the natural way to write "match a slash") hid both the
 * underscore-suffixed families and the bare `github` token from hard rule 1.
 *
 * This is the case base f07b894's doc comment claimed and never implemented.
 */
describe("plugin-boundary scanner (regex literals, B13)", () => {
  const scanOne = (snippet: string) => findViolations(snippet, "fixture.ts");

  it("catches a token hidden behind a `//` inside a regex character class", () => {
    const v = scanOne("const re = /[//]/; const pr_title = 1;");
    expect(v.map((x) => x.token)).toContain("pr_");
    expect(v[0]?.line).toBe(1);
  });

  it("catches the bare `github` token hidden the same way", () => {
    expect(
      scanOne("const re = /[//]/; const github = 1;").map((x) => x.token),
    ).toContain("github");
  });

  it("sees tokens after every regex shape that can contain `//`", () => {
    for (const snippet of [
      "const re = /[//]/; const pull_request = 1;",
      "const re = /a\\/b/; const pr_title = 1;",
      "const re = /[//]/gi; const pr_title = 1;",
      "const re = /a/b/; const pr_title = 1;",
      "function f() { return /[//]/; } const mr_x = 1;",
      "const re =\n  /[//]/;\nconst pr_title = 1;",
      "const s = `${/[//]/}`; const pr_title = 1;",
    ]) {
      expect(
        scanOne(snippet).length,
        `expected a violation after the regex in: ${snippet}`,
      ).toBeGreaterThan(0);
    }
  });

  it("still strips a real // comment that follows a regex literal", () => {
    // The regex ends at its closing `/`; only what follows is a comment.
    expect(scanOne("const re = /[//]/; // pr_hidden")).toEqual([]);
    expect(scanOne("const re = /a\\/b/; // pr_hidden")).toEqual([]);
  });

  it("still treats a division as division, not as a regex start", () => {
    // `a / b / c` must not open a regex that swallows the rest of the file.
    expect(scanOne("const q = a / b / c; // pr_hidden")).toEqual([]);
    expect(scanOne("const q = a / b;\nconst n = 1; // pr_hidden")).toEqual([]);
  });

  it("preserves T6b: template TEXT keeps its token, interpolation does not", () => {
    // Both halves of T6b's root-cause fix, re-asserted by execution. Regressing
    // either is worse than the regex bug being fixed.
    expect(
      scanOne("const s = `a // pr_hidden`;").map((x) => x.token),
    ).toContain("pr_");
    expect(scanOne("const s = `${a // pr_hidden\n}`;")).toEqual([]);
  });

  it("preserves T6b: a `//` in a string is not a comment either", () => {
    expect(
      scanOne('const s = "a // pr_hidden";').map((x) => x.token),
    ).toContain("pr_");
    expect(scanOne("// pr_hidden\nconst n = 1;")).toEqual([]);
  });
});

/**
 * B20: a string literal inside a control header defeated
 * `closesControlHeaderParen`, so the guard reported green over a
 * provider-bound core.
 *
 * Until this fix, `closesControlHeaderParen` matched the header `(` with its own
 * BACKWARD character count over the raw line -- a second, independent lexical
 * model with no notion of strings. A `(` or `)` inside a string literal pushed
 * that count off, so it landed on the wrong paren or ran off the start of the
 * line and fell through to the `return true` fallback. Both directions of that
 * bug are measured below, by execution, at the pre-fix head 78199bb:
 *
 *   Defect 1, FALSE NEGATIVE (the deciding case):
 *     if (label === "(") /[//]/; const pr_title = "PR";   ->  []   pr_ MISSED
 *     if (label === "x") /[//]/; const pr_title = "PR";   ->  ["pr_"]
 *     if (x) /[//]/; const pr_title = "PR";               ->  ["pr_"]
 *
 *   Defect 2, FALSE POSITIVE (the converse):
 *     const x = (")") / c; // pr_hidden                   ->  ["pr_"]  WRONG
 *
 * Defect 2's shape is a GENUINE regex (`/[//]/`), not a literal `)`. QA's own
 * first report asserted cubic's literal-`)` snippets were a false positive, then
 * re-measured and WITHDREW that: those snippets are real comments, so detecting
 * them is correct. The false positive needs the `)` to be inside a string and
 * the `//` to be inside a real regex, so the surplus `)` survives the backward
 * count, exhausts it, and lands on the fail-toward-the-guard fallback.
 *
 * The fix makes the forward main loop record, for every `)` in real code, the
 * keyword that owned the matching `(` (`parenStack` / `controlCloseParens` /
 * `recordedCloseParens` above), so `closesControlHeaderParen` is a set lookup
 * against the SAME lexical state that already tracks quotes, templates and
 * regex bodies. No second lexer.
 */
describe("plugin-boundary scanner (string literals in parens, B20)", () => {
  const scanOne = (snippet: string) => findViolations(snippet, "fixture.ts");
  const tokensOf = (snippet: string) => scanOne(snippet).map((v) => v.token);

  it("DEFECT 1: catches a token behind a control header whose string contains `(`", () => {
    // The exact snippet QA measured as `TOKENS: []` at 78199bb. `pr_` is the
    // deny-list token it was hiding, so this fails loudly if the hole reopens.
    expect(
      tokensOf('if (label === "(") /[//]/; const pr_title = "PR";'),
    ).toContain("pr_");
  });

  it("DEFECT 1: the same header with a paren-free string is the control", () => {
    // Paired control: only the literal `(` differed, so only the literal `(` may
    // be what broke it.
    expect(
      tokensOf('if (label === "x") /[//]/; const pr_title = "PR";'),
    ).toContain("pr_");
    expect(tokensOf('if (x) /[//]/; const pr_title = "PR";')).toContain("pr_");
  });

  it("DEFECT 1: covers `(` in a string across every control keyword", () => {
    for (const keyword of ["if", "while", "for", "switch"]) {
      const snippet = `${keyword} (label === "(") /[//]/; const pr_title = "PR";`;
      expect(
        tokensOf(snippet),
        `expected pr_ to fire after ${keyword}: ${snippet}`,
      ).toContain("pr_");
    }
    // `(` in a string together with a nested paren and a trailing condition.
    expect(
      tokensOf('if (a === "(" && (b || c)) /[//]/; const mr_state = 1;'),
    ).toContain("mr_");
  });

  it("DEFECT 2: a `)` in a string does not make a genuine regex open a comment", () => {
    // The regex here is GENUINE (`/[//]/`) and the token is real code, so the
    // ONLY thing that can produce `["pr_"]` is the backward count landing on the
    // fail-toward-the-guard fallback. At 78199bb this returned ["pr_"].
    expect(tokensOf('const x = (")") /[//]/; const mr_state = 1;')).toEqual([]);
  });

  it("DEFECT 2: a `)` in a string keeps the `/` after it a division", () => {
    // Same surplus-`)` shape, no regex: the `//` must still strip.
    expect(tokensOf('const x = (")") / c; // pr_hidden')).toEqual([]);
    expect(tokensOf('const x = ("(") / c; // pr_hidden')).toEqual([]);
    expect(tokensOf('const x = (")" + a) / c; // pr_hidden')).toEqual([]);
    expect(tokensOf('const x = (")" || b) / c; // pr_hidden')).toEqual([]);
    expect(tokensOf('const x = f((")")) / c; // pr_hidden')).toEqual([]);
  });

  it("DEFECT 2: the no-paren-in-a-string control must still detect", () => {
    // The anti-vacuity pair: a string with NO paren must not stop detection, so
    // a fix that simply made every string-containing-header case clean would
    // fail here.
    expect(tokensOf("const x = (a + b) / c; const mr_state = 1;")).toContain(
      "mr_",
    );
    expect(tokensOf('const x = (")") / c; const mr_state = 1;')).toContain(
      "mr_",
    );
    expect(
      tokensOf('const s = ")"; const y = f(a) / c; const mr_state = 1;'),
    ).toContain("mr_");
  });

  it("DEFECT 2: a string `)` must not make a later control header's `/` a regex", () => {
    // The surplus has to be consumed by the correct paren, not merely absorbed:
    // after the fix this control header still reports, and its own real comment
    // still strips.
    expect(
      tokensOf('const x = (")") / c; if (a) /[//]/; const pr_title = 1;'),
    ).toContain("pr_");
    expect(
      tokensOf('const x = (")") / c; if (a) /[//]/; // pr_hidden'),
    ).toEqual([]);
  });

  it("handles parens inside TEMPLATE text and interpolations", () => {
    // The forward loop's `quote`/`` ` ``-text branch and its `templateStack`
    // interpolation branch both `continue` before the paren handling, so a paren
    // in either place cannot move the stack. Asserted rather than assumed, with
    // the detection side AND the comment side of each shape.
    // Template TEXT holding a paren, then a call paren that must divide:
    expect(
      tokensOf("const s = `) `; const y = f(a) / c; // pr_hidden"),
    ).toEqual([]);
    expect(
      tokensOf("const s = `( `; const y = f(a) / c; const mr_state = 1;"),
    ).toContain("mr_");
    // An INTERPOLATION whose expression contains a paren in a nested string.
    expect(
      tokensOf(
        'const s = `${")"}`; const y = f(a) /[//]/; const pr_title = 1;',
      ),
    ).toEqual([]);
    expect(
      tokensOf('const s = `${")"}`; const y = f(a) / c; // pr_hidden'),
    ).toEqual([]);
    // A paren in template text must not break a following control header.
    expect(
      tokensOf("const s = `) `; if (a) /[//]/; const pr_title = 1;"),
    ).toContain("pr_");
  });

  it("handles a `)` inside a REGEX body, which is also literal text", () => {
    // `/)/` is a real regex whose body holds a `)`. Before this fix that body
    // paren counted toward the header search and could desynchronise it.
    expect(
      tokensOf("const r = /)/; if (a) /[//]/; const pr_title = 1;"),
    ).toContain("pr_");
    expect(tokensOf("const r = /)/; const y = f(a) / c; // pr_hidden")).toEqual(
      [],
    );
  });

  it("does not regress any pre-existing B13 / B18 shape", () => {
    // Everything B13 and B18 pinned, re-asserted in one place so a B20 fix that
    // traded one hole for another is a single named failure here.
    for (const snippet of [
      // B13: regex bodies containing `//`.
      "const re = /[//]/; const pr_title = 1;",
      "const re = /a\\/b/; const pr_title = 1;",
      "const re = /[//]/gi; const pr_title = 1;",
      "function f() { return /[//]/; } const mr_x = 1;",
      // B18: control headers, all keywords, and nested parens.
      "if (x) /[//]/; const pr_title = 1;",
      "while (x) /[//]/; const pr_title = 1;",
      "for (;;) /[//]/; const pr_title = 1;",
      "if (a ? b : c) /[//]/; const pr_title = 1;",
      "with (o) /[//]/; const pr_title = 1;",
      "switch (x) /[//]/; const pr_title = 1;",
      "try { f(); } catch (e) /[//]/; const pr_title = 1;",
      "if ((x)) /[//]/; const pr_title = 1;",
      "if (f(1)) /[//]/; const pr_title = 1;",
      "for (let i = 0; i < n; i++) /[//]/; const mr_state = 1;",
    ]) {
      expect(
        tokensOf(snippet),
        `expected pr_/mr_ to still fire in: ${snippet}`,
      ).not.toEqual([]);
    }

    // And the anti-vacuity side: a real `//` must STILL strip in every one of the
    // string-bearing shapes, so B20 did not fix a false negative by opening a
    // false-positive flood.
    for (const snippet of [
      'if (label === "(") /[//]/; // pr_hidden',
      'if (label === "(") f(); // pr_hidden',
      'while (x === "(") /[//]/; // pr_hidden',
      'const x = (")") / c; // pr_hidden',
      "const s = `) `; if (a) /[//]/; // pr_hidden",
    ]) {
      expect(
        tokensOf(snippet),
        `expected a real comment to still strip in: ${snippet}`,
      ).toEqual([]);
    }
  });
});

/**
 * B18: `if (x) /[//]/;` -- a regex literal in a control statement's BODY.
 *
 * `regexAllowedHere` decided regex-vs-division from the previous significant
 * character alone, and its final branch read any `)` as "a value just ended, so
 * this `/` divides". That is right for `(a / b)` and wrong for a control
 * statement's body, where a bare regex-literal STATEMENT is valid. The `//`
 * inside the character class was then read as a line comment and blanked the
 * rest of the line, so every deny-listed token after it became invisible:
 *
 *   if (x) /[//]/; const pr_title = 1;   ->  []   (zero violations)
 *
 * The four shapes below are the exact cases QA measured at c75a335 and confirmed
 * MISSED. Each is asserted by the deny-list token it was hiding, not by a
 * marker or a proxy, so a scanner mutation that stops detecting these fails
 * here rather than passing quietly.
 */
describe("plugin-boundary scanner (regex after a control paren, B18)", () => {
  const scanOne = (snippet: string) => findViolations(snippet, "fixture.ts");
  const tokensOf = (snippet: string) => scanOne(snippet).map((v) => v.token);

  it("catches a token hidden behind `//` after each control header paren", () => {
    // Every one of these returned [] at c75a335. Named individually so a
    // regression in any single header keyword is a distinct failure.
    for (const snippet of [
      "if (x) /[//]/; const pr_title = 1;",
      "while (x) /[//]/; const pr_title = 1;",
      "for (;;) /[//]/; const pr_title = 1;",
      "if (a ? b : c) /[//]/; const pr_title = 1;",
    ]) {
      expect(
        tokensOf(snippet),
        `expected pr_ to fire after the control paren in: ${snippet}`,
      ).toContain("pr_");
    }
  });

  it("catches the hidden token for with / switch / catch headers too", () => {
    // Not in QA's original four, but they are the same shape and the keyword
    // set that fixes the four would be wrong if it omitted them.
    for (const snippet of [
      "with (o) /[//]/; const pr_title = 1;",
      "switch (x) /[//]/; const pr_title = 1;",
      "try { f(); } catch (e) /[//]/; const pr_title = 1;",
    ]) {
      expect(
        tokensOf(snippet),
        `expected pr_ to fire after the control paren in: ${snippet}`,
      ).toContain("pr_");
    }
  });

  it("still detects through NESTED parens inside the control condition", () => {
    // The backward depth count must land on the header `(` owned by the control
    // keyword, not on an inner grouping or call paren.
    for (const [snippet, token] of [
      ["if ((x)) /[//]/; const pr_title = 1;", "pr_"],
      ["if (f(1)) /[//]/; const pr_title = 1;", "pr_"],
      ["if (a && (b || c)) /[//]/; const mr_state = 1;", "mr_"],
      ["for (let i = 0; i < n; i++) /[//]/; const mr_state = 1;", "mr_"],
    ] as const) {
      expect(
        tokensOf(snippet),
        `expected ${token} to fire after the control paren in: ${snippet}`,
      ).toContain(token);
    }
  });

  it("does NOT treat a value-expression `)` as a regex start", () => {
    // THE ANTI-VACUITY CASE. A naive "any `)` allows a regex" fix passes the
    // four cases above and re-opens a false positive here: a `/` that DIVIDES a
    // value just closed by `)` would be read as a regex start, and the regex
    // would then run to the next unescaped `/` -- swallowing real code and
    // re-exposing tokens that sit behind what should be a comment.
    //
    // NOTE the shape: `(a / b)` is NOT enough to catch that mutation, because
    // its `/` follows the identifier `b`, so the `)` branch is never consulted.
    // The `/` has to be the one DIRECTLY after the `)`, which is what these
    // four are. Measured: with `if (c === ")") return true`, the first line
    // reports `pr_` from behind a genuine comment, and this test is the only
    // thing in the suite that sees it.
    expect(scanOne("const x = (a + b) / c; // pr_hidden")).toEqual([]);
    expect(scanOne("const x = f(a) / c; // pr_hidden")).toEqual([]);
    expect(scanOne("const x = (a) / c; // pr_hidden")).toEqual([]);
    // And the token must still be visible when it is real code, not a comment.
    expect(
      scanOne("const x = (a + b) / c; const mr_state = 1;").map((v) => v.token),
    ).toContain("mr_");
    // Grouping and call parens keep dividing (both pinned green at c75a335).
    expect(
      scanOne("const q = (a / b); const mr_state = 1;").map((v) => v.token),
    ).toContain("mr_");
    expect(scanOne("const q = (a / b); // pr_hidden")).toEqual([]);
    expect(scanOne("const q = f(a / b); // pr_hidden")).toEqual([]);
    // And the plain chained-division case B13 pinned stays a division.
    expect(scanOne("const r = a / b / c; // pr_hidden")).toEqual([]);
  });

  it("does not regress the shapes B13 already closed", () => {
    // The pre-existing fix must remain in force; a `)`-handling change that
    // broke these would be a straight trade, not a fix.
    for (const snippet of [
      "switch (x) {} /[//]/; const pr_title = 1;",
      "do /[//]/; while (x); const pr_title = 1;",
      "const f = () => /[//]/; const pr_title = 1;",
      "if (x) { /[//]/; } const pr_title = 1;",
      "const re = /[//]/; const pr_title = 1;",
    ]) {
      expect(
        tokensOf(snippet),
        `expected pr_ to still fire in: ${snippet}`,
      ).toContain("pr_");
    }
  });

  it("keeps a real // comment after a control-statement body a comment", () => {
    // The fix must not make the scanner treat EVERY `/` after `)` as a regex
    // start: a genuine line comment still has to strip.
    expect(scanOne("if (x) f(); // pr_hidden")).toEqual([]);
    expect(scanOne("if (x) /[//]/; // pr_hidden")).toEqual([]);
    expect(scanOne("while (x) g(); // pr_hidden")).toEqual([]);
  });
});

/**
 * B19 regression: the guard was CASE-BLIND, and a second defect hid behind the
 * first.
 *
 * Measured at `fa8f753` against this exact `findViolations`, by running the real
 * export over probe inputs:
 *
 *   DETECTED :: const github = 1;
 *   MISSED   :: export const GITHUB_TOKEN = 1;
 *   MISSED   :: const GitHubToken = 1;
 *   MISSED   :: const OCTOKIT = 1;
 *   DETECTED :: const pr_title = 1;
 *   MISSED   :: const PR_TITLE = 1;
 *   MISSED   :: export const GITHUB_TOKEN_PREFIX = "github_pat_";
 *   MISSED   :: import { X } from "OCTOKIT";
 *
 * Two independent causes, and fixing only the first is NOT sufficient (see
 * {@link tokenPattern}): every deny token is lowercase, and the trailing `\b`
 * was unsatisfiable inside a compound identifier.
 *
 * This block is the RED-THEN-GREEN control. Revert the `i` flag in
 * {@link tokenPattern} and the first case fails; revert the trailing-boundary
 * work in {@link tokenEndsCleanly} and the first case fails again. A guard
 * change with no such proof is not accepted.
 */
describe("plugin-boundary scanner (case folding, B19)", () => {
  const scanOne = (snippet: string) => findViolations(snippet, "fixture.ts");
  const tokensOf = (snippet: string) => scanOne(snippet).map((v) => v.token);
  const familiesOf = (snippet: string) => scanOne(snippet).map((v) => v.family);

  /**
   * One provider concept per row, across every way code gets named, each with
   * the family it must report.
   *
   * The expected family is per-row rather than a blanket "github": the
   * case-folding applies to the WHOLE deny-list, so a GitLab or Bitbucket
   * spelling that folds into detection is the same fix working, and asserting
   * `github` there would have failed on a correct scanner.
   */
  const SPELLINGS: ReadonlyArray<readonly [string, string, string]> = [
    ["SCREAMING_CASE identifier", "export const GITHUB_TOKEN = 1;", "github"],
    [
      "SCREAMING_CASE compound (the shape of the real leak)",
      'export const GITHUB_TOKEN_PREFIX = "github_pat_";',
      "github",
    ],
    ["PascalCase identifier", "const GitHubToken = 1;", "github"],
    ["SCREAMING_CASE, octokit", "const OCTOKIT = 1;", "github"],
    [
      "SCREAMING_CASE, underscore-suffixed family",
      "const PR_TITLE = 1;",
      "github",
    ],
    [
      "SCREAMING_CASE import specifier",
      'import { X } from "OCTOKIT";',
      "github",
    ],
    ["SCREAMING_CASE, gitlab family", "const MERGE_REQUEST_ID = 1;", "gitlab"],
    [
      "SCREAMING_CASE, bitbucket family",
      "const BITBUCKET_TOKEN = 1;",
      "bitbucket",
    ],
  ];

  it("catches every uppercase and camelCase spelling", () => {
    for (const [label, snippet, family] of SPELLINGS) {
      expect(
        familiesOf(snippet),
        `expected a ${family} violation for ${label}: ${snippet}`,
      ).toContain(family);
    }
  });

  it("adds detection and removes none: the lowercase spellings still fire", () => {
    // The negative control for the whole change. Each of these was DETECTED
    // before it and MUST still be detected after: a widening that dropped a
    // lowercase match would be a regression dressed as a fix.
    for (const snippet of ["const github = 1;", "const pr_title = 1;"]) {
      expect(
        familiesOf(snippet),
        `lowercase control lost: ${snippet}`,
      ).toContain("github");
    }
    // Named per family, so a family that stops being detected is attributable.
    expect(tokensOf("const pr_title = 1;")).toContain("pr_");
    expect(tokensOf("const a1_mr_b = 1;")).toContain("mr_");
    expect(tokensOf("const octokit = 1;")).toContain("octokit");
  });

  it("still refuses a token embedded in the middle of a lowercase word", () => {
    // The cost of the widened trailing boundary: `xgithuby` is a different
    // symbol, and so is `shadow` for `ado`. Both must stay clean or the widening
    // would fire on ordinary identifiers and make the guard unusable.
    expect(scanOne("const xgithuby = 1;")).toEqual([]);
    expect(scanOne("const shadow = 1;")).toEqual([]);
    expect(scanOne("const repositoryx = 1;")).toEqual([]);
    expect(scanOne("const expr_ = 1;")).toEqual([]);
    expect(scanOne("const xmr_thing = 1;")).toEqual([]);
  });

  it("keeps the pre-existing look-alike controls clean", () => {
    // B19 must not disturb the boundary rules B18/B20 established for the
    // `_`-terminated families.
    expect(scanOne("const spr_ = 1;")).toEqual([]);
    expect(scanOne("const repr_ = 1;")).toEqual([]);
  });

  it("catches a forbidden SDK import spelled in any case", () => {
    // The import half of the original hole: case-sensitive
    // FORBIDDEN_IMPORT_PATTERNS meant `@OCTOKIT/rest` was a working import path
    // the guard could not see.
    for (const snippet of [
      'import { X } from "@OCTOKIT/rest";',
      'import { X } from "@octokit/rest";',
      'const o = require("@OCTOKIT/rest");',
    ]) {
      expect(
        familiesOf(snippet),
        `expected provider-sdk for: ${snippet}`,
      ).toContain("provider-sdk");
    }
  });

  it("folds case for typed field names too, not just plain tokens", () => {
    // The `fieldNameOnly` family (repo/repository/branch/commit_sha) goes
    // through a SEPARATE matcher. A guard that folds case in one place and not
    // the other is exactly the half-fixed hole, so this asserts both halves.
    expect(tokensOf("type Meta = { REPOSITORY: string };")).toContain(
      "repository",
    );
    expect(tokensOf("type Meta = { repository: string };")).toContain(
      "repository",
    );
  });
});
