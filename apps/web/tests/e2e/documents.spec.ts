import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";
import {
  documentToolbar,
  expectDocumentToolbar,
  runToolbarCommand,
  saveDocument,
  toolbarControl,
} from "./document-helpers";

async function createDirectEditFixture(page: Page, projectName: string) {
  await login(page, "owner@weaver.local");
  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill(projectName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Add member" }).click();
  const member = page.getByRole("dialog", { name: "Add member" });
  await member.getByLabel("Email").fill("viewer@weaver.local");
  await member.getByLabel("Role").click();
  await page.getByRole("option", { name: "Viewer", exact: true }).click();
  await member.getByRole("button", { name: "Add", exact: true }).click();
  await expect(member).toBeHidden();
  await page
    .getByRole("list", { name: `${projectName} sections` })
    .getByRole("link", { name: "Documents", exact: true })
    .click();
  await page.getByRole("button", { name: "New document" }).click();
  const create = page.getByRole("dialog", { name: "New document" });
  await create.getByLabel("Title").fill("Direct editing");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("[data-document-editor]")).toBeVisible();
  return page.url();
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`direct editing saves, discards, and stays read-only for Viewers on ${viewport.name}`, async ({
    page,
    browser,
  }, testInfo) => {
    const url = await createDirectEditFixture(
      page,
      `Direct edit ${viewport.name} E2E`,
    );
    await page.setViewportSize(viewport);
    await page.reload();
    const editor = page.getByRole("textbox", {
      name: "Document content",
      includeHidden: true,
    });
    const title = page.getByRole("textbox", { name: "Document title" });
    const save = page.getByRole("button", {
      name: "Save document",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await expect(editor).not.toBeFocused();
    await expect(title).not.toBeFocused();
    await expect(save).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Edit document" }),
    ).toHaveCount(0);
    const header = page.getByLabel("Document page header", { exact: true });
    const toolbar = header.getByRole("toolbar", {
      name: "Document formatting",
    });
    const workspace = page.getByRole("region", { name: "Document workspace" });
    const sourceRegion = workspace.getByRole("region", {
      name: "Markdown source",
      exact: true,
    });
    const source = sourceRegion.getByRole("textbox", {
      name: "Document Markdown source",
      exact: true,
    });
    const contextControls = header
      .getByLabel("Document context controls", { exact: true })
      .filter({ visible: true });
    await expectDocumentToolbar(page);
    await expect(
      workspace.getByRole("toolbar", { name: "Document formatting" }),
    ).toHaveCount(0);
    await expect(contextControls).toBeVisible();
    const toolbarBox = await toolbar.boundingBox();
    const contextBox = await contextControls.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(contextBox).not.toBeNull();
    expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(
      contextBox!.x + 1,
    );
    // Groups that do not fit collapse into More instead of scrolling.
    expect(
      await header.evaluate((element) =>
        Array.from(element.querySelectorAll<HTMLElement>("*")).every(
          (child) =>
            !["auto", "scroll"].includes(getComputedStyle(child).overflowX) ||
            child.scrollWidth <= child.clientWidth,
        ),
      ),
    ).toBe(true);
    await expect(
      toolbar.getByRole("button", {
        name: "More formatting options",
        exact: true,
      }),
    ).toHaveCount(viewport.name === "phone" ? 1 : 0);
    const originalToolbar = await toolbar.elementHandle();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`toolbar-default-${viewport.name}.png`),
    });
    await expect(
      page.getByRole("button", {
        name: "Hide formatting toolbar",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Show formatting toolbar",
        exact: true,
      }),
    ).toHaveCount(0);
    const sourceToggle = toolbar.getByRole("button", {
      name: "View Markdown source",
      exact: true,
    });
    await sourceToggle.focus();
    await sourceToggle.press("ControlOrMeta+Alt+e");
    await expect(toolbar).toBeVisible();
    await expect(sourceToggle).toBeFocused();
    await expect(save).toBeHidden();

    await title.focus();
    await expect(save).toBeHidden();
    await editor.focus();
    await expect(save).toBeHidden();
    await editor.press("ControlOrMeta+Alt+e");
    await expect(toolbar).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(save).toBeHidden();
    await editor.press("/");
    await expect(editor).toHaveText("/");
    await expect(
      page.getByRole("dialog", { name: "Insert or change block" }),
    ).toHaveCount(0);
    await editor.press("ControlOrMeta+z");
    await expect(editor).toBeEmpty();
    await expect(save).toBeHidden();

    const originalEditor = await editor.elementHandle();
    const longDraft = Array.from(
      { length: 80 },
      (_, index) => `Unsaved paragraph ${index + 1}: keep this document draft.`,
    ).join("\n");
    await editor.fill(longDraft);
    await expect(editor).toHaveText(longDraft, { useInnerText: true });
    await editor.press("ControlOrMeta+A");
    const selectedDraft = await page.evaluate(() =>
      window.getSelection()?.toString(),
    );
    expect(selectedDraft).toContain("Unsaved paragraph 80");
    await workspace.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => workspace.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(toolbar).toBeInViewport();
    await expect(sourceToggle).toBeInViewport();
    await expect(contextControls).toBeInViewport();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`toolbar-scrolled-${viewport.name}.png`),
    });

    if (viewport.name === "desktop") {
      await contextControls
        .getByRole("button", { name: "Collapse document context", exact: true })
        .click();
      const expandContext = contextControls.getByRole("button", {
        name: "Expand document context",
        exact: true,
      });
      await expect(expandContext).toBeVisible();
      await expect(toolbar).toBeInViewport();
      await expandContext.click();
      await expect(
        contextControls.getByRole("button", {
          name: "Collapse document context",
          exact: true,
        }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        contextControls.getByRole("button", { name: "Context", exact: true }),
      ).toBeInViewport();
      await expect(toolbar).toBeInViewport();
      await expect(editor).not.toBeFocused();
      await expect(editor).toHaveText(longDraft, { useInnerText: true });
      await expect(save).toBeEnabled();
      expect(
        await originalEditor.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(
        await originalToolbar.evaluate((element) => element.isConnected),
      ).toBe(true);
      await page.setViewportSize(viewport);
      await expect(
        contextControls.getByRole("button", {
          name: "Collapse document context",
          exact: true,
        }),
      ).toBeVisible();
      await expect(editor).not.toBeFocused();
    } else {
      await contextControls
        .getByRole("button", { name: "Context", exact: true })
        .click();
      const contextDrawer = page.getByRole("dialog", {
        name: "Document context",
        exact: true,
      });
      await expect(contextDrawer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(contextDrawer).toBeHidden();
    }

    await expectDocumentToolbar(page);
    await expect(editor).toHaveText(longDraft, { useInnerText: true });
    await expect(title).toHaveValue("Direct editing");
    await expect(save).toBeEnabled();
    expect(
      await originalEditor.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect(
      await originalToolbar.evaluate((element) => element.isConnected),
    ).toBe(true);
    await editor.focus();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe(selectedDraft);
    await workspace.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const formattedScroll = await workspace.evaluate(
      (element) => element.scrollTop,
    );
    expect(formattedScroll).toBeGreaterThan(0);
    await sourceToggle.click();
    await expect(sourceRegion).toBeVisible();
    await expect(
      workspace
        .getByRole("article")
        .getByRole("region", { name: "Markdown source", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Markdown source", exact: true }),
    ).toHaveCount(0);
    await expect(editor).toBeHidden();
    expect(
      await originalEditor.evaluate((element) => element.isConnected),
    ).toBe(true);
    await expect(sourceRegion).toBeFocused();
    await expect(sourceRegion.getByRole("heading")).toHaveCount(0);
    await expect(sourceRegion.getByRole("button")).toHaveCount(0);
    await expect(source).not.toBeFocused();
    await expect(source).toBeEditable();
    const rawLayout = await source.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        borderWidth: style.borderTopWidth,
        background: style.backgroundColor,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      };
    });
    expect(rawLayout.borderWidth).toBe("0px");
    expect(rawLayout.background).toBe("rgba(0, 0, 0, 0)");
    expect(rawLayout.scrollHeight).toBeLessThanOrEqual(
      rawLayout.clientHeight + 1,
    );
    await expect(source).toHaveValue(
      /Unsaved paragraph 80: keep this document draft\./,
    );
    await expect(title).toBeVisible();
    await expect(save).toBeEnabled();
    await expect
      .poll(() => workspace.evaluate((element) => element.scrollTop))
      .toBe(0);
    const rawBeforeTitleEnter = await source.inputValue();
    await title.focus();
    await title.press("Enter");
    await expect(source).toBeFocused();
    await expect(sourceRegion).toBeVisible();
    await expect(source).toHaveValue(rawBeforeTitleEnter);
    await expect
      .poll(() =>
        source.evaluate(
          (element) => (element as HTMLTextAreaElement).selectionStart,
        ),
      )
      .toBe(0);
    await expect(save).toBeEnabled();
    const formattedToggle = toolbar.getByRole("button", {
      name: "View formatted document",
      exact: true,
    });
    await expect(formattedToggle).toHaveAttribute("aria-pressed", "true");
    // Table, Image, and Reference live in the Insert menu.
    for (const name of ["Bold", "Insert", "Undo", "Redo"]) {
      await expect(await toolbarControl(page, name)).toBeDisabled();
    }
    for (const control of await toolbar.getByRole("button").all()) {
      if (
        (await control.getAttribute("aria-label")) === "View formatted document"
      )
        continue;
      await expect(control).toBeDisabled();
    }
    if (viewport.name === "desktop") {
      await contextControls
        .getByRole("button", { name: "Collapse document context", exact: true })
        .click();
      await expect(sourceRegion).toBeVisible();
      await contextControls
        .getByRole("button", { name: "Expand document context", exact: true })
        .click();
    } else {
      await contextControls
        .getByRole("button", { name: "Context", exact: true })
        .click();
      const sourceContextDrawer = page.getByRole("dialog", {
        name: "Document context",
        exact: true,
      });
      await expect(sourceContextDrawer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sourceContextDrawer).toBeHidden();
    }
    await expect(sourceRegion).toBeVisible();
    await expect(source).toHaveValue(
      /Unsaved paragraph 80: keep this document draft\./,
    );
    const caretParagraph = "Unsaved paragraph 80: keep this document draft.";
    const beforeCaretEdit = await source.inputValue();
    const caretMarkdown = beforeCaretEdit.replace(
      caretParagraph,
      `__${caretParagraph}__`,
    );
    const savedCaretMarkdown = beforeCaretEdit.replace(
      caretParagraph,
      `**${caretParagraph}**`,
    );
    await source.fill(caretMarkdown);
    const caretPosition = caretMarkdown.indexOf(caretParagraph) + 11;
    await source.evaluate((element, position) => {
      (element as HTMLTextAreaElement).setSelectionRange(position, position);
    }, caretPosition);
    await source.press("ControlOrMeta+s");
    await expect(save).toBeHidden();
    await expect(source).toBeFocused();
    await expect(source).toHaveValue(savedCaretMarkdown);
    await expect
      .poll(() =>
        source.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return { start: input.selectionStart, end: input.selectionEnd };
        }),
      )
      .toEqual({ start: caretPosition, end: caretPosition });
    await expect(sourceRegion).toBeVisible();
    await expect(editor).toBeHidden();
    await formattedToggle.click();
    await expect(sourceRegion).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText(longDraft, { useInnerText: true });
    await expect(save).toBeHidden();
    await expect
      .poll(() =>
        workspace.evaluate(
          (element, previousScroll) =>
            element.scrollTop -
            Math.min(
              previousScroll,
              element.scrollHeight - element.clientHeight,
            ),
          formattedScroll,
        ),
      )
      .toBe(0);
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe(selectedDraft);
    await expect(await toolbarControl(page, "Bold")).toBeEnabled();

    await title.fill("Saved direct editing");
    await editor.fill("Select and format this text");
    await editor.press("ControlOrMeta+A");
    await runToolbarCommand(page, "Bold");
    await expect(editor.locator("strong")).toHaveText(
      "Select and format this text",
    );
    await page
      .getByRole("button", { name: "View Markdown source", exact: true })
      .click();
    await expect(sourceRegion).toBeFocused();
    await expect(source).not.toBeFocused();
    await expect(source).toBeEditable();
    await expect(source).toHaveValue("**Select and format this text**\n");
    await expect(editor).toBeHidden();
    await expect(save).toBeEnabled();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`markdown-source-${viewport.name}.png`),
    });
    await source.focus();
    await source.dispatchEvent("keydown", {
      key: "Escape",
      code: "Escape",
      isComposing: true,
    });
    await expect(sourceRegion).toBeVisible();
    await expect(source).toBeFocused();
    await title.fill("Unsaved source title");
    await expect(source).toHaveValue("**Select and format this text**\n");
    await title.fill("Saved direct editing");
    const invalidMarkdown = "![bad](data:image/png;base64,AAAA)";
    await source.fill(invalidMarkdown);
    await save.click();
    const sourceError = page.getByRole("alert").filter({
      hasText: "Markdown contains content that cannot be saved.",
    });
    await expect(sourceError).toBeVisible();
    await expect(source).toHaveValue(invalidMarkdown);
    await expect(source).toBeEditable();
    await expect(save).toBeEnabled();
    await formattedToggle.click();
    await expect(sourceRegion).toBeVisible();
    await expect(source).toHaveValue(invalidMarkdown);
    await expect(sourceError).toBeVisible();
    await source.fill("__Edited in Markdown__\n\n");
    await expect(save).toBeEnabled();
    const currentMarkdown = await source.inputValue();
    await source.focus();
    await source.press("ControlOrMeta+Alt+s");
    await expect(sourceRegion).toBeHidden();
    await expect(editor.locator("strong")).toHaveText("Edited in Markdown");
    await expect(save).toBeEnabled();
    expect(
      await originalEditor.evaluate((element) => element.isConnected),
    ).toBe(true);
    await editor.press("ControlOrMeta+A");
    await editor.press("ControlOrMeta+Alt+s");
    await expect(sourceRegion).toBeVisible();
    await expect(source).toHaveValue(currentMarkdown);
    await source.focus();
    await source.press("Escape");
    await expect(sourceRegion).toBeVisible();
    await expect(source).not.toBeFocused();
    await expect(source).toHaveValue(currentMarkdown);
    await formattedToggle.click();
    await expect(sourceRegion).toBeHidden();
    await expect(editor).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString().trim()))
      .toBe("Edited in Markdown");
    if (viewport.name === "phone") {
      for (const action of [
        save,
        page.getByRole("button", { name: "Discard changes", exact: true }),
      ]) {
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }
    }
    await editor.press("ControlOrMeta+s");
    await expect(save).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(
      page.getByText("Document saved", { exact: true }).last(),
    ).toBeVisible();
    await expect(title).toHaveValue("Saved direct editing");
    await expect(editor.locator("strong")).toHaveText("Edited in Markdown");
    await expect(
      page.getByRole("dialog", { name: "Save document" }),
    ).toHaveCount(0);
    expect(
      await originalEditor.evaluate((element) => element.isConnected),
    ).toBe(true);

    await editor.press("ControlOrMeta+z");
    await expect(save).toBeEnabled();
    await editor.press("ControlOrMeta+Shift+z");
    await expect(save).toBeHidden();
    await title.fill("Unsaved title");
    await editor.fill("Unsaved body");
    await editor.press("Escape");
    await expect(editor).not.toBeFocused();
    await expect(editor).toHaveText("Unsaved body");
    await expect(editor.locator("strong")).toHaveText("Unsaved body");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await sourceToggle.click();
    await expect(sourceRegion).toBeVisible();
    await expect(source).toHaveValue("**Unsaved body**\n");
    await source.fill("**Unsaved raw body**\n");
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    const discard = page.getByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    await discard.getByRole("button", { name: "Keep editing" }).click();
    await expect(discard).toBeHidden();
    await expect(sourceRegion).toBeVisible();
    await expect(source).toHaveValue("**Unsaved raw body**\n");
    await expect(title).toHaveValue("Unsaved title");
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await discard
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(title).toHaveValue("Saved direct editing");
    await expect(discard).toBeHidden();
    await expect(sourceRegion).toBeVisible();
    await expect(source).toHaveValue("**Edited in Markdown**\n\n");
    await expect(save).toBeHidden();
    await expect(editor).toBeHidden();
    await formattedToggle.click();
    await expect(sourceRegion).toBeHidden();
    await expect(editor.locator("strong")).toHaveText("Edited in Markdown");
    await expect(save).toBeHidden();
    await editor.press("ControlOrMeta+z");
    await expect(save).toBeHidden();
    await expect(editor).toHaveText("Edited in Markdown");
    expect(
      await originalEditor.evaluate((element) => element.isConnected),
    ).toBe(true);
    await originalEditor.dispose();
    expect(
      await originalToolbar.evaluate((element) => element.isConnected),
    ).toBe(true);
    await originalToolbar.dispose();

    const viewerContext = await browser.newContext({ viewport });
    const viewer = await viewerContext.newPage();
    await login(viewer, "viewer@weaver.local");
    await viewer.goto(url);
    const article = viewer.getByRole("article");
    await expect(
      article.getByRole("heading", { name: "Saved direct editing" }),
    ).toBeVisible();
    await expect(article.locator("strong")).toHaveText("Edited in Markdown");
    await expect(
      viewer.getByRole("textbox", { name: "Document content" }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("textbox", { name: "Document title" }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Save document" }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("toolbar", { name: "Document formatting" }),
    ).toHaveCount(0);
    const viewerSourceButton = viewer.getByRole("button", {
      name: "View Markdown source",
      exact: true,
    });
    const originalViewerBody = await article.locator("strong").elementHandle();
    await viewerSourceButton.click();
    const viewerSource = viewer
      .getByRole("region", { name: "Document workspace" })
      .getByRole("article")
      .getByRole("region", { name: "Markdown source", exact: true });
    const viewerSourceText = viewerSource.getByRole("textbox", {
      name: "Document Markdown source",
      exact: true,
    });
    await expect(
      viewer.getByRole("dialog", { name: "Markdown source", exact: true }),
    ).toHaveCount(0);
    await expect(article.locator("strong")).toBeHidden();
    expect(
      await originalViewerBody.evaluate((element) => element.isConnected),
    ).toBe(true);
    await expect(
      article.getByRole("heading", { name: "Saved direct editing" }),
    ).toBeVisible();
    await expect(viewerSource).toBeFocused();
    await expect(viewerSource.getByRole("heading")).toHaveCount(0);
    await expect(viewerSource.getByRole("button")).toHaveCount(0);
    await expect(viewerSourceText).not.toBeFocused();
    await expect(viewerSourceText).toHaveValue("**Edited in Markdown**\n\n");
    await expect(viewerSourceText).toHaveAttribute("readonly", "");
    await viewerSourceText.focus();
    await viewerSourceText.press("ControlOrMeta+Alt+s");
    await expect(viewerSource).toBeHidden();
    await expect(viewerSourceButton).toBeFocused();
    await viewerSourceButton.press("ControlOrMeta+Alt+s");
    await expect(viewerSource).toBeVisible();
    await viewerSourceText.focus();
    await viewerSourceText.press("Escape");
    await expect(viewerSource).toBeVisible();
    await expect(viewerSourceText).not.toBeFocused();
    await viewer
      .getByRole("button", { name: "View formatted document", exact: true })
      .click();
    await expect(viewerSource).toBeHidden();
    await expect(viewerSourceButton).toBeFocused();
    await expect(article.locator("strong")).toHaveText("Edited in Markdown");
    await originalViewerBody.dispose();
    await viewer.keyboard.press("e");
    await expect(viewer.locator("[contenteditable=true]")).toHaveCount(0);
    await article.getByRole("button", { name: "Document actions" }).click();
    await expect(
      viewer.getByRole("menuitem", { name: "Explore graph" }),
    ).toBeVisible();
    await viewerContext.close();
  });
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`Contents lists live headings and jumps to sections on ${viewport.name}`, async ({
    page,
  }) => {
    await createDirectEditFixture(page, `Contents ${viewport.name} E2E`);
    await page.setViewportSize(viewport);
    await page.reload();
    const workspace = page.getByRole("region", { name: "Document workspace" });
    const editor = page.getByRole("textbox", { name: "Document content" });
    const toolbar = documentToolbar(page);
    const source = workspace.getByRole("textbox", {
      name: "Document Markdown source",
      exact: true,
    });
    const filler = (section: string) =>
      Array.from(
        { length: 14 },
        (_, index) => `${section} paragraph ${index + 1}.`,
      ).join("\n\n");
    await expect(editor).toBeVisible();
    await toolbar
      .getByRole("button", { name: "View Markdown source", exact: true })
      .click();
    await source.fill(
      [
        "## Overview",
        filler("Overview"),
        "### Scope",
        filler("Scope"),
        "## Deployment",
        filler("Deployment"),
        "## Appendix",
        filler("Appendix"),
      ].join("\n\n") + "\n",
    );
    await toolbar
      .getByRole("button", { name: "View formatted document", exact: true })
      .click();
    await expect(editor).toBeVisible();

    const openContext = async () => {
      if (viewport.name === "phone")
        await page
          .getByRole("button", { name: "Context", exact: true })
          .click();
    };
    const context = page.getByRole("complementary", {
      name: "Document context",
    });
    const contents = context.getByRole("navigation", {
      name: "Table of contents",
    });
    const stickyTitle = page.locator("[data-document-editor] > header");
    const expectAtTop = async (name: string) => {
      const heading = editor.getByRole("heading", { name, exact: true });
      await expect(heading).toBeInViewport();
      await expect
        .poll(async () => {
          const [box, title] = await Promise.all([
            heading.boundingBox(),
            stickyTitle.boundingBox(),
          ]);
          return box!.y - (title!.y + title!.height);
        })
        .toBeGreaterThanOrEqual(0);
      await expect
        .poll(async () => {
          const [box, title] = await Promise.all([
            heading.boundingBox(),
            stickyTitle.boundingBox(),
          ]);
          return box!.y - (title!.y + title!.height);
        })
        .toBeLessThan(40);
    };

    await openContext();
    await expect(
      context.getByRole("tab", { name: "Contents", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    // Unsaved headings are listed straight from the editor.
    await expect(contents.getByRole("button")).toHaveText([
      "Overview",
      "Scope",
      "Deployment",
      "Appendix",
    ]);
    await contents.getByRole("button", { name: "Deployment" }).click();
    if (viewport.name === "phone")
      await expect(
        page.getByRole("dialog", { name: "Document context" }),
      ).toBeHidden();
    await expectAtTop("Deployment");

    if (viewport.name === "desktop") {
      await expect(
        contents.getByRole("button", { name: "Deployment" }),
      ).toHaveAttribute("aria-current", "location");
      await workspace.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(contents.locator("[aria-current]")).toHaveCount(0);
      await workspace.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(
        contents.getByRole("button", { name: "Appendix" }),
      ).toHaveAttribute("aria-current", "location");
    }

    // A jump from the Markdown source returns to the formatted document.
    await toolbar
      .getByRole("button", { name: "View Markdown source", exact: true })
      .click();
    await expect(source).toBeVisible();
    await openContext();
    await contents.getByRole("button", { name: "Scope" }).click();
    await expect(editor).toBeVisible();
    await expectAtTop("Scope");
    await saveDocument(page);
  });
}

test("drags the sidebar and the context rail to widths that survive a reload", async ({
  page,
}) => {
  await createDirectEditFixture(page, "Panel widths E2E");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const rail = page.getByRole("complementary", { name: "Document context" });
  const sidebar = page.getByRole("complementary", { name: "Primary" });
  const contextControls = page
    .getByLabel("Document context controls", { exact: true })
    .filter({ visible: true });
  const railHandle = page.getByRole("separator", {
    name: "Resize context panel",
  });
  const sidebarHandle = page.getByRole("separator", {
    name: "Resize sidebar",
  });
  const width = async (locator: Locator) =>
    Math.round((await locator.boundingBox())!.width);
  const drag = async (handle: Locator, distance: number) => {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + distance / 2, y);
    await page.mouse.move(x + distance, y);
    await page.mouse.up();
  };

  await expect(rail).toBeVisible();
  expect(await width(rail)).toBe(320);
  expect(await width(sidebar)).toBe(278);
  await drag(railHandle, -100);
  await expect.poll(() => width(rail)).toBe(420);
  expect(await width(contextControls)).toBe(420);
  await drag(sidebarHandle, 60);
  await expect.poll(() => width(sidebar)).toBe(338);

  await page.reload();
  await expect(rail).toBeVisible();
  expect(await width(rail)).toBe(420);
  expect(await width(sidebar)).toBe(338);
  await expect(railHandle).toHaveAttribute("aria-valuenow", "420");

  await railHandle.dblclick();
  await expect.poll(() => width(rail)).toBe(320);
  await sidebarHandle.focus();
  await sidebarHandle.press("ArrowLeft");
  await expect.poll(() => width(sidebar)).toBe(322);
});

test("create, link, version, restore, and render a document", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await login(page, "owner@weaver.local");

  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill("Documents E2E");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("list", { name: "Documents E2E sections" })
    .getByRole("link", { name: "Documents", exact: true })
    .click();

  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Name").fill("Guides");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // Creating a folder stays on the current level; open it explicitly.
  await page.getByRole("link", { name: "Guides", exact: true }).click();
  await expect(page).toHaveURL(/documents\?folder=guides$/);
  await expect(page.getByRole("heading", { name: "Guides" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Up", exact: true }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Title").fill("Overview");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document content" })
    .fill("First version");
  await expectDocumentToolbar(page);
  await runToolbarCommand(page, "Mermaid diagram", "Insert");
  await page.getByRole("button", { name: "Edit Mermaid source" }).click();

  const mermaidSource = page.getByRole("textbox", {
    name: "Mermaid source",
    exact: true,
  });
  await mermaidSource.fill("flowchart TD\n  A[Start] --><<");
  await expect(
    page.getByRole("alert").filter({
      hasText: "Diagram could not be rendered",
    }),
  ).toBeVisible();
  await mermaidSource.fill("flowchart TD\n  A[Start] --> B[End]");
  await expect(
    page.getByRole("img", { name: "Mermaid diagram" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Mermaid source" }).click();

  const editorTitle = page.getByRole("textbox", { name: "Document title" });
  const editorCanvas = page.getByRole("textbox", { name: "Document content" });
  const editorParagraph = page.getByText("First version", { exact: true });
  const [editorCanvasBox, editorParagraphBox, editorTitleTextX] =
    await Promise.all([
      editorCanvas.boundingBox(),
      editorParagraph.boundingBox(),
      editorTitle.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const paddingLeft = Number.parseFloat(
          window.getComputedStyle(element).paddingLeft,
        );
        return box.x + paddingLeft;
      }),
    ]);
  expect(editorCanvasBox).not.toBeNull();
  expect(editorParagraphBox).not.toBeNull();
  expect(editorCanvasBox!.width).toBeGreaterThan(800);
  expect(editorParagraphBox!.width).toBeGreaterThanOrEqual(
    editorCanvasBox!.width - 2,
  );
  expect(Math.abs(editorTitleTextX - editorCanvasBox!.x)).toBeLessThanOrEqual(
    2,
  );

  await saveDocument(page);

  const overview = page.getByRole("article");
  await expect(
    overview.getByRole("paragraph").filter({ hasText: /^First version$/ }),
  ).toBeVisible();
  await expect(
    overview.getByRole("img", { name: "Mermaid diagram" }),
  ).toBeVisible();
  const [articleBox, readerParagraphBox, readerDiagramBox] = await Promise.all([
    overview.boundingBox(),
    overview.getByText("First version", { exact: true }).boundingBox(),
    overview.getByRole("img", { name: "Mermaid diagram" }).boundingBox(),
  ]);
  expect(articleBox).not.toBeNull();
  expect(readerParagraphBox).not.toBeNull();
  expect(readerDiagramBox).not.toBeNull();
  expect(articleBox!.width).toBeGreaterThan(900);
  // Prose fills the canvas up to its 24px side padding, like code and diagrams.
  expect(readerParagraphBox!.width).toBeGreaterThanOrEqual(
    articleBox!.width - 60,
  );
  expect(readerDiagramBox!.width).toBeGreaterThan(800);

  await page
    .getByRole("button", { name: "View Markdown source", exact: true })
    .click();
  const navigationSource = page.getByRole("textbox", {
    name: "Document Markdown source",
    exact: true,
  });
  await navigationSource.fill("**Unsaved Back navigation**\n");
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  let discardPromptPromise = page.waitForEvent("dialog");
  let traversal = page.goBack();
  let discardPrompt = await discardPromptPromise;
  expect(discardPrompt.message()).toBe("Discard unsaved changes?");
  await discardPrompt.dismiss();
  await traversal;
  await expect(navigationSource).toHaveValue("**Unsaved Back navigation**\n");

  discardPromptPromise = page.waitForEvent("dialog");
  traversal = page.goBack();
  discardPrompt = await discardPromptPromise;
  await discardPrompt.accept();
  await traversal;
  await expect(
    page.getByRole("button", { name: "New document" }),
  ).toBeVisible();
  const explorer = page.getByRole("table", { name: "Documents and folders" });
  await expect(explorer.getByRole("link", { name: "Overview" })).toBeVisible();
  await page.getByRole("radio", { name: "Icons view" }).click();
  await expect(
    page
      .getByRole("list", { name: "Documents and folders" })
      .getByRole("link", { name: /Overview/ }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "List view" }).click();

  await page.goForward();
  await expect(
    page
      .getByRole("article")
      .getByRole("paragraph")
      .filter({ hasText: /^First version$/ }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "breadcrumb" })
    .getByRole("link", { name: "Documents", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New document" }),
  ).toBeVisible();
  await page.goBack();
  await page
    .getByRole("button", { name: "View Markdown source", exact: true })
    .click();
  await navigationSource.fill("**Unsaved Forward navigation**\n");
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();

  discardPromptPromise = page.waitForEvent("dialog");
  traversal = page.goForward();
  discardPrompt = await discardPromptPromise;
  expect(discardPrompt.message()).toBe("Discard unsaved changes?");
  await discardPrompt.dismiss();
  await traversal;
  await expect(navigationSource).toHaveValue(
    "**Unsaved Forward navigation**\n",
  );

  discardPromptPromise = page.waitForEvent("dialog");
  traversal = page.goForward();
  discardPrompt = await discardPromptPromise;
  await discardPrompt.accept();
  await traversal;
  await expect(
    page.getByRole("button", { name: "New document" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page
      .getByRole("article")
      .getByRole("paragraph")
      .filter({ hasText: /^First version$/ }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "History" }).click();
  await expect(
    page.getByRole("button", {
      name: /update: guides\/overview\.md/,
    }),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "breadcrumb" })
    .getByRole("button", { name: "Show contents of guides" })
    .click();
  await expect(page.getByRole("menuitem", { name: "Overview" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Overview" }).click();
  await expect(
    page
      .getByRole("article")
      .getByRole("paragraph")
      .filter({ hasText: /^First version$/ }),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "breadcrumb" })
    .getByRole("link", { name: "Documents", exact: true })
    .click();
  await page
    .getByRole("table", { name: "Documents and folders" })
    .getByRole("link", { name: "guides" })
    .click();
  await expect(page).toHaveURL(/documents\?folder=guides$/);
  await page.getByRole("button", { name: "Up", exact: true }).click();
  await expect(page).toHaveURL(/documents$/);

  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Title").fill("Related");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expectDocumentToolbar(page);
  await runToolbarCommand(page, "Reference", "Insert");
  // Leaving the closing menu with the pointer must not dismiss the picker.
  await page.mouse.move(1, 1, { steps: 4 });
  await expect(
    page.getByRole("combobox", { name: "Search documents" }),
  ).toBeFocused();
  await page
    .getByRole("combobox", { name: "Search documents" })
    .fill("Overview");
  await page.getByRole("option", { name: /^Overview/ }).click();

  await page
    .getByRole("button", { name: "View Markdown source", exact: true })
    .click();
  const relatedSource = page.getByRole("textbox", {
    name: "Document Markdown source",
    exact: true,
  });
  const referenceMarkdown = await relatedSource.inputValue();
  expect(referenceMarkdown).toContain("weaver://document/");
  const relatedMarkdown = [
    "## Markdown round trip",
    "",
    "**Written in Markdown**",
    "",
    "- First item",
    "- Second item",
    "",
    referenceMarkdown.trim(),
    "",
    "```mermaid",
    "flowchart TD",
    "  A[Raw source] --> B[Formatted view]",
    "```",
    "",
  ].join("\n");
  await relatedSource.fill(relatedMarkdown);
  await page
    .getByRole("button", { name: "View formatted document", exact: true })
    .click();
  const relatedArticle = page.getByRole("article");
  await expect(
    relatedArticle.getByRole("heading", {
      name: "Markdown round trip",
      level: 2,
    }),
  ).toBeVisible();
  await expect(relatedArticle.locator("strong")).toHaveText(
    "Written in Markdown",
  );
  await expect(relatedArticle.getByRole("listitem")).toHaveText([
    "First item",
    "Second item",
  ]);
  await expect(
    relatedArticle.getByRole("img", { name: "Mermaid diagram" }),
  ).toBeVisible();
  await expect(
    relatedArticle.getByRole("link", { name: "Overview", exact: true }),
  ).toBeVisible();
  await saveDocument(page);
  await page.reload();
  await expect(
    relatedArticle.getByRole("heading", {
      name: "Markdown round trip",
      level: 2,
    }),
  ).toBeVisible();
  await expect(
    relatedArticle.getByRole("img", { name: "Mermaid diagram" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View Markdown source", exact: true })
    .click();
  await expect(relatedSource).toHaveValue(/## Markdown round trip/);
  await expect(relatedSource).toHaveValue(/\*\*Written in Markdown\*\*/);
  await expect(relatedSource).toHaveValue(/weaver:\/\/document\//);
  await expect(relatedSource).toHaveValue(/```mermaid/);
  await page
    .getByRole("button", { name: "View formatted document", exact: true })
    .click();
  await expect(
    page
      .getByRole("article")
      .getByRole("link", { name: "Overview", exact: true }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "History" }).click();
  const savedRelatedVersion = page.getByRole("button", {
    name: /update: related\.md/,
  });
  const createdRelatedVersion = page.getByRole("button", {
    name: /create: related\.md/,
  });
  await expect(savedRelatedVersion).toBeVisible();
  await createdRelatedVersion.click();

  await expect(
    page.getByRole("heading", { name: "Version comparison" }),
  ).toBeVisible();
  await expect(page.getByLabel("Inline document diff")).toContainText(
    "Overview",
  );
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expect(
    page.getByText("creates a new version", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore version" }).click();
  await expect(page.getByText("Version restored")).toBeVisible();

  await expect(
    page.getByRole("button", {
      name: /restore: related\.md \(from [0-9a-f]{7}\)/,
    }),
  ).toBeDisabled();
  await expect(savedRelatedVersion).toBeVisible();
  await expect(createdRelatedVersion).toBeVisible();
});

test("uploads an image into a document and renders it in the reader", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await login(page, "owner@weaver.local");

  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill("Document Images E2E");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("list", { name: "Document Images E2E sections" })
    .getByRole("link", { name: "Documents", exact: true })
    .click();

  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Title").fill("Illustrated");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expectDocumentToolbar(page);
  await runToolbarCommand(page, "Image", "Insert");
  await page.getByLabel("Upload image", { exact: true }).setInputFiles({
    name: "Cover Art.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(page.getByText("Image added")).toBeVisible();

  await page
    .getByRole("button", { name: "View Markdown source", exact: true })
    .click();
  const imageSource = page.getByRole("textbox", {
    name: "Document Markdown source",
    exact: true,
  });
  const originalImageMarkdown = await imageSource.inputValue();
  expect(originalImageMarkdown).toContain("illustrated.assets/cover-art.png");
  await imageSource.fill(
    originalImageMarkdown.replace("Cover Art", "Raw image alt"),
  );
  await page
    .getByRole("button", { name: "View formatted document", exact: true })
    .click();
  await saveDocument(page);
  await page.reload();

  const image = page.getByRole("article").getByRole("img", {
    name: "Raw image alt",
  });
  await expect(image).toBeVisible();
  const src = await image.getAttribute("src");
  expect(src).toMatch(
    /^\/api\/projects\/[0-9a-f-]{36}\/files\/illustrated\.assets\/cover-art\.png$/,
  );
  const response = await page.request.get(src!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");

  const editor = page.getByRole("textbox", { name: "Document content" });
  await editor.locator("p").last().click();
  await page.keyboard.type("Image caption");
  await expect(image).toBeVisible();
  await page
    .getByRole("textbox", { name: "Document title" })
    .fill("Renamed illustrated");
  await saveDocument(page);
  await expect(image).toHaveAttribute(
    "src",
    /\/renamed-illustrated\.assets\/cover-art\.png$/,
  );
  const renamed = await page.request.get((await image.getAttribute("src"))!);
  expect(renamed.status()).toBe(200);
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("Image caption");
  await expect(image).toHaveAttribute(
    "src",
    /\/renamed-illustrated\.assets\/cover-art\.png$/,
  );
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Discard unsaved changes?" })
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(editor).toContainText("Image caption");
});

test("renames from the explorer and imports dropped Markdown files", async ({
  page,
}) => {
  await login(page, "owner@weaver.local");
  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill("Explorer import E2E");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("list", { name: "Explorer import E2E sections" })
    .getByRole("link", { name: "Documents", exact: true })
    .click();

  const dropZone = page.getByTestId("documents-drop-zone");
  const transfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File(
        ['---\ntitle: "Dropped guide"\n---\n\n# Dropped\n\nBody text\n'],
        "dropped-guide.md",
        { type: "text/markdown" },
      ),
    );
    dt.items.add(new File(["plain"], "ignored.txt", { type: "text/plain" }));
    return dt;
  });
  await dropZone.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByText("Imported 1 document")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Dropped guide" });
  await expect(row).toBeVisible();
  await expect(
    row.getByRole("img", { name: /^Index: keyword (pending|ready)/ }),
  ).toBeVisible();

  await row.getByRole("button", { name: "Actions for Dropped guide" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename document" });
  await dialog.getByLabel("Title").fill("Renamed guide");
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByText("Document renamed")).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Renamed guide" }),
  ).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: "Renamed guide" })
    .getByRole("link", { name: /Renamed guide/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Document content" }),
  ).toContainText("Body text");
});

test("exports a document as PDF from the header", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await login(page, "owner@weaver.local");

  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill("PDF Export E2E");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("list", { name: "PDF Export E2E sections" })
    .getByRole("link", { name: "Documents", exact: true })
    .click();

  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Title").fill("Printable");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expectDocumentToolbar(page);

  await page.getByRole("button", { name: "Document actions" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Export as PDF" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("printable.pdf");
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
});
