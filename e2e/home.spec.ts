import { expect, test } from "@playwright/test";

test.describe("home page", () => {
  test("responds with HTTP 200 and renders the root heading", async ({
    page,
    request,
  }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Hello World", level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveTitle(/DevLoop/);
  });

  test("renders the shadcn/ui button and its initial status line", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Get started" }),
    ).toBeVisible();
    await expect(page.getByTestId("get-started-status")).toHaveText(
      "Get started not pressed yet",
    );
  });
});
