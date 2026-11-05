import { expect, it } from "vitest";
import {
  canonicalize,
  contractsMatch,
  withoutSourceRevision,
} from "../scripts/verify-skill-publication-contract";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeDocument(document: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-pinned-contract-"));
  const path = join(dir, "openapi.json");
  writeFileSync(path, JSON.stringify(document));
  return path;
}

it("matches identical documents", () => {
  const document = { info: { title: "a" }, paths: { "/x": {} } };
  const left = writeDocument(document);
  const right = writeDocument(document);

  expect(contractsMatch(left, right).match).toBe(true);
});

it("matches documents with different key order", () => {
  const left = writeDocument({ info: { title: "a" }, paths: {} });
  const right = writeDocument({ paths: {}, info: { title: "a" } });

  expect(contractsMatch(left, right).match).toBe(true);
});

it("ignores a differing info.x-source-revision", () => {
  const left = writeDocument({
    info: { title: "a", "x-source-revision": "abc123" },
    paths: {},
  });
  const right = writeDocument({
    info: { title: "a", "x-source-revision": "def456" },
    paths: {},
  });

  expect(contractsMatch(left, right).match).toBe(true);
});

it("treats any other difference as drift", () => {
  const left = writeDocument({ info: { title: "a" }, paths: { "/x": {} } });
  const right = writeDocument({ info: { title: "b" }, paths: { "/x": {} } });

  expect(contractsMatch(left, right).match).toBe(false);
});

it("canonicalizes nested object key order recursively", () => {
  const value = { b: { z: 1, a: 2 }, a: 1 };

  expect(JSON.stringify(canonicalize(value))).toBe(
    JSON.stringify({ a: 1, b: { a: 2, z: 1 } }),
  );
});

it("removes only info.x-source-revision", () => {
  const document = {
    info: { title: "a", "x-source-revision": "abc123" },
    paths: {},
  };

  expect(withoutSourceRevision(document)).toEqual({
    info: { title: "a" },
    paths: {},
  });
});
