import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home from "./page";

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

  it("emits the shadcn/ui button with the default variant classes", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toMatch(/<button[^>]*class="[^"]*bg-primary[^"]*"/);
    expect(html).toContain("Get started");
  });
});
