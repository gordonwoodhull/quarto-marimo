import type { QuartoMdCell } from "@quarto/types";

/**
 * The engine's half of Quarto 2's execution record: one rendered output per
 * marimo cell, keyed by the unit ids Quarto 2 sends in `options.units`. Quarto 1
 * sends no units, so nothing here runs for it.
 */

/** One execution unit as Quarto 2 sends it (`units` on the execute options). */
export interface WireUnit {
  /** Absent for a cell an earlier engine's output introduced. */
  id?: string;
  index?: number;
  kind: "cell" | "inline";
  language: string;
  /** 1-based line of the unit's fence in the text this engine receives. */
  line: number;
  /** Quarto's language-level view: whether it assigned the unit to this engine. */
  owned: boolean;
}

/**
 * How marimo's execution-input hash is defined. Marimo cells are reactive
 * across the document, so one document hash covers every owned cell plus the
 * top-level keys the engine reads; nothing is excluded, so any change counts.
 * The bare-sql flag needs no field (it decides which sql cells are units) and
 * the mode is per output format, which Quarto records as `quarto_format`.
 */
export const MARIMO_HASH_DEFINITION = {
  id: "marimo",
  version: 1,
  granularity: "document",
  presentationCellOptions: [] as string[],
  presentationExecuteKeys: [] as string[],
  documentKeys: ["eval", "external-env", "pyproject"],
} as const;

const QUARTO_MARKDOWN_MIME = "text/x-quarto-markdown";

interface NotebookOutput {
  output_type: "display_data";
  data: Record<string, string>;
  metadata: { quarto_format: string };
}

interface NotebookCell {
  cell_type: "code";
  execution_count: null;
  metadata: { quarto_cell_id: string };
  outputs: NotebookOutput[];
  source: string[];
}

export interface MarimoRecord {
  notebook: {
    nbformat: 4;
    nbformat_minor: 5;
    metadata: Record<string, never>;
    cells: NotebookCell[];
  };
  recordInfo: {
    version: 1;
    granularity: "document";
    outputKind: "rendered";
    alignment: "ids";
    coverage: "subset";
    hashDefinition: typeof MARIMO_HASH_DEFINITION;
  };
}

export interface BuildRecordInput {
  /** Every chunk of the document, in order; their text joins back into it. */
  cells: QuartoMdCell[];
  /** Marimo's own ownership rule (`cellOwnedByMarimo`). */
  owned: (cell: QuartoMdCell) => boolean;
  /** One projected output per owned chunk, in order. */
  projected: readonly string[];
  units: readonly WireUnit[] | undefined;
  /** The requested output format (`format.identifier["target-format"]`). */
  format: string;
}

/**
 * Build the notebook and `recordInfo` for the cells marimo ran, or `undefined`
 * when no record can be made. A record is additive: `undefined` leaves the
 * render, which still has the projected markdown, untouched.
 *
 * Chunks are matched to units by the line of their fence, which core
 * re-locates into the text marimo received. Marimo's class rule is finer than
 * core's language view (a bare `{python}` cell is not marimo's even when
 * `python` is), so the notebook covers a subset of the units core marked
 * owned (`coverage: "subset"`); the count that matters is the projection count
 * the engine already validates.
 */
export function buildMarimoRecord(input: BuildRecordInput): MarimoRecord | undefined {
  const { units } = input;
  if (units === undefined) return undefined;

  const cellUnits = new Map<number, WireUnit>();
  for (const unit of units) {
    if (unit.kind === "cell") cellUnits.set(unit.line, unit);
  }

  const cells: NotebookCell[] = [];
  let line = 1;
  let projectedIndex = 0;
  for (const chunk of input.cells) {
    const text = chunk.sourceVerbatim.value;
    if (input.owned(chunk)) {
      const markdown = input.projected[projectedIndex++];
      if (markdown === undefined) return undefined;
      const unit = cellUnits.get(line);
      // A marimo cell core has no unit for: the alignment is lost.
      if (unit === undefined) return undefined;
      // A unit with no id was introduced by an earlier engine's output, and one core
      // did not assign to marimo is not one it would accept; neither has a record cell.
      if (unit.id !== undefined && unit.owned) {
        cells.push({
          cell_type: "code",
          execution_count: null,
          metadata: { quarto_cell_id: unit.id },
          outputs: [{
            output_type: "display_data",
            data: { [QUARTO_MARKDOWN_MIME]: markdown },
            metadata: { quarto_format: input.format },
          }],
          source: chunk.source.value.split(/(?<=\n)/),
        });
      }
    }
    line += countNewlines(text);
  }

  return {
    notebook: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells },
    recordInfo: {
      version: 1,
      granularity: "document",
      outputKind: "rendered",
      alignment: "ids",
      coverage: "subset",
      hashDefinition: MARIMO_HASH_DEFINITION,
    },
  };
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  return count;
}
