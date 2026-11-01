import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ hasNextPage: true }));
vi.mock("~/trpc/react", () => ({
  api: {
    document: {
      resolveRefs: {
        useQuery: () => ({ data: [], isLoading: false, error: null }),
      },
      backlinks: {
        useInfiniteQuery: () => ({
          data: {
            pages: [
              {
                documents: [
                  {
                    id: "source",
                    title: "Incoming document",
                    path: "source.md",
                    excerpt: "Source excerpt",
                  },
                ],
              },
            ],
          },
          isLoading: false,
          error: null,
          hasNextPage: state.hasNextPage,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
        }),
      },
    },
  },
}));
import { DocumentLinksPanel } from "./DocumentLinksPanel";
it("renders the backlink page and exposes further pages instead of silently truncating", () => {
  state.hasNextPage = true;
  const render = () =>
    renderToStaticMarkup(
      <DocumentLinksPanel
        projectId="project"
        documentId="document"
        outgoing={[]}
      />,
    );
  expect(render()).toContain("Incoming document");
  expect(render()).toContain("Load more incoming links");
  state.hasNextPage = false;
  expect(render()).not.toContain("Load more incoming links");
});
