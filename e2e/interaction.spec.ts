import { expect, test } from "@playwright/test";

/**
 * Proves the client-component boundary actually works in a real browser:
 * React must hydrate the island and the click must produce a visible DOM
 * change. A server/client split mistake shows up here as a status line that
 * never changes (or as a console/hydration error), not just as a type error.
 */
test.describe("client interaction", () => {
  test("clicking the button updates the status text", async ({ page }) => {
    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /hydrat/i.test(message.text())) {
        hydrationErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      if (/hydrat/i.test(error.message)) {
        hydrationErrors.push(error.message);
      }
    });

    await page.goto("/");

    const status = page.getByTestId("get-started-status");
    await expect(status).toHaveText("Get started not pressed yet");

    await page.getByRole("button", { name: "Get started" }).click();

    await expect(status).toHaveText("Get started pressed");
    expect(hydrationErrors).toEqual([]);
  });
});
