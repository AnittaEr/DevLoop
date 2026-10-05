#!/usr/bin/env bun
/**
 * `bun run secrets:scan` — the CLI entry point for the credential-shape scan.
 *
 * WHAT IT DOES. Reads the list of tracked files from git (never a filesystem
 * walk, so an untracked local `.env.production` is not scanned and a deleted
 * file is not scanned), reads each one's bytes OUT OF THE INDEX with `git
 * cat-file blob :<path>` — the bytes git will commit, not whatever is on disk
 * right now — scans them with the rules in `scripts/secret-scan.ts`, subtracts
 * the committed baseline, and exits non-zero on anything left over.
 *
 * WHY THE BYTES COME FROM THE INDEX. An earlier version read each path off
 * disk, so `--staged` scanned the staged file LIST paired with working-tree
 * content: stage a credential, overwrite the file with clean text, and the
 * commit-time hook passed while the credential went into the commit. The
 * committed-tree mode was conditional on the working tree matching. See
 * `readIndexBlob`.
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

/**
 * The bytes git WILL COMMIT for `file`: its blob in the INDEX, read with
 * `git cat-file blob :<path>` — never `readFileSync`.
 *
 * WHY THIS IS NOT A FILESYSTEM READ (this is the bug this function exists to
 * fix; found by QA at `304bacd` with a reproduction). The first version
 * enumerated paths from git and then read each one off disk, which meant every
 * mode scanned the WORKING TREE:
 *
 *   printf 'export const t = "github_pat_<real-shaped>";\n' > a.ts
 *   git add -f a.ts                       # index now holds the credential
 *   printf 'export const t = "clean";\n' > a.ts   # disk no longer does
 *   git commit -qm x                      # COMMIT_EXIT=0, hook said nothing
 *   git show HEAD:a.ts                    # the credential IS in the commit
 *
 * `--staged` was therefore "the staged file LIST, paired with whatever the file
 * happens to contain right now", and the default committed-tree mode reported
 * green over a HEAD holding a real-shaped PAT whenever the working tree was
 * clean. CI only escaped this because `actions/checkout` happens to materialise
 * HEAD into the working tree first — a coincidence of the runner, not a property
 * of the gate.
 *
 * The index is the right source for BOTH modes, for the same reason the hook and
 * CI must agree: the index is what the next commit will contain, and after a
 * fresh checkout the index equals HEAD. So one read serves "what am I about to
 * commit" and "what is already committed".
 *
 * `:.` is prefixed to the path so a repo-root file whose name begins with `-`
 * cannot be parsed as an option.
 */
function readIndexBlob(file: string): Buffer | undefined {
  try {
    return execFileSync("git", ["cat-file", "blob", `:./${file}`], {
      cwd: repoRoot(),
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // No blob in the index under that name: an unmerged path (`:<path>` needs a
    // stage-0 entry), a gitlink/submodule, or a path that raced away. `git
    // commit` refuses an unmerged tree outright, so this cannot hide a
    // credential in a commit that gets made.
    return undefined;
  }
}

function scanFiles(files: readonly string[]): {
  findings: Finding[];
  /** Paths with no readable index blob. Named on stdout, never silently dropped. */
  unreadable: string[];
} {
  const findings: Finding[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    const bytes = readIndexBlob(file);
    if (bytes === undefined) {
      unreadable.push(file);
      continue;
    }
    findings.push(...scanBuffer(file, bytes));
  }
  return { findings, unreadable };
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
const { findings, unreadable } = stagedOnly
  ? scanFiles(stagedFiles())
  : scanFiles(trackedFiles());
const { entries, unreasoned } = readBaseline();

// A path with no index blob could not be scanned. Naming it is the minimum;
// silently skipping is what made the pre-fix gate green over unread files.
for (const file of unreadable) {
  process.stdout.write(
    `secret-scan: could not read an index blob for ${file}; not scanned.\n`,
  );
}

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
