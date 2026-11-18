import type { UseFormRegisterReturn } from "react-hook-form";

export function KeepOutOfGitField({
  field,
  disabled,
}: {
  field: UseFormRegisterReturn<"keepOutOfGit">;
  disabled: boolean;
}) {
  return (
    <label className="text-text flex min-h-8 items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="accent-brand size-4 shrink-0"
        disabled={disabled}
        {...field}
      />
      Keep out of Git
    </label>
  );
}
