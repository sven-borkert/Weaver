"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PdfRuntimeStatus } from "~/lib/documents/pdf-runtime-status";

export type RuntimeStatus = { pdf: PdfRuntimeStatus };

const RuntimeStatusContext = createContext<RuntimeStatus>({
  pdf: { status: "ok" },
});

export function RuntimeStatusProvider({
  value,
  children,
}: {
  value: RuntimeStatus;
  children: ReactNode;
}) {
  return (
    <RuntimeStatusContext.Provider value={value}>
      {children}
    </RuntimeStatusContext.Provider>
  );
}

export function useRuntimeStatus(): RuntimeStatus {
  return useContext(RuntimeStatusContext);
}
