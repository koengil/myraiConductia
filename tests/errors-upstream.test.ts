import { describe, expect, it } from 'vitest';
import {
  DbError,
  OperatorCopyError,
  UpstreamHttpError,
  dbFailure,
  errorCodeOf,
  upstreamErrorCode,
} from '@/lib/errors/upstream';
import { GoogleHttpError } from '@/lib/google/reader/http';
import { GoogleTokenError } from '@/lib/google/reader/token';
import { GraphHttpError } from '@/lib/graph/http';
import { IgnatiousRequestError } from '@/lib/ignatious/control-plane';

const CANARY = 'CANARY-331 the provider quoted a folder name and a mail subject';

function json(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('UpstreamHttpError', () => {
  it('names the provider, operation, status and code', () => {
    const err = new UpstreamHttpError('box', 'createFolder', 409, 'item_name_in_use', 'req_1');
    expect(err.message).toBe('box createFolder failed: 409 item_name_in_use');
    expect(err).toMatchObject({
      name: 'UpstreamHttpError',
      provider: 'box',
      op: 'createFolder',
      status: 409,
      code: 'item_name_in_use',
      requestId: 'req_1',
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('omits the code when there is none', () => {
    expect(new UpstreamHttpError('resend', 'send', 502).message).toBe('resend send failed: 502');
  });

  it('never carries a body: a sentence passed as the code is dropped', () => {
    const err = new UpstreamHttpError('box', 'upload', 403, CANARY, CANARY);
    expect(err.message).not.toContain('CANARY');
    expect(err.code).toBeNull();
    expect(err.requestId).toBeNull();
    expect(JSON.stringify({ ...err })).not.toContain('CANARY');
  });
});

describe('OperatorCopyError', () => {
  it('passes its fixed message through', () => {
    const err = new OperatorCopyError('Mailbox connection expired; reconnect the mailbox');
    expect(err.message).toBe('Mailbox connection expired; reconnect the mailbox');
    expect(err.name).toBe('OperatorCopyError');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UpstreamHttpError);
  });
});

describe('upstreamErrorCode', () => {
  it.each([
    ['a Box code', { type: 'error', code: 'item_name_in_use', message: CANARY }, 'item_name_in_use'],
    ['a Graph code', { error: { code: 'ErrorAccessDenied', message: CANARY } }, 'ErrorAccessDenied'],
    ['an Anthropic type', { type: 'error', error: { type: 'overloaded_error', message: CANARY } }, 'overloaded_error'],
    ['an OAuth error string', { error: 'invalid_grant', error_description: CANARY }, 'invalid_grant'],
    ['a Resend name', { name: 'validation_error', message: CANARY, statusCode: 403 }, 'validation_error'],
  ])('reads %s', async (_label, body, expected) => {
    expect(await upstreamErrorCode(json(body))).toBe(expected);
  });

  it('returns null rather than a field that is not code-shaped', async () => {
    expect(await upstreamErrorCode(json({ code: CANARY, message: CANARY }))).toBeNull();
    expect(await upstreamErrorCode(json({ error: { code: 'has a space', message: CANARY } }))).toBeNull();
    expect(await upstreamErrorCode(json({ code: 'x'.repeat(65) }))).toBeNull();
  });

  it('returns null for a body that is not JSON, empty, or not an object', async () => {
    expect(await upstreamErrorCode(new Response(CANARY, { status: 500 }))).toBeNull();
    expect(await upstreamErrorCode(new Response('', { status: 500 }))).toBeNull();
    expect(await upstreamErrorCode(json(null))).toBeNull();
    expect(await upstreamErrorCode(json('CANARY-331'))).toBeNull();
    expect(await upstreamErrorCode(json([CANARY]))).toBeNull();
  });
});

describe('DbError and dbFailure', () => {
  it('keeps the step and the code, and nothing the database said', () => {
    const err = dbFailure('Dataroom lookup', {
      code: '22P02',
      message: `invalid input syntax for type uuid: "${CANARY}"`,
      details: CANARY,
    } as { code?: string });
    expect(err).toBeInstanceOf(DbError);
    expect(err.message).toBe('Dataroom lookup failed (22P02)');
    expect(err.code).toBe('22P02');
    expect(err.message).not.toContain('CANARY');
    expect(JSON.stringify({ ...err })).not.toContain('CANARY');
  });

  it('reports an unexpected code when the error has none or a non-code', () => {
    expect(dbFailure('Deal lookup', null).message).toBe('Deal lookup failed (unexpected)');
    expect(dbFailure('Deal lookup', {}).code).toBeNull();
    const odd = dbFailure('Deal lookup', { code: CANARY });
    expect(odd.message).toBe('Deal lookup failed (unexpected)');
    expect(odd.code).toBeNull();
  });

  it('keeps the code a SQL function raised on purpose, and nothing else a P0001 says', () => {
    expect(dbFailure('Save', { code: 'P0001', message: 'name_taken' }).code).toBe('name_taken');
    expect(dbFailure('Save', { code: 'P0001', message: 'name_taken' }).message).toBe('Save failed (name_taken)');
    // A sentence, a capitalised message or another SQLSTATE is not a raised token.
    expect(dbFailure('Save', { code: 'P0001', message: `${CANARY} quoted a name` }).code).toBe('P0001');
    expect(dbFailure('Save', { code: 'P0001', message: 'Name Taken' }).code).toBe('P0001');
    expect(dbFailure('Save', { code: '23505', message: 'name_taken' }).code).toBe('23505');
  });

  it('is read back by errorCodeOf', () => {
    expect(errorCodeOf(dbFailure('Deal lookup', { code: '42501' }))).toBe('42501');
    expect(errorCodeOf(dbFailure('Deal lookup', null))).toBe('unexpected');
  });
});

describe('errorCodeOf', () => {
  it('maps an UpstreamHttpError to provider and status', () => {
    expect(errorCodeOf(new UpstreamHttpError('resend', 'send', 403, 'validation_error'))).toBe('resend_403');
    expect(errorCodeOf(new UpstreamHttpError('graph-mail', 'sendMail', 401))).toBe('graph-mail_401');
    expect(errorCodeOf(new UpstreamHttpError('box', 'upload', 409, 'item_name_in_use'))).toBe('box_409');
  });

  it('maps the body-free provider errors that carry a status to provider and status', () => {
    expect(errorCodeOf(new GoogleHttpError(403, 'forbidden', 1))).toBe('google_403');
    expect(errorCodeOf(new GoogleHttpError(500, null, 6))).toBe('google_500');
    expect(errorCodeOf(new GoogleTokenError('unauthorized_client', 400))).toBe('google-token_400');
    expect(errorCodeOf(new GoogleTokenError(null, 401))).toBe('google-token_401');
    expect(errorCodeOf(new GraphHttpError(404, null, null, 1))).toBe('graph_404');
    expect(errorCodeOf(new IgnatiousRequestError(502, CANARY, null))).toBe('ignatious_502');
  });

  it('keeps returning a GraphHttpError code when it has one', () => {
    expect(errorCodeOf(new GraphHttpError(404, 'ErrorItemNotFound', null, 1))).toBe('ErrorItemNotFound');
  });

  it('reads the code of a pg or PostgREST error', () => {
    expect(errorCodeOf({ code: '23505', message: CANARY })).toBe('23505');
    expect(errorCodeOf(Object.assign(new Error(CANARY), { code: 'PGRST116' }))).toBe('PGRST116');
  });

  it('answers unexpected for anything else, including a code that is not code-shaped', () => {
    expect(errorCodeOf(new Error(CANARY))).toBe('unexpected');
    expect(errorCodeOf(new OperatorCopyError('Mailbox connection expired'))).toBe('unexpected');
    expect(errorCodeOf({ code: CANARY })).toBe('unexpected');
    expect(errorCodeOf({ code: 42 })).toBe('unexpected');
    expect(errorCodeOf(null)).toBe('unexpected');
    expect(errorCodeOf(undefined)).toBe('unexpected');
    expect(errorCodeOf(CANARY)).toBe('unexpected');
    // A status alone, on an error that is not one of the provider classes, is not a code.
    expect(errorCodeOf(Object.assign(new Error(CANARY), { status: 500 }))).toBe('unexpected');
    expect(errorCodeOf({ name: 'GoogleHttpError', status: CANARY })).toBe('unexpected');
  });

  it('never returns text from the error message', () => {
    for (const err of [new Error(CANARY), { message: CANARY }, new UpstreamHttpError('box', CANARY, 500, CANARY)]) {
      expect(errorCodeOf(err)).not.toContain('CANARY');
    }
  });
});
