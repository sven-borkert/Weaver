"use client";

import { Bell } from "lucide-react";

import { Button } from "~/components/ui/button";
import { DialogTrigger } from "~/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { workBadgeLabel } from "~/lib/background-work/presentation";
import { useBackgroundWork } from "./BackgroundWorkProvider";

export function BackgroundWorkBell() {
  const { open, summary, summaryUnavailable, triggerRef } = useBackgroundWork();
  const active = summary?.active.value ?? 0;
  const unseen = summary?.unseen.value ?? 0;
  const label = summaryUnavailable
    ? `${workBadgeLabel(summary)}; updates unavailable`
    : workBadgeLabel(summary);
  return (
    <Tooltip>
      <DialogTrigger asChild>
        <TooltipTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant={open ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={label}
            aria-expanded={open}
            className="relative"
          >
            <Bell className="size-4" aria-hidden="true" />
            {active > 0 ? (
              <span
                className="bg-brand text-on-brand absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full px-1 text-[9px] leading-4 font-semibold"
                aria-hidden="true"
              >
                {summary?.active.capped || active >= 100 ? "99+" : active}
              </span>
            ) : null}
            {unseen > 0 ? (
              <span
                className="bg-brand ring-surface absolute right-0.5 bottom-0.5 size-1.5 rounded-full ring-2"
                aria-hidden="true"
              />
            ) : null}
          </Button>
        </TooltipTrigger>
      </DialogTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
