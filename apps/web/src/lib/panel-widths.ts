import { APP_BASE_PATH } from "./basePath";

export type ResizablePanel = "sidebar" | "contextRail";
export type PanelWidths = Record<ResizablePanel, number>;

type PanelSpec = {
  cookie: string;
  min: number;
  max: number;
  default: number;
  /** Share of the window the panel may take, never below its default. */
  viewportShare: number;
  /** +1 when dragging right widens the panel (left sidebar), -1 for right rails. */
  direction: 1 | -1;
};

export const PANEL_SPECS: Record<ResizablePanel, PanelSpec> = {
  sidebar: {
    cookie: "weaver-sidebar-width",
    min: 200,
    max: 400,
    default: 278,
    viewportShare: 0.35,
    direction: 1,
  },
  contextRail: {
    cookie: "weaver-context-rail-width",
    min: 260,
    max: 560,
    default: 320,
    viewportShare: 0.4,
    direction: -1,
  },
};

export const PANEL_WIDTH_COOKIES = {
  sidebar: PANEL_SPECS.sidebar.cookie,
  contextRail: PANEL_SPECS.contextRail.cookie,
};

export const DEFAULT_PANEL_WIDTHS: PanelWidths = {
  sidebar: PANEL_SPECS.sidebar.default,
  contextRail: PANEL_SPECS.contextRail.default,
};

const KEYBOARD_STEP = 16;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(Math.round(value), min), max);

export function parsePanelWidthCookie(
  panel: ResizablePanel,
  value: string | undefined,
): number {
  const spec = PANEL_SPECS[panel];
  const width = Number.parseFloat(value ?? "");
  return Number.isFinite(width)
    ? clamp(width, spec.min, spec.max)
    : spec.default;
}

export function serializePanelWidthCookie(
  panel: ResizablePanel,
  width: number,
  basePath = APP_BASE_PATH,
): string {
  const spec = PANEL_SPECS[panel];
  return `${spec.cookie}=${clamp(width, spec.min, spec.max)}; Path=${basePath || "/"}; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

/** Mirrors the CSS cap in globals.css (`[data-app-shell]`). */
export function maxPanelWidth(
  panel: ResizablePanel,
  viewportWidth: number,
): number {
  const spec = PANEL_SPECS[panel];
  return Math.round(
    Math.min(
      spec.max,
      Math.max(spec.default, viewportWidth * spec.viewportShare),
    ),
  );
}

export function dragPanelWidth(
  panel: ResizablePanel,
  drag: {
    startWidth: number;
    startX: number;
    x: number;
    viewportWidth: number;
  },
): number {
  const spec = PANEL_SPECS[panel];
  return clamp(
    drag.startWidth + spec.direction * (drag.x - drag.startX),
    spec.min,
    maxPanelWidth(panel, drag.viewportWidth),
  );
}

export function keyboardPanelWidth(
  panel: ResizablePanel,
  width: number,
  key: string,
  viewportWidth: number,
): number | undefined {
  const move = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : undefined;
  if (move === undefined) return undefined;
  const spec = PANEL_SPECS[panel];
  const max = maxPanelWidth(panel, viewportWidth);
  return clamp(
    Math.min(width, max) + spec.direction * move * KEYBOARD_STEP,
    spec.min,
    max,
  );
}
