import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("drops falsy and conditional values", () => {
    const isActive = false;
    expect(cn("foo", isActive && "bar", undefined, null, "")).toBe("foo");
  });

  it("resolves conflicting tailwind utilities so the last one wins", () => {
    expect(cn("px-2 py-1", "px-6")).toBe("py-1 px-6");
  });

  it("accepts conditional object syntax", () => {
    expect(cn({ "font-bold": true, "font-light": false })).toBe("font-bold");
  });
});
