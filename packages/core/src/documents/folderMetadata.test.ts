import { describe, expect, it } from "vitest";

import {
  composeFolderMetadata,
  composeRootFolderMetadata,
  folderMetadataPath,
  isFolderMarkerFile,
  newFolderMetadata,
  normalizeFolderName,
  parseFolderMetadata,
  parseRootFolderMetadata,
} from "./folderMetadata";

describe("folder metadata", () => {
  const author = { id: "7b0d5f0e-6a51-4d1c-9a43-1f1c6f0c8a11", name: "Ada" };

  const ref = { type: "user" as const, id: author.id, name: author.name };
  const refs = [ref];

  it("preserves a stable canonical identity independently of name and stamps", () => {
    const id = "901b91dd-7484-4f7f-a695-7b228232b005";
    const meta = newFolderMetadata(
      "Audit",
      author,
      new Date("2026-10-13T00:00:00.000Z"),
      id,
    );
    expect(meta.id).toBe(id);
    expect(
      parseFolderMetadata(
        composeFolderMetadata({ ...meta, name: "Renamed audit" }),
      )?.id,
    ).toBe(id);
    expect(
      parseFolderMetadata('{"name":"Audit","id":"broken"}'),
    ).not.toHaveProperty("id");
    expect(
      parseRootFolderMetadata(JSON.stringify({ name: "Root", id })),
    ).toEqual({});
  });

  it("root_defaults_do_not_create_a_visible_folder", () => {
    const text = '{"reviewDefaults":{"reviewers":[]}}';
    expect(parseRootFolderMetadata(text)).toEqual({
      reviewDefaults: { reviewers: [] },
    });
    expect(parseFolderMetadata(text)).toBeNull();
    expect(
      composeRootFolderMetadata({ reviewDefaults: { reviewers: refs } }),
    ).toBe(
      `${JSON.stringify({ reviewDefaults: { reviewers: refs } }, null, 2)}\n`,
    );
    expect(
      parseRootFolderMetadata(
        '{"name":"Root","appearance":{"backgroundColor":"#112233"},"created":"2026-10-08T00:00:00.000Z","reviewDefaults":{"reviewers":[]}}',
      ),
    ).toEqual({ reviewDefaults: { reviewers: [] } });
    expect(parseRootFolderMetadata("{}")).toEqual({});
    expect(composeRootFolderMetadata({})).toBe("{}\n");
    for (const text of ["no json", "null", "[]", "1"])
      expect(parseRootFolderMetadata(text)).toBeNull();
  });

  it("default_roundtrip_preserves_appearance_and_stamps", () => {
    const meta = {
      ...newFolderMetadata(
        "Guides",
        author,
        new Date("2026-10-08T09:00:00.000Z"),
      ),
      appearance: { backgroundColor: "#112233" },
      reviewDefaults: { reviewers: refs },
    };
    expect(parseFolderMetadata(composeFolderMetadata(meta))).toEqual(meta);
    expect(
      parseFolderMetadata(
        composeFolderMetadata({ ...meta, reviewDefaults: { reviewers: [] } }),
      ),
    ).toEqual({ ...meta, reviewDefaults: { reviewers: [] } });
  });

  it("canonicalizes_defaults_and_drops_unusable_optional_defaults", () => {
    const group = {
      type: "group" as const,
      id: "7b0d5f0e-6a51-4d1c-9a43-1f1c6f0c8a12",
      name: "Editors",
    };
    const reviewDefaults = { reviewers: [ref, group, ref] };
    const parsed = parseFolderMetadata(
      JSON.stringify({ name: "Guides", reviewDefaults }),
    );
    expect(parsed?.reviewDefaults).toEqual({ reviewers: [group, ref] });
    expect(
      JSON.parse(
        composeFolderMetadata({
          ...newFolderMetadata(
            "Guides",
            author,
            new Date("2026-10-08T09:00:00.000Z"),
          ),
          reviewDefaults,
        }),
      ),
    ).toMatchObject({ reviewDefaults: { reviewers: [group, ref] } });
    const invalid = [
      null,
      [],
      {},
      { reviewers: null },
      { reviewers: "bad" },
      { reviewers: [{ ...ref, type: "team" }] },
      { reviewers: [{ ...ref, id: "bad" }] },
      { reviewers: [{ ...ref, id: author.id.toUpperCase() }] },
      { reviewers: [{ ...ref, name: " Ada " }] },
      { reviewers: [{ ...ref, name: "a\nb" }] },
      { reviewers: [{ ...ref, name: "" }] },
      { reviewers: [{ ...ref, name: "x".repeat(201) }] },
      { reviewers: [null] },
      { reviewers: Array.from({ length: 51 }, () => ref) },
    ];
    for (const reviewDefaults of invalid) {
      expect(
        parseFolderMetadata(JSON.stringify({ name: "Guides", reviewDefaults })),
      ).toEqual(parseFolderMetadata('{"name":"Guides"}'));
      expect(
        parseRootFolderMetadata(JSON.stringify({ reviewDefaults })),
      ).toEqual({});
    }
    expect(
      parseFolderMetadata(JSON.stringify({ name: " ", reviewDefaults })),
    ).toBeNull();
  });

  it("roundtrips_legacy_and_styled_document_folder_table", () => {
    const legacy = newFolderMetadata(
      "Guides",
      author,
      new Date("2026-10-06T09:50:37.000Z"),
    );
    expect(
      parseFolderMetadata(composeFolderMetadata(legacy)),
    ).not.toHaveProperty("appearance");
    const styled = {
      ...legacy,
      appearance: {
        backgroundColor: "#AABBCC",
        icon: { type: "builtin" as const, name: "book-open" as const },
      },
    };
    expect(parseFolderMetadata(composeFolderMetadata(styled))).toEqual({
      ...styled,
      appearance: { ...styled.appearance, backgroundColor: "#aabbcc" },
    });
  });
  it("drops_bad_optional_appearance_without_dropping_content", () => {
    const legacy = parseFolderMetadata('{"name":"Guides"}');
    expect(
      parseFolderMetadata(
        '{"name":"Guides","appearance":{"icon":{"type":"emoji","value":"😀😀"}}}',
      ),
    ).toEqual(legacy);
    expect(composeFolderMetadata({ ...legacy!, appearance: {} })).toBe(
      composeFolderMetadata(legacy!),
    );
  });
  it("round-trips the name and stamps through the committed file", () => {
    const meta = newFolderMetadata(
      "Implementation Plans",
      author,
      new Date("2026-10-06T09:50:37.000Z"),
    );
    const text = composeFolderMetadata(meta);
    expect(JSON.parse(text)).toEqual({
      id: meta.id,
      name: "Implementation Plans",
      created: "2026-10-06T09:50:37.000Z",
      createdBy: author,
      updated: "2026-10-06T09:50:37.000Z",
      updatedBy: author,
    });
    expect(parseFolderMetadata(text)).toEqual(meta);
  });

  it("reads a name-only file and drops unreadable stamps", () => {
    const unstamped = {
      name: "Guides",
      created: null,
      createdBy: null,
      updated: null,
      updatedBy: null,
    };
    expect(parseFolderMetadata('{"name": "Guides"}')).toEqual(unstamped);
    expect(composeFolderMetadata(unstamped)).toBe('{\n  "name": "Guides"\n}\n');
    expect(
      parseFolderMetadata(
        '{"name": "Guides", "created": "yesterday", "createdBy": {"id": 3, "name": "x"}, "updatedBy": {"id": null, "name": "a\\nb"}}',
      ),
    ).toEqual(unstamped);
  });

  it("rejects malformed, empty, multi-line, and oversized names", () => {
    expect(parseFolderMetadata("not json")).toBeNull();
    expect(parseFolderMetadata("[]")).toBeNull();
    expect(parseFolderMetadata('{"name": 3}')).toBeNull();
    expect(parseFolderMetadata('{"name": "  "}')).toBeNull();
    expect(parseFolderMetadata('{"name": "a\\nb"}')).toBeNull();
    expect(normalizeFolderName("x".repeat(121))).toBeNull();
    expect(normalizeFolderName("  Guides  ")).toBe("Guides");
  });

  it("places the file inside the folder and treats it as a marker", () => {
    expect(folderMetadataPath("guides/setup")).toBe(
      "guides/setup/.folder.json",
    );
    expect(folderMetadataPath("")).toBe(".folder.json");
    expect(isFolderMarkerFile(".gitkeep")).toBe(true);
    expect(isFolderMarkerFile(".folder.json")).toBe(true);
    expect(isFolderMarkerFile("notes.md")).toBe(false);
  });
});
