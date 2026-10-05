import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buttonVariants } from "@/components/ui/button";

import Home from "./page";

/** Pull the class attribute off the first <button> in the markup. */
function buttonClass(html: string): string {
  const match = /<button[^>]*\sclass="([^"]*)"/.exec(html);
  if (!match?.[1]) {
    throw new Error(`no <button> with a class attribute in markup: ${html}`);
  }
  return match[1];
}

/**
 * Server-side assertion: render the App Router page component to static markup
 * the way the server does, and assert on the emitted HTML.
 */
describe("Home page (server render)", () => {
  it("emits a Hello World h1 in the server-rendered markup", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("<h1");
    expect(html).toContain("Hello World");
  });

  it("emits the shadcn/ui button with exactly the default variant classes", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("Get started");
    // Compare against buttonVariants() itself rather than a hand-copied class
    // string, so the page and the variant definition cannot drift apart.
    expect(buttonClass(html)).toBe(buttonVariants());
  });

  it("applies bg-primary as a whole class token, not just inside hover:bg-primary/90", () => {
    // Guards the variant definition: a substring match on "bg-primary" would
    // also be satisfied by "hover:bg-primary/90" alone.
    const tokens = buttonVariants().split(/\s+/);
    expect(tokens).toContain("bg-primary");
    expect(tokens).toContain("hover:bg-primary/90");
  });

  it("links to the sign-in page", () => {
    // c11's minimal edit: the home page gains a LINK and nothing else.
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('href="/sign-in"');
  });

  it("carries NO session guard, because it renders no evidence", async () => {
    // The load-bearing half of c11. The home page shows a hard-coded string, so
    // there is nothing on it to withhold — and a guard added here would be
    // ceremony that hides the fact that `/evidence` is the protected page. So the
    // page must not reach the session guard, or the database, at all.
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "page.tsx"),
      "utf8",
    );
    expect(source).not.toContain("requireSession");
    expect(source).not.toContain("session-guard");
    expect(source).not.toContain("readCanonicalEvents");
    expect(source).not.toContain("canonical_events");
  });
});
