import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { DocumentImage } from "./document-image";

const schema = getSchema(
  documentExtensions({
    image: DocumentImage.configure({
      resolveSrc: (src) => `/api/projects/p/files/${src}`,
    }),
  }),
);
const rendered = (attrs: Record<string, unknown>) => {
  const node = schema.nodes.image!.create(attrs);
  const [tag, htmlAttrs] = schema.nodes.image!.spec.toDOM!(node) as unknown as [
    string,
    Record<string, unknown>,
  ];
  return { tag, htmlAttrs };
};
const parsed = (attrs: Record<string, string>) =>
  schema.nodes.image!.spec.parseDOM![0]!.getAttrs!({
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
  } as unknown as HTMLElement);

describe("DocumentImage clipboard HTML", () => {
  it("copies an image with its stored source and width", () => {
    const { tag, htmlAttrs } = rendered({
      src: "guide.assets/a.png",
      alt: "A",
      width: 300,
    });
    expect(tag).toBe("img");
    expect(htmlAttrs).toMatchObject({
      src: "/api/projects/p/files/guide.assets/a.png",
      "data-weaver-src": "guide.assets/a.png",
      alt: "A",
      width: 300,
    });
  });

  it("copies an image without a width without a width attribute", () => {
    const { htmlAttrs } = rendered({ src: "guide.assets/a.png" });
    expect(htmlAttrs.width ?? null).toBeNull();
  });

  it("pastes that HTML back with the stored source and width", () => {
    const { htmlAttrs } = rendered({
      src: "guide.assets/a.png",
      alt: "A",
      width: 300,
    });
    const strings = Object.fromEntries(
      Object.entries(htmlAttrs)
        .filter(([, value]) => value != null)
        .map(([name, value]) => [name, String(value)]),
    );
    expect(parsed(strings)).toMatchObject({
      src: "guide.assets/a.png",
      alt: "A",
      width: 300,
    });
  });

  it("takes no width from an image that no document rendered", () => {
    expect(parsed({ src: "https://example.com/a.png", width: "300" })).toEqual({
      src: "https://example.com/a.png",
    });
  });
});
