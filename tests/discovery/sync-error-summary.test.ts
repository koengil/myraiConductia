// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { InvalidExclusionPolicyError, NoExclusionPolicyError } from '@/lib/discovery/exclusion/errors';
import { GraphHttpError } from '@/lib/graph/http';
import { errorSummary, SYNC_ERROR } from '../../worker/sync';

// content_sources.last_error is what a firm admin reads through the health
// RPC, and admins never read what discovery collects (Q19). Graph's own status
// and code pass through; every other failure becomes a fixed code, because a
// database or extractor message can quote values from the data.
describe('the sync error summary', () => {
  it('keeps Graph status and code', () => {
    expect(errorSummary(new GraphHttpError(429, 'TooManyRequests', 'req-1', 3))).toMatch(/^Graph 429 TooManyRequests/);
  });

  it('keeps Google status and reason, matched by name because the worker may not import the Google reader', () => {
    class GoogleHttpError extends Error {
      constructor(readonly status: number, readonly reason: string | null) {
        super(`Google request failed: ${status} (body: Project Falcon)`);
        this.name = 'GoogleHttpError';
      }
    }
    expect(errorSummary(new GoogleHttpError(403, 'rateLimitExceeded'))).toBe('Google 403 rateLimitExceeded');
    expect(errorSummary(new GoogleHttpError(500, null))).toBe('Google 500');
    // Never the message, which is the one place a body could have leaked.
    expect(errorSummary(new GoogleHttpError(404, 'notFound'))).not.toContain('Falcon');
  });

  it('names a refused delegation with a fixed code, matched by name, never the reason or a body', () => {
    class GoogleTokenError extends Error {
      constructor(readonly reason: string | null, readonly status: number) {
        super(`Google token exchange failed: ${status}${reason ? ` ${reason}` : ''} (body: Project Falcon, token ya29.secret)`);
        this.name = 'GoogleTokenError';
      }
    }
    for (const refusal of [new GoogleTokenError('unauthorized_client', 401), new GoogleTokenError(null, 400)]) {
      const summary = errorSummary(refusal);
      expect(summary).toBe(SYNC_ERROR.DELEGATION);
      expect(summary).toBe('Google delegation refused');
      expect(summary).not.toMatch(/Falcon|ya29|unauthorized_client/);
    }
  });

  it('names a token endpoint outage apart from a refused delegation, by status', () => {
    class GoogleTokenError extends Error {
      constructor(readonly reason: string | null, readonly status: number) {
        super(`Google token exchange failed: ${status} (body: Project Falcon)`);
        this.name = 'GoogleTokenError';
      }
    }
    for (const status of [400, 401, 403]) expect(errorSummary(new GoogleTokenError(null, status))).toBe(SYNC_ERROR.DELEGATION);
    for (const status of [500, 503]) {
      const summary = errorSummary(new GoogleTokenError(null, status));
      expect(summary).toBe(SYNC_ERROR.TOKEN_UNAVAILABLE);
      expect(summary).toBe('Google token endpoint unavailable');
      expect(summary).not.toContain('Falcon');
    }
  });

  it('names a deadline as a timeout, matched by the TimeoutError name only', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(errorSummary(timeout)).toBe(SYNC_ERROR.TIMEOUT);
    expect(errorSummary(timeout)).toBe('Request timed out');
    expect(errorSummary(new DOMException('The operation was aborted', 'AbortError'))).toBe(SYNC_ERROR.WORKER);
  });

  it('names a missing or invalid exclusion policy with a fixed code, by error name, carrying no rule content (#263)', () => {
    expect(errorSummary(new NoExclusionPolicyError())).toBe(SYNC_ERROR.NO_EXCLUSION_POLICY);
    expect(errorSummary(new InvalidExclusionPolicyError())).toBe(SYNC_ERROR.INVALID_EXCLUSION_POLICY);
    expect(SYNC_ERROR.NO_EXCLUSION_POLICY).toBe('No exclusion policy');
    expect(SYNC_ERROR.INVALID_EXCLUSION_POLICY).toBe('Exclusion policy invalid');
    // Matched by name, so a copy of the class from another module instance is still named.
    class Copy extends Error {
      constructor() {
        super('rules: counsel.example');
        this.name = 'InvalidExclusionPolicyError';
      }
    }
    expect(errorSummary(new Copy())).toBe(SYNC_ERROR.INVALID_EXCLUSION_POLICY);
    expect(errorSummary(new Copy())).not.toContain('counsel');
  });

  it('reduces a database failure to a fixed code, dropping the values it quotes', () => {
    const summary = errorSummary(
      new Error('discovery persist: source_items insert failed: Key (internet_message_id)=(<falcon-ioi@buyer.example>) already exists'),
    );
    expect(summary).toBe(SYNC_ERROR.DATABASE);
    expect(errorSummary(new Error('discovery sync: checkpoint update failed: value too long'))).toBe(SYNC_ERROR.DATABASE);
  });

  // The thrown messages carry a code instead of the database's text (#331). The prefixes errorSummary keys on
  // stay, so the Ingestion health label does not change.
  it('maps a code-only message to the same label, because the prefix is kept', () => {
    expect(errorSummary(new Error('discovery persist: source_items insert failed (23505)'))).toBe(SYNC_ERROR.DATABASE);
    expect(errorSummary(new Error('discovery persist: no stored item for a candidate item'))).toBe(SYNC_ERROR.DATABASE);
    expect(errorSummary(new Error('discovery sync: checkpoint update failed (22001)'))).toBe(SYNC_ERROR.DATABASE);
    expect(errorSummary(new Error('graph mail reader: the checkpoint is not JSON'))).toBe(SYNC_ERROR.CHECKPOINT);
    expect(errorSummary(new GraphHttpError(404, 'ErrorItemNotFound', 'a1b2c3d4-0000-4000-8000-000000000009', 1))).toBe('Graph 404 ErrorItemNotFound');
  });

  it('names an unreadable checkpoint', () => {
    expect(errorSummary(new Error('graph mail reader: the checkpoint is not JSON'))).toBe(SYNC_ERROR.CHECKPOINT);
    expect(errorSummary(new Error('graph drive reader: the checkpoint is not a graph-drive checkpoint'))).toBe(SYNC_ERROR.CHECKPOINT);
    expect(errorSummary(new Error('gmail reader: unreadable checkpoint'))).toBe(SYNC_ERROR.CHECKPOINT);
    expect(errorSummary(new Error('gmail reader: unreadable checkpoint (not a delta checkpoint)'))).toBe(SYNC_ERROR.CHECKPOINT);
  });

  it('reduces anything else to the worker code', () => {
    expect(errorSummary(new Error('Project Falcon: unexpected token in the memo'))).toBe(SYNC_ERROR.WORKER);
    expect(errorSummary('a thrown string with Project Falcon in it')).toBe(SYNC_ERROR.WORKER);
  });
});
