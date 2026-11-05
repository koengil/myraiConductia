import { runtimeEnv } from "@/lib/ignatious/config";

export const SKILL_PUBLICATION_REQUEST_TIMEOUT_MS = 10000;

export type SkillPublicationServiceConfig = {
  benchUrl: string;
  publicationToken: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function readSkillPublicationServiceConfig(): SkillPublicationServiceConfig | null {
  const benchUrl = runtimeEnv("IGNATIOUS_SKILL_BENCH_URL")?.trim();
  const publicationToken = runtimeEnv(
    "IGNATIOUS_PUBLICATION_SERVICE_TOKEN",
  )?.trim();
  if (!benchUrl || !publicationToken) return null;

  const apiKey = runtimeEnv("IGNATIOUS_API_KEY")?.trim();
  const authoringToken = runtimeEnv(
    "IGNATIOUS_AUTHORING_SERVICE_TOKEN",
  )?.trim();
  if (publicationToken === apiKey || publicationToken === authoringToken) {
    return null;
  }

  return { benchUrl: trimTrailingSlash(benchUrl), publicationToken };
}

export function readSkillPublicationProcessorTokens(): string[] {
  const current = runtimeEnv("SKILL_PUBLICATION_PROCESSOR_TOKEN")?.trim();
  const previous = runtimeEnv(
    "SKILL_PUBLICATION_PROCESSOR_TOKEN_PREVIOUS",
  )?.trim();
  const cron = runtimeEnv("CRON_SECRET")?.trim();
  return [current, previous, cron].filter((token): token is string =>
    Boolean(token),
  );
}
