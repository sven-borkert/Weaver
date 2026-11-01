"use client";

import { Maximize2, Minimize2, X } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { useAssistant } from "./AssistantProvider";

const FULL_SCREEN_KEY = "weaver.assistant.fullScreen";

// The choice made in this tab wins; storage only seeds it and may be unavailable.
let chosen: boolean | null = null;
const listeners = new Set<() => void>();
function subscribeFullScreen(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
function readFullScreen(): boolean {
  if (chosen !== null) return chosen;
  try {
    return localStorage.getItem(FULL_SCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

type AssistantPanelProps = {
  children: React.ReactNode;
  /** Focus returns here when the panel closes. */
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
};

export function AssistantPanel({
  children,
  returnFocusRef,
}: AssistantPanelProps) {
  const { open, setOpen, composerRef } = useAssistant();
  const fullScreen = useSyncExternalStore(
    subscribeFullScreen,
    readFullScreen,
    () => false,
  );
  const toggleFullScreen = () => {
    chosen = !fullScreen;
    try {
      localStorage.setItem(FULL_SCREEN_KEY, chosen ? "1" : "0");
    } catch {
      // Not remembered across reloads, still toggled.
    }
    listeners.forEach((listener) => listener());
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-label="Assistant"
        showCloseButton={false}
        className={cn(
          "bg-surface grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0",
          fullScreen
            ? "h-dvh w-screen max-w-none rounded-none sm:max-w-none"
            : "h-[min(56rem,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-6xl sm:max-w-6xl",
        )}
        onOpenAutoFocus={(event) => {
          if (composerRef.current && !composerRef.current.disabled) {
            event.preventDefault();
            composerRef.current.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogHeader className="border-line border-b px-4 py-2.5 pr-20">
          <DialogTitle>Assistant</DialogTitle>
          <DialogDescription className="sr-only">
            You can close this window. Active runs continue in the background.
          </DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-11"
            aria-label={fullScreen ? "Exit full screen" : "Full screen"}
            aria-pressed={fullScreen}
            title={fullScreen ? "Exit full screen" : "Full screen"}
            onClick={toggleFullScreen}
          >
            {fullScreen ? (
              <Minimize2 aria-hidden="true" />
            ) : (
              <Maximize2 aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-3"
            aria-label="Close assistant"
            title="Close (runs continue in the background)"
            onClick={() => setOpen(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </DialogHeader>
        <div className="flex min-h-0 flex-col">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
