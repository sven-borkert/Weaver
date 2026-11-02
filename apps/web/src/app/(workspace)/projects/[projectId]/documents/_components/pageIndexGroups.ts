export type IndexPage = {
  id: string;
  title: string;
  path: string;
  type: string | null;
  summary: string | null;
};

export type IndexGroup = { key: string; label: string; pages: IndexPage[] };

/** Consecutive pages of one type share a group; the server sorts by type, so groups never split except at a page boundary. */
export function groupIndexPages(pages: IndexPage[]): IndexGroup[] {
  const groups: IndexGroup[] = [];
  for (const page of pages) {
    const label = page.type?.trim() ?? "";
    const key = label.toLowerCase();
    const last = groups.at(-1);
    if (last?.key === key) last.pages.push(page);
    else
      groups.push({
        key,
        label: label === "" ? "Untyped" : label,
        pages: [page],
      });
  }
  return groups;
}
