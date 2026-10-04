import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Home from "./page";

describe("Home page (client render)", () => {
  it("renders the Hello World heading", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { name: "Hello World", level: 1 }),
    ).toBeVisible();
  });

  it("renders the shadcn/ui call-to-action button", () => {
    render(<Home />);
    expect(screen.getByRole("button", { name: "Get started" })).toBeVisible();
  });

  it("states which foundation pieces are wired up", () => {
    render(<Home />);
    expect(
      screen.getByText(/TypeScript strict, Tailwind, shadcn\/ui/i),
    ).toBeVisible();
  });
});
