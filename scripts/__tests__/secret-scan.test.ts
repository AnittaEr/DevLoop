/**
 * Meta test: the secret-scan gate may not silently stop guarding.
 *
 * WHY THIS FILE EXISTS. `bun run secrets:scan` is the only thing in this
 * repository that objects to a committed credential. A gate with one
 * implementation and no test is one careless edit away from being a gate that
 * always passes, and the failure is SILENT: an always-green secret scan looks
 * exactly like a clean tree. That is the same shape of defect as
 * `src/__tests__/db-suite-registry.test.ts` (a registry that quietly stops
 * registering) and `src/core/__tests__/plugin-boundary.test.ts` (a boundary
 * guard that can be deleted in one commit) — a guard whose failure mode is "the
 * guard silently stopped guarding".
 *
 * WHAT IS PINNED HERE, in order of how quietly each could break:
 *
 *   1. The rule is NOT a vendor-prefix substring match. This is the single
 *      most important assertion in the file. The repository legitimately ships
 *      `github_pat_` in tracked tests; a gate that flagged those would be red on
 *      arrival and would be ignored within a week. The three fixtures named in
 *      the ticket are asserted to be NON-findings, with the reason stated, and a
 *      real fine-grained PAT is asserted to be a finding. If the rule cannot
 *      tell those apart, the rule is wrong — the fix is the rule, never a wider
 *      baseline.
 *   2. Both non-vacuity directions of the baseline (the ticket's c5). A gate
 *      that ignores its baseline passes the "fabricated entry still exits 0"
 *      probe and fails the "removed entry goes red" probe; a gate that fails on
 *      everything does the opposite. Only both together prove the baseline is
 *      read.
 *   3. An unreasoned baseline line is fatal, not a silent waiver.
 *   4. The CI step that runs the gate carries no bypass.
 *   5. The `.gitignore` family is still closed, and `.env.example` is still
 *      tracked.
 *
 * The scanner LIBRARY is imported directly. It has no side effects on import
 * and pulls in nothing from the app, so this file is collectable by the default
 * jsdom suite. The CLI itself is exercised as a SUBPROCESS against a temporary
 * git repository, which is the only way to observe the exit code the gate
 * actually reports.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASELINE_HEADER,
  MIN_RUN,
  formatFinding,
  parseBaseline,
  UNREASONED_PLACEHOLDER,
  renderBaseline,
  scanText,
  shannonEntropy,
  unbaselinedFindings,
} from "../secret-scan";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCANNER_CLI = path.join(REPO_ROOT, "scripts", "scan-secrets.ts");

/**
 * A synthetic PAT with the SHAPE of a real fine-grained token: the vendor
 * prefix followed by one unbroken, high-variety base62 run. Generated from a
 * fixed seed so this literal is deterministic and reviewable, and it is
 * obviously not a live token — it grants nothing.
 */
function syntheticRealLookingPat(seed: number): string {
  let state = seed;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 82; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[state % alphabet.length];
  }
  return `github_pat_${out}`;
}

describe("secret scan: the rule is a shape+entropy rule, not a prefix match", () => {
  // The three fixtures the ticket names, copied VERBATIM from the tracked
  // files. Copied rather than imported so this test keeps pinning the rule even
  // if those modules are refactored.
  const FIXTURES = [
    {
      what: "src/core/credentials/fakes.ts (hyphenated prose after the prefix)",
      literal: "github_pat_not-a-real-fixture-token-1",
      why: "hyphens and the underscore break the base62 run into 3-char pieces",
    },
    {
      what: "src/app/api/sync/__tests__/handler.test.ts:59 (leak canary)",
      literal: "ghp_NOT_A_REAL_TOKEN_leak_canary_4d2f",
      why: "underscores break the run; longest base62 piece is 4 chars",
    },
    {
      what: "src/app/sources/__tests__/composition-root.test.ts:74",
      literal: "github_pat_-not-a-real-fixture-token-1",
      why: "leading underscore; no 20+ char base62 run exists",
    },
  ] as const;

  for (const fixture of FIXTURES) {
    it(`does not flag the fixture in ${fixture.what}`, () => {
      const findings = scanText(
        "fixture.ts",
        `const x = "${fixture.literal}";`,
      );
      expect(findings).toEqual([]);
    });

    it(`explains why ${fixture.what} passes: ${fixture.why}`, () => {
      // Asserted, not just asserted-in-prose: a run longer than MIN_RUN-1 with
      // no single piece reaching MIN_RUN is the mechanism.
      const after = fixture.literal.slice(fixture.literal.indexOf("_") + 1);
      const longest = after
        .split(/[^A-Za-z0-9]+/)
        .reduce((a, b) => (b.length > a.length ? b : a), "");
      expect(longest.length).toBeLessThan(MIN_RUN);
    });
  }

  it("flags a real-shaped fine-grained PAT", () => {
    const pat = syntheticRealLookingPat(20261004);
    const findings = scanText("src/x.ts", `const t = "${pat}";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("vendor-prefix-entropy");
  });

  it("flags the OTHER vendor prefixes too, not only github_pat_", () => {
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = `${prefix}${syntheticRealLookingPat(7).slice("github_pat_".length)}`;
      expect(scanText("src/x.ts", `const t = "${token}";`)).toHaveLength(1);
    }
  });

  it("flags a long LOW-entropy run as well as a short high-entropy one", () => {
    // Length alone is not the rule either: 40 A's is long but carries no
    // entropy, so both halves of the rule are load-bearing.
    const lowEntropy = `github_pat_${"A".repeat(40)}`;
    expect(scanText("src/x.ts", `const t = "${lowEntropy}";`)).toEqual([]);
  });

  it("flags a credential-shaped NAME carrying opaque material, with no vendor prefix", () => {
    const material = syntheticRealLookingPat(99).slice("github_pat_".length);
    const findings = scanText(
      "src/x.ts",
      `const SERVICE_TOKEN = "${material}";`,
    );
    expect(findings.map((f) => f.rule)).toContain("secret-name-opaque-value");
  });

  it("does NOT flag an ordinary call expression passed to a secret-ish name", () => {
    // Regression: an earlier rule matched the CALLEE name, so
    // `credentials: createFakeCredentialProvider(...)` became a finding. That
    // produced a baseline of pure noise, which is the fastest possible way to
    // make a baseline get ignored.
    const findings = scanText(
      "src/x.ts",
      "const opts = { credentials: createFakeCredentialProvider({ profile }) };",
    );
    expect(findings).toEqual([]);
  });

  it("does NOT flag a connection string in a password-shaped name", () => {
    const findings = scanText(
      "src/x.ts",
      'const POSTGRES_PASSWORD = "devloop";',
    );
    expect(findings).toEqual([]);
  });

  it("never puts the candidate text in a finding or its rendering", () => {
    const pat = syntheticRealLookingPat(31337);
    const finding = scanText("src/x.ts", `const t = "${pat}";`)[0];
    expect(finding).toBeDefined();
    expect(JSON.stringify(finding)).not.toContain(pat.slice(11, 31));
    expect(formatFinding(finding!)).not.toContain(pat);
  });
});

describe("secret scan: entropy maths", () => {
  it("is zero for an empty string and maximal for a uniform alphabet", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("ab")).toBe(1);
    expect(shannonEntropy("aaaa")).toBe(0);
  });
});

describe("secret scan: the baseline is read in BOTH directions", () => {
  it("c5(a): a fabricated entry changes nothing — extra entries are ignored", () => {
    const finding = scanText(
      "src/x.ts",
      `const t = "${syntheticRealLookingPat(5)}";`,
    )[0]!;
    const baseline = parseBaseline(
      renderBaseline([
        { fingerprint: finding.fingerprint, reason: "real finding" },
        {
          fingerprint: "ffffffffffffffff",
          reason: "fabricated, matches nothing",
        },
      ]),
    );
    expect(baseline.unreasonedLines).toEqual([]);
    expect(unbaselinedFindings([finding], baseline.entries)).toEqual([]);
  });

  it("c5(b): removing the real entry makes the same finding unbaselined", () => {
    const finding = scanText(
      "src/x.ts",
      `const t = "${syntheticRealLookingPat(5)}";`,
    )[0]!;
    const baseline = parseBaseline(
      renderBaseline([
        {
          fingerprint: "ffffffffffffffff",
          reason: "fabricated, matches nothing",
        },
      ]),
    );
    const left = unbaselinedFindings([finding], baseline.entries);
    expect(left).toHaveLength(1);
    expect(formatFinding(left[0]!)).toContain("src/x.ts:1");
  });

  it("treats an entry with no reason as a defect, not a waiver", () => {
    const parsed = parseBaseline("# header\ndeadbeefdeadbeef\n");
    expect(parsed.entries).toEqual([]);
    expect(parsed.unreasonedLines).toHaveLength(1);
    expect(parsed.unreasonedLines[0]?.line).toBe(2);
  });

  it("treats the generator's UNREASONED placeholder as no reason at all", () => {
    // The generator writes this placeholder for a finding it has no reason for.
    // It is a NON-EMPTY string, so a mere emptiness test accepts it and the gate
    // then reports a "reviewed" baseline nobody reviewed. Found by running
    // `secrets:scan:baseline` on batch 14, which emitted exactly this line and
    // then exited 0 on its own output.
    const line = `dbe9a14d6e7a70de\t${UNREASONED_PLACEHOLDER}`;
    const parsed = parseBaseline(`# header\n${line}\n`);
    expect(parsed.entries).toEqual([]);
    expect(parsed.unreasonedLines).toHaveLength(1);
    expect(parsed.unreasonedLines[0]?.line).toBe(2);

    // A real reason that merely mentions the word must still be accepted, or
    // the guard above would be unusable.
    const real = parseBaseline(
      `aaaa1111bbbb2222\tIdentified by name only: not material.\n`,
    );
    expect(real.entries).toHaveLength(1);
    expect(real.unreasonedLines).toEqual([]);
  });

  it("round-trips through render and parse", () => {
    const text = renderBaseline([{ fingerprint: "abc123", reason: "why" }]);
    expect(text).toContain(BASELINE_HEADER.split("\n")[0] as string);
    expect(parseBaseline(text).entries).toEqual([
      { fingerprint: "abc123", reason: "why" },
    ]);
  });
});

/**
 * Run the shipped CLI against a throwaway git repository. Returns the exit
 * code and combined output. This is the only assertion here that observes the
 * gate's real exit code, which is the thing CI actually reacts to.
 */
function runGate(files: Readonly<Record<string, string>>): {
  status: number;
  output: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "secret-scan-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    mkdirSync(path.join(dir, "security"), { recursive: true });
    for (const name of ["secret-scan.ts", "scan-secrets.ts"]) {
      writeFileSync(
        path.join(dir, "scripts", name),
        readFileSync(path.join(REPO_ROOT, "scripts", name), "utf8"),
        "utf8",
      );
    }
    execFileSync("git", ["add", "-A"], { cwd: dir });
    try {
      // Invoked by ABSOLUTE path so this test cannot pass by scanning some
      // copy of the scanner: the file under test is the shipped entry point.
      const output = execFileSync("bun", ["run", SCANNER_CLI], {
        cwd: path.join(dir, "scripts"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output };
    } catch (error) {
      const err = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        status: err.status ?? 1,
        output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("secret scan: the shipped CLI's exit code, in a throwaway repo", () => {
  const pat = syntheticRealLookingPat(4242);

  it("exits 1 and names file and line when the tree holds an unbaselined PAT", () => {
    const result = runGate({ "src/leak.ts": `export const t = "${pat}";\n` });
    expect(result.status).toBe(1);
    expect(result.output).toContain("src/leak.ts:1");
    expect(result.output).toContain("vendor-prefix-entropy");
  });

  it("exits 1 when the baseline line has no reason", () => {
    const result = runGate({
      "src/leak.ts": `export const t = "${pat}";\n`,
      "security/secret-scan-baseline.txt": "# header\nabc123\n",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("no reason");
  });

  it("exits 0 on a clean tree", () => {
    const result = runGate({ "src/ok.ts": "export const n = 1;\n" });
    expect(result.status).toBe(0);
    expect(result.output).toContain("OK");
  });

  it("still finds the leak when run from a SUBDIRECTORY, not just the root", () => {
    // A real bug in the first version of this CLI, and the worst failure mode
    // a credential gate can have: `git ls-files` and `git diff --cached` are
    // cwd-relative, so invoked from `scripts/` the script listed no files, the
    // read threw and was swallowed, and it reported "OK — 0 findings" — GREEN
    // over a tree containing a credential. The green lie was the gate's own
    // bug, produced by the gate.
    //
    // `runGate` writes `src/leak.ts`, so running the CLI with cwd `scripts/`
    // must still see it and still exit 1. If this test ever passes vacuously
    // because the temp repo has no `src/`, it cannot: the assertion below is on
    // the output naming that exact path.
    const dir = mkdtempSync(path.join(tmpdir(), "secret-scan-cwd-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(path.join(dir, "src"), { recursive: true });
      mkdirSync(path.join(dir, "scripts"), { recursive: true });
      mkdirSync(path.join(dir, "security"), { recursive: true });
      writeFileSync(
        path.join(dir, "src", "leak.ts"),
        `export const t = "${syntheticRealLookingPat(606)}";\n`,
        "utf8",
      );
      for (const name of ["secret-scan.ts", "scan-secrets.ts"]) {
        writeFileSync(
          path.join(dir, "scripts", name),
          readFileSync(path.join(REPO_ROOT, "scripts", name), "utf8"),
          "utf8",
        );
      }
      execFileSync("git", ["add", "-A"], { cwd: dir });
      const output = execFileSync("bun", ["run", SCANNER_CLI], {
        cwd: path.join(dir, "scripts"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Reached only if the CLI exited 0, which is the bug.
      throw new Error(`expected a non-zero exit, got 0 with output: ${output}`);
    } catch (error) {
      const err = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      expect(err.status).toBe(1);
      expect(`${err.stdout ?? ""}${err.stderr ?? ""}`).toContain(
        "src/leak.ts:1",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 when the ONLY finding is baselined with a reason", () => {
    // Generate the real fingerprint by scanning the same content the CLI will.
    const content = `export const t = "${pat}";\n`;
    const finding = scanText("src/leak.ts", content)[0]!;
    const result = runGate({
      "src/leak.ts": content,
      "security/secret-scan-baseline.txt": renderBaseline([
        {
          fingerprint: finding.fingerprint,
          reason: "fixture, not a credential",
        },
      ]),
    });
    expect(result.status).toBe(0);
  });
});

describe("the repository state this gate depends on", () => {
  const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  const ci = readFileSync(
    path.join(REPO_ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );

  it("ignores the whole env family and re-admits the example", () => {
    expect(gitignore).toContain(".env*");
    expect(gitignore).toContain("!.env.example");
  });

  it("runs the scan in CI", () => {
    expect(ci).toContain("secrets:scan");
  });

  it("has NO bypass in the CI step — no || true, no --exit-zero, no --no-verify", () => {
    // Only the scan step is inspected, so a `|| true` elsewhere in the workflow
    // (e.g. an advisory informational step) cannot mask a bypass of THIS gate.
    const scanStep = ci
      .split(/\n(?=\s*- name:)/)
      .filter((chunk) => chunk.includes("secrets:scan"));
    expect(scanStep).toHaveLength(1);
    const step = scanStep[0]!;
    expect(step).not.toMatch(/\|\|\s*true/);
    expect(step).not.toMatch(/exit-zero/);
    expect(step).not.toMatch(/no-verify/);
    expect(step).not.toMatch(/severity|threshold|CRITICAL|HIGH/i);
  });

  it("keeps .env.example tracked and the probe names untracked", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(tracked.split("\n")).toContain(".env.example");

    const check = (name: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", name], {
          cwd: REPO_ROOT,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    };
    for (const name of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.staging",
      ".env.production.local",
      ".env.development.local",
    ]) {
      expect(check(name)).toBe(true);
    }
    expect(check(".env.example")).toBe(false);
  });

  it("every committed baseline entry carries a reason", () => {
    const parsed = parseBaseline(
      readFileSync(
        path.join(REPO_ROOT, "security", "secret-scan-baseline.txt"),
        "utf8",
      ),
    );
    expect(parsed.unreasonedLines).toEqual([]);
    expect(parsed.entries.length).toBeGreaterThan(0);
    for (const entry of parsed.entries) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
