export const BACKOFF_SECONDS_SCHEDULE = [5, 15, 60, 300, 900] as const;
export const PAUSE_RETRY_SECONDS = 300;
export const RECEIPT_CONFLICT_RETRY_SECONDS = 900;
// Publish attempts before the operation fails as publish_exhausted (#249).
// attempt_count resets to 0 on entering publishing and climbs on the
// 409 -> reconcile -> not-published loop, so this bounds both. With the backoff schedule, 20 attempts is roughly 4 hours.
export const MAX_PUBLISH_ATTEMPTS = 20;

export function backoffSecondsFor(attemptCount: number): number {
  const clamped = Math.min(
    Math.max(attemptCount, 1),
    BACKOFF_SECONDS_SCHEDULE.length,
  );
  return BACKOFF_SECONDS_SCHEDULE[clamped - 1];
}

export function retryAtSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
