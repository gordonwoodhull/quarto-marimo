import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CheckConfiguration,
  DependenciesOptions,
  DependenciesResult,
  EngineProjectContext,
  ExecuteOptions,
  ExecuteResult,
  ExecutionEngineDiscovery,
  ExecutionEngineInstance,
  ExecutionTarget,
  LanguageClaim,
  MappedString,
  PandocIncludes,
  PostProcessOptions,
  QuartoAPI,
} from "@quarto/types";

import {
  cellOwnedByMarimo,
  containsMarimoFence,
  MARIMO_CELL_REGEX,
  MARIMO_CELL_REGEX_WITH_BARE_SQL,
} from "./authoring.ts";
import { writeBrowserHeader } from "./browser-assets.ts";
import {
  projectInteractivePage,
  projectStaticPage,
  validateProjectionCount,
} from "./projection.ts";
import { runMarimoCompiler } from "./process.ts";

let quarto: QuartoAPI;

const marimoEngineDiscovery: ExecutionEngineDiscovery = {
  init: (quartoAPI: QuartoAPI) => {
    quarto = quartoAPI;
  },

  name: "marimo",
  defaultExt: ".qmd",
  defaultYaml: () => ["format: html", "engine: marimo"],
  defaultContent: () => [
    "```{python .marimo}",
    "import marimo as mo",
    "slider = mo.ui.slider(1, 10, 1)",
    "slider",
    "```",
  ],
  validExtensions: () => [".qmd", ".md"],

  // Quarto 1 only: Quarto 2 reads the static `claims-files: []` from
  // `_extension.yml` and never calls this, because it selects marimo by
  // language claim. Quarto 1 needs the sniff to detect documents that use the
  // legacy `python {.marimo}` fence, which its language detection misses.
  claimsFile: (file: string, extension: string) => {
    if (![".qmd", ".md"].includes(extension.toLowerCase())) return false;
    try {
      return containsMarimoFence(readFileSync(file, "utf-8"));
    } catch {
      return false;
    }
  },

  claimsLanguage: (
    language: string,
    firstClass?: string,
  ): boolean | number | LanguageClaim => {
    if (
      (language === "python" || language === "sql" ||
        language === "markdown") &&
      firstClass === "marimo"
    ) {
      return 2;
    }
    if (
      language === "python.marimo" ||
      language === "sql.marimo" ||
      language === "markdown.marimo" ||
      language === "marimo"
    ) {
      return 1;
    }
    // Bare `{sql}` rides along as interop when marimo is already present via
    // a primary claim elsewhere in the document (Quarto 2 only; Quarto 1
    // ignores object-valued claims). Bare `{python}` stays unclaimed.
    if (language === "sql") return { kind: "interop" };
    return false;
  },

  canFreeze: false,
  generatesFigures: true,

  checkInstallation: async (configuration: CheckConfiguration) => {
    const report: Record<string, unknown> = {};
    if (configuration.jsonResult) {
      const render = (configuration.jsonResult.render ??= {}) as Record<
        string,
        unknown
      >;
      render.marimo = report;
    }
    const checkRender = async () => {
      const result = await quarto.system.checkRender({
        content: "```{python .marimo}\n1 + 1\n```\n",
        language: "python",
        services: configuration.services,
      });
      if (result.error) {
        if (configuration.jsonResult) {
          report.error = result.error.message;
          return;
        }
        throw result.error;
      }
      report.ok = true;
    };
    if (configuration.jsonResult) {
      await checkRender();
    } else {
      const message = "Checking marimo engine render...";
      await quarto.console.withSpinner(
        { message, doneMessage: `${message}OK\n` },
        checkRender,
      );
    }
  },

  launch: (_context: EngineProjectContext): ExecutionEngineInstance => ({
    name: marimoEngineDiscovery.name,
    canFreeze: marimoEngineDiscovery.canFreeze,

    markdownForFile(file: string): Promise<MappedString> {
      return Promise.resolve(quarto.mappedString.fromFile(file));
    },

    target: (
      file: string,
      _quiet?: boolean,
      markdown?: MappedString,
    ): Promise<ExecutionTarget | undefined> => {
      const source = markdown ?? quarto.mappedString.fromFile(file);
      return Promise.resolve({
        source: file,
        input: file,
        markdown: source,
        metadata: quarto.markdownRegex.extractYaml(source.value),
      });
    },

    partitionedMarkdown: (file: string) =>
      Promise.resolve(
        quarto.markdownRegex.partition(readFileSync(file, "utf-8")),
      ),

    execute: async (options: ExecuteOptions): Promise<ExecuteResult> => {
      const interactive = quarto.format.isHtmlCompatible(options.format);
      // Quarto 2's `handledLanguages` is the leave-alone set, so marimo owns
      // bare sql exactly when "sql" is absent from it. Quarto 1 omits it.
      const bareSql = options.handledLanguages !== undefined &&
        !options.handledLanguages.includes("sql");
      const execution = await quarto.console.withSpinner(
        { message: "Executing marimo cells..." },
        async () =>
          await runMarimoCompiler(quarto, {
            moduleUrl: import.meta.url,
            source: options.target.markdown.value,
            input: options.target.input,
            interactive,
            globalEval: options.target.metadata.eval !== false,
            externalEnv: options.target.metadata["external-env"] === true,
            pyproject: String(options.target.metadata.pyproject ?? ""),
            bareSql,
          }),
      );
      const chunks = await quarto.markdownRegex.breakQuartoMd(
        options.target.markdown,
        false,
        false,
        bareSql ? MARIMO_CELL_REGEX_WITH_BARE_SQL : MARIMO_CELL_REGEX,
      );
      const marimoCells = chunks.cells.filter((cell) =>
        cellOwnedByMarimo(cell, options.handledLanguages)
      );
      const projected = execution.kind === "page"
        ? projectInteractivePage(execution.page)
        : await projectStaticPage(execution.outputs, htmlToMarkdown);
      validateProjectionCount(projected, marimoCells.length);

      let index = 0;
      const markdown = chunks.cells
        .map((cell) =>
          cellOwnedByMarimo(cell, options.handledLanguages)
            ? projected[index++] ?? ""
            : cell.sourceVerbatim.value
        )
        .join("");
      const includes: PandocIncludes = {};
      if (execution.kind === "page") {
        const extensionDir = dirname(fileURLToPath(import.meta.url));
        includes["include-in-header"] = [
          writeBrowserHeader(extensionDir, options.tempDir),
        ];
      }
      return {
        engine: "marimo",
        markdown,
        supporting: [],
        filters: [],
        includes,
      };
    },

    dependencies: (
      _options: DependenciesOptions,
    ): Promise<DependenciesResult> => Promise.resolve({ includes: {} }),

    postprocess: (_options: PostProcessOptions): Promise<void> =>
      Promise.resolve(),
  }),
};

async function htmlToMarkdown(html: string): Promise<string> {
  const result = await quarto.system.pandoc(
    ["-f", "html", "-t", "markdown"],
    html,
  );
  if (!result.success) {
    throw new Error(result.stderr || "Pandoc could not convert marimo HTML");
  }
  return result.stdout || "";
}

export default marimoEngineDiscovery;
