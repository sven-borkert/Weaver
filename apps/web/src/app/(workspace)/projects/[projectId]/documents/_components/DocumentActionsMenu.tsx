"use client";

import {
  Check,
  FileDown,
  FolderArchive,
  MoreHorizontal,
  Send,
  Settings2,
  Tags,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { DOCUMENT_KINDS } from "@weaver/core/documents/kinds";
import { projectRoleAtLeast } from "@weaver/core/roles";
import { useRuntimeStatus } from "~/app/(workspace)/_components/RuntimeStatusContext";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { withBasePath } from "~/lib/basePath";
import { api, type RouterOutputs } from "~/trpc/react";
import { SendToRemoteDialog } from "../../_components/SendToRemoteDialog";
import { MarkReviewedDialog } from "./MarkReviewedDialog";
import { PropertiesDialog } from "./PropertiesDialog";
import { ReviewSettingsDialog } from "./ReviewSettingsDialog";

export const UNSAVED_REVIEW_HINT = "Save or discard your changes first";

type DialogKind = "reviewed" | "settings" | "send" | "properties";

function ItemLabel({ label, hint }: { label: string; hint?: string }) {
  if (!hint) return label;
  return (
    <span className="flex flex-col">
      {label}
      <span className="text-text-3 text-[11px]">{hint}</span>
    </span>
  );
}

export function DocumentActionsMenu({
  projectId,
  document,
  baseCommitSha,
  dirty = false,
}: {
  projectId: string;
  document: RouterOutputs["document"]["get"];
  baseCommitSha: string;
  dirty?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const dialogProps = (kind: DialogKind) => ({
    open: dialog === kind,
    onOpenChange: (open: boolean) => setDialog(open ? kind : null),
  });
  const permissions = api.document.reviewPermissions.useQuery({
    projectId,
    documentId: document.id,
  }).data;
  const myRole = api.project.get.useQuery({ projectId }).data?.myRole;
  const canEditProperties = myRole
    ? projectRoleAtLeast(myRole, "Editor")
    : false;
  const canSend = (api.remoteInstance.listForUser.useQuery().data ?? []).length;
  const pdfUnavailable = useRuntimeStatus().pdf.status !== "ok";
  const reviewHint = dirty ? UNSAVED_REVIEW_HINT : undefined;
  const spec = DOCUMENT_KINDS[document.kind];
  const unsupportedHint = `Not available for ${spec.label}s`;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            size="icon"
            className="size-11"
            aria-label="Document actions"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!dirty ? (
            <DropdownMenuItem asChild>
              <Link
                href={`/projects/${projectId}/graph?document=${document.id}`}
              >
                <Waypoints />
                Explore graph
              </Link>
            </DropdownMenuItem>
          ) : null}
          {permissions?.canMarkReviewed ? (
            <DropdownMenuItem
              disabled={dirty}
              onSelect={() => setDialog("reviewed")}
            >
              <Check />
              <ItemLabel label="Mark as reviewed" hint={reviewHint} />
            </DropdownMenuItem>
          ) : null}
          {permissions?.canEditReview ? (
            <DropdownMenuItem
              disabled={dirty}
              onSelect={() => setDialog("settings")}
            >
              <Settings2 />
              <ItemLabel label="Review settings…" hint={reviewHint} />
            </DropdownMenuItem>
          ) : null}
          {canEditProperties ? (
            <DropdownMenuItem
              disabled={dirty}
              onSelect={() => setDialog("properties")}
            >
              <Tags />
              <ItemLabel label="Properties…" hint={reviewHint} />
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            asChild
            disabled={pdfUnavailable || !spec.supportsPdf}
          >
            <a
              href={withBasePath(
                `/api/documents/${document.id}/pdf?projectId=${projectId}`,
              )}
              target="_blank"
              rel="noopener"
            >
              <FileDown />
              <ItemLabel
                label="Export as PDF"
                hint={
                  !spec.supportsPdf
                    ? unsupportedHint
                    : pdfUnavailable
                      ? "PDF export is unavailable on this server"
                      : dirty
                        ? "Exports the saved version"
                        : undefined
                }
              />
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a
              href={withBasePath(
                `/api/documents/${document.id}/archive?projectId=${projectId}`,
              )}
              download
            >
              <FolderArchive />
              <ItemLabel
                label={
                  spec.supportsImages
                    ? "Download as ZIP (with images)"
                    : "Download as ZIP"
                }
                hint={dirty ? "Downloads the saved version" : undefined}
              />
            </a>
          </DropdownMenuItem>
          {canSend ? (
            <DropdownMenuItem
              disabled={!spec.supportsRemoteSend}
              onSelect={() => setDialog("send")}
            >
              <Send />
              <ItemLabel
                label="Send to another Weaver…"
                hint={
                  !spec.supportsRemoteSend
                    ? unsupportedHint
                    : dirty
                      ? "Sends the saved version"
                      : undefined
                }
              />
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {permissions?.canMarkReviewed ? (
        <MarkReviewedDialog
          projectId={projectId}
          documentId={document.id}
          baseCommitSha={baseCommitSha}
          triggerRef={triggerRef}
          {...dialogProps("reviewed")}
        />
      ) : null}
      {permissions?.canEditReview ? (
        <ReviewSettingsDialog
          projectId={projectId}
          document={document}
          baseCommitSha={baseCommitSha}
          triggerRef={triggerRef}
          {...dialogProps("settings")}
        />
      ) : null}
      {canEditProperties ? (
        <PropertiesDialog
          projectId={projectId}
          document={document}
          baseCommitSha={baseCommitSha}
          triggerRef={triggerRef}
          {...dialogProps("properties")}
        />
      ) : null}
      <SendToRemoteDialog
        kind="document"
        projectId={projectId}
        itemId={document.id}
        itemTitle={document.title}
        dirty={dirty}
        returnFocusRef={triggerRef}
        {...dialogProps("send")}
      />
    </>
  );
}
