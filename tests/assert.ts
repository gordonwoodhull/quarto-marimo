// Deno-style assertion names over `node:assert/strict`, so the same test files
// run under `node --test` (Quarto 2) and `deno test --no-check -A` (Quarto 1).
import assert from "node:assert/strict";

export function assertEquals(actual: unknown, expected: unknown): void {
  assert.deepStrictEqual(actual, expected);
}

export function assertStringIncludes(actual: string, expected: string): void {
  assert.ok(
    actual.includes(expected),
    `expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`,
  );
}

type ErrorClass = new (...args: never[]) => Error;

export function assertThrows(
  fn: () => unknown,
  errorClass: ErrorClass,
  message?: string,
): void {
  assert.throws(fn, matcher(errorClass, message));
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  errorClass: ErrorClass,
  message?: string,
): Promise<void> {
  await assert.rejects(fn, matcher(errorClass, message));
}

function matcher(errorClass: ErrorClass, message?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof errorClass, `expected ${errorClass.name}`);
    if (message !== undefined) {
      assert.match((error as Error).message, new RegExp(escape(message)));
    }
    return true;
  };
}

export const assertOk: (value: unknown) => asserts value = assert.ok;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
