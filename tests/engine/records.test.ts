import { test } from "node:test";

import type { QuartoMdCell } from "@quarto/types";

import { assertEquals } from "../assert.ts";
import { cellOwnedByMarimo } from "../../src/engine/authoring.ts";
import {
  buildMarimoRecord,
  MARIMO_HASH_DEFINITION,
  type WireUnit,
} from "../../src/engine/records.ts";

function chunk(language: string | "markdown", text: string): QuartoMdCell {
  return {
    cell_type: language === "markdown" ? "markdown" : { language },
    sourceVerbatim: { value: text },
    source: { value: text },
  } as unknown as QuartoMdCell;
}

const MARKDOWN = (text: string) => chunk("markdown", text);

// A document: prose (lines 1-2), a tagged cell (3-5), prose (6), a bare python cell (7-9),
// prose (10), a tagged cell (11-13).
function mixedChunks(): QuartoMdCell[] {
  return [
    MARKDOWN("# Title\n\n"),
    chunk("python", "```{python .marimo}\n1 + 1\n```\n"),
    MARKDOWN("\n"),
    chunk("python", "```{python}\n2 + 2\n```\n"),
    MARKDOWN("\n"),
    chunk("python", "```{python .marimo}\n3 + 3\n```\n"),
  ];
}

const owned = (cell: QuartoMdCell) => cellOwnedByMarimo(cell, undefined);

function unit(line: number, id: string | undefined, isOwned = true): WireUnit {
  return { id, index: 0, kind: "cell", language: "python", line, owned: isOwned };
}

const MIME = "text/x-quarto-markdown";

// ---- ownership: positive `ownedLanguages` when present ----

function bareSql(): QuartoMdCell {
  return chunk("sql", "```{sql}\nselect 1\n```\n");
}

test("ownedLanguages decides bare sql when present", () => {
  // q2 assigned sql to marimo.
  assertEquals(cellOwnedByMarimo(bareSql(), [], ["python", "sql"]), true);
  // q2 left sql to another engine: marimo must not run it.
  assertEquals(cellOwnedByMarimo(bareSql(), ["sql"], ["python"]), false);
  // An owned-by-nobody sql is absent from both lists; the positive list says no. The
  // complement rule alone would have said yes.
  assertEquals(cellOwnedByMarimo(bareSql(), [], ["python"]), false);
});

test("the backwards read of handledLanguages stays fixed", () => {
  // The 2026-07-02 regression read `handledLanguages.includes("sql")` as ownership.
  assertEquals(cellOwnedByMarimo(bareSql(), ["sql"], []), false);
  assertEquals(cellOwnedByMarimo(bareSql(), ["sql"], undefined), false);
});

test("without ownedLanguages the complement of handledLanguages applies", () => {
  assertEquals(cellOwnedByMarimo(bareSql(), [], undefined), true);
  assertEquals(cellOwnedByMarimo(bareSql(), undefined, undefined), false);
});

test("a tagged cell is marimo's whatever the language lists say", () => {
  const tagged = chunk("python", "```{python .marimo}\n1\n```\n");
  assertEquals(cellOwnedByMarimo(tagged, ["python"], []), true);
});

// ---- the record ----

test("matches chunks to units by line and ignores a bare python cell", () => {
  const units = [unit(3, "1-aaaaaaaa-unlabeled"), unit(7, "2-bbbbbbbb-unlabeled"), unit(11, "3-cccccccc-unlabeled")];
  const record = buildMarimoRecord({
    cells: mixedChunks(),
    owned,
    projected: ["<one/>", "<three/>"],
    units,
    format: "html",
  });
  if (!record) throw new Error("expected a record");
  const cells = record.notebook.cells;
  assertEquals(cells.length, 2);
  assertEquals(
    cells.map((c) => c.metadata.quarto_cell_id),
    ["1-aaaaaaaa-unlabeled", "3-cccccccc-unlabeled"],
  );
  assertEquals(cells[0].outputs[0].data[MIME], "<one/>");
  assertEquals(cells[1].outputs[0].data[MIME], "<three/>");
});

test("each output is rendered markdown tagged with the format", () => {
  const record = buildMarimoRecord({
    cells: mixedChunks(),
    owned,
    projected: ["a", "b"],
    units: [unit(3, "x"), unit(11, "y")],
    format: "pdf",
  });
  if (!record) throw new Error("expected a record");
  const out = record.notebook.cells[0].outputs[0];
  assertEquals(out.output_type, "display_data");
  assertEquals(out.metadata.quarto_format, "pdf");
});

test("recordInfo declares document granularity and subset coverage", () => {
  const record = buildMarimoRecord({
    cells: mixedChunks(),
    owned,
    projected: ["a", "b"],
    units: [unit(3, "x"), unit(11, "y")],
    format: "html",
  });
  if (!record) throw new Error("expected a record");
  assertEquals(record.recordInfo, {
    version: 1,
    granularity: "document",
    outputKind: "rendered",
    alignment: "ids",
    coverage: "subset",
    hashDefinition: MARIMO_HASH_DEFINITION,
  });
});

test("the hash declaration is the one core pins", () => {
  assertEquals(MARIMO_HASH_DEFINITION, {
    id: "marimo",
    version: 1,
    granularity: "document",
    presentationCellOptions: [],
    presentationExecuteKeys: [],
    documentKeys: ["eval", "external-env", "pyproject"],
  });
});

test("a unit with no id, or one core did not mark owned, gets no record cell", () => {
  const record = buildMarimoRecord({
    cells: mixedChunks(),
    owned,
    projected: ["a", "b"],
    // The first cell was introduced by an earlier engine's output (no id); the second
    // is one core does not give marimo.
    units: [unit(3, undefined), unit(11, "y", false)],
    format: "html",
  });
  if (!record) throw new Error("expected a record");
  assertEquals(record.notebook.cells.length, 0);
});

test("no units means no record (an older core, or Quarto 1)", () => {
  assertEquals(
    buildMarimoRecord({
      cells: mixedChunks(),
      owned,
      projected: ["a", "b"],
      units: undefined,
      format: "html",
    }),
    undefined,
  );
});

test("a marimo cell with no unit at its line means no record", () => {
  assertEquals(
    buildMarimoRecord({
      cells: mixedChunks(),
      owned,
      projected: ["a", "b"],
      units: [unit(3, "x")],
      format: "html",
    }),
    undefined,
  );
});

test("a span unit never matches a cell", () => {
  const span: WireUnit = { ...unit(11, "s"), kind: "inline" };
  assertEquals(
    buildMarimoRecord({
      cells: mixedChunks(),
      owned,
      projected: ["a", "b"],
      units: [unit(3, "x"), span],
      format: "html",
    }),
    undefined,
  );
});
