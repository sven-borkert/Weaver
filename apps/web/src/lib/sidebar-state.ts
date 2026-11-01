export const SIDEBAR_COOKIE_NAME = "weaver-sidebar";

const COLLAPSED_VALUE = "collapsed";
const EXPANDED_VALUE = "expanded";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function isSidebarCollapsedCookie(value: string | undefined): boolean {
  return value === COLLAPSED_VALUE;
}

export function serializeSidebarCookie(collapsed: boolean): string {
  const value = collapsed ? COLLAPSED_VALUE : EXPANDED_VALUE;
  return `${SIDEBAR_COOKIE_NAME}=${value}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}
