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

/** Module specifiers `src/core/` may never reach for. */
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
 */
function tokenPattern(token: string): RegExp {
  const escaped = escapeForRegExp(token);
  if (token.endsWith("_")) {
    return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}`);
  }
  const lead = /[A-Za-z0-9]/.test(token[0] ?? "") ? "\\b" : "";
  const trail = /[A-Za-z0-9_]/.test(token[token.length - 1] ?? "") ? "\\b" : "";
  return new RegExp(`${lead}${escaped}${trail}`);
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/\-]/g, "\\$&");
}

/** A typed field position: `repo:`, `repo?:`, inside an interface / type / object type. */
function fieldNamePattern(token: string): RegExp {
  return new RegExp(
    `(?:^|[{;,\\n])\\s*(?:readonly\\s+)?${escapeForRegExp(token)}\\s*\\??\\s*:`,
    "m",
  );
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

/**
 * Strip `//` line comments ONLY, replacing each stripped character with a space
 * so that every offset -- and therefore every line number -- is preserved.
 *
 * String and template literals are tracked so that a `//` inside them is not
 * mistaken for a comment. Block comments are deliberately NOT stripped: the
 * comment policy requires a provider token inside `/* *\/` or JSDoc to fail.
 *
 * T6b ROOT CAUSE: the `//` branch used to be tested FIRST and unconditionally,
 * so a `//` inside template-literal TEXT blanked the rest of the line -- provider
 * tokens and all -- and the guard went green over them. Template state was NOT
 * lost after an interpolation; the `//` strip simply ignored the literal state.
 * The fix is to track the enclosing literal (`quote`) and honour `//` as a
 * comment only in real code. Inside `${...}` we are back in real code, so a
 * `//` there is still a genuine comment and is still stripped.
 */
export function stripLineComments(source: string): string {
  const out = source.split("");
  /** Open `${` depths of enclosing templates; 0 means "inside the expression". */
  const templateStack: number[] = [];
  /** Enclosing literal delimiter, or null when we are in real code. */
  let quote: string | null = null;
  let i = 0;
  const n = source.length;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  while (i < n) {
    const ch = source[i] as string;
    const next = source[i + 1];

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

    if (ch === "{") {
      // A nested object/brace inside an interpolation, not the end of it.
      if (templateStack.length > 0) {
        templateStack[templateStack.length - 1] =
          (templateStack[templateStack.length - 1] ?? 0) + 1;
      }
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
