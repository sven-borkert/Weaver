"use client";

import {
  NodeViewWrapper,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { imageWidth, MAX_IMAGE_WIDTH } from "@weaver/core/editor/imageTag";
import { Button } from "~/components/ui/button";
import { resolveDocumentImageUrl } from "~/lib/documents/image-url";
import { cn } from "~/lib/utils";
import { useDocumentEditingDisabled } from "./DocumentEditingContext";

const ImageContext = createContext({ projectId: "", documentPath: "" });

export function DocumentImageProvider({
  projectId,
  documentPath,
  children,
}: {
  projectId: string;
  documentPath: string;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ projectId, documentPath }),
    [projectId, documentPath],
  );
  return <ImageContext value={value}>{children}</ImageContext>;
}

const MIN_DRAG_WIDTH = 48;
const PRESETS = [25, 50, 75, 100] as const;
const SIDES = ["left", "right"] as const;
type Side = (typeof SIDES)[number];

/** A dragged width in whole pixels, kept usable and inside the text column. */
export function clampImageWidth(width: number, column: number): number {
  const max = Math.min(Math.max(column, MIN_DRAG_WIDTH), MAX_IMAGE_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_DRAG_WIDTH), max));
}

type Drag = { pointerId: number; startX: number; startWidth: number };

export function DocumentImageNodeView({
  node,
  selected,
  editor,
  updateAttributes,
}: Pick<ReactNodeViewProps, "node"> &
  Partial<
    Pick<ReactNodeViewProps, "selected" | "editor" | "updateAttributes">
  >) {
  const context = useContext(ImageContext);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const parentDisabled = useDocumentEditingDisabled();
  const editable = useEditorState({
    editor: editor ?? null,
    selector: ({ editor: current }) => current?.isEditable ?? false,
  });
  const resizable =
    Boolean(selected) &&
    Boolean(editable) &&
    !parentDisabled &&
    !!updateAttributes;
  // Handles that unmount mid-drag never see the release, so the drag ends here.
  if (!resizable && preview !== null) setPreview(null);
  useEffect(() => {
    if (!resizable) drag.current = null;
  }, [resizable]);
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const stored = imageWidth(node.attrs.width);

  const column = () =>
    image.current?.closest("[data-image-column]")?.clientWidth ?? 0;
  const commit = (width: number | null) => {
    if (editor && !editor.isDestroyed && editor.isEditable)
      updateAttributes?.({ width });
  };
  const dragged = (side: Side, clientX: number) => {
    const { startX, startWidth } = drag.current!;
    const delta = clientX - startX;
    return clampImageWidth(
      startWidth + (side === "right" ? delta : -delta),
      column(),
    );
  };
  const end = (event: PointerEvent<HTMLButtonElement>) => {
    drag.current = null;
    setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleProps = (side: Side) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !image.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: image.current.getBoundingClientRect().width,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      if (event.clientX !== drag.current.startX || preview !== null)
        setPreview(dragged(side, event.clientX));
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const moved = preview !== null || event.clientX !== drag.current.startX;
      const width = dragged(side, event.clientX);
      end(event);
      if (moved) commit(width);
    },
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => {
      if (drag.current?.pointerId === event.pointerId) end(event);
    },
    onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => {
      if (drag.current?.pointerId === event.pointerId) end(event);
    },
  });

  const url = resolveDocumentImageUrl({ ...context, src });
  if (!url)
    return (
      <NodeViewWrapper contentEditable={false} data-drag-handle>
        <span
          role="img"
          aria-label="Unavailable image"
          className="border-line bg-subtle text-text-2 inline-flex rounded border px-2 text-xs"
        >
          Image unavailable
        </span>
      </NodeViewWrapper>
    );

  return (
    <NodeViewWrapper contentEditable={false} data-drag-handle data-image-column>
      <div
        className={cn(
          "relative w-fit max-w-full rounded-lg",
          selected && "ring-brand ring-2",
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- User images require authenticated document URLs. */}
        <img
          ref={image}
          src={url}
          data-weaver-src={src}
          draggable={false}
          alt={typeof node.attrs.alt === "string" ? node.attrs.alt : ""}
          title={
            typeof node.attrs.title === "string" ? node.attrs.title : undefined
          }
          width={stored ?? undefined}
          style={preview === null ? undefined : { width: preview }}
        />
        {resizable
          ? SIDES.map((side) => (
              // A button, so the editor leaves its pointer events alone.
              <button
                key={side}
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                data-resize-handle={side}
                className={cn(
                  "border-brand bg-surface absolute bottom-0 z-10 size-4 touch-none rounded-full border-2",
                  side === "left"
                    ? "left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"
                    : "right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
                )}
                {...handleProps(side)}
              />
            ))
          : null}
        {resizable ? (
          <div
            role="group"
            aria-label="Image size"
            className="border-line bg-surface absolute top-2 left-2 z-10 flex w-max max-w-[calc(100vw-4rem)] flex-wrap gap-1 rounded-lg border p-1 shadow-sm"
          >
            {PRESETS.map((percent) => (
              <Button
                key={percent}
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Set image width to ${percent}%`}
                onClick={() => {
                  const width = imageWidth(
                    Math.round((column() * percent) / 100),
                  );
                  if (width !== null) commit(width);
                }}
              >
                {percent}%
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label="Reset image size"
              disabled={stored === null}
              onClick={() => commit(null)}
            >
              Reset size
            </Button>
          </div>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}
