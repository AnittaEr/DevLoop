import path from "node:path";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("next.config outputFileTracingRoot", () => {
  it("pins the tracing root to the repository root", () => {
    // The repo root is the directory holding package.json, one level up from src.
    const repoRoot = path.resolve(__dirname, "../..");

    expect(nextConfig.outputFileTracingRoot).toBe(repoRoot);
  });

  it("does not infer the workspace root from a lockfile above the repo", () => {
    // A stray /Users/<user>/Code/package-lock.json sits above this repo and makes
    // Next.js print a multiple-lockfiles / inferred-workspace-root warning.
    // Pinning the tracing root must keep the resolved root inside the repo no
    // matter what lockfiles exist above it.
    const repoRoot = path.resolve(__dirname, "../..");
    const tracingRoot = String(nextConfig.outputFileTracingRoot);

    expect(path.isAbsolute(tracingRoot)).toBe(true);
    // Derive the expected segment from the repo root rather than hardcoding a
    // directory name, so the assertion holds in any checkout location.
    expect(tracingRoot.split(path.sep)).toContain(path.basename(repoRoot));
  });
});
