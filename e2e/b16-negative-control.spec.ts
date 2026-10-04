import { expect, test } from "@playwright/test";

// B16 NEGATIVE CONTROL — TEMPORARY. Deleted in the very next commit.
//
// Purpose: prove the new CI e2e step actually EXECUTES the suite rather than
// exiting 0 without running anything. It passes every other gate
// (format:check, lint, typecheck, test, build) and asserts a heading that
// does not exist, so the ONLY step that can go red is E2E (Playwright).
// A green CI run on this commit would mean the e2e step is vacuous.
test.describe("B16 negative control", () => {
  test("deliberately fails to prove the CI e2e step is not vacuous", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "THIS HEADING DOES NOT EXIST B16 NEGATIVE CONTROL",
        level: 1,
      }),
    ).toBeVisible({ timeout: 5_000 });
  });
});