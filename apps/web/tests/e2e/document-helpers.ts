import { expect, type Locator, type Page } from "@playwright/test";

export async function saveDocument(page: Page): Promise<void> {
  const save = page.getByRole("button", { name: "Save document", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "Document content" }),
  ).toBeVisible();
}

export function documentToolbar(page: Page): Locator {
  return page
    .getByLabel("Document page header", { exact: true })
    .getByRole("toolbar", { name: "Document formatting" });
}

export async function expectDocumentToolbar(page: Page): Promise<void> {
  await expect(
    page.getByRole("textbox", { name: "Document content" }),
  ).toBeVisible();
  await expect(documentToolbar(page)).toBeVisible();
}

const MORE = "More formatting options";

function menuEntry(page: Page, name: string | RegExp): Locator {
  const exact = typeof name === "string";
  return page
    .getByRole("menuitem", { name, exact })
    .or(page.getByRole("menuitemradio", { name, exact }))
    .or(page.getByRole("menuitemcheckbox", { name, exact }));
}

/** The visible toolbar button for `name`, or More when its group collapsed. */
export async function toolbarControl(
  page: Page,
  name: string | RegExp,
): Promise<Locator> {
  const toolbar = documentToolbar(page);
  const direct = toolbar.getByRole("button", {
    name,
    exact: typeof name === "string",
  });
  return (await direct.isVisible())
    ? direct
    : toolbar.getByRole("button", { name: MORE, exact: true });
}

/** Runs a command directly, through its `menu` trigger, or through More. */
export async function runToolbarCommand(
  page: Page,
  name: string,
  menu?: string | RegExp,
): Promise<void> {
  const control = await toolbarControl(page, menu ?? name);
  const collapsed = (await control.getAttribute("aria-label")) === MORE;
  await control.click();
  if (collapsed && menu !== undefined) await menuEntry(page, menu).click();
  if (collapsed || menu !== undefined) await menuEntry(page, name).click();
}
