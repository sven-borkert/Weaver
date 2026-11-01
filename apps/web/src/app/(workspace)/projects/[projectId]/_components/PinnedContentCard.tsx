"use client";

import type { ProjectPinView } from "@weaver/core/dashboard/schema";
import { FileText, Table2 } from "lucide-react";
import Link from "next/link";
import { documentKindIcon } from "~/components/icons/document-kind-icon";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";

export function PinnedContentCard({
  pins,
  canManagePins,
  onManage,
  manageTriggerRef,
}: {
  pins: ProjectPinView[];
  canManagePins: boolean;
  onManage: () => void;
  manageTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const visible = pins.filter((pin) => pin.available || canManagePins);
  return (
    <Card role="region" aria-label="Pinned content">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <h2 className="text-text text-sm font-semibold">Pinned content</h2>
        {canManagePins ? (
          <Button
            ref={manageTriggerRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={onManage}
          >
            Manage pinned content
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {visible.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {visible.map((pin) => {
              const Icon =
                pin.kind === "document"
                  ? pin.available && pin.content.documentKind
                    ? documentKindIcon(pin.content.documentKind)
                    : FileText
                  : Table2;
              if (!pin.available)
                return (
                  <li
                    key={pin.pinId}
                    className="text-text-3 border-line rounded-md border border-dashed px-3 py-2 text-sm"
                  >
                    Unavailable {pin.kind}
                  </li>
                );
              const target = pin.content.destination;
              const href =
                target.kind === "document"
                  ? `/projects/${target.projectId}/documents/${target.documentId}`
                  : `/projects/${target.projectId}/tables/${target.tableId}`;
              return (
                <li key={pin.pinId}>
                  <Link
                    href={href}
                    className="border-line hover:bg-hover focus-visible:ring-ring flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm focus-visible:ring-2"
                  >
                    <Icon
                      className="text-text-3 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="truncate">{pin.content.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-text-3 text-sm">
            No pinned content yet. Project owners and maintainers can add
            shortcuts here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
