"use client";

import { useMemo } from "react";
import { pythonDefinitions } from "@weaver/core/documents/pythonOutline";
import { cn } from "~/lib/utils";

export function PythonOutlinePanel({
  text,
  navigable,
  onSelect,
}: {
  text: string;
  navigable: boolean;
  onSelect: (line: number) => void;
}) {
  const definitions = useMemo(() => pythonDefinitions(text), [text]);
  if (definitions.length === 0)
    return (
      <p className="text-text-3 m-0 p-3 py-6 text-center text-[12px]">
        This file has no top-level functions or classes.
      </p>
    );
  return (
    <nav aria-label="Definitions" className="p-3">
      {navigable ? null : (
        <p className="text-text-3 mt-0 mb-2 text-[12px]">
          Return to the file to jump to a definition.
        </p>
      )}
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {definitions.map((definition, index) => (
          <li key={`${definition.kind}:${definition.name}:${index}`}>
            <button
              type="button"
              disabled={!navigable}
              title={`${definition.kind} ${definition.name}`}
              onClick={() => onSelect(definition.line)}
              className={cn(
                "text-text-2 hover:bg-hover focus-visible:ring-brand/50 block w-full truncate rounded-[6px] py-1 pr-2 pl-2 text-left text-[12px] leading-5 outline-none focus-visible:ring-3 disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:py-2",
                definition.kind === "class" && "text-text font-medium",
              )}
            >
              <span className="text-text-3 mr-1 font-mono">
                {definition.kind}
              </span>
              {definition.name}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
