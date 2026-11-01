import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
const state = vi.hoisted(() => {
  const query: {
    data: unknown;
    error: unknown;
    isLoading: boolean;
    refetch: ReturnType<typeof vi.fn>;
  } = { data: undefined, error: undefined, isLoading: false, refetch: vi.fn() };
  return {
    test: vi.fn(),
    save: vi.fn(),
    invalidate: vi.fn(),
    fetch: vi.fn(),
    setData: vi.fn(),
    dirty: vi.fn(),
    query,
  };
});
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      oidc: {
        getSettings: {
          invalidate: state.invalidate,
          fetch: state.fetch,
          setData: state.setData,
        },
      },
    }),
    oidc: {
      getSettings: { useQuery: () => state.query },
      testConnection: {
        useMutation: () => ({
          mutateAsync: state.test,
          reset: vi.fn(),
          isPending: false,
        }),
      },
      updateSettings: {
        useMutation: () => ({
          mutateAsync: state.save,
          reset: vi.fn(),
          isPending: false,
        }),
      },
    },
  },
}));
vi.mock("~/lib/use-unsaved-changes-guard", () => ({
  useUnsavedChangesGuard: state.dirty,
  UNSAVED_CHANGES_CONFIRMATION: "Discard unsaved changes?",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { OidcSettingsForm } from "./OidcSettingsForm";
import { OidcSettingsScreen } from "./OidcSettingsScreen";
import { OidcMetadataPanel } from "./OidcMetadataPanel";
const settings: RouterOutputs["oidc"]["getSettings"] = {
  enabled: true,
  displayName: "Company",
  discoveryUrl: "https://idp.example.test/discovery",
  clientId: "weaver",
  hasClientSecret: true,
  revision: "11111111-1111-4111-8111-111111111111",
  source: "database",
  encryptionConfigured: true,
  callbackUrl: "https://weaver.example.test/weaver/api/auth/callback/oidc",
  discovery: null,
};
const result: RouterOutputs["oidc"]["testConnection"] = {
  compatible: true,
  issues: [],
  warnings: [],
  signingAlgorithms: ["RS256"],
  tokenEndpointAuthMethod: "client_secret_post",
  metadata: {
    issuer: "https://idp.example.test",
    authorization_endpoint: "https://idp.example.test/authorize",
    token_endpoint: "https://idp.example.test/token",
    jwks_uri: "https://idp.example.test/keys",
    id_token_signing_alg_values_supported: ["RS256"],
  },
};
let renderer: ReactTestRenderer | undefined;
type NodeMock = {
  name: string;
  type: string;
  value: string;
  checked: boolean;
  focus: () => void;
};
const nodes = new Map<string, NodeMock>();
const onSaved = vi.fn();
async function mount(screen = false) {
  await act(async () => {
    renderer = create(
      screen ? (
        <OidcSettingsScreen />
      ) : (
        <OidcSettingsForm settings={settings} onSaved={onSaved} />
      ),
      {
        createNodeMock(element) {
          if (element.type !== "input") return {};
          const props = element.props as { name?: string; type?: string };
          const node = {
            name: props.name ?? "",
            type: props.type ?? "text",
            value: "",
            checked: false,
            focus: vi.fn(),
          };
          nodes.set(node.name, node);
          return node;
        },
      },
    );
  });
}
function field(name: string) {
  return renderer!.root
    .findAllByType("input")
    .find((input) => input.props.name === name)!;
}
async function change(name: string, value: string | boolean) {
  const node = nodes.get(name)!;
  if (typeof value === "boolean") node.checked = value;
  else node.value = value;
  await act(async () => {
    await (field(name).props.onChange as (event: unknown) => Promise<void>)({
      type: "change",
      target: node,
    });
  });
}
function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find(
      (entry) =>
        entry.children.filter((child) => typeof child === "string").join("") ===
        label,
    )!;
}
async function click(label: string) {
  await act(async () => {
    await (button(label).props.onClick as () => Promise<void>)();
  });
}
async function submit() {
  await act(async () => {
    await (
      renderer!.root.findByType("form").props.onSubmit as (
        event: unknown,
      ) => Promise<void>
    )({ preventDefault: vi.fn(), persist: vi.fn() });
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  state.save.mockReset().mockResolvedValue({
    ...settings,
    revision: "22222222-2222-4222-8222-222222222222",
  });
  state.test.mockReset().mockResolvedValue(result);
  state.invalidate.mockReset().mockResolvedValue(undefined);
  state.fetch.mockReset().mockResolvedValue(settings);
  state.dirty.mockReset();
  onSaved.mockReset();
  nodes.clear();
  state.query.data = settings;
  state.query.error = undefined;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("OIDC settings form", () => {
  it("tests the unsaved URL without sending the replacement secret", async () => {
    await mount();
    await change("discoveryUrl", "https://unsaved.example.test/discovery");
    await change("clientSecret", "new-secret");
    await click("Test connection");
    expect(state.test.mock.calls[0]?.[0]).toEqual({
      discoveryUrl: "https://unsaved.example.test/discovery",
    });
    expect(JSON.stringify(state.test.mock.calls)).not.toContain("new-secret");
    expect(state.dirty).toHaveBeenLastCalledWith(true);
    expect(
      renderer!.root.findAllByProps({ "aria-label": "OIDC metadata" }),
    ).toHaveLength(1);
  });
  it("discards a late test result after A to B to A URL edits", async () => {
    let finish!: (value: typeof result) => void;
    state.test.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    let request!: Promise<void>;
    await act(async () => {
      request = (
        button("Test connection").props.onClick as () => Promise<void>
      )();
    });
    await change("discoveryUrl", "https://other.example.test/discovery");
    await change("discoveryUrl", settings.discoveryUrl);
    await act(async () => {
      finish(result);
      await request;
    });
    expect(
      renderer!.root.findAllByProps({ "aria-label": "OIDC metadata" }),
    ).toHaveLength(0);
  });
  it("saves with the loaded revision, retains an empty secret, and clears a replacement after success", async () => {
    await mount();
    await change("displayName", "Renamed");
    await submit();
    expect(state.save.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: settings.revision,
      displayName: "Renamed",
      clientSecret: "",
    });
    await change("clientSecret", "replacement");
    await submit();
    expect(state.save.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: "22222222-2222-4222-8222-222222222222",
      clientSecret: "replacement",
    });
    expect(nodes.get("clientSecret")?.value).toBe("");
  });
  it("disables OIDC without requiring a discovery test", async () => {
    await mount();
    await change("enabled", false);
    await submit();
    expect(state.save.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
    expect(state.test).not.toHaveBeenCalled();
  });
  it("preserves a draft through background reads and a failed save", async () => {
    await mount();
    await change("displayName", "Draft");
    await act(async () => {
      renderer!.update(
        <OidcSettingsForm
          settings={{
            ...settings,
            displayName: "Remote edit",
            revision: "33333333-3333-4333-8333-333333333333",
          }}
          onSaved={onSaved}
        />,
      );
    });
    state.save.mockRejectedValue(new Error("Unavailable"));
    await submit();
    expect(nodes.get("displayName")?.value).toBe("Draft");
    expect(state.save.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: settings.revision,
      displayName: "Draft",
    });
  });
  it("locks edits during a pending save", async () => {
    let finish!: (saved: typeof settings) => void;
    state.save.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    await change("displayName", "Draft");
    let submitted!: Promise<void>;
    await act(async () => {
      submitted = (
        renderer!.root.findByType("form").props.onSubmit as (
          event: unknown,
        ) => Promise<void>
      )({ preventDefault: vi.fn(), persist: vi.fn() });
    });
    expect(renderer!.root.findByType("fieldset").props.disabled).toBe(true);
    await act(async () => {
      finish(settings);
      await submitted;
    });
    expect(renderer!.root.findByType("fieldset").props.disabled).toBe(false);
  });
  it("reloads conflicts explicitly and never replays an accepted write when refresh fails", async () => {
    await mount();
    await change("displayName", "Draft");
    state.save.mockRejectedValueOnce({
      data: { code: "CONFLICT" },
      message: "Changed",
    });
    await submit();
    await click("Reload latest");
    expect(nodes.get("displayName")?.value).toBe("Company");
    state.invalidate.mockRejectedValueOnce(new Error("Refresh unavailable"));
    await change("displayName", "Accepted");
    await submit();
    expect(button("Retry refresh")).toBeTruthy();
    await click("Retry refresh");
    expect(state.save).toHaveBeenCalledTimes(2);
    expect(state.invalidate).toHaveBeenCalledWith(undefined, undefined, {
      throwOnError: true,
    });
  });
  it("removes the secret draft after access is revoked and does not restore it", async () => {
    await mount(true);
    await change("clientSecret", "sensitive-draft");
    state.query.error = { data: { code: "FORBIDDEN" } };
    await act(async () => renderer!.update(<OidcSettingsScreen />));
    expect(renderer!.root.findAllByType("form")).toHaveLength(0);
    state.query.error = undefined;
    await act(async () => renderer!.update(<OidcSettingsScreen />));
    expect(nodes.get("clientSecret")?.value).toBe("");
  });
  it("copies the derived callback URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mount();
    await click("Copy callback URL");
    expect(writeText).toHaveBeenCalledWith(
      "https://weaver.example.test/weaver/api/auth/callback/oidc",
    );
  });
  it("pins server discovery failures to the URL and removes stale successful metadata", async () => {
    await act(async () => {
      renderer = create(
        <OidcSettingsForm
          settings={{ ...settings, discovery: result }}
          onSaved={onSaved}
        />,
      );
    });
    state.test.mockRejectedValue({
      message: "Origin is not allowed",
      data: { field: "discoveryUrl" },
    });
    await click("Test connection");
    expect(field("discoveryUrl").props["aria-invalid"]).toBe(true);
    expect(
      renderer!.root.findAllByProps({ "aria-label": "OIDC metadata" }),
    ).toHaveLength(0);
  });

  it("shows metadata and labels unadvertised capabilities", () => {
    const html = renderToStaticMarkup(<OidcMetadataPanel result={result} />);
    expect(html).toContain("https://idp.example.test/keys");
    expect(html).toContain("Not advertised");
    expect(html).toContain("RS256");
  });
});
