import { parsePublicationRead } from "./parsePublicationRead";
import type { PublicationRead } from "./types";

export function parseAuthoritativePublicationRead(
  value: unknown,
): { available: false } | PublicationRead | null {
  const result = parsePublicationRead(value);
  return result === undefined ? null : result;
}
