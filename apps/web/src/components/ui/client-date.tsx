"use client";
import { useMounted } from "~/lib/use-mounted";

export function ClientDate({ value }: { value: Date }) {
  const mounted = useMounted();
  if (!mounted) return <span aria-label="Date loading">—</span>;
  return (
    <time dateTime={value.toISOString()}>{value.toLocaleDateString()}</time>
  );
}

export function ClientDateTime({ value }: { value: Date }) {
  const mounted = useMounted();
  if (!mounted) return <span aria-label="Date and time loading">—</span>;
  return <time dateTime={value.toISOString()}>{value.toLocaleString()}</time>;
}
