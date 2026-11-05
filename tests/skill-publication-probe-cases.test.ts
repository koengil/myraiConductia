import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";
import { CASES } from "./support/skillPublicationProbeCases";

const ROOT = resolve("supabase/tests/skill_publication.sql");
const ECHO_PREFIX = "\\echo ok: ";

function includePaths(file: string): string[] {
  const dir = dirname(file);
  const lines = readFileSync(file, "utf8").split("\n");
  const paths: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\\ir\s+(\S+)/);
    if (match && match[1].startsWith("skill_publication/")) {
      paths.push(resolve(dir, match[1]));
    }
  }
  return paths;
}

function echoOkLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(ECHO_PREFIX))
    .map((line) => line.slice(ECHO_PREFIX.length));
}

it("keeps the exported probe case titles in sync with the skill_publication SQL includes", () => {
  const titles = includePaths(ROOT).flatMap(echoOkLines);
  expect(titles).toEqual(CASES);
});
