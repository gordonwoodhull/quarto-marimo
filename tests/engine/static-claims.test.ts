import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parse } from "yaml";

import { assertEquals } from "../assert.ts";
import marimoEngineDiscovery from "../../src/engine/index.ts";

type Claim = { whenClass?: string; kind: string; priority?: number };

const manifest = parse(
  readFileSync(
    new URL("../../_extensions/marimo/_extension.yml", import.meta.url),
    "utf-8",
  ),
);
const engine = manifest.contributes.engines[0];
const claims: Record<string, Claim[]> = engine.claims;

// What Quarto 2 would resolve from the static claims for (language, class).
function staticClaim(language: string, firstClass?: string) {
  const matches = (claims[language] ?? []).filter((claim) =>
    claim.whenClass === undefined || claim.whenClass === firstClass
  );
  // A class-gated claim is more specific than an ungated one.
  const gated = matches.filter((claim) => claim.whenClass !== undefined);
  const claim = (gated.length ? gated : matches)[0];
  if (!claim) return false;
  return claim.kind === "primary" ? claim.priority : { kind: claim.kind };
}

test("static claims agree with the runtime claimsLanguage", () => {
  for (
    const [language, firstClass] of [
      ["python", "marimo"],
      ["sql", "marimo"],
      ["markdown", "marimo"],
      ["python.marimo", undefined],
      ["sql.marimo", undefined],
      ["markdown.marimo", undefined],
      ["marimo", undefined],
      ["sql", undefined],
      ["python", undefined],
      ["r", "marimo"],
    ] as const
  ) {
    assertEquals(
      staticClaim(language, firstClass),
      marimoEngineDiscovery.claimsLanguage(language, firstClass),
    );
  }
});

// The runtime `claimsFile` is deliberately exempt: it exists for Quarto 1's
// legacy `python {.marimo}` fences, while Quarto 2 selects marimo by language.
test("the manifest declares every static axis and claims no whole files", () => {
  assertEquals(engine.name, "marimo");
  assertEquals(engine["file-extensions"], [".qmd", ".md"]);
  assertEquals(engine["claims-files"], []);
  assertEquals(
    marimoEngineDiscovery.validExtensions(),
    engine["file-extensions"],
  );
});
