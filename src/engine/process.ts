import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { QuartoAPI } from "@quarto/types";
import {
  type CompiledMarimoPage,
  isCompiledMarimoPage,
} from "@marimo-team/mdx-marimo/bridge/protocol";

const defaultCompilerTimeoutMs = 300_000;

// The host exchanges UTF-8 bytes on stdin and stdout, but Python decodes and
// encodes those streams with the host locale unless UTF-8 mode is on. Windows
// locales such as cp932 otherwise turn document text into mojibake and lone
// surrogates that later fail JSON encoding.
const pythonUtf8Environment: Record<string, string> = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};

export type StaticMarimoOutput = {
  type: "html" | "figure" | "para" | "plain" | "blockquote";
  value: string;
  displayCode: boolean;
  code: string;
  language: string;
};

export type MarimoExecution =
  | { kind: "page"; page: CompiledMarimoPage }
  | { kind: "static"; outputs: StaticMarimoOutput[] };

export async function runMarimoCompiler(
  quarto: QuartoAPI,
  options: {
    moduleUrl: string;
    source: string;
    input: string;
    interactive: boolean;
    globalEval: boolean;
    externalEnv: boolean;
    pyproject: string;
    bareSql?: boolean;
  },
): Promise<MarimoExecution> {
  const extensionDir = dirname(fileURLToPath(options.moduleUrl));
  const extractPath = join(extensionDir, "python", "extract.py");
  let command: string;
  let args: string[];
  let temporaryDirectory: string | undefined;

  if (options.externalEnv) {
    command = process.env.QUARTO_PYTHON || "python";
    args = [extractPath];
  } else {
    command = "uv";
    const uvCommand = await constructUvCommand(
      quarto,
      extensionDir,
      options.pyproject,
    );
    temporaryDirectory = uvCommand.temporaryDirectory;
    args = [...uvCommand.args, extractPath];
  }
  args.push(
    options.input,
    options.interactive ? "html" : "static",
    options.globalEval ? "yes" : "no",
  );
  // Only Quarto 2 resolves bare `{sql}` ownership; the flag is appended last
  // so the argument list is unchanged for hosts that never set it.
  if (options.bareSql) args.push("yes");

  let output: string;
  try {
    output = await executeProcess(quarto, command, args, options.source);
  } finally {
    if (temporaryDirectory) {
      removeTemporaryDirectory(temporaryDirectory);
    }
  }
  const value: unknown = JSON.parse(output);
  if (isPageExecution(value) || isStaticExecution(value)) return value;
  throw new TypeError("marimo compiler returned an invalid execution payload");
}

async function constructUvCommand(
  quarto: QuartoAPI,
  extensionDir: string,
  pyproject: string,
): Promise<{ args: string[]; temporaryDirectory: string }> {
  const commandPath = join(extensionDir, "python", "command.py");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "quarto-marimo-"));
  try {
    const output = await executeProcess(
      quarto,
      "uv",
      ["run", "--with", "marimo", commandPath],
      pyproject,
      compilerTimeoutMs(),
      {
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      },
    );
    const value: unknown = JSON.parse(output);
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string")
    ) {
      throw new TypeError(
        "marimo dependency resolver returned invalid uv arguments",
      );
    }
    return { args: value, temporaryDirectory };
  } catch (error: unknown) {
    removeTemporaryDirectory(temporaryDirectory);
    throw error;
  }
}

export function executeProcess(
  quarto: QuartoAPI,
  command: string,
  args: string[],
  stdin: string,
  timeoutMs = compilerTimeoutMs(),
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Node replaces the child environment where Deno merges it, so merge
    // explicitly to behave the same under both runtimes.
    const child = spawn(command, args, {
      env: { ...process.env, ...pythonUtf8Environment, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // The child may exit before reading all of stdin (EPIPE); the exit status
    // below reports the real failure.
    child.stdin.on("error", () => {});
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) => {
      settle(() => {
        if (timedOut) {
          reject(timeoutError(command, args, timeoutMs));
          return;
        }
        const errorText = Buffer.concat(stderr).toString("utf-8");
        if (errorText) quarto.console.info(errorText.trim());
        if (code !== 0) {
          reject(
            new Error(
              errorText.trim() || `${command} exited with code ${code}`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf-8"));
      });
    });
    child.stdin.end(stdin, "utf-8");
  });
}

function compilerTimeoutMs(): number {
  const seconds = Number(process.env.QUARTO_MARIMO_TIMEOUT_SECONDS ?? "");
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : defaultCompilerTimeoutMs;
}

function timeoutError(
  command: string,
  args: string[],
  timeoutMs: number,
): Error {
  return new Error(
    `marimo compilation timed out after ${timeoutMs / 1000}s while running ${
      [command, ...args].join(" ")
    }`,
  );
}

function removeTemporaryDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function isPageExecution(
  value: unknown,
): value is { kind: "page"; page: CompiledMarimoPage } {
  return (
    isRecord(value) &&
    value.kind === "page" &&
    isCompiledMarimoPage(value.page)
  );
}

function isStaticExecution(
  value: unknown,
): value is { kind: "static"; outputs: StaticMarimoOutput[] } {
  return (
    isRecord(value) &&
    value.kind === "static" &&
    Array.isArray(value.outputs) &&
    value.outputs.every(isStaticOutput)
  );
}

function isStaticOutput(value: unknown): value is StaticMarimoOutput {
  return (
    isRecord(value) &&
    (value.type === "html" ||
      value.type === "figure" ||
      value.type === "para" ||
      value.type === "plain" ||
      value.type === "blockquote") &&
    typeof value.value === "string" &&
    typeof value.displayCode === "boolean" &&
    typeof value.code === "string" &&
    typeof value.language === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
