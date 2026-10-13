import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const EXTENSION_CONFIG = "_extension.yml";

export function writeBrowserHeader(
  extensionDir: string,
  tempDir: string,
): string {
  const version = extensionVersion(extensionDir);
  const assetsDir = join(extensionDir, "assets");
  const browser = readFileSync(join(assetsDir, `browser-v${version}.js`), "utf-8")
    .replace(/<\/script/gi, "<\\/script");
  const styles = readFileSync(join(assetsDir, `islands-bridge-v${version}.css`), "utf-8")
    .replace(/<\/style/gi, "<\\/style");
  const header = [
    `<style data-marimo-islands>${styles}</style>`,
    `<script type="module" data-marimo-islands>${browser}</script>`,
  ].join("\n");
  // The include file needs an `.html` suffix, which `mkdtemp` cannot add, so
  // write into a private directory and name the file ourselves.
  const directory = mkdtempSync(join(tempDir, "marimo-header-"));
  const path = join(directory, "header.html");
  writeFileSync(path, header);
  return path;
}

function extensionVersion(extensionDir: string): string {
  const config = readFileSync(join(extensionDir, EXTENSION_CONFIG), "utf-8");
  const match = config.match(/^version:\s*["']?([^"'\s#]+)["']?\s*$/m);
  if (!match) throw new Error("marimo extension version is missing");
  return match[1];
}
