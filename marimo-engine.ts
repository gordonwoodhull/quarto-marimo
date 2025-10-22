/*
 * marimo-engine.ts
 *
 * Quarto external engine for marimo
 */

import { fromFileUrl, join, dirname } from "path";

import {
  DependenciesOptions,
  DependenciesResult,
  ExecuteOptions,
  ExecuteResult,
  ExecutionEngineDiscovery,
  ExecutionTarget,
  LaunchedExecutionEngine,
  MappedString,
  PandocIncludes,
  PostProcessOptions,
  EngineProjectContext,
} from "../quarto-cli/packages/quarto-types/dist/index.js";

// Helper function to execute external processes
async function executePython(
  command: string,
  args: string[] = [],
  stdin: string = ""
): Promise<string> {
  const process = Deno.run({
    cmd: [command, ...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  // Input handling
  if (stdin) {
    const encoder = new TextEncoder();
    await process.stdin.write(encoder.encode(stdin));
  }
  await process.stdin.close();

  // Output handling
  const output = await process.output();
  const status = await process.status();

  // Handle errors
  if (!status.success) {
    const errorOutput = await process.stderrOutput();
    const decoder = new TextDecoder();
    throw new Error(`Process execution failed: ${decoder.decode(errorOutput)}`);
  }

  process.close();

  // Return output
  const decoder = new TextDecoder();
  return decoder.decode(output);
}

// Construct UV command for dependencies
async function constructUvCommand(header: string): Promise<string[]> {
  // Get the directory of the current module
  const currentDir = dirname(fromFileUrl(import.meta.url));

  // Create a platform-appropriate path to the script
  const scriptPath = join(currentDir, "lib", "command.py");

  // Run uv with correct arguments (matching the Lua implementation)
  const result = await executePython(
    "uv",
    ["run", "--with", "marimo", scriptPath],
    header
  );

  return JSON.parse(result);
}

const marimoEngineDiscovery: ExecutionEngineDiscovery & { _discovery: boolean } = {
  _discovery: true,

  name: "marimo",

  defaultExt: ".qmd",

  defaultYaml: () => ["format: html", "engine: marimo"],

  defaultContent: () => [
    "```{.marimo}",
    "import marimo as mo",
    "slider = mo.ui.slider(1, 10, 1)",
    "slider",
    "```",
  ],

  validExtensions: () => [".qmd", ".md"],

  claimsFile: (_file: string, _ext: string) => {
    return false; // Don't claim files automatically
  },

  claimsLanguage: (language: string) => {
    return language === "marimo" || language === "python.marimo";
  },

  canFreeze: false,

  generatesFigures: true,

  launch: (context: EngineProjectContext): LaunchedExecutionEngine => {
    return {
      name: marimoEngineDiscovery.name,
      canFreeze: marimoEngineDiscovery.canFreeze,

      markdownForFile(file: string): Promise<MappedString> {
        return Promise.resolve(context.mappedStringFromFile(file));
      },

      target: (
        file: string,
        _quiet?: boolean,
        markdown?: MappedString
      ): Promise<ExecutionTarget | undefined> => {
        if (markdown === undefined) {
          markdown = context.mappedStringFromFile(file);
        }
        const metadata = context.readYamlFromMarkdown(markdown.value);
        return Promise.resolve({
          source: file,
          input: file,
          markdown,
          metadata,
        });
      },

      partitionedMarkdown: (file: string) => {
        return Promise.resolve(
          context.partitionMarkdown(Deno.readTextFileSync(file))
        );
      },

      execute: async (options: ExecuteOptions): Promise<ExecuteResult> => {
        const { target, format } = options;
        const markdown = target.markdown.value;

        // Determine MIME sensitivity
        const outputFormat = format.pandoc.to || "html";
        const mimeSensitive = outputFormat === "pdf" || outputFormat === "latex";

        // Check for debug mode
        const debugMode = Deno.env.get("QUARTO_MARIMO_DEBUG") === "true";

        // Setup environment based on metadata
        const useExternalEnv = target.metadata["external-env"] === true;
        const pyprojectConfig = target.metadata["pyproject"];

        try {
          // Get platform-appropriate paths
          const currentDir = dirname(fromFileUrl(import.meta.url));
          const extractPath = join(currentDir, "lib", "extract.py");

          // Build command based on environment mode
          let command: string;
          let args: string[];

          if (useExternalEnv) {
            command = "python";
            args = [extractPath];
          } else {
            // Get UV command with dependencies
            const header = pyprojectConfig ? String(pyprojectConfig) : "";
            const uvFlags = await constructUvCommand(header);
            command = "uv";
            args = [...uvFlags, extractPath];
          }

          // Add file and MIME sensitivity arguments
          args.push(target.input, mimeSensitive ? "yes" : "no");

          // Add debug flag if in debug mode
          if (debugMode) {
            args.push("--debug");
          }

          // Execute Python script
          const result = await executePython(command, args, markdown);
          const marimoExecution = JSON.parse(result);

          // Log debug info if available
          if (debugMode && marimoExecution.chunk_sequence) {
            console.error("=== Marimo Debug Info ===");
            console.error("Chunk sequence:", marimoExecution.chunk_sequence.join(" -> "));
            const markdownCount = marimoExecution.chunk_sequence.filter((x: string) => x === "markdown").length;
            const marimoCount = marimoExecution.chunk_sequence.filter((x: string) => x === "marimo").length;
            console.error(`Markdown sections: ${markdownCount}`);
            console.error(`Marimo blocks: ${marimoCount}`);
            if (marimoExecution.first_markdown) {
              console.error("First markdown section:", marimoExecution.first_markdown);
            }
            if (marimoExecution.cell_debug_info) {
              console.error("Cell debug info:");
              marimoExecution.cell_debug_info.forEach((info: any, idx: number) => {
                console.error(`  Cell ${idx}:`, JSON.stringify(info, null, 2));
              });
            }
            console.error("=========================");
          }

          // Setup includes for HTML formats
          const includes: PandocIncludes = {};
          if (outputFormat === "html" && marimoExecution.header) {
            // Write header content to a temp file (like Jupyter does)
            const tempFile = Deno.makeTempFileSync({
              dir: options.tempDir,
              prefix: "marimo-header-",
              suffix: ".html",
            });
            Deno.writeTextFileSync(tempFile, marimoExecution.header);
            includes["include-in-header"] = [tempFile];
          }

          return {
            engine: "marimo",
            markdown: marimoExecution.markdown,
            supporting: [],
            filters: [],
            includes: Object.keys(includes).length > 0 ? includes : undefined,
          };
        } catch (error) {
          console.error("Error executing marimo:", error);
          return {
            engine: "marimo",
            markdown: `\`\`\`\nError executing marimo: ${
              (error as Error).message
            }\n\`\`\`\n\n${markdown}`,
            supporting: [],
            filters: [],
          };
        }
      },

      dependencies: (_options: DependenciesOptions): Promise<DependenciesResult> => {
        return Promise.resolve({
          includes: {},
        });
      },

      postprocess: (_options: PostProcessOptions): Promise<void> =>
        Promise.resolve(),
    };
  },
};

export default marimoEngineDiscovery;
