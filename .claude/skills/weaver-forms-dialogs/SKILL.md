---
name: weaver-forms-dialogs
description: Use when adding or changing Weaver create/edit forms, dialogs, delete confirmations, or mutation UX under apps/web/src/app — including react-hook-form + zodResolver, applyTrpcErrorToForm, sonner toasts, or tRPC mutation invalidation.
---

# Forms, dialogs and mutation UX

Create forms use react-hook-form and a Zod schema that mirrors the tRPC input, usually hosted in a centred `Dialog`; settings edits live in a `Card`. Mutations are `useMutation` + manual `useUtils` invalidation + sonner toasts — no optimistic updates. Destructive actions get an explicit confirmation (type-the-name for project deletion, confirm dialog for member removal).

## Key files

| Path                                                                                             | Role                                                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `apps/web/src/app/(workspace)/_components/CreateProjectDialog.tsx`                               | Canonical create flow: Dialog + form + mutation + invalidate + navigate            |
| `apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/ProjectSettingsForm.tsx` | Canonical edit form: initialized from loaded project, `canEdit` gating             |
| `apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/AddMemberDialog.tsx`     | Controller-backed `Select` dropdown variant; exports `PROJECT_ROLES`               |
| `apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/DeleteProjectDialog.tsx` | Danger-zone card + type-the-project-name confirmation                              |
| `apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/MembersSection.tsx`      | Members table + role `Select` + remove confirmation dialog                         |
| `apps/web/src/lib/trpcErrors.ts`                                                                 | `applyTrpcErrorToForm()` — server `err.data.field` → RHF `setError`                |
| `apps/web/src/server/api/schemas/project.ts`                                                     | Project input schemas mirrored by forms                                            |
| `apps/web/src/server/api/schemas/projectMember.ts`                                               | Member input schemas mirrored by forms                                             |
| `apps/web/src/components/ui/`                                                                    | Dialog/select/sonner primitives; `<Toaster />` is in `apps/web/src/app/layout.tsx` |

## Conventions

- Form schemas are client-side mirrors of the server input schemas, marked with a comment ("Client-side mirror of the server's … input"). Change both together when a field changes. Server schemas stay the single source of truth for the API (weaver-trpc-routers).
- `useForm({ resolver: zodResolver(schema), defaultValues })`; values typed as `z.infer` (these schemas have no `.default()` — if you add defaults, switch to `z.input`).
- Pending saves must disable editable fields or preserve every draft revision newer than the submitted snapshot. Identity-changing surfaces key forms by entity/conversation; completion callbacks invalidate `variables` identity, never whatever entity is currently rendered.
- The document canvas uses `useDocumentSession` and saved-baseline equality:
  direct Save keeps the editor mounted and has no comment dialog. Discard is
  confirmed separately and resets undo history; conflict offers Keep editing,
  Reload latest, or Overwrite with my version. Preserve drafts on save/refresh
  errors, and treat pending image uploads as unsaved work. See `weaver-documents`.
- Submit: mutation `onSuccess` → `toast.success("…")` → `utils.<router>.<proc>.invalidate(...)` → close dialog / reset / navigate; `onError` → if `err.data?.field` has rendered inline feedback, `applyTrpcErrorToForm(err, (name, error) => setError(name, error))`, else `toast.error(err.message || "fallback")` (copy the exact blocks from `CreateProjectDialog.tsx`).
- Field-pinned service errors carry `{ field: "<rhfField>" }` in
  `CoreError.details`; the web adapter and error formatter lift it to
  `err.data.field`.
- Field markup: `flex flex-col gap-1.5` wrapper + `<Label htmlFor>` + `{...register(name)}` + inline `<p className="text-danger text-[12px]">` error. `aria-invalid` on invalid inputs.
- Dropdowns: `Controller` + shadcn `Select` primitives (`AddMemberDialog.tsx`); role lists come from the shared `PROJECT_ROLES` const.
- Dialogs: local `open` state; `onOpenChange` ignores closes while the mutation `isPending` and resets `defaultValues` on close; trigger via `<DialogTrigger asChild><Button …>`.
- Mark mutation `DialogContent` itself `aria-busy` while pending, in addition to disabling close/cancel/submit controls. Dropdown-triggered dialogs have no persistent `DialogTrigger`; retain the action-menu button and explicitly restore focus to it after close. If invalidation removes or rekeys that trigger, focus a connected, deliberately focusable workspace/list fallback. Full-height table drawers use their labeled Dialog triggers and Radix focus restoration.
- `focusDialogTarget(target, fallback)` (`apps/web/src/lib/dialog-focus.ts`) is the shared `onCloseAutoFocus` helper implementing the row above: it tries `target` then `fallback`, skipping either one that is disconnected **or disabled** (a disabled control silently refuses focus), so a trigger that becomes disabled after the mutation still falls through to the workspace/list fallback instead of losing focus.
- Edit forms get their initial values from the already-loaded query result via `defaultValues` (settings pages load `project.get` first and gate rendering on it) — avoid a reactive `values:` prop or an unconditional refresh reset that overwrites drafts. Accepted saves may reset to their normalized values while fields are disabled; deliberately refreshable settings such as diagnostics use `reset(..., { keepDirtyValues: true })` so unsaved fields survive background updates. A dialog over a refetching query (the Rename document dialog) uses `values` together with `resetOptions: { keepDirtyValues: true }`, keys the form on `open` only — never on a commit SHA, which remounts it on every refetch — and renders from `dataUnlessAccessError(data, error)` with the data branch first, so a transient background error never unmounts a draft while an access error still clears it.
- Content appearance edits use `components/appearance/AppearanceDialog.tsx`.
  Dirty fields become a strict core `AppearancePatch`; omitted fields preserve
  metadata, explicit null resets only that field. Read current metadata/revision
  on opening and disable Save during refresh/pending writes. Image upload sends
  `target`, `expectedRevision`, `patch`, and `file` in one multipart request to
  the project appearance route, using `withBasePath`. Keep the form open on
  validation/upload/conflict errors and offer a reload that retains dirty fields.
  Store dialog state outside dropdown content, restore the stable action trigger,
  and discard open appearance state when edit permission is lost.
- Recursive reviewer dialogs use `FolderReviewDialog.tsx`, with state outside
  folder dropdown content and the same `focusDialogTarget` handler for loaded,
  loading and error branches. Pending writes keep the dialog busy through cache
  refresh. Live defaults `canManage` disables picker/apply/clear even when already
  open; conflicts keep the selection and require an explicit refreshed preview,
  with no automatic replay. Use preview-specific `staleTime: 0` so returning to a
  cached selection refetches. Persist accepted-write state across refresh failures:
  keep that state above loaded/error form branches. Refresh retries the full
  canonical cache invalidation path, never a mutation,
  and keeps the hint/writes locked until recovery closes the dialog.
  Initialize the picker from `configuredReviewers`; display effective `reviewers`
  and the inheritance source separately. A configured empty selection must remain
  empty rather than materializing Owner references. Send only target type/id.
  Apply sends its current preview's HEAD; Use parent default sends the defaults
  read HEAD and clears only the setting, without changing existing documents.
- Deletes: project deletion is a danger-zone card with type-the-name confirmation (`confirmed = confirmName === projectName`, destructive submit disabled until true); member removal is a confirm dialog holding the target row in state. Permission gating happens before rendering the control (`canEdit`/`canManage`/`canDelete` in the settings page).
- Table mutations retain local draft data on validation, size/cap, conflict,
  reload, and refresh failures. Render controlled safe copy rather than raw
  server messages or paths; keep cached data visible only for transient refresh failures and
  provide Retry. Destructive confirmations identify the exact table or column,
  and multi-row deletion states the exact row count and table title.
- Table role gating happens before rendering triggers: Viewer is read-only,
  Editor+ gets create/move/delete/edit/save/schema/restore, Maintainer+ gets
  rebuild. Global Admin grants no project-role privilege: derive gates from live membership and capabilities (see **weaver-auth**).
  Permission-scoped dialog state must also be invalidated across demotion so
  it cannot reopen from stale local state if edit access returns in one mount.

- One-time secrets (`settings/_components/MachineApiKeyDialog.tsx`) use
  `useMutation({ gcTime: 0 })`, copy the secret into local state, call
  `reset()` immediately and clear the state when the secret dialog closes or
  unmounts. Never put a secret into a query key or `setData`. When creation
  succeeds but the list refresh (`invalidate(..., { throwOnError: true })`)
  fails, keep showing the secret and offer a Retry that only refetches the list,
  never another create.

## How to: add a create/edit flow for a new entity

1. Add the server input schema (`apps/web/src/server/api/schemas/<entity>.ts`) and wire the router `.input()` (weaver-trpc-routers).
2. Copy the closest dialog/form: `CreateProjectDialog.tsx` for creates, `ProjectSettingsForm.tsx` for edits, `AddMemberDialog.tsx` when a select is involved.
3. Mirror the schema client-side with the "Client-side mirror" comment; `useForm` + `zodResolver` + `defaultValues`.
4. Wire the mutation: `onSuccess` toast + invalidate, `onError` with the `applyTrpcErrorToForm` / `toast.error` split.
5. Host in a `Dialog` (creates) or a `Card` section (settings-style edits); gate destructive submits.
6. Iterate with `pnpm lint` / `pnpm typecheck` — forms have no integration specs; `pnpm e2e` is Tier 3 (ask first, Standing Rule #4).

## Common mistakes

| Mistake                                                      | Reality/Fix                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Changing a server input schema without the client mirror     | They drift; update both in the same commit                                                                                                                                                                                                       |
| Toasting a field-pinned error instead of `setError`          | Pin only fields with rendered feedback; toast all others                                                                                                                                                                                         |
| Unconditional refresh resets overwrite edits                 | Use loaded defaults; explicit refresh keeps dirty fields                                                                                                                                                                                         |
| Closing a dialog while the mutation is pending               | `onOpenChange` guards on `isPending` — keep the guard                                                                                                                                                                                            |
| Marking only the submit button busy                          | Put `aria-busy` on `DialogContent` so the dialog's pending state is announced                                                                                                                                                                    |
| Losing focus after a dropdown opens a dialog                 | Restore focus to the stable dropdown trigger after the triggerless dialog closes                                                                                                                                                                 |
| Closing a dialog before the refreshed data arrives           | Document review writes (`MarkReviewedDialog`, `ReviewSettingsDialog`) keep the dialog busy until `invalidateDocumentReview` has refetched `document.get`, so the editor adopts the new head; a failed refetch shows `RELOAD_BEFORE_EDITING_HINT` |
| Forgetting the invalidation after success                    | Stale lists/details; invalidate the exact queries the UI reads                                                                                                                                                                                   |
| Building forms with a shadcn Form wrapper                    | No `ui/form.tsx` here — plain `useForm` destructuring + `Label` + inline `<p>` errors                                                                                                                                                            |
| Rendering a destructive control for a role that can't use it | Gate by `myRole` before rendering (settings page pattern)                                                                                                                                                                                        |

## See also

weaver-entity-tables (list/table views), weaver-ui-pages (page structure, styling), weaver-trpc-routers (input schemas, error mapping), weaver-testing. CLAUDE.md Standing Rule #4; `docs/IMPLEMENTATION.md` UI section.

## Review hardening invariants

Disable the full credential-policy form while saving, including native controls via fieldset and portaled Select controls explicitly, so policy edits cannot be discarded after submission.
