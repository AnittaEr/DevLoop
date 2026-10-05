#!/usr/bin/env bun
/**
 * `bun run secrets:scan` — the CLI entry point for the credential-shape scan.
 *
 * WHAT IT DOES. Reads the list of tracked files from git (never a filesystem
 * walk, so an untracked local `.env.production` is not scanned and a deleted
 * file is not scanned), scans each with the rules in `scripts/secret-scan.ts`,
 * subtracts the committed baseline, and exits non-zero on anything left over.
 *
 * EXIT CODES.
 *   0 — every finding is accounted for by the baseline.
 *   1 — at least one finding is not in the baseline, or the baseline itself is
 *       malformed. There is deliberately NO severity threshold and NO flag that
 *       downgrades a finding: a gate that can be told to ignore a high finding
 *       is a gate that reports green forever.
 *
 * MODES.
 *   (default)          verify: scan, subtract the baseline, fail on the rest.
 *   --staged           scan only the files staged for the current commit
 *                      (`git diff --cached --name-only --diff-filter=ACM`).
 *                      Used by the `pre-commit` hook, so a commit-time block
 *                      and a CI block are decided by the SAME rules and the
 *                      SAME baseline. See `.githooks/pre-commit`.
 *   --write-baseline   rewrite the baseline's entry block from the current
 *                      findings, preserving each surviving entry's reason and
 *                      never inventing one. Then exits 0 whether or not there
 *                      were findings, because the point is to capture them.
 *
 * The gate runs in `verify` in `.github/workflows/ci.yml`, BEFORE the quality
 * gates, so a leaked credential is the first thing a red run says rather than
 * something buried behind a build failure. It needs no database, no browser
 * and no build output.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type BaselineEntry,
  type Finding,
  formatFinding,
  parseBaseline,
  renderBaseline,
  scanBuffer,
  unbaselinedFindings,
  UNREASONED_PLACEHOLDER,
} from "./secret-scan";

const BASELINE_PATH = "security/secret-scan-baseline.txt";

/**
 * The repository root, resolved through git rather than assumed to be the cwd.
 *
 * Every path below is read relative to this, not to `process.cwd()`. The first
 * version used relative paths, which silently scanned NOTHING — and reported
 * "OK — 0 findings" — whenever the script was invoked from a subdirectory: the
 * `git ls-files` output names repo-root-relative paths, so reading them from
 * `scripts/` threw, the read was swallowed by the `catch`, and the empty
 * findings list read as a clean tree. That is the exact failure this gate
 * exists to prevent, produced by the gate itself.
 */
let cachedRoot: string | undefined;

/**
 * The repository root, resolved once through git and memoised.
 *
 * A function rather than a module-level const because `gitRaw` below anchors
 * itself AT this value: a const evaluated at module load would call `gitRaw`
 * before its own `const` bindings were initialised and throw a TDZ
 * ReferenceError. Resolving lazily breaks that cycle and costs one execFileSync
 * per process.
 */
function repoRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  cachedRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return cachedRoot;
}

function inRepo(relative: string): string {
  return path.join(repoRoot(), relative);
}

/**
 * Run git anchored at the REPOSITORY ROOT, not at the cwd.
 *
 * `git ls-files` and `git diff --cached --name-only` are both relative to the
 * cwd, so run from a subdirectory they list only that subdirectory. Left
 * uncorrected, invoking this script from `scripts/` scanned nothing and
 * reported "OK — 0 findings" — the green lie this gate exists to prevent,
 * produced by the gate itself. Anchoring at the root makes the file list the
 * same no matter where the script was invoked from, which is also what the
 * `--staged` mode needs to see a commit's whole change.
 */
function gitRaw(args: readonly string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: repoRoot(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Every tracked path, NUL-separated so a path containing a newline or a space
 * cannot be split into two phantom files.
 */
function trackedFiles(): readonly string[] {
  const out = gitRaw(["ls-files", "-z"]);
  return out.split("\0").filter((p) => p !== "");
}

/**
 * The paths staged for the current commit. Same NUL separation, and
 * `--diff-filter=ACM` so a staged DELETION is not scanned (there is no content)
 * and a staged CONFLICT/UNMERGED path is, which is the case that matters.
 */
function stagedFiles(): readonly string[] {
  const out = gitRaw([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--diff-filter=ACMU",
  ]);
  return out.split("\0").filter((p) => p !== "");
}

function scanFiles(files: readonly string[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(inRepo(file));
    } catch {
      // A file in the index but absent from the working tree (a staged delete,
      // or a sparse checkout) is not scanned rather than crashing the gate.
      continue;
    }
    findings.push(...scanBuffer(file, bytes));
  }
  return findings;
}

function readBaseline(): {
  entries: readonly BaselineEntry[];
  unreasoned: readonly { line: number; text: string }[];
} {
  let text: string;
  try {
    text = readFileSync(inRepo(BASELINE_PATH), "utf8");
  } catch {
    return { entries: [], unreasoned: [] };
  }
  const parsed = parseBaseline(text);
  return { entries: parsed.entries, unreasoned: parsed.unreasonedLines };
}

const writeBaseline = process.argv.includes("--write-baseline");
const stagedOnly = process.argv.includes("--staged");
const findings = stagedOnly
  ? scanFiles(stagedFiles())
  : scanFiles(trackedFiles());
const { entries, unreasoned } = readBaseline();

// An unreasoned baseline line is a DEFECT, not a waiver: it is the shape a
// silent blanket waiver takes. Reported and fatal in both modes, so the
// baseline can never be quietly weakened.
if (unreasoned.length > 0) {
  process.stderr.write(
    `secret-scan: ${BASELINE_PATH} has ${unreasoned.length} entr${unreasoned.length === 1 ? "y" : "ies"} with no reason:\n`,
  );
  for (const { line, text } of unreasoned) {
    process.stderr.write(`  ${BASELINE_PATH}:${line}: ${text.trim()}\n`);
  }
  process.stderr.write(
    "Every accepted finding needs a reason saying why it is not a credential.\n",
  );
  process.exit(1);
}

if (writeBaseline) {
  const known = new Map(entries.map((e) => [e.fingerprint, e.reason]));
  const next: BaselineEntry[] = findings.map((f) => ({
    fingerprint: f.fingerprint,
    reason: known.get(f.fingerprint) ?? UNREASONED_PLACEHOLDER,
  }));
  writeFileSync(inRepo(BASELINE_PATH), renderBaseline(next));
  process.stdout.write(
    `secret-scan: wrote ${next.length} entr${next.length === 1 ? "y" : "ies"} to ${BASELINE_PATH}\n`,
  );
  for (const f of findings) process.stdout.write(`  ${formatFinding(f)}\n`);
  process.exit(0);
}

const findingsToReport = unbaselinedFindings(findings, entries);

// A stale baseline entry is worth naming: it is how a waiver outlives its
// subject. Not fatal — deleting a fixture must not break the gate for
// everyone — but never silent.
const live = new Set(findings.map((f) => f.fingerprint));
const stale = entries.filter((e) => !live.has(e.fingerprint));

if (findingsToReport.length > 0) {
  process.stderr.write(
    `secret-scan: ${findingsToReport.length} finding${findingsToReport.length === 1 ? "" : "s"} NOT in ${BASELINE_PATH}:\n`,
  );
  for (const f of findingsToReport) {
    process.stderr.write(`  ${formatFinding(f)}\n`);
  }
  process.stderr.write(
    "\nA finding means a credential-SHAPED string, not a proven credential. This\n" +
      "gate sees base62 material only: a base64 value containing +, / or = is\n" +
      "NOT flagged, nor is material hyphen-grouped after a vendor prefix. If a\n" +
      "finding is a real credential, remove it and rotate it. If it is a\n" +
      "fixture, decide deliberately whether to reword the literal or add a\n" +
      `baselined entry with a reason: bun run secrets:scan --write-baseline\n` +
      'See docs/testing.md "Credential scanning" for what the rule does not cover.\n',
  );
  process.exit(1);
}

if (stale.length > 0) {
  process.stdout.write(
    `secret-scan: ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} stale (no longer match anything):\n`,
  );
  for (const e of stale) {
    process.stdout.write(`  ${e.fingerprint}\t${e.reason}\n`);
  }
  process.stdout.write(
    "Run 'bun run secrets:scan --write-baseline' to drop them.\n",
  );
}

process.stdout.write(
  `secret-scan: OK — ${findings.length} finding${findings.length === 1 ? "" : "s"}, all accounted for in ${BASELINE_PATH} (${entries.length} baselined).\n`,
);
