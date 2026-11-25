import { expect, test } from "@playwright/test";

// One sentence to Pundit sets up the feed; the dashboard opens with Discover filling.
// Needs an account that has not finished setup: the provisioned live-acceptance account has,
// so this skips for it unless its profile is reset to onboarding_status 'not-started'.
test("new user reaches a populated workspace from one sentence to Pundit", async ({ page }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;
  test.skip(!email || !password, "Set E2E_TEST_EMAIL and E2E_TEST_PASSWORD for onboarding coverage.");

  await page.goto("/sign-in");
  await page.getByText("Use email instead", { exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email!);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password!);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/email") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  await expect(page).toHaveURL(/\/dashboard/);

  const question = page.getByRole("heading", { name: "What do you do, and who do you want to reach?" });
  const setupShown = await question.waitFor({ timeout: 15_000 }).then(() => true, () => false);
  test.skip(!setupShown, "This account has already finished setup; reset its profile to cover onboarding.");

  await page.getByRole("textbox", { name: "Message Pundit" })
    .fill("I lead product marketing at a SaaS company and write for B2B marketers in India about AI and go-to-market.");
  await page.getByRole("button", { name: "Set me up" }).click();
  await expect(page.getByRole("heading", { name: "Your feed is ready" })).toBeVisible({ timeout: 120_000 });

  await page.getByRole("button", { name: "Go to my dashboard", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(question).toHaveCount(0);
  await expect.poll(async () => {
    const response = await page.request.get("/api/inbox?status=active");
    return response.ok() ? (await response.json()).length : 0;
  }, { timeout: 150_000, intervals: [2_000, 5_000] }).toBeGreaterThan(0);
});
