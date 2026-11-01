import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./LoginForm";

type SocialRequest = {
  provider: string;
  callbackURL: string;
  errorCallbackURL: string;
  disableRedirect: boolean;
};
type SocialResponse = {
  data: { url: string } | null;
  error: { status: number } | null;
};
const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  signIn: vi.fn<(request: SocialRequest) => Promise<SocialResponse>>(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => state.params }));
vi.mock("~/lib/authClient", () => ({
  authClient: { signIn: { social: state.signIn } },
}));
vi.mock("~/lib/basePath", () => ({
  APP_BASE_PATH: "/weaver",
  withBasePath: (path: string) => `/weaver${path === "/" ? "" : path}`,
  stripBasePath: (path: string) => path.replace(/^\/weaver(?=\/|$)/, "") || "/",
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  state.params = new URLSearchParams();
  state.signIn.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("LoginForm OIDC", () => {
  it("shows the configured provider while keeping password login available", () => {
    const html = renderToStaticMarkup(
      <LoginForm oidcDisplayName="Authentik" />,
    );
    expect(html).toContain("Sign in with Authentik");
    expect(html).toContain('name="password"');
    expect(renderToStaticMarkup(<LoginForm />)).not.toContain("Sign in with");
  });

  it("starts social login with safe base-path-aware destinations and navigates once", async () => {
    state.params = new URLSearchParams(
      "callbackUrl=%2Fweaver%2Fprojects%2Fp1&client_id=mcp-client&sig=test-signature",
    );
    const destinations: string[] = [];
    vi.stubGlobal("window", {
      location: { assign: (url: string) => destinations.push(url) },
    });
    let resolve!: (result: SocialResponse) => void;
    state.signIn.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => {
      renderer = create(<LoginForm oidcDisplayName="Authentik" />);
    });
    const providerButton = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.props.type === "button")!;
    let click!: Promise<void>;
    await act(async () => {
      click = (
        providerButton().props as { onClick: () => Promise<void> }
      ).onClick();
    });
    expect(
      renderer!.root
        .findAllByType("button")
        .every((button) => button.props.disabled),
    ).toBe(true);
    const request = state.signIn.mock.calls[0]![0];
    expect(request).toMatchObject({
      provider: "oidc",
      callbackURL: "/weaver/projects/p1",
      disableRedirect: true,
    });
    const errorUrl = new URL(request.errorCallbackURL, "http://localhost:3000");
    expect(errorUrl.pathname).toBe("/weaver/login");
    expect(errorUrl.searchParams.get("sig")).toBe("test-signature");
    await act(async () => {
      resolve({ data: { url: "https://auth.example/authorize" }, error: null });
      await click;
    });
    expect(destinations).toEqual(["https://auth.example/authorize"]);
  });

  it("renders a safe callback error without displaying provider-supplied descriptions", () => {
    state.params = new URLSearchParams(
      "error=invalid_state&error_description=UNTRUSTED_PROVIDER_DETAIL",
    );
    const html = renderToStaticMarkup(
      <LoginForm oidcDisplayName="Authentik" />,
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("UNTRUSTED_PROVIDER_DETAIL");
  });
});
