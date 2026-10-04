import { describe, expect, it } from "vitest";

// TEMPORARY — deliberately failing, exists only to prove the CI gate BLOCKS (D-023).
// Removed in the immediately following commit.
describe("i1 gate proof", () => {
  it("must be red so the pipeline is proven to block", () => {
    expect(1 + 1).toBe(3);
  });
});