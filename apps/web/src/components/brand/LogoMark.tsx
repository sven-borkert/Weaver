import { cn } from "~/lib/utils";

/** The Weaver W mark; decorative because the product name sits beside it. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 36"
      fill="none"
      stroke="currentColor"
      strokeWidth={5}
      strokeLinejoin="bevel"
      aria-hidden="true"
      className={cn("text-brand h-6 w-7 shrink-0", className)}
    >
      <path d="M3 5 12 31 20 10 28 31 37 5" />
      <path d="m11 5 5 14m8 0 5-14" />
    </svg>
  );
}
