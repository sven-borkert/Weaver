---
name: weaver-ui-pages
description: Use when changing Weaver Next.js pages/routes/layouts, AppShell navigation and panels, shared content explorer and appearance UI, unsaved-change navigation, responsive styling/design tokens, dark mode, base-path links or hydration behavior.
---

# Weaver UI Pages

Every signed-in page renders inside AppShell via the `(workspace)` route group whose layout does the auth gating (the path-forwarding `proxy.ts` does not authorize requests); interactivity lives in colocated `"use client"` components. Styling uses only the semantic token utilities from `apps/web/src/styles/globals.css`, which also provides dark mode. Document and table routes use AppShell's full-height branch so the workspace, rather than shell `<main>`, owns scrolling.

Project/personal-workspace lifecycle uses `weaver-projects`; dashboard/read-model policy uses `weaver-dashboard`. Shared explorer, appearance, shell and navigation rules remain here; the document/table skills own editor-specific behavior.

## Key files

| Path                                                                                              | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/layout.tsx`                                                                     | Root layout: ThemeProvider (next-themes), TooltipProvider, TRPCReactProvider, sonner Toaster; metadata title "Weaver"                                                                                                                                                                                                                                                                                                                                    |
| `apps/web/src/app/(workspace)/layout.tsx`                                                         | Auth gate (`getSessionUser(await headers())` → `redirect("/login")`) + `<AppShell>`                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/web/src/app/(workspace)/_components/AppShell.tsx`                                           | Sidebar + Topbar; single global-search dialog/shortcut owner; ordinary or full-height `<main>`                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/app/(workspace)/_components/WorkspaceBreadcrumbs.tsx`                               | Query-backed project/settings/documents/document breadcrumb trail                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/app/(workspace)/_components/Sidebar.tsx`                                            | Brand header (`LogoMark` + name) + collapse toggle, `<ProjectSwitcher>`, `<ProjectSections>`, admin links, build stamp                                                                                                                                                                                                                                                                                                                                   |
| `apps/web/src/app/(workspace)/reviews/page.tsx`                                                   | `/reviews`: renders `ReviewsScreen` (`_components/ReviewsScreen.tsx`), the documents due for the caller across projects, cursor-paged via `review.listDue`; `/reviews/recent` renders `RecentlyReviewedScreen` via `review.listRecent`                                                                                                                                                                                                                   |
| `apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/DocumentReviewCard.tsx`   | Project settings "Document review" card (default interval/reviewers, reviewer groups via `ReviewerGroupDialog`); Owners edit, others read-only                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/components/review/{ReviewerPicker.tsx,reviewer-options.ts}`                         | Shared member/group reviewer picker used by the settings card and the document Review settings dialog                                                                                                                                                                                                                                                                                                                                                    |
| `apps/web/src/lib/documents/{review-status.ts,review-cache-invalidation.ts}`                      | Overdue / due-soon status and reviewer summary; `invalidateDocumentReview` after a review write                                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/src/app/(workspace)/_components/AppVersionFooter.tsx`                                   | Sidebar footer build stamp: version + local build time (version only in the rail); reads `lib/buildInfo.ts`                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/app/(workspace)/_components/RailLink.tsx`                                           | Icon-only tooltip link used by the collapsed rail                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/app/(workspace)/_components/ProjectSections.tsx`                                    | Section links (icons when collapsed) for `useActiveProjectId()`'s project, from `project.get`; renders nothing only when no project resolves                                                                                                                                                                                                                                                                                                             |
| `apps/web/src/app/(workspace)/_components/ProjectSwitcher.tsx`                                    | Sidebar project switcher under the brand header (`collapsed` renders the rail's icon button); same menu in both forms                                                                                                                                                                                                                                                                                                                                    |
| `apps/web/src/app/(workspace)/_components/DocumentsBreadcrumbs.tsx`                               | Documents folder/document breadcrumb trail; each folder crumb opens a menu of that folder's contents                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/app/(workspace)/_components/LastOpenedProjectRecorder.tsx`                          | Records `User.lastOpenedProjectId` on every project route via `account.recordLastOpenedProject`; failures are silent                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/lib/sidebar-state.ts`                                                               | `weaver-sidebar` cookie name/parse/serialize shared by the `(workspace)` layout and `AppShell`                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/app/(workspace)/_components/Topbar.tsx`                                             | Page label, global-search trigger, background-work bell, ThemeToggle, UserMenu                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/app/(workspace)/_components/GlobalSearchDialog.tsx`                                 | App-level search query/scope/active state, identity guard, keyboard behavior, navigation, and focus restoration                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/src/app/(workspace)/_components/ThemeToggle.tsx`                                        | system→light→dark cycle with a `useMounted` hydration guard                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/app/(workspace)/page.tsx`                                                           | Root redirect to the landing project's Documents, or `/login` with none; personal workspace created on demand (`resolveLandingProjectId`)                                                                                                                                                                                                                                                                                                                |
| `apps/web/src/app/(workspace)/home/page.tsx`                                                      | Redirects to `/`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/app/(workspace)/projects/[projectId]/activity/page.tsx`                             | Renders `ProjectActivityScreen`: active work, latest activity, pins, scheduled report shortcuts                                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/src/app/(workspace)/projects/[projectId]/_components/ProjectActivityScreen.tsx`         | Active-work preview, `ActivityList`, `ProjectPinsSection`, project-filtered `ReportShortcutsCard`; region "Project activity"                                                                                                                                                                                                                                                                                                                             |
| `apps/web/src/lib/navigation/use-active-project-id.ts`                                            | `useActiveProjectId()`: the route project, else the stored last-opened project (`fromRoute` flag)                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/app/(workspace)/projects/[projectId]/settings/page.tsx`                             | Project settings: form + members + project API keys (Maintainer+) + danger zone                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/page.tsx`                            | Full-height documents folder/list route                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/[documentId]/page.tsx`               | Full-height document read/edit/diff route                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentsWorkspace.tsx`  | Canvas/context layout and the narrow context drawer                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/web/src/components/explorer/ContentExplorerScreen.tsx`, `ContentExplorer.tsx`, `adapter.ts` | Shared folder/list explorer (URL `?folder=`, search/sort/view, drop-zone import, drag entries onto folders via the adapter's `useOperations`, folder names from `tree.folderNames`) driven by an `ExplorerAdapter`; documents and tables each supply a `*ExplorerAdapter`; optional `columns[].visible(items)` hides a column while no item has a value, and `filter` adds a value select beside Sort that searches like the title box (documents: Type) |
| `apps/web/src/app/(workspace)/projects/[projectId]/graph/page.tsx`                                | Full-height graph route with canonical URL parsing and readiness-aware client boundary                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/web/src/app/(workspace)/projects/[projectId]/imports/[fileId]/page.tsx`                     | Import draft review route with project/file identity check and linked review screen                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/web/src/components/assistant/AssistantProvider.tsx`                                         | Shell-owned assistant state: dialog open, active conversation, the one live-run SSE subscription, unseen-completion                                                                                                                                                                                                                                                                                                                                      |
| `apps/web/src/components/assistant/AssistantPanel.tsx`                                            | Large centered `Dialog` at every viewport width                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/src/app/(workspace)/assistant/_components/AssistantPage.tsx`                            | Full-page `/assistant` and `/assistant/[conversationId]` view: conversation list beside `AssistantConversation`                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/src/app/(auth)/login/`                                                                  | Login page + form + `safeLoginCallbackUrl`; resumes an in-flight OAuth authorization via the signed `oauth_query`                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/app/(auth)/consent/`                                                                | OAuth consent page/form — names the client, resource, and requested scopes and states the write consequence                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/app/(workspace)/account/api-keys/`                                                  | Personal API keys page: `ApiKeysCard`, `CreateApiKeyDialog` (one-time secret reveal), `RevokeApiKeyDialog`                                                                                                                                                                                                                                                                                                                                               |
| `apps/web/src/app/(workspace)/admin/layout.tsx`                                                   | Global-Admin gate; calls `notFound()` for every non-Admin                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/web/src/app/(workspace)/admin/ai/`                                                          | Administration › Settings › AI connections, models, provider tests, health, and purpose routes                                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/styles/globals.css`                                                                 | Tailwind v4 CSS-first tokens (`:root` + `.dark`) mapped via `@theme inline`                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/components/ui/`                                                                     | shadcn-style primitives (`radix-ui`)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/lib/basePath.ts`                                                                    | `withBasePath()` for raw hrefs and manual fetch URLs                                                                                                                                                                                                                                                                                                                                                                                                     |
| `docs/IMPLEMENTATION.md`                                                                          | `## Web adapters and UI` section — update when restructuring (Standing Rule #1)                                                                                                                                                                                                                                                                                                                                                                          |

## Conventions

- Shared native `Button` elements default to `autoComplete="off"` so Firefox
  cannot restore stale disabled state before React hydration. `asChild` leaves
  this attribute to the child; do not suppress hydration warnings to hide it.

- Use **weaver-auth** as the canonical session API contract: `auth` is the Better Auth instance, while `getSessionUser` resolves the signed-in user.
- Auth is per route-group layout; a new route group is **public** until you copy the gate: `getSessionUser(await headers())` → `redirect("/login")` — `apps/web/src/app/(workspace)/layout.tsx`. Admin pages stay below `(workspace)/admin`; its nested layout calls `notFound()` unless `user.role === "Admin"`.
- Next 16: `params` is a `Promise` — `await` it (`apps/web/src/app/(workspace)/projects/[projectId]/page.tsx`).
- The root tRPC provider keys its QueryClient and child subtree by the Better Auth principal. A change to a different signed-in principal cancels and clears the old client and remounts local drafts/assistant state; logout and login complete with full-document navigation. A client/server principal mismatch hides the old server children and reloads before hydration can expose them under the new account; pending or failed session refetches retain the last observed principal. Session expiry retains the mounted draft and offers sign-in in another tab; it never reloads the page. Assistant conversation storage is principal-scoped. Never restore a module-level browser QueryClient singleton.
- Client components fetch with `useQuery` from `~/trpc/react` (e.g. `api.project.list.useQuery()`); types via `RouterOutputs` from `~/trpc/react`.
- Style with token utilities only: `bg-canvas/surface/surface-2/subtle/hover/pressed`, `border-line/line-strong/line-faint`, `text-text/text-2/text-3/text-muted/text-on-accent`, `brand-*`, lifecycle `draft/review/approved/danger/info` — never raw palette colors (`gray-*`, `slate-*`). Dark mode is the `.dark` variable flip in `globals.css`; no `dark:` variants for token-covered colors; theme-dependent client rendering needs a mounted guard (`ThemeToggle.tsx`'s `useMounted`).
- New colors = new `--color-*` mapping in `globals.css` (`:root` + `.dark`). No `tailwind.config.js`.
- Token values come from the Weaver design kit v1.1 "Blue" (cool-white surfaces, cobalt `--brand`, light blue in dark mode with dark `--text-on-accent`). The sidebar `<aside>` carries `.nav-scope`, which re-points the generic tokens to the navy navigation palette in both themes — style sidebar children with the ordinary token classes, never with navy literals; portaled menus and tooltips sit outside the scope. The shadcn bindings live in one rule shared by `:root`, `.theme-light` and `.nav-scope` because a `var()` binding resolves where it is declared; add a new scope's selector there. As for the base palette, the kit names only part of the token set, the rest is derived in the same family and must keep 4.5:1. Weaver keeps its own compact type scale and panel sizes. `.theme-light` re-declares the light values on a subtree; the `(auth)` layout uses it so sign-in and consent stay light over the artwork (`public/login-background.webp`, addressed with `withBasePath`). Fonts are self-hosted via `@fontsource-variable/*` imports in `app/layout.tsx` because the CSP allows only same-origin fonts — never add a Google Fonts `@import`. Focus shadows use `shadow-(--sh-focus)`, not literal rgba values.
- The shared Dialog overlay/content suppresses fade, zoom, and transition motion under `prefers-reduced-motion`; feature drawers inherit that behavior without duplicating animation state.
- Merge classes with `cn()` from `~/lib/utils`; components accept `className`.
- Sidebar nav: add links to `Sidebar.tsx`; the active project's section list renders automatically from `project.get` in `ProjectSections.tsx`, using `useActiveProjectId()` to fall back to the stored last-opened project on routes without a project segment (nothing only when no project resolves at all). Choosing a project happens in the sidebar's `ProjectSwitcher` (accessible name "Switch project"), above the section list. `AppShell` owns exactly one `GlobalSearchDialog` and guarded `Cmd/Ctrl+K` listener; `Topbar` only opens that owner. Do not add route-local dialogs or duplicate shortcut listeners. Escape restores the Topbar trigger; result selection closes the modal first and routes from the close-autofocus boundary on the next frame so destination-owned focus is not trapped or replaced. Both pointer and keyboard selection first call `confirmNavigation(withBasePath(href))`; every shell-owned programmatic navigation that can leave an editor must use this same dirty-draft boundary. The background-work tray uses the same dirty-draft check before its focus-safe navigation handoff.
- The Sidebar has its own "Reviews" section (`NavSectionLabel`, independent of the selected project) with "Open" (`/reviews`, `ClipboardCheck`, active on that exact path) and "Recently reviewed" (`/reviews/recent`, `History`). "Open" renders only when `review.dueCount` reports `isReviewer`, i.e. the user is an effective reviewer of a document in an accessible project; "Recently reviewed" is always shown. The rail has one `ClipboardCheck` icon (a dot when reviews are due) to `/reviews` (`/reviews/recent` for a non-reviewer), active on both pages. The query polls every 60s (`refetchInterval`, not in background); a due count above zero adds the badge (`99+` cap) and "Open reviews, N due" in the accessible name.
- `AppShell`'s single keyboard listener also owns `Cmd/Ctrl+J`, which toggles `AssistantProvider`'s `open` state (`assistant.toggle()`). The assistant has no `Sidebar` entry — it opens only via the shortcut or the Topbar trigger button.
- Every user has a personal workspace (`Project.personalOwnerId`); the switcher marks it "Personal", Settings shows a badge and hides the delete card, and it is never a valid deletion target — it is also the landing fallback when a user has no other project memberships.
- `AssistantPanel` is a centered modal on every screen size (up to 72rem wide,
  56rem tall, with viewport margins). It never consumes a workspace column.
  Closing hides chat and restores trigger focus while the shell-owned provider
  keeps active runs and completion indicators alive.
- The sidebar collapses to `--sidebar-w-collapsed`: `AppShell` owns the state, writes the `weaver-sidebar` cookie on toggle, and receives the initial value from the `(workspace)` layout's server-side `cookies()` read so SSR and hydration agree. The rail keeps the active project's `${name} sections` list (same accessible names as the expanded list, the switcher is an icon button opening the same menu), and Administration. `UserMenu` renders only in the Topbar.
- Panel widths: the expanded sidebar and the document/table Context rails carry a `PanelResizeHandle` (`components/layout/PanelResizeHandle.tsx`, `role="separator"`, arrows step 16px, double-click resets). `AppShell` owns the widths (`PanelWidthsContext`), writes `--sidebar-w-pref`/`--context-rail-w-pref` on `[data-app-shell]`, and saves the base-path-scoped `weaver-sidebar-width`/`weaver-context-rail-width` cookies on release; the `(workspace)` layout reads them server-side. `globals.css` derives `--sidebar-w`/`--context-rail-w` from those, capped at `max(default, 35vw / 40vw)` — keep `maxPanelWidth` in `lib/panel-widths.ts` in step with that CSS. Portaled drawers sit outside `[data-app-shell]` and keep the `:root` defaults. A handle's parent element must be the panel (it measures the start width there); never re-render per pointer move.
- Below `md`, `MobileNavigation` renders the same sidebar in a Dialog drawer. `Topbar` keys it by pathname so successful navigation closes it; crossing to desktop closes it too. Mobile opening/closing never changes the desktop sidebar cookie. Keep narrow top-bar actions compact and breadcrumbs horizontally contained so account and theme controls stay reachable.
- The sidebar footer renders `<AppVersionFooter />` (compact in the collapsed
  rail). It reads the build metadata inlined by `next.config.ts`
  through `~/lib/buildInfo`; never import `~/lib/appVersion` from client code —
  it bundles the root `package.json`.
- The sidebar shows its Administration section only to global Admins and links
  **Settings** to `/admin/settings` (AI, Remote Instances and OIDC tabs), **Diagnostics** to `/admin/diagnostics`, **Projects** and **Users**; this is instance administration, not project
  navigation. Administration no longer links **Connections** (`/admin/connections`
  redirects): every user reaches their own outbound MCP connections under
  Account › MCP connections (`/account/connections`) from the user menu.
- AppShell's `<main>` is `relative` on every route so absolutely positioned descendants (notably `sr-only` labels) stay inside its scroll container; without it they extend the document and add a second, browser-level scrollbar. Keep it positioned.
- AppShell recognizes `/projects/:projectId/documents` and descendants as the documents branch: its `<main>` is `min-h-0`, `overflow-hidden`, and padded by 3, while `DocumentsWorkspace` fills that height and owns canvas/tree/context scrolling. Ordinary routes keep the shell's `overflow-y-auto` and padding 6. Preserve this split when adding document subroutes; nested document pages must not introduce a second page-level scroller.
- AppShell applies that same full-height branch to `/projects/:projectId/tables` and descendants. The tables list route uses the same shared explorer as Documents (no folder sidebar); `TablesWorkspace` and the detail editor keep every flex/grid boundary `min-h-0 min-w-0`; the explorer canvas, context rail, and AG Grid each own only their local scrolling. The grid must not widen the shell or introduce a page-level horizontal scrollbar.
- AppShell also applies the full-height branch to `/projects/:projectId/graph`. `GraphWorkspace` owns local scrolling, exposes a project-labeled `tabIndex={-1}` route focus target, and renders Viewer-safe readiness onboarding before graph data presentation resolves. Parse all request query state through `apps/web/src/lib/knowledge/graphUrl.ts`; do not read unbounded raw values in client components.
- `/assistant` and `/assistant/[conversationId]` also join AppShell's full-height branch. `AssistantPage` (not `AssistantPanel`) owns this route: a 2xl two-column grid with a persistent conversation list beside `AssistantConversation` (a Dialog-based list below 2xl), and `AppShell` skips rendering its own `AssistantPanel` on this route so the conversation is never shown twice.
- The graph route project always owns the canvas. If a direct focus response belongs to another project, verify fresh accessible-project scope and canonically replace the route before rendering graph data; inaccessible targets stay metadata-free and retryable verification failures render no cached canvas.
- Graph wide layouts keep the canvas and keyboard outline beside a collapsible details rail. Below `xl`, the outline precedes a horizontally contained canvas and the existing Dialog drawer pattern hosts filters and details from the same React-owned props. Leaving the narrow breakpoint closes both mobile-only dialogs; mobile details focuses its stable dialog title on opening, with Radix autofocus retained if that target is unavailable; drawer close preserves graph/filter/selection state and returns focus to a connected selected outline control or the workspace fallback. Same-project focus/document destinations refocus that workspace, while filter-only replacements retain component state and current focus.
- Full-height workspaces expose a labeled `tabIndex={-1}` content region as a
  stable programmatic focus fallback when an invalidation removes the control
  that opened a triggerless mutation dialog.
- `WorkspaceBreadcrumbs` derives context from `usePathname`/`useParams` and the existing project/document/import queries. Project trails start with a link to the project (`ProjectCrumb`, none on global routes). Project settings render `Project / Settings`; the documents list renders `Project / Documents`; detail routes render linked `Project / Documents / Current title`; the graph route renders `Project / Graph`; the import review route renders linked `Project / Imports / <file name>`; `/account/api-keys` renders a static `Account / API keys` trail; `/admin/ai` renders `Administration / AI`; `/reviews` and `/reviews/recent` render `Reviews / Open` and `Reviews / Recently reviewed`; `/assistant` renders `Assistant`, and `/assistant/[conversationId]` renders a linked `Assistant / <conversation title>` (title omitted while its query is loading or inaccessible). Loading uses a compact skeleton and missing/inaccessible data falls back to a nonsensitive label. Keep these breadcrumbs contextual rather than hard-coding a Topbar page name. Document and table detail trails also render a `CopyLocationButton` (`app/(workspace)/_components/CopyLocationButton.tsx`) that copies the location text from `lib/copy-location.ts`; it stays disabled until the folder names have loaded.
- `<Link>` and `redirect()` auto-prefix the basePath; raw `<a href>` and manual fetch URLs need `withBasePath()` (`apps/web/src/lib/basePath.ts`).
- Timestamps: don't call `toLocaleString` in server-rendered markup (hydration mismatch) — render client-side after mount.
- A client component using `useSearchParams` must be wrapped in `<Suspense>` by its page — `apps/web/src/app/(auth)/login/page.tsx`.
- UI iteration: `pnpm lint` / `pnpm typecheck` / `pnpm check` / `pnpm format:check`; colocated `apps/web/src/**/*.test.ts` runs under `pnpm test`; no integration specs cover the UI; `pnpm e2e` is Tier 3 (Standing Rule #4). The serial graph/search browser workflow lives in `apps/web/tests/e2e/knowledge-ui.spec.ts`.

## How to: add a project-scoped page

1. Create `apps/web/src/app/(workspace)/projects/[projectId]/<feature>/page.tsx`; the `(workspace)` layout already gates auth. Read the param via `await params` (server) or `useParams()` (client).
2. Add a colocated `"use client"` component for interactivity; fetch via `api.<router>.<proc>.useQuery()`.
3. Register nav in `Sidebar.tsx` if it deserves a top-level entry.
4. Run `pnpm check`.

Document subroutes additionally reuse `DocumentsWorkspace` and the existing
breadcrumb derivation; do not add their own outer full-height shell.

## Common mistakes

| Mistake                                                | Reality/Fix                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Assuming global auth / adding `middleware.ts`          | Auth lives only in route-group layouts; copy the gate                                           |
| Raw palette colors or `dark:` variants                 | Tokens only; `.dark` flips variables                                                            |
| Creating `tailwind.config.ts`                          | Tailwind v4 CSS-first — theme config lives in `globals.css`                                     |
| Adding another global-search dialog or shortcut owner  | Keep the single owner in `AppShell`; `Topbar` only triggers it                                  |
| Letting AppShell and a document/table page both scroll | Keep the feature `<main>` overflow-hidden and let its workspace own local scrolling             |
| Rendering cached data after an access error            | Cached data is for transient failures only; replace it on missing/forbidden/unauthorized errors |
| Hard-coding project/document titles in Topbar          | Extend `WorkspaceBreadcrumbs` through existing access-hiding queries                            |
| `withBasePath()` on `<Link>` / missing on raw `<a>`    | Link/redirect auto-prefix; only raw hrefs and manual fetch need it                              |
| `toLocaleString` in server-rendered markup             | Hydration mismatch — render client-side after mount                                             |
| Adding an admin page outside `(workspace)/admin`       | Keep the shared shell/auth gate and the nested global-Admin `notFound()` gate                   |

## Explorer selection and bulk actions

`ContentExplorerScreen` owns visible-entry selection, serial batches, progress
and failed-entry retention; selection resets on project/folder/search or role
changes. `ContentExplorer` has no checkboxes: entry links carry
`data-explorer-entry`, Ctrl/Cmd+click toggles, Shift+click adds the range from
the last toggled anchor (`applySelectionGesture` in `lib/explorer/selection.ts`),
Space/Shift+Space mirror that on the focused entry, Ctrl/Cmd+A selects all and
Escape clears; plain clicks still open. Selected rows/tiles carry
`data-selected`. Keep the modifier interception on the entry `<Link>` (Ctrl+click
would otherwise open a tab) and the Shift mouse-down guard against text selection.
`ExplorerBulkActions` is always rendered, shows the gesture hint while empty,
owns Select all (`total`/`onSelectAll`) and captures confirmation snapshots;
`useExplorerOperations` reuses existing authorized endpoints and cache owners.
Assigned Viewer reviewers can select/review documents; Editor gates apply to
move/delete. Review previews filter permission and capture each document revision;
table deletes also capture revisions before confirmation. Refresh failures report
accepted writes separately and never replay mutations.

Drag payloads are scoped to project and content kind (`lib/explorer/drag.ts`).
`selection.ts` normalizes selected folder roots and blocks self/descendant/no-op
moves. Up preserves each searched item's own parent destination. Deletion runs
items before folders and retains the server's empty-only folder rule.

## Shared content appearance

`components/appearance/AppearanceDialog.tsx` fetches `appearance.get` when opened
and guards saves with that fetched revision. Both explorers and detail menus
reuse it; keep each triggerless dialog outside its dropdown content so menu
closure cannot destroy the draft. Editor-only actions pass optional
`onAppearance` callbacks through `ExplorerAdapter`; Viewers never mount the picker.

`AppearanceIcon` uses the finite core builtin allowlist, contained images with
item-kind fallback, and `withBasePath` for the committed icon route.
Decorative uploaded images disable native dragging so explorer items own the drag.
`appearanceStyle` chooses the higher-contrast black/white foreground. Colored
rows/tiles inherit it; badges/menu controls keep neutral token surfaces. Reader
and editor canvases and table cells retain their theme; appearance colors belong
to the explorer. Absent metadata keeps the existing item defaults.
`ExplorerIconSize` is Standard (40 px) or Compact (24 px), with names and roving
focus at both sizes. Persist `<viewStorageKey>:iconSize` after a user action;
restore only after mount, default to Standard, and tolerate storage reads/writes
throwing. The list layout does not depend on this preference.

## See also

- **weaver-entity-tables**, **weaver-forms-dialogs** — the list and form halves of feature pages.
- **weaver-trpc-routers** — a new entity page implies router + service work.
- **weaver-testing** — test cadence (Standing Rule #4).

- Editor+ project navigation includes Imports. Project navigation also
  includes Tasks (`ProjectSections.tsx`, between Imports and Settings), visible
  to every member regardless of role — see `weaver-scheduled-tasks`.
  Breadcrumbs cover Tables, Imports and per-file import review, Diagnostics
  and Connected apps; project crumbs target the canonical project route. The
  Tasks list and detail routes share one trail (`Project / Tasks`, with a
  static `Task` segment on the detail route rather than a fetched title);
  `/account/tasks` renders a static `Account / Tasks` trail.
- `apps/web/src/proxy.ts` forwards the trusted request path for the workspace login callback; authorization stays in layouts/services. `safeLoginCallbackUrl` validates the callback.
- Use shared `useMounted` (useSyncExternalStore) for hydration-sensitive output and `components/ui/client-date.tsx` for dates. Query failures must render an error/retry state; only transient failures may retain cached data. Member controls reflect both grantable rank and target rank.
- Assistant layout and shortcut conventions are owned by `weaver-assistant`.

## Background work (Phase 6B)

The shell mounts `components/background-work/BackgroundWorkProvider.tsx` and one
tray; Topbar renders the accessible bell even on mobile. The wider tray has no
scrolling: active/recent selectors and Previous/Next show one item at a time.
Acknowledge only the displayed recent item, never hidden pages or the active view.
Compact short-height layouts keep footer controls inside the viewport. Account › Background work
uses the server route/client screen split with cursor pages and explicit seen action.
Use `lib/background-work` helpers for labels, polling and destinations. Browser code
may value-import only zod-only `@weaver/core/jobs/backgroundWorkSchema`, never the
service/SQL adapters. The provider is principal-keyed and keeps the bell's unread
receipts independent of assistant-panel unread state. See weaver-jobs for access,
receipt, polling and cache-error rules.

## Project Activity page

`/projects/<id>/activity` renders `ProjectActivityScreen` (`role="region"`,
`aria-label="Project activity"`): a project header, then in order the Active
work preview, `ActivityList`, `ProjectPinsSection`, and a project-filtered
`ReportShortcutsCard`. `dashboard.projectOverview` supplies counts, pins,
`canManagePins` and `workAudience`; do not infer shared-work permission in the
browser. The active-work preview requests three items only after the snapshot
loads, with its audience, and polls every five seconds only while visible;
the overview snapshot polls every 30 seconds. Access errors hide all cached
project content; transient errors keep clearly labeled stale data.

`ManageProjectPinsDialog` is curator-only, searches current-project
candidates with a 200ms debounce and typed kind/resource identity, and
invalidates snapshot and candidates after mutations. Unavailable pins
consume capacity and can be removed by curators; unpinning only removes a
shortcut. The Active work card's "View all" link seeds
`/account/background-work` through `lib/background-work/initialFilters.ts`.

The active project is sticky: `useActiveProjectId()` returns the route
project when present, else the stored last-opened project. The switcher and
`ProjectSections` mark a project current only when it came from the route
(`fromRoute`), so global routes (Administration, Account, Assistant) keep
showing the last-opened project's sections without claiming it as "current".
Project creation still opens Settings.

The shared explorer adapter's optional `rootActions({ projectId })` renders only
at the root, independent of folder discovery. Documents use it for recursive
reviewers; Tables omit it. The screen's focusable `data-explorer-workspace-focus` container
is available in loaded, empty, loading and error states for dialog close fallback;
prefer the existing `data-explorer-focus` list/grid target when it is present.

## Leaving an editor

Every shell-owned action that leaves the page without an anchor click must ask
`confirmNavigation(href)` from `~/lib/use-unsaved-changes-guard` first; the
capture-phase link guard only sees `a[href]`. Sign out is the irreversible
case: `UserMenu` runs `signOutWithGuard()`, which confirms before
`authClient.signOut()`, then calls `suppressUnsavedPrompt()` so the already
confirmed full-page exit cannot raise a second native beforeunload prompt, and
restores the prompt if sign-out fails.

Proxy generates a per-request nonce and enforces script CSP on page routes,
including login/consent; root layout passes the nonce to next-themes. The bounded
`/api/csp-report` endpoint records only an allowlisted directive (no URLs or content).
Workspace/global error boundaries expose Next 16's `retry` callback; not-found
has a safe return link. Project navigation disappears on access errors, and last
opened/project/member mutations invalidate `account.landingProject`. Assistant's
full-page toggle navigates to the Weaver landing route, never arbitrary history.

The Administration Settings layout uses `/admin/settings/{ai,remote-instances,oidc}`
with link-based tabs. Legacy AI/remote-instance pages redirect with query values
preserved. Account remote-instance connections remain under Account.

## Exams

Project Exams navigation is visible only with `myTrainingRole`. Exam routes present not-found for Training Off. Taking screens flush unacknowledged saves before submission, including expiry. See `weaver-exams`.

## Review hardening invariants

Root-relative document and assistant links share lib/editor/link-base-path.ts. Base-path helpers recognize query/fragment boundaries at the base root. External document images return the unavailable fallback under the local-only image CSP.
