import { describe, expect, it } from "vitest";
import { assertMode2SupabaseUrl, requireMode2ServiceRoleKey } from "./mode2Url";

function acceptsLoopbackHttpUrl(): void {
  expect(assertMode2SupabaseUrl("http://127.0.0.1:54329").hostname).toBe(
    "127.0.0.1",
  );
}

function rejectsSharedStackDatabasePort(): void {
  expect(() => assertMode2SupabaseUrl("http://127.0.0.1:54322")).toThrow(
    /54322/,
  );
}

function rejectsSharedStackApiPort(): void {
  expect(() => assertMode2SupabaseUrl("http://127.0.0.1:54321")).toThrow(
    /54321/,
  );
}

function rejectsNonLoopbackHost(): void {
  expect(() => assertMode2SupabaseUrl("http://example.com:54329")).toThrow(
    /loopback/,
  );
}

function rejectsNonHttpUrl(): void {
  expect(() => assertMode2SupabaseUrl("postgres://127.0.0.1:54329")).toThrow(
    /http/,
  );
}

function acceptsLocalhostLoopback(): void {
  expect(assertMode2SupabaseUrl("http://localhost:54329").hostname).toBe(
    "localhost",
  );
}

function acceptsBracketedIpv6Loopback(): void {
  expect(assertMode2SupabaseUrl("http://[::1]:54329").hostname).toBe("[::1]");
}

function requiresServiceRoleKey(): void {
  expect(() => requireMode2ServiceRoleKey({})).toThrow(
    /CONDUCTIA_SUPABASE_E2E_SERVICE_ROLE_KEY/,
  );
}

function returnsServiceRoleKeyWhenPresent(): void {
  expect(
    requireMode2ServiceRoleKey({
      CONDUCTIA_SUPABASE_E2E_SERVICE_ROLE_KEY: "secret",
    }),
  ).toBe("secret");
}

const CASES: [string, () => void][] = [
  ["accepts a loopback http URL on a non-blocked port", acceptsLoopbackHttpUrl],
  [
    "rejects port 54322, the shared local stack's database port",
    rejectsSharedStackDatabasePort,
  ],
  [
    "rejects port 54321, the shared local stack's API port",
    rejectsSharedStackApiPort,
  ],
  ["rejects a non-loopback host", rejectsNonLoopbackHost],
  ["rejects a non-http(s) URL", rejectsNonHttpUrl],
  ["accepts localhost as loopback", acceptsLocalhostLoopback],
  ["accepts a bracketed ::1 as loopback", acceptsBracketedIpv6Loopback],
  ["requires the service role key env var", requiresServiceRoleKey],
  [
    "returns the service role key when present",
    returnsServiceRoleKeyWhenPresent,
  ],
];

describe("mode 2 Supabase URL validation", () => {
  for (const [name, testCase] of CASES) {
    it(name, testCase);
  }
});
