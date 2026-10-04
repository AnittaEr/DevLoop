import { expect, test } from "@playwright/test";
import { collectHydrationErrors } from "./support/hydration";

/**
 * Proves the client-component boundary actually works in a real browser:
 * React must hydrate the island and the click must produce a visible DOM
 * change. A server/client split mistake shows up here as a status line that
 * never changes, and as a hydration error on the console.
 *
 * The hydration check is load-bearing, not decoration — see
 * e2e/support/hydration.ts for why a naive `/hydrat/i` filter silently
 * matches nothing against this config's production build.
 */
test.describe("client interaction", () => {
  test("clicking the button updates the status text", async ({ page }) => {
    // Listeners must be attached before the first navigation.
    const hydrationErrors = collectHydrationErrors(page);

    await page.goto("/");

    const status = page.getByTestId("get-started-status");
    await expect(status).toHaveText("Get started not pressed yet");

    await page.getByRole("button", { name: "Get started" }).click();

    await expect(status).toHaveText("Get started pressed");
    expect(hydrationErrors).toEqual([]);
  });
});
