import { mkdir, mkdtemp, rename, rm, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const extensionUrl = new URL(".", import.meta.url);
const version = await extensionVersion();
const releaseUrl = new URL(
  `https://github.com/marimo-team/quarto-marimo/releases/download/v${version}/`,
);
const engineName = `marimo-engine-v${version}.js`;

const artifacts = [
  {
    name: engineName,
    path: new URL(engineName, extensionUrl),
  },
  {
    name: `browser-v${version}.js`,
    path: new URL(`assets/browser-v${version}.js`, extensionUrl),
  },
  {
    name: `islands-bridge-v${version}.css`,
    path: new URL(`assets/islands-bridge-v${version}.css`, extensionUrl),
  },
];

for (const artifact of artifacts) {
  await ensureArtifact(artifact.name, artifact.path);
}

const { default: engine } = await import(
  new URL(engineName, extensionUrl).href
);
export default engine;

async function extensionVersion() {
  const config = await readFile(
    new URL("_extension.yml", extensionUrl),
    "utf-8",
  );
  const match = config.match(/^version:\s*["']?([^"'\s#]+)["']?\s*$/m);
  if (!match) throw new Error("marimo extension version is missing");
  return match[1];
}

async function ensureArtifact(name, path) {
  try {
    await stat(path);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const assetUrl = new URL(name, releaseUrl);
  let contents;
  try {
    const response = await fetch(assetUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    contents = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Failed to download quarto-marimo ${version} asset ${name}${detail}`,
      { cause: error },
    );
  }

  const directory = fileURLToPath(new URL(".", path));
  await mkdir(directory, { recursive: true });
  const temporaryDirectory = await mkdtemp(`${directory}.download-`);
  const temporaryPath = `${temporaryDirectory}/artifact`;
  try {
    await writeFile(temporaryPath, contents, "utf-8");
    await rename(temporaryPath, fileURLToPath(path));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
