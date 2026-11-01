"use client";

import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { Textarea } from "~/components/ui/textarea";

export function ExamTextarea({
  ref,
  value,
  ...props
}: ComponentProps<typeof Textarea> & { value: string }) {
  const element = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const textarea = element.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value]);
  return (
    <Textarea
      {...props}
      value={value}
      className="field-sizing-fixed resize-none overflow-hidden"
      ref={(node) => {
        element.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
    />
  );
}
