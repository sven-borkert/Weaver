import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// unpdf resolves pdf.js into a process-wide singleton (see
// packages/artifact-readers/src/pdf.ts's module comment and
// packages/ingestion/src/native/pdfReadersInteropReaderFirst.test.ts /
// pdfReadersInteropIngestionFirst.test.ts). Both packages configure the
// same pdfjs-dist legacy build; if their pins ever drift apart, pdf.js's
// strict API/worker version check breaks whichever package configures
// the singleton second, in whichever process runs both.
test("artifact-readers and ingestion pin identical unpdf and pdfjs-dist versions", () => {
  const readers = JSON.parse(
    readFileSync("packages/artifact-readers/package.json", "utf8"),
  );
  const ingestion = JSON.parse(
    readFileSync("packages/ingestion/package.json", "utf8"),
  );
  for (const pkg of ["unpdf", "pdfjs-dist"]) {
    const readersVersion = readers.dependencies[pkg];
    const ingestionVersion = ingestion.dependencies[pkg];
    assert.ok(
      readersVersion,
      `packages/artifact-readers must depend on ${pkg}`,
    );
    assert.ok(ingestionVersion, `packages/ingestion must depend on ${pkg}`);
    assert.doesNotMatch(
      readersVersion,
      /[\^~]/,
      `packages/artifact-readers's ${pkg} pin must be exact`,
    );
    assert.doesNotMatch(
      ingestionVersion,
      /[\^~]/,
      `packages/ingestion's ${pkg} pin must be exact`,
    );
    assert.equal(
      readersVersion,
      ingestionVersion,
      `${pkg}: packages/artifact-readers (${readersVersion}) and packages/ingestion (${ingestionVersion}) must pin the same version`,
    );
  }
});

// exceljs itself has no singleton-race hazard like unpdf/pdfjs-dist, but the
// two packages read/write the same .xlsx format; pinning identically keeps
// artifact-readers' Excel reader (packages/artifact-readers/src/excel.ts)
// verified against the same library version ingestion writes with.
test("artifact-readers and ingestion pin identical exceljs versions", () => {
  const readers = JSON.parse(
    readFileSync("packages/artifact-readers/package.json", "utf8"),
  );
  const ingestion = JSON.parse(
    readFileSync("packages/ingestion/package.json", "utf8"),
  );
  const readersVersion = readers.dependencies.exceljs;
  const ingestionVersion = ingestion.dependencies.exceljs;
  assert.ok(readersVersion, "packages/artifact-readers must depend on exceljs");
  assert.ok(ingestionVersion, "packages/ingestion must depend on exceljs");
  assert.doesNotMatch(
    readersVersion,
    /[\^~]/,
    "packages/artifact-readers's exceljs pin must be exact",
  );
  assert.doesNotMatch(
    ingestionVersion,
    /[\^~]/,
    "packages/ingestion's exceljs pin must be exact",
  );
  assert.equal(
    readersVersion,
    ingestionVersion,
    `exceljs: packages/artifact-readers (${readersVersion}) and packages/ingestion (${ingestionVersion}) must pin the same version`,
  );
});
