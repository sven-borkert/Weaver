// Light-theme copy of the viewer's typography; tokens fixed so the PDF never depends on a user theme.
export const PRINT_STYLES = `
:root {
  --text: #15243b; --text-2: #52647e; --line: #dce4ef; --line-strong: #b6c6dc;
  --subtle: #edf2f8; --surface-2: #edf2f8; --brand-text: #124cc4;
  --info: #155eef; --info-bg: #eaf2ff; --info-border: #a9c8fa;
  --approved: #1f7a3f; --approved-bg: #ecf7ef; --approved-border: #bfe3cb; --approved-dot: #2f9e57;
  --warning: #9a6300; --warning-bg: #fdf6e7; --warning-border: #f1dfb0;
  --danger: #b3261e; --danger-bg: #fdeeed; --danger-border: #f3c5c1;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
}
@page { size: A4 portrait; margin: 20mm; }
html { color: var(--text); font: 11pt/1.55 -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
body { margin: 0; }
h1.title { font-size: 22pt; line-height: 1.2; margin: 0 0 4pt; }
p.meta { color: var(--text-2); font-size: 9pt; margin: 0 0 18pt; }
.document-prose :where(h1, h2, h3, h4, h5, h6) { line-height: 1.25; margin: 1.4em 0 0.5em; break-after: avoid; }
.document-prose :where(h1) { font-size: 18pt; }
.document-prose :where(h2) { font-size: 15pt; }
.document-prose :where(h3) { font-size: 13pt; }
.document-prose :where(h4, h5, h6) { font-size: 11pt; }
.document-prose :where(p) { margin: 0 0 1em; }
.document-prose :where(ul, ol) { margin: 0 0 1em; padding-inline-start: 1.5em; }
.document-prose :where(ul) { list-style: disc; }
.document-prose :where(ol) { list-style: decimal; }
.document-prose :where(li) { margin: 0.25em 0; }
.document-prose :where(li > p) { margin: 0; }
.document-prose :where(ul[data-type="taskList"]) { list-style: none; padding-inline-start: 0; }
.document-prose :where(ul[data-type="taskList"] > li) { display: flex; gap: 0.5em; }
.document-prose :where(ul[data-type="taskList"] input) { margin: 0.35em 0 0; }
.document-prose :where(a) { color: var(--brand-text); text-decoration: underline; }
.document-prose :where(blockquote) { border-inline-start: 3px solid var(--line-strong); color: var(--text-2); margin: 1.25em 0; padding-inline-start: 1rem; }
.document-prose :where(code) { background: var(--subtle); border: 1px solid var(--line); border-radius: 4px; font-family: var(--font-mono); font-size: 0.9em; padding: 0.1em 0.3em; }
.document-prose :where(pre) { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; margin: 1.25em 0; padding: 1rem; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
.document-prose :where(pre code) { background: transparent; border: 0; padding: 0; }
.document-prose :where(pre.mermaid) { background: transparent; border: 0; padding: 0; text-align: center; }
.document-prose :where(pre.mermaid svg) { max-width: 100%; height: auto; }
.document-prose :where(table) { border-collapse: collapse; margin: 1.25em 0; width: 100%; }
.document-prose :where(th, td) { border: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: start; vertical-align: top; }
.document-prose :where(th) { background: var(--surface-2); color: var(--text-2); font-weight: 600; }
.document-prose :where(tr) { break-inside: avoid; }
.document-prose :where(img) { display: block; height: auto; margin: 1.25em 0; max-width: 100%; border-radius: 8px; }
.document-prose :where(.image-missing) { border: 1px dashed var(--line-strong); border-radius: 8px; color: var(--text-2); font-size: 9pt; margin: 1.25em 0; padding: 0.75rem 1rem; }
.document-prose :where(.crossref) { color: var(--brand-text); text-decoration: underline dotted; }
.document-prose :where([data-callout]) { --callout-accent: var(--info); --callout-label: var(--info); --callout-bg: var(--info-bg); --callout-border: var(--info-border);
  background: var(--callout-bg); border: 1px solid var(--callout-border); border-inline-start: 4px solid var(--callout-accent); border-radius: 8px; color: var(--text-2); margin: 1.25em 0; padding: 0.625rem 1rem 0.75rem; break-inside: avoid; }
.document-prose :where([data-callout])::before { color: var(--callout-label); content: "Note"; display: block; font-size: 9pt; font-weight: 600; letter-spacing: 0.02em; margin-bottom: 0.375rem; }
.document-prose :where([data-callout="TIP"]) { --callout-accent: var(--approved-dot); --callout-label: var(--approved); --callout-bg: var(--approved-bg); --callout-border: var(--approved-border); }
.document-prose :where([data-callout="TIP"])::before { content: "Tip"; }
.document-prose :where([data-callout="IMPORTANT"]) { --callout-accent: #6b46c1; --callout-label: #6b46c1; --callout-bg: #f3effb; --callout-border: #d9cff2; }
.document-prose :where([data-callout="IMPORTANT"])::before { content: "Important"; }
.document-prose :where([data-callout="WARNING"]) { --callout-accent: var(--warning); --callout-label: var(--warning); --callout-bg: var(--warning-bg); --callout-border: var(--warning-border); }
.document-prose :where([data-callout="WARNING"])::before { content: "Warning"; }
.document-prose :where([data-callout="CAUTION"]) { --callout-accent: var(--danger); --callout-label: var(--danger); --callout-bg: var(--danger-bg); --callout-border: var(--danger-border); }
.document-prose :where([data-callout="CAUTION"])::before { content: "Caution"; }
`;
