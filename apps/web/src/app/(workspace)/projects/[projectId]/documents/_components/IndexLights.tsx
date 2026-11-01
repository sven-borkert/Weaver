"use client";

import {
  indexLightLabel,
  indexLightsDescription,
  type DocumentIndexLights,
  type IndexLight,
} from "@weaver/core/documents/indexLight";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

const DOT_CLASS: Record<IndexLight, string> = {
  ready: "bg-approved-dot border-approved-dot",
  failed: "bg-danger border-danger",
  pending: "bg-transparent border-line-strong",
  unavailable: "bg-transparent border-line",
};

function Dot({ light }: { light: IndexLight }) {
  return (
    <span
      data-light={light}
      aria-hidden="true"
      className={cn(
        "inline-block size-2 rounded-full border",
        DOT_CLASS[light],
      )}
    />
  );
}

export function IndexLights({
  lights,
  className,
}: {
  lights: DocumentIndexLights;
  className?: string;
}) {
  const description = indexLightsDescription(lights);
  const ariaLabel = lights.summary
    ? `${description}. ${lights.summary}`
    : description;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={ariaLabel}
          className={cn("inline-flex shrink-0 items-center gap-1", className)}
        >
          <Dot light={lights.keyword} />
          <Dot light={lights.semantic} />
          <Dot light={lights.graph} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-[12px]">
        <div>Keyword: {indexLightLabel(lights.keyword)}</div>
        <div>Semantic: {indexLightLabel(lights.semantic)}</div>
        <div>Graph: {indexLightLabel(lights.graph)}</div>
        {lights.summary ? (
          <div className="text-text-2 mt-1">{lights.summary}</div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
