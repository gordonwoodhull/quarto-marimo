import type { QuartoMdCell } from "@quarto/types";

export const MARIMO_CELL_REGEX =
  /^\s{0,3}(`{3,})\s*(?=(?:\{)?\.?((?:python|sql|markdown)(?:\.marimo)?|marimo)(?=[\s}]))(?:(?:python|sql|markdown)\s+\{(?=(?:\.marimo(?=[\s}])|[^}]*\s\.marimo(?=[\s}])))[^}]*\}|\{(?:(?:python|sql|markdown)\.marimo(?=[\s}])|(?:python|sql|markdown)(?=\s)(?=[^}]*\s\.marimo(?=[\s}]))|\.?marimo(?=[\s}]))[^}]*\})\s*$/;

const MARKDOWN_FENCE_REGEX = /^\s{0,3}(`{3,}|~{3,})/;
const MARKDOWN_FENCE_CLOSE_REGEX = /^\s{0,3}(`{3,}|~{3,})\s*$/;

export function containsMarimoFence(markdown: string): boolean {
  let enclosingFence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (enclosingFence) {
      const closingFence = line.match(MARKDOWN_FENCE_CLOSE_REGEX)?.[1];
      if (
        closingFence?.[0] === enclosingFence[0] &&
        closingFence.length >= enclosingFence.length
      ) {
        enclosingFence = undefined;
      }
      continue;
    }
    if (MARIMO_CELL_REGEX.test(line)) return true;
    enclosingFence = line.match(MARKDOWN_FENCE_REGEX)?.[1];
  }
  return false;
}

export function isMarimoCell(cell: QuartoMdCell): boolean {
  if (typeof cell.cell_type !== "object" || !("language" in cell.cell_type)) {
    return false;
  }
  const language = cell.cell_type.language;
  if (
    language !== "python" &&
    language !== "sql" &&
    language !== "markdown" &&
    language !== "marimo" &&
    language !== "python.marimo" &&
    language !== "sql.marimo" &&
    language !== "markdown.marimo"
  ) {
    return false;
  }
  const firstLine = cell.sourceVerbatim.value.split("\n", 1)[0] ?? "";
  return MARIMO_CELL_REGEX.test(firstLine);
}

/**
 * Whether `execute()` owns `cell` for this render. Every `.marimo`-tagged cell
 * is marimo's; a bare `{sql}` cell is marimo's only when Quarto 2 assigned sql
 * to this engine.
 *
 * Quarto 2 sends `ownedLanguages`, the positive set of languages it assigned to
 * marimo, and bare sql is marimo's exactly when that set includes "sql". When
 * it is absent (an older Quarto 2), the leave-alone set `handledLanguages`
 * applies instead: marimo owns bare sql when "sql" is absent from it. That
 * complement also covers a language owned by nobody, which is why the positive
 * set wins when present. Quarto 1 sends neither, so bare sql is never marimo's
 * there.
 */
export function cellOwnedByMarimo(
  cell: QuartoMdCell,
  handledLanguages: string[] | undefined,
  ownedLanguages?: string[],
): boolean {
  if (isMarimoCell(cell)) return true;
  if (typeof cell.cell_type !== "object" || !("language" in cell.cell_type)) {
    return false;
  }
  if (cell.cell_type.language !== "sql") return false;
  return bareSqlOwned(handledLanguages, ownedLanguages);
}

/** Whether marimo runs bare `{sql}` cells; see {@link cellOwnedByMarimo}. */
export function bareSqlOwned(
  handledLanguages: string[] | undefined,
  ownedLanguages: string[] | undefined,
): boolean {
  if (ownedLanguages !== undefined) return ownedLanguages.includes("sql");
  return handledLanguages !== undefined && !handledLanguages.includes("sql");
}

/**
 * Wider cell-split matcher used only by `execute()` when marimo owns bare sql:
 * a custom `startCodeCellRegex` replaces the default fence detection entirely,
 * so bare `{sql}` fences must be recognized here to come back as their own
 * chunk. Never use it for file claiming (`containsMarimoFence`).
 */
export const MARIMO_CELL_REGEX_WITH_BARE_SQL = withBareSqlAlternative(
  MARIMO_CELL_REGEX,
);

// `breakQuartoMd` reads the fence from group 1 and the language from group 2,
// so the bare-sql form is added as one more alternative inside the existing
// final group rather than as a second top-level pattern.
function withBareSqlAlternative(regex: RegExp): RegExp {
  const tail = ")\\s*$";
  if (!regex.source.endsWith(tail)) {
    throw new Error("unexpected MARIMO_CELL_REGEX shape");
  }
  const head = regex.source.slice(0, -tail.length);
  return new RegExp(`${head}|\\{sql(?=[\\s}])[^}]*\\}${tail}`);
}
