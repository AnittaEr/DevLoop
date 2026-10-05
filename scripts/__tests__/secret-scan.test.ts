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
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { LOAD_BEARING_TEST_TIMEOUT } from "@/core/testing/load-bearing-test-timeout";

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

// ── WHY THESE FIFTEEN TESTS CARRY A BUDGET, AND HOW EACH NUMBER WAS REACHED ──
//
// Every test below reaches a real subprocess: `git init`/`config`/`add`/`commit`
// through `initTempRepo`, `git`, `gitIsolated` and `runGate`, or
// `bun run scripts/secret-scan.ts` itself. That is a cold process start per
// call, so the cost is a property of the MACHINE and the load on it, not of the
// code under test -- and none of it is what these tests assert. Under the 5s
// global default they go red for reasons that have nothing to do with the code,
// which is the defect B53's regression guard exists to make impossible.
//
// MEASURED AT HEAD `b66720e` (the reconciled batch-15 tree) ON THIS MACHINE
// (8 cores, 16GB, macOS): N concurrent FULL `bun run test` suites in N SEPARATE
// detached worktrees, so no two runs shared a repository, with each test's own
// duration read out of Vitest's JSON reporter (`--reporter=json`) rather than
// the file being timed from outside.
//
//   7 concurrent suites    worst observation 12553ms
//   12 concurrent suites   worst observation 28051ms
//   16 concurrent suites   worst observation 58930ms   <-- sized from this
//
// 16 concurrent suites is TWO WHOLE SUITES PER CORE on an 8-core box -- more
// load than CI or a developer produces, used here precisely because a budget
// sized from a comfortable load is a budget that has never been tested.
//
// A FLAT `subprocess` (30s) IS NOT ENOUGH AT THIS LOAD, and that is a
// measurement rather than a preference: the worst 16x observation is 58930ms,
// so one 30s budget would sit BELOW a duration this machine actually produced.
// The next round number above it is the 60s `subprocessX4`, so the sites whose
// own worst observation exceeded 30s take `subprocessX4` and the rest take
// `subprocess`. Seven of the fifteen exceeded 30s; the split is read off the
// numbers in each site's own comment, not from a guess about which tests "feel
// heavy". The spread is load-driven: the two heaviest are the two that run the
// scanner CLI more than once inside a single test.
//
// THE GLOBAL 5s DEFAULT IS UNCHANGED. These are per-test budgets on fifteen
// tests; the other ~670 tests still fail at 5000ms, so a regression that made an
// ordinary in-process test slow is still caught in 5s.

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
 * The identity every temp repo in this file commits as. It is a FIXTURE value:
 * `.invalid` is reserved by RFC 2606 and can never be a real mailbox.
 */
const TEMP_REPO_GIT_NAME = "devloop secret-scan tests";
const TEMP_REPO_GIT_EMAIL = "secret-scan-tests@example.invalid";

/**
 * Initialise a throwaway repository at `dir` with a committer identity that
 * does NOT depend on ambient machine state.
 *
 * WHY THIS EXISTS (B55, PR #16 red in CI). `git commit` needs an author and a
 * committer. When a repository configures neither, git falls back to global
 * config, then to `EMAIL`/`GIT_AUTHOR_*`/`GIT_COMMITTER_*`, and finally — on
 * macOS only — to the OS account name via `getpwuid()`. A Linux CI runner has
 * none of those, so `git commit` exits non-zero with
 * `fatal: empty ident name ... not allowed` and this suite goes red in a way
 * no macOS run can reproduce. Measured pre-fix: 1 failure in 6 full-suite runs
 * under `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`, because the
 * failure is load-dependent (the `bun run` subprocess inherits whatever the
 * parallel suite left behind) and single-file runs never hit it.
 *
 * So the identity is set EXPLICITLY, here, once per temp repo, at every one of
 * the three sites that create one. The hermeticity test below asserts it, and
 * that assertion fails on macOS too — which a "no local failures" argument
 * could never do.
 */
function initTempRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", TEMP_REPO_GIT_NAME], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.email", TEMP_REPO_GIT_EMAIL], {
    cwd: dir,
  });
}

/**
 * An environment with every ambient git identity removed, emulating a CI
 * runner: no global config, no system config, no `EMAIL`, no `GIT_*_NAME` /
 * `GIT_*_EMAIL`. On macOS this still does not make an unconfigured repo
 * uncommittable — `getpwuid()` fills in the OS account — which is exactly why
 * the tests below assert the RESOLVED ident rather than merely observing that
 * a commit succeeded.
 */
function envWithoutAmbientGitIdentity(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.EMAIL;
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

/**
 * Run the shipped CLI against a throwaway git repository. Returns the exit
 * code and combined output. This is the only assertion here that observes the
 * gate's real exit code, which is the thing CI actually reacts to.
 */
function runGate(
  files: Readonly<Record<string, string>>,
  onRepo?: (dir: string) => void,
): {
  status: number;
  output: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "secret-scan-"));
  try {
    initTempRepo(dir);
    onRepo?.(dir);
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

/**
 * Create a throwaway git repository with the shipped scanner copied in, and
 * hand its directory to `body`.
 *
 * The scanner is copied from THIS repo and invoked by absolute path, so the
 * file under test is always the shipped entry point and a test cannot pass by
 * scanning a copy.
 */
function withTempRepo(body: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "secret-scan-repo-"));
  try {
    initTempRepo(dir);
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    mkdirSync(path.join(dir, "security"), { recursive: true });
    for (const name of ["secret-scan.ts", "scan-secrets.ts"]) {
      writeFileSync(
        path.join(dir, "scripts", name),
        readFileSync(path.join(REPO_ROOT, "scripts", name), "utf8"),
        "utf8",
      );
    }
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the shipped CLI in `cwd` and capture its real exit code and output. */
function runScanner(
  cwd: string,
  args: readonly string[] = [],
): { status: number; output: string } {
  try {
    const output = execFileSync("bun", ["run", SCANNER_CLI, ...args], {
      cwd,
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
}

/** Run a git command in `cwd`, failing the test loudly if it does not work. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * `git` with every ambient identity removed — see
 * `envWithoutAmbientGitIdentity`. Used only by the hermeticity tests, which
 * must resolve the ident the way a Linux CI runner does. The other tests go
 * through `git()`, whose environment does not matter *because* `initTempRepo`
 * configured the repo explicitly: the repo config is consulted before the
 * `getpwuid()` fallback, so it wins regardless.
 */
function gitIsolated(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: envWithoutAmbientGitIdentity(),
  });
}

describe("secret scan: every temp repo is hermetic w.r.t. git identity (B55)", () => {
  // The defect this pins: PR #16's `verify` job was red because
  // `withTempRepo()` created a repository with no `user.name`/`user.email`, and
  // `git commit` inside it needed one. macOS papers over this with
  // `getpwuid()`; a Linux CI runner has no such fallback. A suite that merely
  // PASSES locally therefore proves nothing — these tests assert the resolved
  // ident instead, and they fail on macOS too if the configuration is removed.
  const author = (dir: string) =>
    gitIsolated(dir, "log", "-1", "--format=%an <%ae>").trim();

  // MEASURED BUDGET: `subprocess`. creates a temp repo, writes a file and
  // commits, so it pays `git init`, two `git config` calls, `git add` and
  // `git commit` on top of the init. this test's own worst observation, 16
  // concurrent full suites: 20546ms (median 11571ms)
  // 20546ms sits under 30s, so `subprocess` holds with headroom at the worst
  // load measured; the 60s tier would be spent for nothing.
  it(
    "withTempRepo's repo commits as the FIXTURE ident, not the OS account",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        expect(gitIsolated(dir, "config", "--get", "user.email").trim()).toBe(
          TEMP_REPO_GIT_EMAIL,
        );
        writeFileSync(path.join(dir, "a.ts"), "export const n = 1;\n", "utf8");
        gitIsolated(dir, "add", "-A");
        // Under the emulated runner: no global/system config, no EMAIL, no
        // GIT_*_NAME/_EMAIL. This is the exact `git commit` that failed in CI.
        gitIsolated(dir, "commit", "-qm", "hermetic");
        expect(author(dir)).toBe(
          `${TEMP_REPO_GIT_NAME} <${TEMP_REPO_GIT_EMAIL}>`,
        );
      });
    },
  );

  // MEASURED BUDGET: `subprocessX4`. drives the whole gate through
  // `runGate`: init, config, add, and then the scanner CLI itself as a
  // subprocess. this test's own worst observation, 16 concurrent full
  // suites: 31805ms (median 14573ms)
  // 31805ms EXCEEDS the 30s `subprocess` tier at this load, so this site takes
  // `subprocessX4`: a 30s budget here would be one this machine has already
  // been observed to blow through, which is how a budget gets crossed again on
  // the next slower machine.
  it(
    "runGate's repo has the fixture identity configured",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocessX4 },
    () => {
      // `runGate` gets an `onRepo` hook because it creates the repo itself and
      // deletes it in its own `finally`; the hook is the only way to observe the
      // repository it built, and an empty hook would let this pass vacuously.
      let observed = false;
      runGate({ "src/ok.ts": "export const n = 1;\n" }, (dir) => {
        observed = true;
        expect(gitIsolated(dir, "config", "--get", "user.name").trim()).toBe(
          TEMP_REPO_GIT_NAME,
        );
      });
      expect(observed).toBe(true);
    },
  );

  // MEASURED BUDGET: `subprocess`. the control for the pair above, and it
  // builds an UNCONFIGURED repo on purpose, so it pays the same init and
  // commit work with none of the config calls -- which is exactly what
  // makes it a control. this test's own worst observation, 16 concurrent
  // full suites: 23175ms (median 12664ms)
  // 23175ms sits under 30s, so `subprocess` holds with headroom at the worst
  // load measured; the 60s tier would be spent for nothing.
  it(
    "an UNCONFIGURED repo has no fixture ident — so the config is load-bearing",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      // The control for the pair above, and the reason "the commit worked" is not
      // evidence. On macOS this repo still commits, as the OS account — which is
      // precisely why the defect was invisible here and red on the runner. On
      // Linux git refuses outright. Both platforms agree on the assertion: the
      // identity the two tests above rely on comes from `initTempRepo`, never
      // from the machine.
      const dir = mkdtempSync(path.join(tmpdir(), "secret-scan-unconfigured-"));
      try {
        // Deliberately NOT `initTempRepo`: this repo must have NO identity, which
        // is the control for the fix. Its single bare `git init` is the one the
        // structural guard below accounts for.
        execFileSync("git", ["init", "-q"], { cwd: dir });
        let unconfiguredName = "";
        let unconfiguredEmail = "";
        try {
          unconfiguredName = gitIsolated(
            dir,
            "config",
            "--get",
            "user.name",
          ).trim();
        } catch {
          // `git config --get` exits 1 when the key is unset — the state under test.
        }
        try {
          unconfiguredEmail = gitIsolated(
            dir,
            "config",
            "--get",
            "user.email",
          ).trim();
        } catch {
          // As above.
        }
        expect(unconfiguredName).toBe("");
        expect(unconfiguredEmail).toBe("");

        writeFileSync(path.join(dir, "a.ts"), "export const n = 1;\n", "utf8");
        gitIsolated(dir, "add", "-A");
        let committed = false;
        try {
          gitIsolated(dir, "commit", "-qm", "unconfigured");
          committed = true;
        } catch {
          // Expected on the Linux CI runner: git refuses, which is what made
          // PR #16 red.
        }
        if (committed) {
          // On macOS git resolved the OS account via getpwuid() instead — which is
          // exactly why the defect was invisible here.
          expect(author(dir)).not.toBe(
            `${TEMP_REPO_GIT_NAME} <${TEMP_REPO_GIT_EMAIL}>`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("no temp repo in this file is created by a bare `git init` any more", () => {
    // Structural guard for the THIRD site (the inline cwd test), which builds
    // its own repository and so cannot be covered by exercising the helper.
    // Without this, re-adding `git init -q` at any site would restore the exact
    // defect while every hermeticity test above still passed.
    const source = readFileSync(__filename, "utf8");
    const bareInits = source.match(/\["init", "-q"\]/g) ?? [];
    // Exactly two: the one inside `initTempRepo`, and the one in the
    // unconfigured-repo control above, which must NOT configure an identity.
    expect(bareInits).toHaveLength(2);
    const helperCalls = source.match(/^\s*initTempRepo\(dir\);$/gm) ?? [];
    expect(helperCalls).toHaveLength(3); // runGate, withTempRepo, inline cwd
  });
});

describe("secret scan: the STAGED BYTES are scanned, not the working tree", () => {
  // A real bug found by QA at `304bacd`, in the exact code path the ticket's c6
  // exists to close. `scanFiles()` took its path LIST from `git diff --cached`
  // and then read each path with `readFileSync` — the WORKING TREE. So `--staged`
  // meant "the staged file list, paired with whatever the file contains right
  // now", and this needed no `--no-verify` at all:
  //
  //   git add -f a.ts          # index holds the credential
  //   echo clean > a.ts        # disk does not
  //   git commit -qm x         # COMMIT_EXIT=0, hook silent
  //   git show HEAD:a.ts       # the PAT IS IN THE COMMIT
  //
  // The default committed-tree mode had the same hole: it reported green over a
  // HEAD holding a real-shaped PAT whenever the working tree was clean. CI only
  // escaped because `actions/checkout` materialises HEAD into the working tree
  // first — a coincidence of the runner, not a property of the gate.
  //
  // Every test here stages BYTES THAT DIFFER FROM DISK. A test that only asserts
  // the path list is staged, with the file on disk holding the same bytes, would
  // pass against the broken code — which is the round-1 lesson in a new costume.

  const pat = syntheticRealLookingPat(8675309);
  const CLEAN = 'export const t = "clean";\n';

  // MEASURED BUDGET: `subprocess`. init, config, add, commit, then a second
  // `add` and a `--staged` scan: two scanner invocations across one test.
  // this test's own worst observation, 16 concurrent full suites: 24327ms
  // (median 17798ms)
  // 24327ms sits under 30s, so `subprocess` holds with headroom at the worst
  // load measured; the 60s tier would be spent for nothing.
  it(
    "--staged exits 1 on a staged credential whose working-tree copy is clean",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        const file = path.join(dir, "a.ts");
        writeFileSync(file, `export const t = "${pat}";\n`, "utf8");
        git(dir, "add", "-f", "a.ts");
        // The divergence the old code could not see.
        writeFileSync(file, CLEAN, "utf8");
        expect(readFileSync(file, "utf8")).toBe(CLEAN);

        const result = runScanner(dir, ["--staged"]);
        expect(result.status).toBe(1);
        expect(result.output).toContain("a.ts:1");
        expect(result.output).toContain("vendor-prefix-entropy");
      });
    },
  );

  // MEASURED BUDGET: `subprocess`. init, config, add, commit, then the
  // committed-tree scan: a second scanner invocation. this test's own worst
  // observation, 16 concurrent full suites: 29662ms (median 18769ms)
  // 29662ms sits under 30s, so `subprocess` holds with headroom at the worst
  // load measured; the 60s tier would be spent for nothing.
  it(
    "the default committed-tree mode exits 1 over a credential only in the index",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      withTempRepo((dir) => {
        const file = path.join(dir, "a.ts");
        writeFileSync(file, `export const t = "${pat}";\n`, "utf8");
        git(dir, "add", "-f", "a.ts");
        writeFileSync(file, CLEAN, "utf8");

        const result = runScanner(dir);
        expect(result.status).toBe(1);
        expect(result.output).toContain("a.ts:1");
      });
    },
  );

  // MEASURED BUDGET: `subprocess`. init, config, add, commit, an unlink, a
  // re-add, then the `--staged` scan. this test's own worst observation, 16
  // concurrent full suites: 28159ms (median 20648ms)
  // 28159ms sits under 30s, so `subprocess` holds with headroom at the worst
  // load measured; the 60s tier would be spent for nothing.
  it(
    "--staged exits 1 when the working-tree copy of a staged file is DELETED",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      // The pre-fix code caught this one only by accident, via its readFileSync
      // throw. Pinned so the index read cannot regress into a disk read that
      // "handles" absence by skipping.
      withTempRepo((dir) => {
        const file = path.join(dir, "a.ts");
        writeFileSync(file, `export const t = "${pat}";\n`, "utf8");
        git(dir, "add", "-f", "a.ts");
        rmSync(file);

        const result = runScanner(dir, ["--staged"]);
        expect(result.status).toBe(1);
        expect(result.output).toContain("a.ts:1");
      });
    },
  );

  // MEASURED BUDGET: `subprocess`. init, config, add, commit, then the
  // clean `--staged` scan. this test's own worst observation, 16 concurrent
  // full suites: 26974ms (median 21491ms)
  // 26974ms sits under 30s, so `subprocess` holds with headroom at the worst
  // load measured; the 60s tier would be spent for nothing.
  it(
    "--staged exits 0 when the staged bytes are clean even if disk holds a PAT",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      // The other direction, and the one that keeps the gate honest rather than
      // merely noisy: a credential lying around in the working tree that is NOT
      // staged must not block an unrelated commit. The committed-tree mode is
      // where an uncommitted PAT gets reported, and it does — see the test above.
      withTempRepo((dir) => {
        const file = path.join(dir, "a.ts");
        writeFileSync(file, CLEAN, "utf8");
        git(dir, "add", "-f", "a.ts");
        git(dir, "commit", "-qm", "clean content");
        writeFileSync(file, `export const t = "${pat}";\n`, "utf8");

        const result = runScanner(dir, ["--staged"]);
        expect(result.status).toBe(0);
      });
    },
  );

  // MEASURED BUDGET: `subprocessX4`. THE HEAVIEST SITE IN THIS FILE. It
  // drives the shipped pre-commit HOOK end to end, which means the hook's
  // own `bun run secrets:scan` runs as a subprocess INSIDE the commit, and
  // the test then asserts on the refusal by running the scanner again. The
  // most cold process starts of any test here, and so the worst observation
  // in the file. this test's own worst observation, 16 concurrent full
  // suites: 58930ms (median 48658ms)
  // 58930ms EXCEEDS the 30s `subprocess` tier at this load, so this site takes
  // `subprocessX4`: a 30s budget here would be one this machine has already
  // been observed to blow through, which is how a budget gets crossed again on
  // the next slower machine.
  it(
    "the shipped pre-commit HOOK blocks the commit, not just the CLI",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocessX4 },
    () => {
      // The end-to-end version of the same defect, through the hook the developer
      // actually runs. QA's reproduction used `git commit`; this asserts the
      // installed hook refuses it.
      withTempRepo((dir) => {
        // Identity comes from `withTempRepo` (c3): this call site used to set it
        // inline while the helper did not, which is how the missing-identity
        // defect hid here — the file looked deliberate.
        mkdirSync(path.join(dir, ".githooks"), { recursive: true });
        writeFileSync(
          path.join(dir, ".githooks", "pre-commit"),
          readFileSync(path.join(REPO_ROOT, ".githooks", "pre-commit"), "utf8"),
          "utf8",
        );
        // git SILENTLY ignores a non-executable hook (only a hint on stderr), so
        // without this the commit would succeed and the test would pin the
        // absence of a hook rather than the presence of one.
        chmodSync(path.join(dir, ".githooks", "pre-commit"), 0o755);
        git(dir, "config", "core.hooksPath", ".githooks");

        const file = path.join(dir, "a.ts");
        writeFileSync(file, CLEAN, "utf8");
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "initial");

        writeFileSync(file, `export const t = "${pat}";\n`, "utf8");
        git(dir, "add", "-f", "a.ts");
        writeFileSync(file, CLEAN, "utf8");

        let commitStatus = 0;
        try {
          git(dir, "commit", "-qm", "smuggle a credential in");
        } catch (error) {
          commitStatus = (error as { status?: number }).status ?? 1;
        }
        expect(commitStatus).not.toBe(0);

        // The commit was refused, so the index still holds exactly the bytes it
        // held before — proof the hook refused on the STAGED content and that
        // nothing was rewritten on the way through. (Asserting the index held
        // CLEAN here was backwards: refusing the commit is exactly what leaves
        // the smuggled bytes staged.)
        expect(git(dir, "show", ":./a.ts")).toContain("github_pat_");
        expect(git(dir, "log", "--format=%s", "-1").trim()).toBe("initial");
      });
    },
  );

  // MEASURED BUDGET: `subprocessX4`. the second heaviest: it builds an
  // UNMERGED index -- init, config, add, a deliberate `rm --cached`, an
  // untracked write, several `git cat-file` and `git ls-files` probes --
  // and then scans, so it runs the CLI on top of the repo construction.
  // this test's own worst observation, 16 concurrent full suites: 53196ms
  // (median 43159ms)
  // 53196ms EXCEEDS the 30s `subprocess` tier at this load, so this site takes
  // `subprocessX4`: a 30s budget here would be one this machine has already
  // been observed to blow through, which is how a budget gets crossed again on
  // the next slower machine.
  it(
    "names, rather than silently drops, a path with no readable index blob",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocessX4 },
    () => {
      // An UNMERGED path: `git ls-files` lists it, `git diff --cached
      // --diff-filter=ACMU` deliberately includes it, but `:<path>` needs a
      // stage-0 entry and there is none, so `cat-file` fails. The gate must SAY
      // so rather than skip in silence — a silently skipped path is the shape of
      // the green lie this whole card is about.
      //
      // It is not fatal, and must not be: `git commit` refuses an unmerged tree
      // outright, so nothing it could have hidden can reach a commit that gets
      // made. The committed-tree CI run sees this only if a developer leaves the
      // conflict unresolved, which CI reports anyway.
      withTempRepo((dir) => {
        writeFileSync(path.join(dir, "f"), "base\n", "utf8");
        git(dir, "add", "f");
        git(dir, "commit", "-qm", "base");

        const startBranch = git(
          dir,
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ).trim();
        git(dir, "checkout", "-qb", "other");
        writeFileSync(path.join(dir, "f"), "other\n", "utf8");
        git(dir, "commit", "-qam", "other");
        git(dir, "checkout", "-q", startBranch);
        writeFileSync(path.join(dir, "f"), "mine\n", "utf8");
        git(dir, "commit", "-qam", "mine");
        // Both sides touched `f` from a common base, so this conflicts rather
        // than fast-forwarding and leaves `f` at stages 1/2/3.
        expect(() => git(dir, "merge", "other")).toThrow();

        const result = runScanner(dir);
        expect(result.output).toContain("f");
        expect(result.output).toContain("not scanned");
      });
    },
  );
});

describe("secret scan: the shipped CLI's exit code, in a throwaway repo", () => {
  const pat = syntheticRealLookingPat(4242);

  // MEASURED BUDGET: `subprocess`. init, config, add, commit, then one CLI
  // scan whose stderr it asserts on. this test's own worst observation, 16
  // concurrent full suites: 26619ms (median 18494ms)
  // 26619ms sits under 30s, so `subprocess` holds with headroom at the worst
  // load measured; the 60s tier would be spent for nothing.
  it(
    "exits 1 and names file and line when the tree holds an unbaselined PAT",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
      const result = runGate({ "src/leak.ts": `export const t = "${pat}";\n` });
      expect(result.status).toBe(1);
      expect(result.output).toContain("src/leak.ts:1");
      expect(result.output).toContain("vendor-prefix-entropy");
    },
  );

  // MEASURED BUDGET: `subprocessX4`. init, config, add, commit, then one
  // CLI scan against a doctored baseline. this test's own worst
  // observation, 16 concurrent full suites: 50500ms (median 21370ms)
  // 50500ms EXCEEDS the 30s `subprocess` tier at this load, so this site takes
  // `subprocessX4`: a 30s budget here would be one this machine has already
  // been observed to blow through, which is how a budget gets crossed again on
  // the next slower machine.
  it(
    "exits 1 when the baseline line has no reason",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocessX4 },
    () => {
      const result = runGate({
        "src/leak.ts": `export const t = "${pat}";\n`,
        "security/secret-scan-baseline.txt": "# header\nabc123\n",
      });
      expect(result.status).toBe(1);
      expect(result.output).toContain("no reason");
    },
  );

  // MEASURED BUDGET: `subprocessX4`. init, config, add, commit, then one
  // CLI scan expected to pass. this test's own worst observation, 16
  // concurrent full suites: 33163ms (median 20914ms)
  // 33163ms EXCEEDS the 30s `subprocess` tier at this load, so this site takes
  // `subprocessX4`: a 30s budget here would be one this machine has already
  // been observed to blow through, which is how a budget gets crossed again on
  // the next slower machine.
  it(
    "exits 0 on a clean tree",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocessX4 },
    () => {
      const result = runGate({ "src/ok.ts": "export const n = 1;\n" });
      expect(result.status).toBe(0);
      expect(result.output).toContain("OK");
    },
  );

  // MEASURED BUDGET: `subprocessX4`. init, config, add, commit, then a `bun
  // run` from a SUBDIRECTORY -- a cold start resolving the script through a
  // nested `package.json` lookup, which is why it costs more than its
  // neighbours. this test's own worst observation, 16 concurrent full
  // suites: 33527ms (median 16514ms)
  // 33527ms EXCEEDS the 30s `subprocess` tier at this load, so this site takes
  // `subprocessX4`: a 30s budget here would be one this machine has already
  // been observed to blow through, which is how a budget gets crossed again on
  // the next slower machine.
  it(
    "still finds the leak when run from a SUBDIRECTORY, not just the root",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocessX4 },
    () => {
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
        initTempRepo(dir);
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
        throw new Error(
          `expected a non-zero exit, got 0 with output: ${output}`,
        );
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
    },
  );

  // MEASURED BUDGET: `subprocessX4`. init, config, add, commit, then one
  // CLI scan whose only finding must be baselined. this test's own worst
  // observation, 16 concurrent full suites: 36188ms (median 17374ms)
  // 36188ms EXCEEDS the 30s `subprocess` tier at this load, so this site takes
  // `subprocessX4`: a 30s budget here would be one this machine has already
  // been observed to blow through, which is how a budget gets crossed again on
  // the next slower machine.
  it(
    "exits 0 when the ONLY finding is baselined with a reason",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocessX4 },
    () => {
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
    },
  );
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

  // MEASURED BUDGET: `subprocess`. the cheapest of the fifteen: two `git
  // ls-files` calls against the REPO (no temp repo, no scanner) plus a
  // baseline parse. this test's own worst observation, 16 concurrent full
  // suites: 19966ms (median 11224ms)
  // 19966ms sits under 30s, so `subprocess` holds with headroom at the worst
  // load measured; the 60s tier would be spent for nothing.
  it(
    "keeps .env.example tracked and the probe names untracked",
    { timeout: LOAD_BEARING_TEST_TIMEOUT.subprocess },
    () => {
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
    },
  );

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
