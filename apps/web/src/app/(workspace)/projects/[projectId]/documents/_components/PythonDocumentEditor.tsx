"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "~/components/ui/skeleton";
import type { PythonDocumentEditorProps } from "./PythonDocumentEditorImpl";

const Impl = dynamic(
  () =>
    import("./PythonDocumentEditorImpl").then(
      (m) => m.PythonDocumentEditorImpl,
    ),
  {
    ssr: false,
    loading: () => (
      <article className="w-full px-6 py-8">
        <div role="status" aria-label="Preparing code editor">
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="mt-4 h-64 w-full" />
        </div>
      </article>
    ),
  },
);

export function PythonDocumentEditor(props: PythonDocumentEditorProps) {
  return <Impl {...props} />;
}
