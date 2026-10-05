#!/usr/bin/env bun
/**
 * `bun run secrets:hook:install` — point this clone's git at `.githooks`.
 *
 * WHY THIS EXISTS. `.githooks/pre-commit` is a committed hook script, but a
 * hook directory under `.git/hooks/` is never pushed. `core.hooksPath` is the
 * repository's own way to declare "my hooks live HERE, in the worktree", and it
 * survives a fresh clone in the only sense that matters: once set, the hook
 * applies to every commit in that clone without anyone copying a file into
 * `.git/hooks/`.
 *
 * WHAT IT DOES NOT DO, stated plainly so nobody mistakes this for enforcement.
 * `core.hooksPath` lives in `.git/config`, which is LOCAL to a clone. It is not
 * a repository property and it is not transmitted by a push or a fetch. A fresh
 * clone therefore has NO hook until this script (or the equivalent one-line
 * `git config`) is run there. That is a property of git, not of this
 * repository, and no committed file can change it.
 *
 * A SHARED-CONFIG WARNING, because this repository uses git worktrees. Without
 * `extensions.worktreeConfig`, `git config core.hooksPath` writes to the
 * SHARED config, so in a worktree it enables the hook for EVERY worktree of the
 * repository, not just this one. That is not harmful — the hook only scans what
 * is staged in the worktree doing the committing — but it means running this in
 * one worktree changes the behaviour of sibling worktrees, and a developer who
 * did not expect that would be right to be annoyed. This script therefore says
 * so out loud. To scope it to one worktree instead, enable
 * `extensions.worktreeConfig` and use `git config --worktree`, which this
 * repository has deliberately NOT enabled: turning it on changes how every
 * existing local config in every developer's clone is read, which is a much
 * larger decision than this card should make unilaterally.
 *
 * So: this hook is the CHEAP FIRST LAYER, and the gate that is actually
 * guaranteed to run on every commit is `bun run secrets:scan` in the `verify`
 * job of `.github/workflows/ci.yml`. If a commit was made with this hook not
 * installed, CI is what catches the credential — later, but it does catch it.
 */

import { execFileSync } from "node:child_process";

const HOOKS_PATH = ".githooks";

function git(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Like {@link git}, but an unset key (exit 1, no output) is an empty string. */
function gitRead(args: readonly string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const top = git(["rev-parse", "--show-toplevel"]);
// `git config --get` exits 1 when the key is UNSET, so its stdout is the answer
// and its exit code is not an error. Reading it as a failure here would mean the
// installer only ever worked on a clone that already had the hook.
const current = gitRead(["config", "--get", "core.hooksPath"]);

if (current === HOOKS_PATH) {
  process.stdout.write(
    `secrets:hook:install — core.hooksPath is already ${HOOKS_PATH}; nothing to do.\n`,
  );
} else {
  git(["config", "core.hooksPath", HOOKS_PATH]);
  process.stdout.write(
    `secrets:hook:install — set core.hooksPath=${HOOKS_PATH}${current === "" ? "" : ` (was ${current})`}\n`,
  );
}

process.stdout.write(
  `\nThe pre-commit credential scan is now active in this clone (${top}).\n` +
    "It is LOCAL to this clone: core.hooksPath is stored in .git/config, which\n" +
    "is not pushed. Run this script again after a fresh clone, or set it by hand:\n" +
    "\n" +
    "    git config core.hooksPath .githooks\n" +
    "\n" +
    "NOTE, in a worktree: without extensions.worktreeConfig this writes the\n" +
    "SHARED config, so the hook is now active for every worktree of this\n" +
    "repository, not only this one. Harmless (each commit is scanned in its own\n" +
    "worktree) but surprising. Undo with: git config --unset core.hooksPath\n" +
    "\n" +
    "Either way the CI gate (bun run secrets:scan in the verify job) runs on every\n" +
    "push regardless of hooks, and is the layer that is actually guaranteed.\n",
);
