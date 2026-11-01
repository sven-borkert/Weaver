"use client";

import {
  Activity,
  ClipboardCheck,
  FolderKanban,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { LogoMark } from "~/components/brand/LogoMark";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { AppVersionFooter } from "./AppVersionFooter";
import { ProjectSections } from "./ProjectSections";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { RailLink } from "./RailLink";

type SidebarProps = {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  className?: string;
  toggleLabel?: string;
};

function NavSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-text-3 px-3 pt-3 pb-1 text-[11px] font-medium tracking-[0.06em] uppercase">
      {children}
    </div>
  );
}

function ReviewCountBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-danger-bg text-danger border-danger-border rounded-full border px-1.5 text-[11px] leading-[16px] font-medium",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function CollapseToggle({
  collapsed,
  onCollapsedChange,
  toggleLabel,
}: SidebarProps) {
  const label =
    toggleLabel ?? (collapsed ? "Expand sidebar" : "Collapse sidebar");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-expanded={!collapsed}
          className="text-text-3 hover:text-text shrink-0"
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="size-4" aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  collapsed,
  onCollapsedChange,
  className,
  toggleLabel,
}: SidebarProps) {
  const pathname = usePathname();
  const meQuery = api.account.me.useQuery();
  const me = dataUnlessAccessError(meQuery.data, meQuery.error);
  const isAdmin = me?.role === "Admin";
  const dueCountQuery = api.review.dueCount.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const dueCount = dataUnlessAccessError(
    dueCountQuery.data,
    dueCountQuery.error,
  );
  const isReviewer = dueCount?.isReviewer === true;
  const openActive = pathname === "/reviews";
  const recentActive = pathname === "/reviews/recent";
  const reviewsActive = openActive || recentActive;
  const openLabel =
    dueCount && dueCount.count > 0
      ? `Open reviews, ${dueCount.count} due`
      : "Open reviews";

  if (collapsed) {
    return (
      <aside
        aria-label="Primary"
        data-collapsed="true"
        className={cn(
          "nav-scope bg-sidebar text-sidebar-foreground border-line flex w-(--sidebar-w-collapsed) shrink-0 flex-col border-r",
          className,
        )}
      >
        <div className="bg-surface border-line flex h-(--topbar-h) shrink-0 items-center justify-center border-b">
          <LogoMark />
        </div>

        <div className="flex shrink-0 flex-col items-center gap-2 px-2 pt-2">
          <CollapseToggle
            collapsed={collapsed}
            onCollapsedChange={onCollapsedChange}
            toggleLabel={toggleLabel}
          />
          <ProjectSwitcher collapsed />
        </div>

        <nav
          aria-label="Primary navigation"
          className="scrollarea flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-2"
        >
          <ProjectSections collapsed />
          <RailLink
            href={isReviewer ? "/reviews" : "/reviews/recent"}
            label={isReviewer ? openLabel : "Recently reviewed"}
            active={reviewsActive}
          >
            <span className="relative">
              <ClipboardCheck className="size-4" aria-hidden="true" />
              {dueCount && dueCount.count > 0 ? (
                <span
                  aria-hidden="true"
                  className="bg-danger absolute -top-1 -right-1 size-2 rounded-full"
                />
              ) : null}
            </span>
          </RailLink>
          {isAdmin ? (
            <>
              <RailLink
                href="/admin/settings"
                label="Settings"
                active={pathname.startsWith("/admin/settings")}
              >
                <Settings className="size-4" aria-hidden="true" />
              </RailLink>
              <RailLink
                href="/admin/diagnostics"
                aria-current={
                  pathname.startsWith("/admin/diagnostics") ? "page" : undefined
                }
                label="Diagnostics"
                active={pathname.startsWith("/admin/diagnostics")}
              >
                <Activity className="size-4" aria-hidden="true" />
              </RailLink>
              <RailLink
                href="/admin/projects"
                aria-current={
                  pathname.startsWith("/admin/projects") ? "page" : undefined
                }
                label="Projects"
                active={pathname.startsWith("/admin/projects")}
              >
                <FolderKanban className="size-4" aria-hidden="true" />
              </RailLink>
              <RailLink
                href="/admin/users"
                aria-current={
                  pathname.startsWith("/admin/users") ? "page" : undefined
                }
                label="Users"
                active={pathname.startsWith("/admin/users")}
              >
                <Users className="size-4" aria-hidden="true" />
              </RailLink>
            </>
          ) : null}
        </nav>

        <AppVersionFooter compact />
      </aside>
    );
  }

  return (
    <aside
      aria-label="Primary"
      className={cn(
        "nav-scope bg-sidebar text-sidebar-foreground border-line flex w-(--sidebar-w) shrink-0 flex-col border-r",
        className,
      )}
    >
      <div className="bg-surface border-line flex h-(--topbar-h) shrink-0 items-center justify-between gap-2 border-b pr-2 pl-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <LogoMark />
          <div className="min-w-0">
            <div className="text-text text-[15px] leading-tight font-semibold">
              Weaver
            </div>
            <div className="text-text-3 text-[12px]">Knowledge, connected</div>
          </div>
        </div>
        <CollapseToggle
          collapsed={collapsed}
          onCollapsedChange={onCollapsedChange}
          toggleLabel={toggleLabel}
        />
      </div>

      <div className="shrink-0 px-2 pt-2 pb-1">
        <ProjectSwitcher />
      </div>

      <nav
        aria-label="Primary navigation"
        className="scrollarea min-h-0 flex-1 overflow-y-auto px-2 py-1"
      >
        <ProjectSections />

        <NavSectionLabel>Reviews</NavSectionLabel>
        {isReviewer ? (
          <Link
            href="/reviews"
            aria-label={openLabel}
            aria-current={openActive ? "page" : undefined}
            className={cn(
              "text-text-2 hover:bg-hover hover:text-text flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px]",
              openActive && "bg-hover text-text",
            )}
          >
            <ClipboardCheck className="size-4 shrink-0" aria-hidden="true" />
            Open
            {dueCount && dueCount.count > 0 ? (
              <ReviewCountBadge count={dueCount.count} className="ml-auto" />
            ) : null}
          </Link>
        ) : null}
        <Link
          href="/reviews/recent"
          aria-current={recentActive ? "page" : undefined}
          className={cn(
            "text-text-2 hover:bg-hover hover:text-text flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px]",
            recentActive && "bg-hover text-text",
          )}
        >
          <History className="size-4 shrink-0" aria-hidden="true" />
          Recently reviewed
        </Link>

        {isAdmin ? (
          <>
            <NavSectionLabel>Administration</NavSectionLabel>
            <Link
              href="/admin/settings"
              aria-current={
                pathname.startsWith("/admin/settings") ? "page" : undefined
              }
              className={cn(
                "text-text-2 hover:bg-hover hover:text-text flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px]",
                pathname.startsWith("/admin/settings") && "bg-hover text-text",
              )}
            >
              <Settings className="size-4 shrink-0" aria-hidden="true" />
              Settings
            </Link>
            <Link
              href="/admin/diagnostics"
              aria-current={
                pathname.startsWith("/admin/diagnostics") ? "page" : undefined
              }
              className={cn(
                "text-text-2 hover:bg-hover hover:text-text flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px]",
                pathname.startsWith("/admin/diagnostics") &&
                  "bg-hover text-text",
              )}
            >
              <Activity className="size-4 shrink-0" aria-hidden="true" />
              Diagnostics
            </Link>
            <Link
              href="/admin/projects"
              aria-current={
                pathname.startsWith("/admin/projects") ? "page" : undefined
              }
              className={cn(
                "text-text-2 hover:bg-hover hover:text-text flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px]",
                pathname.startsWith("/admin/projects") && "bg-hover text-text",
              )}
            >
              <FolderKanban className="size-4 shrink-0" aria-hidden="true" />
              Projects
            </Link>
            <Link
              href="/admin/users"
              aria-current={
                pathname.startsWith("/admin/users") ? "page" : undefined
              }
              className={cn(
                "text-text-2 hover:bg-hover hover:text-text flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px]",
                pathname.startsWith("/admin/users") && "bg-hover text-text",
              )}
            >
              <Users className="size-4 shrink-0" aria-hidden="true" />
              Users
            </Link>
          </>
        ) : null}
      </nav>

      <AppVersionFooter />
    </aside>
  );
}
