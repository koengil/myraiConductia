import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export function isObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function withoutSourceRevision(document: Json): Json {
  if (!isObject(document) || !isObject(document.info)) return document;
  const info = { ...document.info };
  delete info["x-source-revision"];
  return { ...document, info };
}

export function comparable(path: string): string {
  const document = JSON.parse(readFileSync(path, "utf8")) as Json;
  return JSON.stringify(canonicalize(withoutSourceRevision(document)));
}

export function contractsMatch(
  canonicalPath: string,
  pinnedPath: string,
): { match: boolean; reason?: string } {
  try {
    return { match: comparable(canonicalPath) === comparable(pinnedPath) };
  } catch (error) {
    return {
      match: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const LABEL = "Skill publication contract";
const CANONICAL_PATH = "openapi/skill-publication.json";
const PINNED_RELATIVE_PATH =
  "platform/apps/skill-bench/src/authoring/publication/contract/openapi.json";

function run(): number {
  const ignatiousRepo = process.env.IGNATIOUS_REPO;
  if (!ignatiousRepo) {
    console.error(
      "IGNATIOUS_REPO must name the Ignatious checkout that holds the pinned contract.",
    );
    return 1;
  }
  const canonical = resolve(CANONICAL_PATH);
  const pinned = join(resolve(ignatiousRepo), PINNED_RELATIVE_PATH);
  const result = contractsMatch(canonical, pinned);
  if (result.match) {
    console.log(
      `${LABEL} matches.\nConductia: ${canonical}\nIgnatious: ${pinned}`,
    );
    return 0;
  }
  console.error(
    `${LABEL} mismatch${result.reason ? `: ${result.reason}` : "."}`,
  );
  console.error(`Conductia: ${canonical}`);
  console.error(`Ignatious: ${pinned}`);
  return 1;
}

if (process.argv[1]?.endsWith("verify-skill-publication-contract.ts")) {
  process.exitCode = run();
}
