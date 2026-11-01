"use client";

import type { ProjectOverview } from "@weaver/core/dashboard/schema";
import { useRef, useState, type RefObject } from "react";
import { ManageProjectPinsDialog } from "./ManageProjectPinsDialog";
import { PinnedContentCard } from "./PinnedContentCard";

export function ProjectPinsSection({
  overview,
  fallbackFocusRef,
}: {
  overview: ProjectOverview;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  return overview.canManagePins ? (
    <ManagedProjectPins
      overview={overview}
      fallbackFocusRef={fallbackFocusRef}
    />
  ) : (
    <PinnedContentCard
      pins={overview.pins}
      canManagePins={false}
      onManage={() => undefined}
    />
  );
}

function ManagedProjectPins({
  overview,
  fallbackFocusRef,
}: {
  overview: ProjectOverview;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <PinnedContentCard
        pins={overview.pins}
        canManagePins
        onManage={() => setOpen(true)}
        manageTriggerRef={triggerRef}
      />
      <ManageProjectPinsDialog
        overview={overview}
        open={open}
        onOpenChange={setOpen}
        onRestoreFocus={() => {
          const target = triggerRef.current;
          if (target?.isConnected) target.focus();
          else fallbackFocusRef.current?.focus();
        }}
      />
    </>
  );
}
