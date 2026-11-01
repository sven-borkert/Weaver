"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";

/** `text` is null until the location is fully resolved, so a click never copies a partial address. */
export function CopyLocationButton({
  text,
  label,
}: {
  text: string | null;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={text === null}
          className="text-text-2 shrink-0"
          onClick={() => {
            if (text === null) return;
            if (!navigator.clipboard) {
              toast.error("Copy failed — clipboard is not available here");
              return;
            }
            void navigator.clipboard
              .writeText(text)
              .then(() => toast.success("Location copied"))
              .catch(() => toast.error("Copy failed"));
          }}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
