import { safeLoginCallbackUrl } from "~/app/(auth)/login/callbackUrl";
import { checkGitRuntime } from "@weaver/git-store/version";
import { checkPdfRuntime } from "~/server/documents/pdf/runtime";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  ACCOUNT_PASSWORD_PATH,
  shouldRedirectToChangePassword,
} from "~/lib/passwordChangeGate";
import { PANEL_WIDTH_COOKIES, parsePanelWidthCookie } from "~/lib/panel-widths";
import {
  isSidebarCollapsedCookie,
  SIDEBAR_COOKIE_NAME,
} from "~/lib/sidebar-state";
import { getSessionUser } from "~/server/auth";
import { AppShell } from "./_components/AppShell";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const requestPath = requestHeaders.get("x-weaver-request-path");
  const user = await getSessionUser(requestHeaders);
  if (!user)
    redirect(
      `/login?callbackUrl=${encodeURIComponent(safeLoginCallbackUrl(requestPath))}`,
    );
  // UX nudge only — requireActiveUser (Task 9) is the authoritative gate.
  if (shouldRedirectToChangePassword(user.mustChangePassword, requestPath)) {
    redirect(ACCOUNT_PASSWORD_PATH);
  }
  const cookieStore = await cookies();
  const sidebarCollapsed = isSidebarCollapsedCookie(
    cookieStore.get(SIDEBAR_COOKIE_NAME)?.value,
  );
  const panelWidths = {
    sidebar: parsePanelWidthCookie(
      "sidebar",
      cookieStore.get(PANEL_WIDTH_COOKIES.sidebar)?.value,
    ),
    contextRail: parsePanelWidthCookie(
      "contextRail",
      cookieStore.get(PANEL_WIDTH_COOKIES.contextRail)?.value,
    ),
  };
  const [git, pdf] = await Promise.all([checkGitRuntime(), checkPdfRuntime()]);
  return (
    <AppShell
      initialSidebarCollapsed={sidebarCollapsed}
      initialPanelWidths={panelWidths}
      git={git}
      pdf={pdf}
    >
      {children}
    </AppShell>
  );
}
