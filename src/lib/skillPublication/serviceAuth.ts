import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { correlationId } from "@/lib/skillAuthoring/browserRoute";
import { writeSkillPublicationDenialAudit } from "./audit";
import { readSkillPublicationProcessorTokens } from "./config";

const WINDOW_MS = 60_000;
const SOURCE_FAILURE_LIMIT = 10;
const GLOBAL_FAILURE_LIMIT = 100;
const MAX_SOURCE_BUCKETS = 1_000;
const GLOBAL_BUCKET = "global";

type FailureBucket = { windowStart: number; failures: number };
export type SkillPublicationAuthLimiterState = Map<string, FailureBucket>;

export type ServiceAuthFailure = { ok: false; response: NextResponse };
export type ServiceAuthResult = { ok: true } | ServiceAuthFailure;

export type ServiceAuthOptions = {
  compare?: (left: Buffer, right: Buffer) => boolean;
  limiter?: SkillPublicationAuthLimiterState;
  now?: () => number;
  writeDenialAudit?: (input: { correlationId: string }) => Promise<void>;
  tokens?: () => string[];
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function sourceAddress(request: Request): string {
  const raw = request.headers
    .get("x-vercel-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  const family = raw ? isIP(raw) : 0;
  if (family === 4) return `source:${raw}`;
  if (family === 6 && raw)
    return `source:${new URL(`http://[${raw}]`).hostname.slice(1, -1)}`;
  return "source:unknown";
}

function activeBucket(
  limiter: SkillPublicationAuthLimiterState,
  key: string,
  now: number,
): FailureBucket {
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const existing = limiter.get(key);
  if (existing?.windowStart === windowStart) return existing;
  const bucket = { windowStart, failures: 0 };
  limiter.set(key, bucket);
  return bucket;
}

function capSourceBuckets(limiter: SkillPublicationAuthLimiterState): void {
  while (limiter.size > MAX_SOURCE_BUCKETS + 1) {
    const oldest = limiter.keys().next().value;
    if (oldest === undefined) return;
    if (oldest === GLOBAL_BUCKET) {
      const global = limiter.get(GLOBAL_BUCKET);
      limiter.delete(GLOBAL_BUCKET);
      if (global) limiter.set(GLOBAL_BUCKET, global);
      continue;
    }
    limiter.delete(oldest);
  }
}

function reserveFailure(
  limiter: SkillPublicationAuthLimiterState,
  source: string,
  now: number,
): boolean {
  const global = activeBucket(limiter, GLOBAL_BUCKET, now);
  const sourceBucket = activeBucket(limiter, source, now);
  capSourceBuckets(limiter);
  if (
    global.failures >= GLOBAL_FAILURE_LIMIT ||
    sourceBucket.failures >= SOURCE_FAILURE_LIMIT
  )
    return false;
  global.failures += 1;
  sourceBucket.failures += 1;
  return true;
}

function failure(status: 401 | 429, error: string): ServiceAuthFailure {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

function tokenMatches(
  token: string | null,
  candidates: string[],
  compare: (left: Buffer, right: Buffer) => boolean,
): boolean {
  if (token === null) return false;
  const supplied = digest(token);
  return candidates
    .map((candidate) => compare(supplied, digest(candidate)))
    .reduce((matched, result) => matched || result, false);
}

async function defaultDenialAudit({
  correlationId: id,
}: {
  correlationId: string;
}): Promise<void> {
  await writeSkillPublicationDenialAudit(createSupabaseAdminClient(), {
    service: "conductia",
    correlationId: id,
    reasonCode: "service_unauthorized",
  });
}

async function deny(
  request: Request,
  limiter: SkillPublicationAuthLimiterState,
  now: () => number,
  writeDenialAudit: (input: { correlationId: string }) => Promise<void>,
  source: string,
): Promise<ServiceAuthFailure> {
  const currentTime = now();
  if (!reserveFailure(limiter, source, currentTime))
    return failure(429, "Too many authentication failures.");
  const correlation = correlationId(request);
  try {
    await writeDenialAudit({ correlationId: correlation });
  } catch {
    console.error("[skill_publication_audit]", {
      code: "SKILL_PUBLICATION_DENIAL_AUDIT_FAILED",
      correlationId: correlation,
    });
  }
  return failure(401, "Unauthorized");
}

const defaultLimiter: SkillPublicationAuthLimiterState = new Map();

export function createSkillPublicationServiceAuth(
  options: ServiceAuthOptions = {},
) {
  const compare = options.compare ?? timingSafeEqual;
  const limiter = options.limiter ?? defaultLimiter;
  const now = options.now ?? Date.now;
  const writeDenialAudit = options.writeDenialAudit ?? defaultDenialAudit;
  const tokens = options.tokens ?? readSkillPublicationProcessorTokens;
  return async function requireSkillPublicationService(
    request: Request,
  ): Promise<ServiceAuthResult> {
    const source = sourceAddress(request);
    const authenticated = tokenMatches(bearerToken(request), tokens(), compare);
    if (!authenticated)
      return deny(request, limiter, now, writeDenialAudit, source);
    limiter.delete(source);
    return { ok: true };
  };
}

export const requireSkillPublicationService =
  createSkillPublicationServiceAuth();
