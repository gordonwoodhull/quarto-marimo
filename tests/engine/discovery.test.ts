import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { QuartoMdCell } from "@quarto/types";

import { assertEquals } from "../assert.ts";
import {
  cellOwnedByMarimo,
  MARIMO_CELL_REGEX,
  MARIMO_CELL_REGEX_WITH_BARE_SQL,
} from "../../src/engine/authoring.ts";

import marimoEngineDiscovery from "../../src/engine/index.ts";

test("claims native class and dot language forms", () => {
  assertEquals(marimoEngineDiscovery.claimsLanguage("python", "marimo"), 2);
  assertEquals(marimoEngineDiscovery.claimsLanguage("sql", "marimo"), 2);
  assertEquals(marimoEngineDiscovery.claimsLanguage("markdown", "marimo"), 2);
  assertEquals(marimoEngineDiscovery.claimsLanguage("python.marimo"), 1);
  assertEquals(marimoEngineDiscovery.claimsLanguage("sql.marimo"), 1);
  assertEquals(marimoEngineDiscovery.claimsLanguage("markdown.marimo"), 1);
  assertEquals(marimoEngineDiscovery.claimsLanguage("marimo"), 1);
});

test("leaves ordinary languages to other engines", () => {
  assertEquals(marimoEngineDiscovery.claimsLanguage("python"), false);
  assertEquals(marimoEngineDiscovery.claimsLanguage("r", "marimo"), false);
});

test("claims files containing marimo fences", () => {
  for (
    const source of [
      "```{markdown .marimo}\n# Reactive heading\n```",
      "```python {.marimo}\nvalue = 1\n```",
      "```{marimo}\nvalue = 1\n```",
      "```{.marimo}\nvalue = 1\n```",
    ]
  ) {
    withTempFile(".qmd", source, (file) => {
      assertEquals(marimoEngineDiscovery.claimsFile(file, ".qmd"), true);
    });
  }
});

test("requires marimo to be a complete class name", () => {
  withTempFile(
    ".qmd",
    "```{python .marimo-example}\nvalue = 1\n```",
    (file) => {
      assertEquals(marimoEngineDiscovery.claimsFile(file, ".qmd"), false);
    },
  );
});

test("ignores marimo examples nested in an outer code fence", () => {
  const source = "````markdown\n```{python .marimo}\nvalue = 1\n```\n````";
  withTempFile(".qmd", source, (file) => {
    assertEquals(marimoEngineDiscovery.claimsFile(file, ".qmd"), false);
  });
});

test("ignores four-space-indented marimo examples", () => {
  const source = "    ```{python .marimo}\n    value = 1\n    ```";
  withTempFile(".qmd", source, (file) => {
    assertEquals(marimoEngineDiscovery.claimsFile(file, ".qmd"), false);
  });
});

test("does not claim unsupported file types", () => {
  withTempFile(".py", "```{python .marimo}\nvalue = 1\n```", (file) => {
    assertEquals(marimoEngineDiscovery.claimsFile(file, ".py"), false);
  });
});

function withTempFile(
  extension: string,
  contents: string,
  inspect: (file: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "quarto-marimo-test-"));
  const file = join(directory, `test${extension}`);
  try {
    writeFileSync(file, contents);
    inspect(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("claims bare sql as interop but leaves bare python alone", () => {
  assertEquals(marimoEngineDiscovery.claimsLanguage("sql"), { kind: "interop" });
  assertEquals(marimoEngineDiscovery.claimsLanguage("python"), false);
});

test("bare sql never makes a document self-claim for marimo", () => {
  withTempFile(".qmd", "```{sql}\nselect 1\n```", (file) => {
    assertEquals(marimoEngineDiscovery.claimsFile(file, ".qmd"), false);
  });
});

function cell(language: string, firstLine: string): QuartoMdCell {
  return {
    cell_type: { language },
    sourceVerbatim: { value: `${firstLine}\nbody\n` },
  } as unknown as QuartoMdCell;
}

test("bare sql cells are marimo's only when sql is not left alone", () => {
  const bare = cell("sql", "```{sql}");
  assertEquals(cellOwnedByMarimo(bare, []), true);
  assertEquals(cellOwnedByMarimo(bare, ["sql"]), false);
  assertEquals(cellOwnedByMarimo(bare, undefined), false);
  assertEquals(cellOwnedByMarimo(cell("python", "```{python}"), []), false);
  assertEquals(
    cellOwnedByMarimo(cell("python", "```{python .marimo}"), ["sql"]),
    true,
  );
});

test("the widened split matcher adds only bare sql, with the same groups", () => {
  const bare = "```{sql query=df}";
  assertEquals(MARIMO_CELL_REGEX.test(bare), false);
  const match = bare.match(MARIMO_CELL_REGEX_WITH_BARE_SQL);
  assertEquals(match?.[1], "```");
  assertEquals(match?.[2], "sql");
  assertEquals(MARIMO_CELL_REGEX_WITH_BARE_SQL.test("```{python}"), false);
  assertEquals(MARIMO_CELL_REGEX_WITH_BARE_SQL.test("```{sqlfoo}"), false);
  for (const line of ["```{python .marimo}", "```{sql.marimo}", "```python {.marimo}"]) {
    assertEquals(MARIMO_CELL_REGEX_WITH_BARE_SQL.test(line), true);
  }
});
