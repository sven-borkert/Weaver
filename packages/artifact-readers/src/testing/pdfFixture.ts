/**
 * Builds a minimal but structurally valid PDF (correct xref offsets) with one
 * Helvetica text line per page, for exercising the PDF reader.
 */
function escapePdfText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function buildTestPdf(pageTexts: string[]): Buffer {
  const objBodies = new Map<number, string>();
  let next = 4;
  const pages = pageTexts.map((text) => ({
    pageNum: next++,
    contentNum: next++,
    text,
  }));

  objBodies.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objBodies.set(
    2,
    `<< /Type /Pages /Kids [${pages.map((p) => `${p.pageNum} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  objBodies.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const p of pages) {
    objBodies.set(
      p.pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${p.contentNum} 0 R >>`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(p.text)}) Tj ET`;
    objBodies.set(
      p.contentNum,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }

  const totalObjs = 3 + pages.length * 2;
  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (let n = 1; n <= totalObjs; n++) {
    offsets.set(n, out.length);
    out += `${n} 0 obj\n${objBodies.get(n)}\nendobj\n`;
  }
  const xrefOffset = out.length;
  out += `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n++) {
    out += `${String(offsets.get(n)).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
