"use client";

import { Menu } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Sidebar } from "./Sidebar";

export function MobileNavigation() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open navigation"
          className="shrink-0 md:hidden"
        >
          <Menu aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const link = (event.target as Element).closest("a[href]");
          if (
            link &&
            !link.hasAttribute("download") &&
            !link.getAttribute("target")
          )
            setOpen(false);
        }}
        className="bg-sidebar top-0 left-0 flex h-dvh max-h-dvh w-(--sidebar-w) max-w-[calc(100vw-2rem)] translate-x-0 translate-y-0 gap-0 rounded-none p-0 sm:max-w-[calc(100vw-2rem)] md:hidden"
      >
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <DialogDescription className="sr-only">
          Browse your projects and account pages.
        </DialogDescription>
        <Sidebar
          collapsed={false}
          onCollapsedChange={() => setOpen(false)}
          toggleLabel="Close navigation"
          className="w-full"
        />
      </DialogContent>
    </Dialog>
  );
}
