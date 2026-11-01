"use client";

import type { Editor } from "@tiptap/core";
import { ChevronDown, Ellipsis } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type RefObject } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useToolbarOverflow } from "~/lib/editor/use-toolbar-overflow";
import { cn } from "~/lib/utils";
import {
  documentToolbarGroups,
  type DocumentCommand,
  type ToolbarCloseFocus,
  type ToolbarControl,
  type ToolbarGroup,
  type ToolbarMenuEntry,
} from "./document-toolbar-groups";
import { DocumentToolbarButton } from "./DocumentToolbarButton";

const MORE_MENU_ID = "more";

type ToolbarMenus = {
  openMenu: string | null;
  onOpenChange: (id: string, open: boolean) => void;
  /** `trigger` is the menu's own trigger, which may have collapsed or unmounted. */
  onCloseAutoFocus: (event: Event, trigger: HTMLElement | null) => void;
  select: (
    closeFocus: ToolbarCloseFocus | undefined,
    action: () => void,
  ) => void;
};

const menuContentClass = "w-auto min-w-44";
const menuItemClass = "pointer-coarse:min-h-11";

function MenuEntries({
  entries,
  menus,
}: {
  entries: ToolbarMenuEntry[];
  menus: ToolbarMenus;
}) {
  return entries.map((entry, index) => {
    if (entry.kind === "separator")
      return <DropdownMenuSeparator key={`separator-${index}`} />;
    if (entry.kind === "radio")
      return (
        <DropdownMenuRadioGroup
          key={entry.label}
          aria-label={entry.label}
          value={entry.value}
        >
          {entry.options.map(
            ({ value, label, icon: Icon, disabled, onSelect }) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                disabled={disabled}
                className={menuItemClass}
                onSelect={() => menus.select("editor", onSelect)}
              >
                {Icon ? <Icon aria-hidden="true" /> : null}
                {label}
              </DropdownMenuRadioItem>
            ),
          )}
        </DropdownMenuRadioGroup>
      );
    const Icon = entry.icon;
    return (
      <DropdownMenuItem
        key={entry.label}
        disabled={entry.disabled}
        className={menuItemClass}
        onSelect={() => menus.select(entry.closeFocus, entry.onSelect)}
      >
        {Icon ? <Icon aria-hidden="true" /> : null}
        {entry.label}
      </DropdownMenuItem>
    );
  });
}

function ToolbarMenu({
  control,
  menus,
}: {
  control: Extract<ToolbarControl, { kind: "menu" }>;
  menus: ToolbarMenus;
}) {
  const Icon = control.icon;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <DropdownMenu
      modal={false}
      open={menus.openMenu === control.id}
      onOpenChange={(open) => menus.onOpenChange(control.id, open)}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant={control.active ? "secondary" : "ghost"}
          className={cn(
            "h-8 gap-0.5 px-1.5 pointer-coarse:h-11 pointer-coarse:min-w-11",
            control.id === "text-style" && "w-28 justify-between px-2",
          )}
          aria-label={control.label}
          title={control.label}
          data-active={control.active ? true : undefined}
          disabled={control.disabled}
        >
          {Icon ? <Icon aria-hidden="true" /> : null}
          {control.text ? (
            <span className="max-w-24 truncate px-0.5">{control.text}</span>
          ) : null}
          <ChevronDown aria-hidden="true" className="text-text-3 size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-document-toolbar-menu
        className={menuContentClass}
        onCloseAutoFocus={(event) =>
          menus.onCloseAutoFocus(event, triggerRef.current)
        }
      >
        <MenuEntries entries={control.entries} menus={menus} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolbarGroupControls({
  group,
  menus,
}: {
  group: ToolbarGroup;
  menus: ToolbarMenus;
}) {
  return group.controls.map((control) => {
    if (control.kind === "menu")
      return <ToolbarMenu key={control.id} control={control} menus={menus} />;
    const Icon = control.icon;
    return (
      <DocumentToolbarButton
        key={control.label}
        label={control.label}
        active={control.active}
        disabled={control.disabled}
        onClick={control.onSelect}
      >
        <Icon />
      </DocumentToolbarButton>
    );
  });
}

function ToolbarOverflowMenu({
  groups,
  disabled,
  menus,
  triggerRef,
}: {
  groups: ToolbarGroup[];
  disabled: boolean;
  menus: ToolbarMenus;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <DropdownMenu
      modal={false}
      open={menus.openMenu === MORE_MENU_ID}
      onOpenChange={(open) => menus.onOpenChange(MORE_MENU_ID, open)}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 pointer-coarse:size-11"
          aria-label="More formatting options"
          title="More formatting options"
          disabled={disabled}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-document-toolbar-menu
        align="end"
        className={menuContentClass}
        onCloseAutoFocus={(event) =>
          menus.onCloseAutoFocus(event, triggerRef.current)
        }
      >
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup aria-label={group.label}>
              {group.controls.map((control) => {
                if (control.kind === "menu") {
                  const MenuIcon = control.icon;
                  return (
                    <DropdownMenuSub key={control.id}>
                      <DropdownMenuSubTrigger
                        aria-label={control.label}
                        disabled={control.disabled}
                        className={menuItemClass}
                      >
                        {MenuIcon ? <MenuIcon aria-hidden="true" /> : null}
                        {control.label}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        data-document-toolbar-menu
                        className={menuContentClass}
                      >
                        <MenuEntries entries={control.entries} menus={menus} />
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  );
                }
                const Icon = control.icon;
                const select = () =>
                  menus.select(control.closeFocus, control.onSelect);
                return control.active === undefined ? (
                  <DropdownMenuItem
                    key={control.label}
                    disabled={control.disabled}
                    className={menuItemClass}
                    onSelect={select}
                  >
                    <Icon aria-hidden="true" />
                    {control.label}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuCheckboxItem
                    key={control.label}
                    checked={control.active}
                    disabled={control.disabled}
                    className={menuItemClass}
                    onSelect={select}
                  >
                    <Icon aria-hidden="true" />
                    {control.label}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Formatting groups on one line; groups that do not fit move into the More menu. */
export function DocumentFormattingControls({
  editor,
  locked,
  run,
  onLink,
  onImage,
  onReference,
  onMermaid,
  canOpenMenu,
  onCommandMenuClosed,
  onMenuOpenChange,
}: {
  editor: Editor;
  locked: boolean;
  run: (command: DocumentCommand) => void;
  onLink: () => void;
  onImage: () => void;
  onReference: () => void;
  onMermaid?: () => void;
  canOpenMenu: () => boolean;
  /** Restores the editor selection and focus after a menu command. */
  onCommandMenuClosed: (event: Event) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const closeFocus = useRef<ToolbarCloseFocus | null>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const groups = documentToolbarGroups({
    editor,
    disabled: locked,
    run,
    onLink,
    onImage,
    onReference,
    onMermaid,
  });
  const { rowRef, visible } = useToolbarOverflow(
    groups.map((group) => group.id).join(" "),
  );
  const overflow = groups.slice(Math.min(visible, groups.length));
  const available = groups
    .slice(0, visible)
    .flatMap((group) =>
      group.controls.flatMap((control) =>
        control.kind === "menu" ? [control.id] : [],
      ),
    );
  if (overflow.length) available.push(MORE_MENU_ID);
  // A menu whose trigger collapsed or disappeared can no longer report closing.
  if (openMenu !== null && !available.includes(openMenu)) setOpenMenu(null);
  const menuOpen = openMenu !== null;
  useEffect(() => {
    onMenuOpenChange(menuOpen);
  }, [menuOpen, onMenuOpenChange]);

  const menus: ToolbarMenus = {
    openMenu,
    onOpenChange: (menu, open) => {
      if (open && !canOpenMenu()) return;
      if (open) {
        closeFocus.current = null;
        afterClose.current = null;
      }
      setOpenMenu((current) =>
        open ? menu : current === menu ? null : current,
      );
    },
    onCloseAutoFocus: (event, trigger) => {
      const target = closeFocus.current;
      const action = afterClose.current;
      closeFocus.current = null;
      afterClose.current = null;
      if (target === "editor") onCommandMenuClosed(event);
      else if (target === "keep") event.preventDefault();
      // Radix still returns focus to the trigger; the action may then move it on.
      else if (target === "after-close") action?.();
      else if (!trigger?.isConnected || trigger.closest("[inert]")) {
        // Radix would focus an inert or detached trigger and drop focus on body.
        const more = moreRef.current;
        if (more?.isConnected && !more.disabled) {
          event.preventDefault();
          more.focus();
        } else onCommandMenuClosed(event);
      }
    },
    select: (target, action) => {
      closeFocus.current = target ?? "editor";
      if (target === "after-close") afterClose.current = action;
      else action();
    },
  };

  return (
    <>
      <div
        ref={rowRef}
        className="relative flex h-10 min-w-0 flex-1 flex-wrap content-start items-center overflow-hidden p-1 pointer-coarse:h-13"
      >
        {groups.map((group, index) => {
          const hidden = index >= visible;
          return (
            <div
              key={group.id}
              role="group"
              aria-label={group.label}
              data-toolbar-group={group.id}
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex shrink-0 items-center gap-0.5",
                hidden && "invisible",
              )}
            >
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className="bg-line mx-1 h-5 w-px shrink-0"
                />
              ) : null}
              <ToolbarGroupControls group={group} menus={menus} />
            </div>
          );
        })}
      </div>
      {overflow.length ? (
        <ToolbarOverflowMenu
          groups={overflow}
          disabled={locked}
          menus={menus}
          triggerRef={moreRef}
        />
      ) : null}
    </>
  );
}
