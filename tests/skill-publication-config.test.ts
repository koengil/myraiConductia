import { afterEach, expect, it } from "vitest";
import {
  readSkillPublicationProcessorTokens,
  readSkillPublicationServiceConfig,
  SKILL_PUBLICATION_REQUEST_TIMEOUT_MS,
} from "@/lib/skillPublication/config";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(overrides: Record<string, string | undefined>) {
  delete process.env.IGNATIOUS_SKILL_BENCH_URL;
  delete process.env.IGNATIOUS_PUBLICATION_SERVICE_TOKEN;
  delete process.env.IGNATIOUS_API_KEY;
  delete process.env.IGNATIOUS_AUTHORING_SERVICE_TOKEN;
  delete process.env.SKILL_PUBLICATION_PROCESSOR_TOKEN;
  delete process.env.SKILL_PUBLICATION_PROCESSOR_TOKEN_PREVIOUS;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const NULL_CONFIG_CASES: Array<[string, Record<string, string | undefined>]> = [
  [
    "the bench URL is missing",
    { IGNATIOUS_PUBLICATION_SERVICE_TOKEN: "pub-token" },
  ],
  [
    "the publication token is missing",
    { IGNATIOUS_SKILL_BENCH_URL: "http://localhost:4212" },
  ],
  [
    "the publication token equals the Ignatious API key",
    {
      IGNATIOUS_SKILL_BENCH_URL: "http://localhost:4212",
      IGNATIOUS_PUBLICATION_SERVICE_TOKEN: "shared-secret",
      IGNATIOUS_API_KEY: "shared-secret",
    },
  ],
  [
    "the publication token equals the authoring service token",
    {
      IGNATIOUS_SKILL_BENCH_URL: "http://localhost:4212",
      IGNATIOUS_PUBLICATION_SERVICE_TOKEN: "shared-secret",
      IGNATIOUS_AUTHORING_SERVICE_TOKEN: "shared-secret",
    },
  ],
];

it.each(NULL_CONFIG_CASES)(
  "readSkillPublicationServiceConfig returns null when %s",
  (_reason, env) => {
    resetEnv(env);

    expect(readSkillPublicationServiceConfig()).toBeNull();
  },
);

it("readSkillPublicationServiceConfig returns the trimmed bench URL and publication token when configured", () => {
  resetEnv({
    IGNATIOUS_SKILL_BENCH_URL: " http://localhost:4212/ ",
    IGNATIOUS_PUBLICATION_SERVICE_TOKEN: "pub-token",
  });

  expect(readSkillPublicationServiceConfig()).toEqual({
    benchUrl: "http://localhost:4212",
    publicationToken: "pub-token",
  });
});

it("readSkillPublicationServiceConfig accepts a publication token distinct from both other credentials", () => {
  resetEnv({
    IGNATIOUS_SKILL_BENCH_URL: "http://localhost:4212",
    IGNATIOUS_PUBLICATION_SERVICE_TOKEN: "pub-token",
    IGNATIOUS_API_KEY: "api-key",
    IGNATIOUS_AUTHORING_SERVICE_TOKEN: "authoring-token",
  });

  expect(readSkillPublicationServiceConfig()).toEqual({
    benchUrl: "http://localhost:4212",
    publicationToken: "pub-token",
  });
});

const PROCESSOR_TOKEN_CASES: Array<
  [string, Record<string, string | undefined>, string[]]
> = [
  ["unset", {}, []],
  [
    "only the current token is set",
    { SKILL_PUBLICATION_PROCESSOR_TOKEN: "current-token" },
    ["current-token"],
  ],
  [
    "both tokens are set",
    {
      SKILL_PUBLICATION_PROCESSOR_TOKEN: "current-token",
      SKILL_PUBLICATION_PROCESSOR_TOKEN_PREVIOUS: "previous-token",
    },
    ["current-token", "previous-token"],
  ],
];

it.each(PROCESSOR_TOKEN_CASES)(
  "readSkillPublicationProcessorTokens returns %s",
  (_reason, env, expected) => {
    resetEnv(env);

    expect(readSkillPublicationProcessorTokens()).toEqual(expected);
  },
);

it("SKILL_PUBLICATION_REQUEST_TIMEOUT_MS is a positive bounded timeout", () => {
  expect(SKILL_PUBLICATION_REQUEST_TIMEOUT_MS).toBe(10000);
});
