import { expect, type Page } from "@playwright/test";

/**
 * A browser opened after setup was done elsewhere has no tour progress: the guide stays closed and
 * the page stays where it was opened, instead of moving to Settings → Integrations.
 */
export async function expectNoTourOnNewDevice(page: Page) {
  const opened = new URL(page.url()).pathname;
  await expect(page.getByRole("main").first()).toBeVisible();
  // The tour decides once the profile has loaded; leave time for it to open or move the page if it would.
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("dialog-app-tour")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(opened);
}

/** App tour in the Help panel (both layouts), as a user on a new device opens it: it starts at Connect an account. */
export async function openTourFromHelp(page: Page) {
  await page.getByTestId("button-navbar-help").click();
  await page.getByTestId("button-help-app-tour").click();
  await expect(page.getByTestId("dialog-app-tour").getByRole("heading", { name: "Connect an account (optional)", exact: true })).toBeVisible();
}

export async function skipFirstWorkspaceTour(page: Page) {
  const origin = new URL(page.url()).origin;
  await expect(page).toHaveURL(url => url.origin === origin && url.pathname === "/dashboard/settings"
    && url.searchParams.get("tab") === "integrations");
  await expect(page.getByRole("tab", { name: "integrations", exact: true })).toHaveAttribute("aria-selected", "true");
  const tour = page.getByTestId("dialog-app-tour");
  await expect(tour.getByRole("heading", { name: "Connect an account (optional)", exact: true })).toBeVisible();
  await expect(page.getByTestId("app-tour-arrow")).toBeVisible();
  await tour.getByRole("button", { name: "Skip tour", exact: true }).press("Enter");
  await expect(tour).toHaveCount(0);
}
