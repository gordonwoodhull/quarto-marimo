import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";

import type { QuartoAPI } from "@quarto/types";

import { assertEquals, assertRejects } from "../assert.ts";
import { executeProcess, runMarimoCompiler } from "../../src/engine/process.ts";

const windows = process.platform === "win32";
const quarto = { console: { info: () => {} } } as unknown as QuartoAPI;

function withScript(body: string, run: (command: string) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "quarto-marimo-test-"));
    const command = join(directory, "script.sh");
    try {
      writeFileSync(command, body);
      chmodSync(command, 0o755);
      await run(command);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const compilerOptions = {
  moduleUrl: import.meta.url,
  source: "",
  input: "page.qmd",
  interactive: false,
  globalEval: true,
  externalEnv: true,
  pyproject: "",
};

test(
  "external environments use QUARTO_PYTHON",
  { skip: windows },
  withScript(
    '#!/bin/sh\nprintf \'%s\\n\' \'{"kind":"static","outputs":[]}\'\n',
    async (command) => {
      const previous = process.env.QUARTO_PYTHON;
      process.env.QUARTO_PYTHON = command;
      try {
        const result = await runMarimoCompiler(quarto, compilerOptions);
        assertEquals(result, { kind: "static", outputs: [] });
      } finally {
        if (previous === undefined) delete process.env.QUARTO_PYTHON;
        else process.env.QUARTO_PYTHON = previous;
      }
    },
  ),
);

test(
  "the compiler receives the document arguments and the bare-sql flag last",
  { skip: windows },
  withScript(
    '#!/bin/sh\nprintf \'{"kind":"static","outputs":[],"argv":"%s"}\' "$*"\n',
    async (command) => {
      const previous = process.env.QUARTO_PYTHON;
      process.env.QUARTO_PYTHON = command;
      try {
        const args = async (bareSql?: boolean) => {
          const result = await runMarimoCompiler(quarto, {
            ...compilerOptions,
            bareSql,
          });
          return (result as unknown as { argv: string }).argv.split(" ").slice(1);
        };
        assertEquals(await args(), ["page.qmd", "static", "yes"]);
        assertEquals(await args(true), ["page.qmd", "static", "yes", "yes"]);
      } finally {
        if (previous === undefined) delete process.env.QUARTO_PYTHON;
        else process.env.QUARTO_PYTHON = previous;
      }
    },
  ),
);

test("compiler processes stop at the configured timeout", async () => {
  await assertRejects(
    () =>
      executeProcess(
        quarto,
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        "",
        25,
      ),
    Error,
    "marimo compilation timed out",
  );
});

test("a missing command rejects with the spawn error", async () => {
  await assertRejects(
    () => executeProcess(quarto, "quarto-marimo-no-such-command", [], ""),
    Error,
    "ENOENT",
  );
});

test("a failing process reports its stderr", async () => {
  await assertRejects(
    () =>
      executeProcess(
        quarto,
        process.execPath,
        ["-e", "console.error('boom'); process.exit(3)"],
        "",
      ),
    Error,
    "boom",
  );
});

test(
  "compiler processes run Python in UTF-8 mode and exchange UTF-8 bytes",
  { skip: windows },
  // Echo the UTF-8 controls and the raw stdin bytes back as a payload so the
  // test observes exactly what a Python child would see.
  withScript(
    '#!/bin/sh\ninput=$(cat)\nprintf \'{"env":"%s","stdin":"%s"}\' "$PYTHONUTF8:$PYTHONIOENCODING" "$input"\n',
    async (command) => {
      const output = await executeProcess(
        quarto,
        command,
        [],
        "こんにちわ 日本語",
      );

      assertEquals(JSON.parse(output), {
        env: "1:utf-8",
        stdin: "こんにちわ 日本語",
      });
    },
  ),
);
