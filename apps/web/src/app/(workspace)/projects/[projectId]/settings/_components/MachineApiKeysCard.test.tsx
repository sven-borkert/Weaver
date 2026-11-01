import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  configuration: vi.fn(),
  unresolved: vi.fn(),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    projectApiKey: {
      list: { useQuery: mocks.list },
      configuration: { useQuery: mocks.configuration },
      unresolvedOperations: { useQuery: mocks.unresolved },
    },
  },
}));
vi.mock("./MachineApiKeyDialog", () => ({
  MachineApiKeyDialog: ({ existing }: { existing?: { name: string } }) => (
    <button>{existing ? `Edit ${existing.name}` : "Create key"}</button>
  ),
}));
vi.mock("./RevokeMachineApiKeyDialog", () => ({
  RevokeMachineApiKeyDialog: ({ name }: { name: string }) => (
    <button>{`Revoke ${name}`}</button>
  ),
}));
vi.mock("~/components/ui/client-date", () => ({
  ClientDateTime: ({ value }: { value: Date }) => (
    <time>{value.toISOString()}</time>
  ),
}));

import { MachineApiKeysCard } from "./MachineApiKeysCard";

const active = {
  id: "key-1",
  projectId: "project",
  name: "Daily audit",
  fingerprint: "a1b2c3d4",
  status: "Active",
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  lastUsedAt: new Date("2026-10-13T08:00:00Z"),
  policyVersion: 2,
  rateLimitPerMinute: 60,
  grants: [
    {
      kind: "documentFolder",
      targetId: null,
      root: true,
      actions: ["create"],
      available: true,
      label: "Documents root",
      location: "",
    },
    {
      kind: "document",
      targetId: "11111111-1111-4111-8111-111111111111",
      root: false,
      actions: ["update"],
      available: false,
      label: "Unavailable target",
      location: "",
    },
  ],
};
const revoked = {
  ...active,
  id: "key-2",
  name: "Old publisher",
  status: "Revoked",
  revokedAt: new Date("2026-10-10T00:00:00Z"),
};
const query = (data: unknown, error: unknown = null) => ({
  data,
  error,
  isLoading: false,
  isFetching: false,
  refetch: vi.fn(),
});

describe("project API keys card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockReturnValue(query([active, revoked]));
    mocks.configuration.mockReturnValue(
      query({ baseUrl: "https://weaver.example/weaver" }),
    );
    mocks.unresolved.mockReturnValue(query([]));
  });

  it("does not query or mount credential controls without management access", () => {
    expect(
      renderToStaticMarkup(
        <MachineApiKeysCard projectId="project" canManage={false} />,
      ),
    ).toBe("");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.configuration).not.toHaveBeenCalled();
    expect(mocks.unresolved).not.toHaveBeenCalled();
  });

  it("lists keys with their effective permissions and no secret", () => {
    const html = renderToStaticMarkup(
      <MachineApiKeysCard projectId="project" canManage />,
    );
    expect(html).toContain("Daily audit");
    expect(html).toContain("Fingerprint a1b2c3d4");
    expect(html).toContain("60 requests per minute");
    expect(html).toContain("Never expires");
    expect(html).toContain("Documents root");
    expect(html).toContain("with subfolders and future content");
    expect(html).toContain("unavailable");
    expect(html).toContain("Edit Daily audit");
    expect(html).toContain("Revoke Daily audit");
    expect(html).not.toContain("Edit Old publisher");
    expect(html).not.toContain("Revoke Old publisher");
    expect(html).toContain(
      "https://weaver.example/weaver/api/v1/projects/project",
    );
    expect(html).not.toContain("wvr_project_");
  });

  it("surfaces unresolved writes for manual investigation", () => {
    mocks.unresolved.mockReturnValue(
      query([
        {
          id: "op-1",
          keyId: "key-1",
          operation: "document.create",
          createdAt: new Date("2026-10-12T00:00:00Z"),
          reason: "Unconfirmed",
        },
      ]),
    );
    const html = renderToStaticMarkup(
      <MachineApiKeysCard projectId="project" canManage />,
    );
    expect(html).toContain("Writes awaiting confirmation");
    expect(html).toContain(
      "document.create · operation op-1 · key Daily audit",
    );
  });

  it("clears every control after losing access but keeps data on transient errors", () => {
    mocks.list.mockReturnValue(
      query([active], { data: { code: "FORBIDDEN" } }),
    );
    expect(
      renderToStaticMarkup(
        <MachineApiKeysCard projectId="project" canManage />,
      ),
    ).toBe("");
    mocks.list.mockReturnValue(
      query([active], { data: { code: "INTERNAL_SERVER_ERROR" } }),
    );
    expect(
      renderToStaticMarkup(
        <MachineApiKeysCard projectId="project" canManage />,
      ),
    ).toContain("Daily audit");
  });
});
