import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { assertEquals } from "../assert.ts";

// Fork only: the loader downloads the versioned artifacts on first use from
// QUARTO_MARIMO_RELEASE_URL (default: the fork's GitHub releases).
test("the loader downloads, caches, and imports the versioned engine", async () => {
  const extension = mkdtempSync(join(tmpdir(), "quarto-marimo-loader-"));
  const source = new URL("../../_extensions/marimo/", import.meta.url);
  cpSync(new URL("marimo-engine.js", source), join(extension, "marimo-engine.js"));
  cpSync(new URL("_extension.yml", source), join(extension, "_extension.yml"));
  const version = /^version:\s*(\S+)/m.exec(
    readFileSync(join(extension, "_extension.yml"), "utf-8"),
  )![1];

  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end(
      request.url?.endsWith(`marimo-engine-v${version}.js`)
        ? 'export default { name: "downloaded" };'
        : "/* asset */",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const previous = process.env.QUARTO_MARIMO_RELEASE_URL;
  process.env.QUARTO_MARIMO_RELEASE_URL = `http://127.0.0.1:${port}/release`;
  try {
    const loader = pathToFileURL(join(extension, "marimo-engine.js")).href;
    const engine = (await import(`${loader}?first`)).default;
    assertEquals(engine, { name: "downloaded" });
    assertEquals(requests.length, 3);
    assertEquals(existsSync(join(extension, "assets", `browser-v${version}.js`)), true);

    // A second load finds every artifact in the cache and downloads nothing.
    await import(`${loader}?second`);
    assertEquals(requests.length, 3);
  } finally {
    if (previous === undefined) delete process.env.QUARTO_MARIMO_RELEASE_URL;
    else process.env.QUARTO_MARIMO_RELEASE_URL = previous;
    server.close();
    rmSync(extension, { recursive: true, force: true });
  }
});
