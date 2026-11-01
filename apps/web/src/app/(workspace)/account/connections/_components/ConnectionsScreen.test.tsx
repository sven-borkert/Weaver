import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import {
  ConnectionRows,
  PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
} from "./ConnectionsScreen";

describe("external connection list", () => {
  it("renders policy, disabled state and detail destination", () => {
    const html = renderToStaticMarkup(
      <ConnectionRows
        rows={[
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "Documents API",
            endpoint: "https://example.test/mcp",
            enabled: false,
            allowInsecureTls: false,
            authMode: "none",
            revision: 1,
            timeoutMs: 30000,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastDiscoveredAt: null,
            discoveryProtocol: null,
            discoveryServerName: null,
            discoveryToolCount: null,
            discoveryResourceCount: null,
            discoveryErrorCode: null,
            discoveryErrorSummary: null,
          },
        ]}
      />,
    );
    expect(html).toContain("Documents API");
    expect(html).toContain("Disabled");
    expect(html).not.toContain("Never ask");
    expect(html).toContain("/account/connections/11111111");
  });
  it("uses the specified paging and debounce bounds", () => {
    expect(PAGE_SIZE).toBe(25);
    expect(SEARCH_DEBOUNCE_MS).toBe(200);
  });
});
