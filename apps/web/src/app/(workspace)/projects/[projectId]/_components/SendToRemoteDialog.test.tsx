import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ remotes: [] as unknown[] }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    remoteInstance: {
      listForUser: {
        useQuery: () => ({ data: mocked.remotes, isLoading: false }),
      },
      targets: { useQuery: () => ({ data: undefined, isLoading: false }) },
      targetFolders: {
        useQuery: () => ({ data: undefined, isLoading: false }),
      },
      sendDocument: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      sendTable: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import { SendToRemoteDialog } from "./SendToRemoteDialog";

const ids = {
  projectId: "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c",
  itemId: "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b",
};

const oneConnectedRemote = () => [
  {
    id: "3f6a4b7e-9a80-4b7e-9a80-0a4c3a3f1b2c",
    name: "Other Weaver",
    baseUrl: "https://other.example/weaver",
    connection: {
      remoteUserName: "me",
      connectedAt: new Date(),
      lastUsedAt: new Date(),
    },
  },
];

describe("SendToRemoteDialog", () => {
  it("renders the trigger and, while dirty, the saved-version hint", () => {
    mocked.remotes = [
      {
        id: "3f6a4b7e-9a80-4b7e-9a80-0a4c3a3f1b2c",
        name: "Other Weaver",
        baseUrl: "https://other.example/weaver",
        connection: {
          remoteUserName: "me",
          connectedAt: new Date(),
          lastUsedAt: new Date(),
        },
      },
    ];
    const html = renderToStaticMarkup(
      <SendToRemoteDialog kind="document" itemTitle="Plan" dirty {...ids} />,
    );
    expect(html).toContain("Send to another Weaver…");
    expect(html).toContain("Sends the saved version");
  });

  it("hides the trigger when no remote is registered", () => {
    mocked.remotes = [];
    expect(
      renderToStaticMarkup(
        <SendToRemoteDialog kind="table" itemTitle="T" {...ids} />,
      ),
    ).not.toContain("Send to another Weaver…");
  });

  it("renders an icon-only trigger in compact mode", () => {
    mocked.remotes = oneConnectedRemote();
    const html = renderToStaticMarkup(
      <SendToRemoteDialog kind="table" itemTitle="T" compact {...ids} />,
    );
    expect(html).toContain('aria-label="Send to another Weaver…"');
    expect(html).not.toContain(">Send to another Weaver…<");
  });
});
