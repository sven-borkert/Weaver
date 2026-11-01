"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/lib/utils";
const tabs = [
  ["ai", "AI"],
  ["remote-instances", "Remote Instances"],
  ["oidc", "OIDC"],
] as const;
export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Administration settings"
      className="border-line flex gap-1 overflow-x-auto border-b"
    >
      {tabs.map(([tab, label]) => {
        const href = `/admin/settings/${tab}`;
        const active = pathname === href;
        return (
          <Link
            key={tab}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-4 py-2 text-[13px] font-medium",
              active
                ? "border-brand-text text-brand-text"
                : "text-text-3 hover:text-text border-transparent",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
