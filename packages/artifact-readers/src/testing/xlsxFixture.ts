/**
 * Builds a minimal in-memory workbook for exercising the Excel reader.
 * Test support only: not exported outside the testing subpath.
 */
import ExcelJS from "exceljs";

export async function buildXlsx(
  sheets: Array<{ name: string; rows: unknown[][] }>,
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    workbook.addWorksheet(sheet.name).addRows(sheet.rows);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
