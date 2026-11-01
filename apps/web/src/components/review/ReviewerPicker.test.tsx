import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { ReviewerPicker } from "./ReviewerPicker";

const options = [
  { type: "group", id: "g1", label: "Legal", detail: "Group · 2 members" },
  { type: "user", id: "u1", label: "Ada", detail: "ada@example.test" },
] as const;

const gone = { type: "user", id: "gone", name: "Old Owner" } as const;

it("renders one labelled checkbox per option with the selection checked", () => {
  const html = renderToStaticMarkup(
    <ReviewerPicker
      options={[...options]}
      value={[{ type: "user", id: "u1" }]}
      onChange={vi.fn()}
    />,
  );
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).toMatch(
    /<label[^>]*><input[^>]*checked=""[^>]*\/><span[^>]*><span[^>]*>Ada<\/span><span[^>]*>ada@example\.test<\/span>/,
  );
  expect(html).toContain("Group · 2 members");
});

it("disables every control when disabled", () => {
  const html = renderToStaticMarkup(
    <ReviewerPicker
      options={[...options]}
      value={[]}
      onChange={vi.fn()}
      disabled
      unresolved={[gone]}
    />,
  );
  for (const input of html.match(/<input[^>]*>/g) ?? [])
    expect(input).toContain('disabled=""');
  expect(html).toMatch(/<button[^>]*disabled/);
});

it("lists unresolved entries with a named remove button", () => {
  const html = renderToStaticMarkup(
    <ReviewerPicker
      options={[]}
      value={[]}
      onChange={vi.fn()}
      unresolved={[gone]}
      onRemoveUnresolved={vi.fn()}
    />,
  );
  expect(html).toContain("Old Owner");
  expect(html).toContain("no longer in this project");
  expect(html).toContain('aria-label="Remove Old Owner"');
});
