/**
 * Credential-shape scanner for the committed tree.
 *
 * WHY THIS EXISTS. Measured at `origin/main` = `c6de1d7` (2026-10-04): nothing
 * in this repository objected to a committed real-looking credential. No CI
 * step scanned the tree, and no commit-time hook ran. `.gitignore` covered
 * three shapes of env file and not `.env.production`, which stages cleanly.
 *
 * WHY IT IS NOT A SUBSTRING MATCH ON A VENDOR PREFIX. The obvious rule --
 * "grep for `github_pat_`" -- is red on arrival in THIS repository, because
 * these tracked test files legitimately contain that prefix:
 *
 *   - `src/core/credentials/fakes.ts` builds its fixture from a caller-supplied
 *     `TokenProfile` and appends `not-a-real-fixture-token-1`; its own docstring
 *     records that the material is hyphenated English prose so "no 20+ character
 *     alphanumeric run exists".
 *   - `src/app/api/sync/__tests__/handler.test.ts:59` declares a leak canary
 *     `ghp_NOT_A_REAL_TOKEN_leak_canary_4d2f`.
 *   - `src/app/sources/__tests__/composition-root.test.ts:74` declares
 *     `FIXTURE_PAT = "github_pat_-not-a-real-fixture-token-1"`.
 *
 * A gate that is red on the day it lands teaches everyone to ignore it. So the
 * rule is built on the SHAPE OF THE MATERIAL AFTER THE PREFIX: a vendor prefix
 * followed by a contiguous run of >= {@link MIN_RUN} base62 characters whose
 * Shannon entropy is at least {@link MIN_BITS_PER_CHAR}. Every one of those
 * fixtures has a longest base62 run of three characters (`NOT`, `not`, `boom`),
 * because the hyphen and the underscore both terminate a base62 run. A real
 * fine-grained PAT is `github_pat_` followed by ~80 unbroken base62 characters.
 * See {@link scanText} for the exact implementation and
 * `scripts/__tests__/secret-scan.test.ts` for the tests that pin the
 * fixtures as non-findings.
 *
 * WHY ENTROPY AS WELL AS LENGTH. A length rule alone is defeated by a long run
 * of one repeated character, and an entropy rule alone by an unbroken alphabet
 * in sequence. Requiring both means a finding is a
 * long, high-variety base62 run -- the shape random token material takes and
 * prose does not.
 *
 * This module is the LIBRARY half and has no side effects on import; the CLI
 * entry point is `scripts/scan-secrets.ts`. It uses `node:fs`/`node:child_process`
 * directly and imports nothing from the app, so it is collectable by the default
 * Vitest suite (which runs in jsdom) without dragging the toolchain in.
 */

import { createHash } from "node:crypto";

/** Longest base62 run after a prefix that is even considered. */
export const MIN_RUN = 20;

/** Minimum Shannon entropy, in bits per character, for such a run. */
export const MIN_BITS_PER_CHAR = 3.5;

/**
 * Vendor token prefixes, treated only as ANCHORS. A hit on one of these strings
 * is not a finding by itself; see the module docstring.
 */
export const VENDOR_PREFIXES = [
  "github_pat_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;

/**
 * Identifier fragments that make a `NAME = "value"` line credential-shaped,
 * case-insensitively. Used by the assignment rule below.
 */
export const SECRET_NAME_FRAGMENTS = [
  "token",
  "secret",
  "passwd",
  "password",
  "api_key",
  "apikey",
  "api-key",
  "credential",
  "private_key",
  "privatekey",
  "access_key",
  "accesskey",
] as const;

export interface Finding {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
  /** 1-indexed line number. */
  readonly line: number;
  /** Stable rule id, e.g. `vendor-prefix-entropy`. */
  readonly rule: string;
  /** Which anchored prefix matched, for the assignment rule the name fragment. */
  readonly trigger: string;
  /**
   * A shape description of the match. NEVER the matched text: a finding report
   * that echoes the candidate is a report that can put a real credential into a
   * CI log, a baseline file and a reviewer's terminal.
   */
  readonly shape: string;
  /**
   * Stable identity of THIS finding: changes if the file, line, rule or the
   * candidate's bytes move. Deliberately a hash of the secret, not the secret,
   * so the baseline file is safe to commit.
   */
  readonly fingerprint: string;
}

/**
 * Placeholder the baseline GENERATOR writes for a finding it has no reason
 * for. It is a real string, so it parses as a non-empty reason — which is why
 * {@link parseBaseline} treats it as unreasoned rather than accepting it. See
 * `unreasonedLines`.
 */
export const UNREASONED_PLACEHOLDER = "UNREASONED — review this and replace";

export interface BaselineEntry {
  readonly fingerprint: string;
  readonly reason: string;
}

export interface BaselineFile {
  readonly entries: readonly BaselineEntry[];
  /** Lines that looked like entries but had no reason, with their line number. */
  readonly unreasonedLines: readonly { line: number; text: string }[];
}

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Longest contiguous run of base62 characters in `text`, starting at or after
 * `from`. `-` and `_` terminate a run, which is exactly what separates the
 * hyphenated-prose fixtures from real token material.
 */
function longestBase62RunFrom(text: string, from: number): string {
  let best = "";
  let current = "";
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (/[A-Za-z0-9]/.test(ch)) {
      current += ch;
      if (current.length > best.length) best = current;
    } else {
      current = "";
    }
  }
  return best;
}

function fingerprintOf(
  path: string,
  line: number,
  rule: string,
  trigger: string,
  candidate: string,
): string {
  return createHash("sha256")
    .update(
      `${path}\u0000${line}\u0000${rule}\u0000${trigger}\u0000${candidate}`,
    )
    .digest("hex")
    .slice(0, 16);
}

function makeFinding(
  path: string,
  line: number,
  rule: string,
  trigger: string,
  shape: string,
  candidate: string,
): Finding {
  return {
    path,
    line,
    rule,
    trigger,
    shape,
    fingerprint: fingerprintOf(path, line, rule, trigger, candidate),
  };
}

/**
 * Scan one line of one file and return its findings.
 *
 * Exported (rather than kept private behind `scanFile`) so the tests can pin
 * the rule against the exact fixture literals this repository ships, which is
 * the only way to show the rule is not a prefix substring match.
 */
export function scanText(path: string, text: string): readonly Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const lineNo = index + 1;

    // ── Rule 1: vendor prefix followed by long high-entropy base62 material ──
    for (const prefix of VENDOR_PREFIXES) {
      let from = 0;
      for (;;) {
        const at = line.indexOf(prefix, from);
        if (at < 0) break;
        from = at + prefix.length;
        const run = longestBase62RunFrom(line, from);
        if (run.length < MIN_RUN) continue;
        const entropy = shannonEntropy(run);
        if (entropy < MIN_BITS_PER_CHAR) continue;
        findings.push(
          makeFinding(
            path,
            lineNo,
            "vendor-prefix-entropy",
            prefix,
            `${run.length} base62 chars after ${prefix}, entropy ${entropy.toFixed(2)} bits/char`,
            run,
          ),
        );
      }
    }

    // ── Rule 2: a credential-shaped NAME assigned opaque material ────────────
    // Deliberately narrow: the NAME must carry a secret-ish fragment AND the
    // value must be long, unbroken and high-entropy. `POSTGRES_PASSWORD:
    // devloop` in ci.yml fails the length test; a real key does not.
    const assignment =
      /([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*["'`]?([^\s"'`,;]+)["'`]?/g;
    for (;;) {
      const match = assignment.exec(line);
      if (match === null) break;
      const name = match[1] as string;
      const value = match[2] as string;
      const lowered = name.toLowerCase();
      const fragment = SECRET_NAME_FRAGMENTS.find((f) => lowered.includes(f));
      if (fragment === undefined) continue;
      // The value must be ENTIRELY base62 and at least MIN_RUN long. This one
      // test does three jobs: it rejects a URL, a path or a hyphenated phrase,
      // and it rejects an ordinary call expression such as
      // `credentials: createFakeCredentialProvider({ profile })` — an earlier
      // version of this rule matched the callee name and produced a baseline of
      // pure noise, which is the fastest way to make a baseline ignored.
      if (!new RegExp(`^[A-Za-z0-9]{${MIN_RUN},}$`).test(value)) continue;
      const entropy = shannonEntropy(value);
      if (entropy < MIN_BITS_PER_CHAR) continue;
      findings.push(
        makeFinding(
          path,
          lineNo,
          "secret-name-opaque-value",
          fragment,
          `${value.length} chars for name containing "${fragment}", entropy ${entropy.toFixed(2)} bits/char`,
          value,
        ),
      );
    }
  }

  return findings;
}

/** Files larger than this are not scanned; a credential is never this big. */
export const MAX_SCANNED_BYTES = 1_000_000;

/**
 * Scan the text of a file, returning `[]` for a file too large or binary. A
 * binary blob is skipped on the NUL byte rather than sniffed, so the reason a
 * file was skipped is always one of the two returned here.
 */
export function scanBuffer(path: string, bytes: Buffer): readonly Finding[] {
  if (bytes.byteLength > MAX_SCANNED_BYTES) return [];
  if (bytes.includes(0)) return [];
  return scanText(path, bytes.toString("utf8"));
}

export const BASELINE_HEADER = `# Accepted secret-scan findings — generated, then reviewed.
#
# FORMAT. One entry per line:
#   <fingerprint><TAB><reason>
# The fingerprint is emitted by \`bun run secrets:scan --write-baseline\`. It is a
# hash of file, line, rule, trigger and the candidate's bytes — never the
# candidate itself, so this file is safe to commit.
#
# WHY A BASELINE AT ALL. This repository deliberately ships credential-SHAPED
# literals in tracked tests (see scripts/secret-scan.ts). A scanner
# that flags those is red on arrival and gets ignored, so the accepted findings
# are listed here, each with the reason it is not a credential.
#
# AN ENTRY WITH NO REASON IS A DEFECT, NOT A WAIVER. \`bun run secrets:scan\`
# exits non-zero on an unreasoned line rather than ignoring it, and
# scripts/__tests__/secret-scan.test.ts asserts that behaviour.
#
# \`bun run secrets:scan --write-baseline\` rewrites the entry block, preserving
# the reason of every entry whose fingerprint is unchanged and dropping entries
# that no longer match anything. It never invents a reason.
`;

/**
 * Parse a baseline file. Lines beginning `#` and blank lines are comments. Any
 * other line must be `<fingerprint><TAB><reason>` with a non-empty reason; a
 * line that is not that shape is returned in {@link BaselineFile.unreasonedLines}
 * so the CLI can fail on it rather than silently dropping it.
 */
export function parseBaseline(text: string): BaselineFile {
  const entries: BaselineEntry[] = [];
  const unreasonedLines: { line: number; text: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const tab = raw.indexOf("\t");
    const fingerprint = tab < 0 ? trimmed : raw.slice(0, tab).trim();
    const reason = tab < 0 ? "" : raw.slice(tab + 1).trim();
    // The generator's placeholder is a NON-EMPTY string, so an emptiness test
    // alone would accept it and the gate would report a reviewed baseline that
    // nobody reviewed. It is fatal for the same reason an empty reason is:
    // both are an entry nobody can audit.
    if (
      fingerprint === "" ||
      reason === "" ||
      reason.startsWith("UNREASONED")
    ) {
      unreasonedLines.push({ line: index + 1, text: raw });
      continue;
    }
    entries.push({ fingerprint, reason });
  }
  return { entries, unreasonedLines };
}

/**
 * Render the baseline file for the given entries, preserving the header.
 */
export function renderBaseline(entries: readonly BaselineEntry[]): string {
  const body = entries.map((e) => `${e.fingerprint}\t${e.reason}`).join("\n");
  return body === "" ? BASELINE_HEADER : `${BASELINE_HEADER}\n${body}\n`;
}

/** The subset of `findings` that no baseline entry accounts for. */
export function unbaselinedFindings(
  findings: readonly Finding[],
  baseline: readonly BaselineEntry[],
): readonly Finding[] {
  const known = new Set(baseline.map((e) => e.fingerprint));
  return findings.filter((f) => !known.has(f.fingerprint));
}

/** One human-readable line per finding. Never includes the candidate text. */
export function formatFinding(finding: Finding): string {
  return `${finding.path}:${finding.line}: [${finding.rule}] ${finding.trigger} -> ${finding.shape} (fingerprint ${finding.fingerprint})`;
}
