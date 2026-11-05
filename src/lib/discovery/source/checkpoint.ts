// A typed "the stored cursor is gone" signal (#259 phase 3, design R9 and R21).
// Provider-neutral and free of any SDK, so the worker can catch it without
// importing a reader (the fence): the Gmail reader throws it, and #271 maps
// Graph's 410 onto it.

/**
 * A provider said the stored incremental cursor is no longer valid (Gmail 404
 * on history.list; Graph 410 syncStateNotFound in #271). The worker resets the
 * source to a fresh backfill (R9); it is a normal event, not a failure.
 */
export class CheckpointExpiredError extends Error {
  constructor(readonly provider: 'google' | 'microsoft') {
    super(`${provider} incremental checkpoint expired`);
    this.name = 'CheckpointExpiredError';
  }
}

export function isCheckpointExpired(error: unknown): error is CheckpointExpiredError {
  return error instanceof CheckpointExpiredError || (error as { name?: string } | null)?.name === 'CheckpointExpiredError';
}
