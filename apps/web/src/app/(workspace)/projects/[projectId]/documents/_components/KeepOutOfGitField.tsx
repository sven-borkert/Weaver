import type { UseFormRegisterReturn } from "react-hook-form";

/** Chooses Git-ignored storage; `forced` inside a folder that is already outside Git. */
export function KeepOutOfGitField({
  field,
  disabled,
  forced = false,
}: {
  field: UseFormRegisterReturn<"keepOutOfGit">;
  disabled: boolean;
  forced?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-text flex min-h-8 items-center gap-2 text-sm">
        {forced ? (
          <input
            type="checkbox"
            className="accent-brand size-4 shrink-0"
            checked
            disabled
            readOnly
          />
        ) : (
          <input
            type="checkbox"
            className="accent-brand size-4 shrink-0"
            disabled={disabled}
            {...field}
          />
        )}
        Keep out of Git
      </label>
      <p className="text-text-3 m-0 text-[12px]">
        {forced
          ? "This folder is outside Git, so everything in it is too."
          : "Shown and edited here like any document, but never committed, versioned or pushed."}
      </p>
    </div>
  );
}
