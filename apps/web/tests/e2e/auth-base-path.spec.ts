import { expect, test } from "@playwright/test";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

test.describe("authentication with a base path", () => {
  test.skip(basePath !== "/knowledge", "requires the /knowledge build");

  test("keeps browser auth requests under the application base path", async ({
    page,
  }) => {
    const authRequestPaths: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.includes("/api/auth/")) authRequestPaths.push(pathname);
    });

    await page.goto(`${basePath}/login`);
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");

    await page.getByLabel("Email").fill("admin@weaver.local");
    await page.getByLabel("Password").fill("admin1234567");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(
      new RegExp(`${basePath}/projects/[0-9a-f-]{36}/documents$`),
    );

    await page.getByRole("button", { name: "User menu" }).first().click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`${basePath}/login`);

    expect(authRequestPaths).toContain(`${basePath}/api/auth/sign-in/email`);
    expect(authRequestPaths).toContain(`${basePath}/api/auth/sign-out`);
    expect(authRequestPaths.length).toBeGreaterThan(0);
    expect(
      authRequestPaths.every((pathname) =>
        pathname.startsWith(`${basePath}/api/auth/`),
      ),
    ).toBe(true);
  });

  test("returns to the requested account page after sign-in", async ({
    page,
  }) => {
    await page.goto(`${basePath}/account/api-keys`);
    await expect(page).toHaveURL(/\/knowledge\/login\?callbackUrl=/);
    expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe(
      "/account/api-keys",
    );
    await page.getByLabel("Email").fill("admin@weaver.local");
    await page.getByLabel("Password").fill("admin1234567");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${basePath}/account/api-keys`);
    await expect(
      page.getByRole("heading", { name: "API keys", exact: true }),
    ).toBeVisible();
  });
});
