import { describe, expect, it } from "vitest";
import { buildDocx, type DocxParagraphSpec } from "../testing/docxFixture";
import { readWordOutline } from "../word";

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22" /></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="CustomHeading">
    <w:pPr><w:outlineLvl w:val="0" /></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="BodyOverride">
    <w:basedOn w:val="CustomHeading" />
    <w:pPr><w:outlineLvl w:val="9" /></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="BodyChild">
    <w:basedOn w:val="BodyOverride" />
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:basedOn w:val="CustomHeading" />
    <w:pPr><w:outlineLvl w:val="9" /></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:basedOn w:val="BodyOverride" />
  </w:style>
</w:styles>`;

describe("explicit body outline levels", () => {
  it.each<{ name: string; paragraph: DocxParagraphSpec }>([
    {
      name: "a paragraph overriding a custom heading style",
      paragraph: { style: "CustomHeading", outlineLevel: 9 },
    },
    {
      name: "a paragraph overriding a Heading N style id",
      paragraph: { style: "Heading3", outlineLevel: 9 },
    },
    {
      name: "a style overriding its heading ancestor",
      paragraph: { style: "BodyOverride" },
    },
    {
      name: "a derived style inheriting a body override",
      paragraph: { style: "BodyChild" },
    },
    {
      name: "a Heading N style id with a body override",
      paragraph: { style: "Heading1" },
    },
    {
      name: "a Heading N style id inheriting a body override",
      paragraph: { style: "Heading2" },
    },
  ])("keeps $name in its existing chapter", async ({ paragraph }) => {
    const outline = await readWordOutline(
      await buildDocx({
        styles: STYLES,
        body: [
          { type: "heading", level: 3, text: "Real chapter" },
          { type: "paragraph", text: "Body paragraph", ...paragraph },
        ],
      }),
    );

    expect(outline.headingSource).toBe("styles");
    expect(
      outline.chapters.map(({ title, level, blockCount }) => ({
        title,
        level,
        blockCount,
      })),
    ).toEqual([{ title: "Real chapter", level: 3, blockCount: 2 }]);
  });

  it.each([
    { outlineLevel: 0, expectedLevel: 1 },
    { outlineLevel: 8, expectedLevel: 9 },
  ])(
    "allows paragraph level $outlineLevel to override an inherited body level",
    async ({ outlineLevel, expectedLevel }) => {
      const outline = await readWordOutline(
        await buildDocx({
          styles: STYLES,
          body: [
            {
              type: "paragraph",
              text: "Explicit heading",
              style: "BodyChild",
              outlineLevel,
            },
          ],
        }),
      );

      expect(outline.headingSource).toBe("styles");
      expect(
        outline.chapters.map(({ title, level }) => ({ title, level })),
      ).toEqual([{ title: "Explicit heading", level: expectedLevel }]);
    },
  );

  it.each<{ name: string; paragraph: DocxParagraphSpec }>([
    { name: "paragraph", paragraph: { outlineLevel: 9 } },
    { name: "derived style", paragraph: { style: "BodyChild" } },
    { name: "Heading N style", paragraph: { style: "Heading1" } },
  ])(
    "does not infer large or bold headings from a $name body level",
    async ({ paragraph }) => {
      const outline = await readWordOutline(
        await buildDocx({
          styles: STYLES,
          body: [
            { type: "paragraph", runs: [{ text: "First section", size: 32 }] },
            {
              type: "paragraph",
              ...paragraph,
              runs: [{ text: "Large body", size: 48 }],
            },
            {
              type: "paragraph",
              ...paragraph,
              runs: [{ text: "Bold body", size: 22, bold: true }],
            },
            ...Array.from({ length: 5 }, () => ({
              type: "paragraph" as const,
              text: "Ordinary prose that establishes the body font size.",
            })),
            { type: "paragraph", runs: [{ text: "Second section", size: 32 }] },
            ...Array.from({ length: 5 }, () => ({
              type: "paragraph" as const,
              text: "More ordinary prose in the second section.",
            })),
          ],
        }),
      );

      expect(outline.headingSource).toBe("inferred");
      expect(
        outline.chapters.map(({ title, level }) => ({ title, level })),
      ).toEqual([
        { title: "First section", level: 1 },
        { title: "Second section", level: 1 },
      ]);
    },
  );

  it.each<{ name: string; paragraph: DocxParagraphSpec }>([
    { name: "paragraph", paragraph: { outlineLevel: 9 } },
    { name: "derived style", paragraph: { style: "BodyChild" } },
  ])(
    "counts a $name body level in font-size and heading-share statistics",
    async ({ paragraph }) => {
      const outline = await readWordOutline(
        await buildDocx({
          styles: STYLES,
          body: [
            { type: "paragraph", runs: [{ text: "First section", size: 32 }] },
            ...Array.from({ length: 4 }, () => ({
              type: "paragraph" as const,
              ...paragraph,
              runs: [
                {
                  text: "Body prose with a font size different from the document default.",
                  size: 28,
                },
              ],
            })),
            { type: "paragraph", runs: [{ text: "Second section", size: 32 }] },
          ],
        }),
      );

      expect(outline.headingSource).toBe("inferred");
      expect(
        outline.chapters.map(({ title, level }) => ({ title, level })),
      ).toEqual([
        { title: "First section", level: 1 },
        { title: "Second section", level: 1 },
      ]);
    },
  );
});
