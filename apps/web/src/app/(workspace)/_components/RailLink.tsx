"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

type RailLinkProps = {
  href: string;
  label: string;
  active?: boolean;
  children: ReactNode;
};

/** Icon-only navigation entry for the collapsed sidebar rail. */
export function RailLink({
  href,
  label,
  active = false,
  children,
}: RailLinkProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "text-text-2 hover:bg-hover hover:text-text flex size-9 items-center justify-center rounded-[6px] transition-colors",
            active && "bg-brand-bg text-brand-text",
          )}
        >
          {children}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
