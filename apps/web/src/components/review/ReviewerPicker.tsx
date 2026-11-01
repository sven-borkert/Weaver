"use client";

import { X } from "lucide-react";
import { useId } from "react";

import { Button } from "~/components/ui/button";
import {
  toggleTarget,
  type ReviewerOption,
  type ReviewerTarget,
} from "./reviewer-options";

export function ReviewerPicker({
  options,
  value,
  onChange,
  disabled,
  unresolved,
  onRemoveUnresolved,
  "aria-label": ariaLabel,
}: {
  options: ReviewerOption[];
  value: ReviewerTarget[];
  onChange: (next: ReviewerTarget[]) => void;
  disabled?: boolean;
  /** Entries stored on the document that no longer resolve; shown with a remove button. */
  unresolved?: { type: "user" | "group"; id: string; name: string }[];
  onRemoveUnresolved?: (id: string) => void;
  "aria-label"?: string;
}) {
  const baseId = useId();
  return (
    <div className="flex flex-col gap-2">
      {unresolved?.map((entry) => (
        <div
          key={`${entry.type}:${entry.id}`}
          className="border-line flex items-center justify-between gap-2 rounded-[6px] border px-3 py-1.5"
        >
          <div className="flex flex-col">
            <span className="text-text text-[13px]">{entry.name}</span>
            <span className="text-text-3 text-[12px]">
              no longer in this project
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={`Remove ${entry.name}`}
            onClick={() => onRemoveUnresolved?.(entry.id)}
          >
            <X />
          </Button>
        </div>
      ))}
      <div
        role="group"
        aria-label={ariaLabel ?? "Reviewers"}
        className="border-line max-h-64 overflow-y-auto rounded-[6px] border"
      >
        {options.map((option) => {
          const id = `${baseId}-${option.type}-${option.id}`;
          const checked = value.some(
            (target) => target.type === option.type && target.id === option.id,
          );
          return (
            <label
              key={`${option.type}:${option.id}`}
              htmlFor={id}
              className="hover:bg-surface flex cursor-pointer items-start gap-2 px-3 py-1.5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
            >
              <input
                id={id}
                type="checkbox"
                className="mt-0.5"
                checked={checked}
                disabled={disabled}
                onChange={() =>
                  onChange(
                    toggleTarget(value, { type: option.type, id: option.id }),
                  )
                }
              />
              <span className="flex flex-col">
                <span className="text-text text-[13px]">{option.label}</span>
                <span className="text-text-3 text-[12px]">{option.detail}</span>
              </span>
            </label>
          );
        })}
        {options.length === 0 ? (
          <p className="text-text-3 m-0 px-3 py-2 text-[12px]">
            No reviewers available.
          </p>
        ) : null}
      </div>
    </div>
  );
}
