import { themeQuartz } from "ag-grid-community";

export const weaverTableTheme = themeQuartz.withParams({
  backgroundColor: "var(--color-surface)",
  foregroundColor: "var(--color-text)",
  headerBackgroundColor: "var(--color-surface-2)",
  headerTextColor: "var(--color-text-2)",
  borderColor: "var(--color-line)",
  rowHoverColor: "var(--color-hover)",
  selectedRowBackgroundColor: "var(--color-brand-bg)",
  accentColor: "var(--color-brand)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  spacing: 6,
});
