import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

type SessionState = {
  isPending: boolean;
  data: { user: { id: string } } | null;
};

const state = vi.hoisted(
  (): { queued: SessionState[]; session: SessionState } => ({
    queued: [],
    session: {
      isPending: false,
      data: { user: { id: "b" } },
    },
  }),
);
vi.mock("~/lib/authClient", () => ({
  authClient: { useSession: () => state.queued.shift() ?? state.session },
}));
import { TRPCReactProvider } from "./react";

it.each(["b"])(
  "never mounts stale account-A server children under principal %s",
  (id) => {
    state.session = { isPending: false, data: id ? { user: { id } } : null };
    const hydrateOldAccount = vi.fn(() => <p>Private account A data</p>);
    const StaleServerChildren = hydrateOldAccount;
    const html = renderToStaticMarkup(
      <TRPCReactProvider initialPrincipalId="a">
        <StaleServerChildren />
      </TRPCReactProvider>,
    );
    expect(html).toBe("");
    expect(hydrateOldAccount).not.toHaveBeenCalled();
  },
);

it("does not revert to the stale server principal when B enters a pending session refetch", () => {
  state.queued = [
    { isPending: false, data: { user: { id: "b" } } },
    { isPending: true, data: null },
  ];
  const hydrateOldAccount = vi.fn(() => <p>Private account A data</p>);
  const StaleServerChildren = hydrateOldAccount;
  const html = renderToStaticMarkup(
    <TRPCReactProvider initialPrincipalId="a">
      <StaleServerChildren />
    </TRPCReactProvider>,
  );
  expect(html).toBe("");
  expect(hydrateOldAccount).not.toHaveBeenCalled();
});

it("allows anonymous server children to finish sign-in navigation when a session arrives", () => {
  state.queued = [];
  state.session = { isPending: false, data: { user: { id: "signed-in" } } };
  const html = renderToStaticMarkup(
    <TRPCReactProvider initialPrincipalId={null}>
      <p>Finish sign-in navigation</p>
    </TRPCReactProvider>,
  );
  expect(html).toContain("Finish sign-in navigation");
});

it("keeps the existing draft mounted when the session expires", () => {
  state.queued = [];
  state.session = { isPending: false, data: null };
  const html = renderToStaticMarkup(
    <TRPCReactProvider initialPrincipalId="a">
      <p>Unsaved draft</p>
    </TRPCReactProvider>,
  );
  expect(html).toContain("Unsaved draft");
  expect(html).toContain("Sign in again");
});
