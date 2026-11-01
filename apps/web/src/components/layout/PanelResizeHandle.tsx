"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  PANEL_SPECS,
  dragPanelWidth,
  keyboardPanelWidth,
  type PanelWidths,
  type ResizablePanel,
} from "~/lib/panel-widths";
import { cn } from "~/lib/utils";

export type PanelWidthControls = {
  widths: PanelWidths;
  /** Applies a width while dragging without saving it. */
  preview: (panel: ResizablePanel, width: number) => void;
  /** Applies and remembers a width. */
  commit: (panel: ResizablePanel, width: number) => void;
};

export const PanelWidthsContext = createContext<PanelWidthControls | null>(
  null,
);

type Drag = {
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
};

/** Drag handle on a panel's inner edge; its parent element is the panel. */
export function PanelResizeHandle({
  panel,
  label,
  className,
}: {
  panel: ResizablePanel;
  label: string;
  className?: string;
}) {
  const controls = useContext(PanelWidthsContext);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  if (!controls) return null;
  const spec = PANEL_SPECS[panel];
  const width = controls.widths[panel];

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    delete document.documentElement.dataset.panelResizing;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.width !== current.startWidth)
      controls.commit(panel, current.width);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      data-panel-resize={panel}
      data-dragging={dragging || undefined}
      className={cn(
        "absolute inset-y-0 z-30 w-1.5 cursor-col-resize touch-none outline-none",
        "hover:before:bg-brand focus-visible:before:bg-brand data-[dragging]:before:bg-brand before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const startWidth = Math.round(
          event.currentTarget.parentElement?.getBoundingClientRect().width ??
            width,
        );
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth,
          width: startWidth,
        };
        setDragging(true);
        document.documentElement.dataset.panelResizing = "true";
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        current.width = dragPanelWidth(panel, {
          startWidth: current.startWidth,
          startX: current.startX,
          x: event.clientX,
          viewportWidth: window.innerWidth,
        });
        controls.preview(panel, current.width);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => controls.commit(panel, spec.default)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const next = keyboardPanelWidth(
          panel,
          width,
          event.key,
          window.innerWidth,
        );
        if (next === undefined) return;
        event.preventDefault();
        controls.commit(panel, next);
      }}
    />
  );
}
