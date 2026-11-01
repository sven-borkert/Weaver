"use client";

import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type Ref,
} from "react";

export type DocumentSourceViewProps = {
  value: string;
  onChange?: (value: string) => void;
  readOnly: boolean;
  open: boolean;
  regionRef?: Ref<HTMLElement>;
  inputRef?: Ref<HTMLTextAreaElement>;
  resetKey?: number;
};

export function DocumentSourceView({
  regionRef,
  resetKey = 0,
  ...props
}: DocumentSourceViewProps) {
  return (
    <section
      ref={regionRef}
      role="region"
      aria-label="Markdown source"
      tabIndex={-1}
      hidden={!props.open}
      inert={!props.open}
      className="w-full outline-none"
    >
      <SourceInput key={resetKey} {...props} />
    </section>
  );
}

function SourceInput({
  value,
  onChange,
  readOnly,
  open,
  inputRef,
}: Omit<DocumentSourceViewProps, "regionRef" | "resetKey">) {
  const input = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{
    value: string;
    start: number;
    end: number;
    direction: HTMLTextAreaElement["selectionDirection"];
  } | null>(null);
  const rememberSelection = useCallback((element: HTMLTextAreaElement) => {
    selection.current = {
      value: element.value,
      start: element.selectionStart,
      end: element.selectionEnd,
      direction: element.selectionDirection,
    };
  }, []);
  useImperativeHandle(inputRef, () => input.current!, []);
  useLayoutEffect(() => {
    const element = input.current;
    const saved = selection.current;
    if (!element || !saved) return;
    if (
      element.ownerDocument.activeElement !== element ||
      saved.value === value
    )
      return;
    const start = Math.min(saved.start, value.length);
    const end = Math.min(saved.end, value.length);
    element.setSelectionRange(start, end, saved.direction);
    selection.current = { ...saved, value, start, end };
  }, [value]);
  const resize = useCallback(() => {
    const element = input.current;
    if (!element) return;
    const workspace = element.closest<HTMLElement>(
      '[role="region"][aria-label="Document workspace"]',
    );
    const top = workspace?.scrollTop;
    const left = workspace?.scrollLeft;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    if (workspace && top !== undefined && left !== undefined) {
      workspace.scrollTop = top;
      workspace.scrollLeft = left;
    }
  }, []);
  useLayoutEffect(() => {
    if (open) resize();
  }, [value, open, resize]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? element.clientWidth;
      if (nextWidth <= 0 || nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);
  return (
    <textarea
      ref={input}
      aria-label="Document Markdown source"
      value={value}
      readOnly={readOnly}
      rows={1}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onSelect={(event) => rememberSelection(event.currentTarget)}
      onFocus={(event) => rememberSelection(event.currentTarget)}
      onChange={(event) => {
        if (!readOnly && open) {
          rememberSelection(event.currentTarget);
          onChange?.(event.currentTarget.value);
        }
      }}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.nativeEvent.isComposing ||
          event.defaultPrevented ||
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        event.currentTarget.blur();
      }}
      className="block min-h-[420px] w-full resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 font-mono text-base leading-relaxed outline-none"
    />
  );
}
