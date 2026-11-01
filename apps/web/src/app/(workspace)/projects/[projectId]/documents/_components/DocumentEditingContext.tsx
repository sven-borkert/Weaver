"use client";

import { createContext, useContext, type ReactNode } from "react";

const DocumentEditingContext = createContext(false);

export function DocumentEditingProvider({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <DocumentEditingContext value={disabled}>{children}</DocumentEditingContext>
  );
}

export function useDocumentEditingDisabled() {
  return useContext(DocumentEditingContext);
}
