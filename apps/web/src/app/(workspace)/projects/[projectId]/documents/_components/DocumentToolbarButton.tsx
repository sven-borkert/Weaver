"use client";

import type { ComponentProps } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export function DocumentToolbarButton({
  label,
  active,
  title = label,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  label: string;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant={active ? "secondary" : "ghost"}
      className={cn("size-8 pointer-coarse:size-11", className)}
      aria-label={label}
      aria-pressed={active}
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      {...props}
    >
      {children}
    </Button>
  );
}
