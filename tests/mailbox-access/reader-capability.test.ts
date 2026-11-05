import { describe, expect, it } from 'vitest';

import { MailboxAccessRefusedError } from '@/lib/mailboxAccess';

/*
 * The reader capability (#262, audit round 1, item 1). Every static fence can
 * be walked around (a computed import(), a re-export, a helper), so the reader
 * factories refuse at run time: a caller without the capability that only
 * src/lib/mailboxAccess/readers.ts holds gets MailboxAccessRefusedError with
 * reason no_capability, and no reader.
 */

// A computed specifier: no lint rule or import graph sees this file reach the reader.
const READER = ['../../src/lib/graph', 'reader'].join('/');
const FIXTURE = ['../../src/lib/graph/reader', 'fixture'].join('/');
const CAPABILITY = ['../../src/lib/graph/reader', 'capability'].join('/');
// The provider-neutral home (C3); the graph path above is a re-export of it.
const NEUTRAL_CAPABILITY = ['../../src/lib/discovery/source', 'capability'].join('/');

async function refusal(run: () => unknown): Promise<unknown> {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe('the reader capability', () => {
  it('refuses getContentSource reached by a computed import, called the old way', async () => {
    const reader = (await import(/* @vite-ignore */ READER)) as {
      getContentSource: (...args: unknown[]) => unknown;
    };
    const error = await refusal(() => reader.getContentSource('mailbox', 'fixture'));
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: 'no_capability' });
  });

  it('refuses a forged capability, whatever its shape', async () => {
    const reader = (await import(/* @vite-ignore */ READER)) as {
      getContentSource: (...args: unknown[]) => unknown;
    };
    for (const forged of [{}, Object.freeze({}), Symbol('capability'), 'capability', null, undefined]) {
      const error = await refusal(() => reader.getContentSource(forged, 'mailbox', 'fixture'));
      expect(error, String(forged)).toBeInstanceOf(MailboxAccessRefusedError);
      expect(error).toMatchObject({ reason: 'no_capability' });
    }
  });

  it('refuses the fixture reader factory without the capability', async () => {
    const fixture = (await import(/* @vite-ignore */ FIXTURE)) as {
      createFixtureContentSource: (...args: unknown[]) => unknown;
    };
    const error = await refusal(() => fixture.createFixtureContentSource());
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: 'no_capability' });
  });

  it('refuses the fixture corpus loader without the capability (round 2, item 9)', async () => {
    const fixture = (await import(/* @vite-ignore */ FIXTURE)) as {
      loadFixtureMailboxes: (...args: unknown[]) => unknown;
    };
    for (const args of [[], [undefined], ['tests/fixtures/discovery'], [{}], [Object.freeze({})], [null]]) {
      const error = await refusal(() => fixture.loadFixtureMailboxes(...args));
      expect(error, JSON.stringify(args)).toBeInstanceOf(MailboxAccessRefusedError);
      expect(error).toMatchObject({ reason: 'no_capability' });
    }
  });

  it('refuses the live Graph factories without the capability (#243): readers, credentials, tokens, the probe', async () => {
    const load = (name: string) => import(/* @vite-ignore */ ['../../src/lib/graph/reader', name].join('/'));
    const mail = await load('mail');
    const drive = await load('drive');
    const token = await load('token');
    const certificate = await load('certificateSource');
    const reader = await load('index');
    const probe = await load('probe');
    const http = { getToken: async () => 'token', fetchImpl: (async () => new Response('{}')) as typeof fetch };
    const registration = { tenantId: 't', msTenantId: 'm', clientId: 'c', certThumbprint: null, certSecretRef: null };
    const calls: Array<[string, () => unknown]> = [
      ['createGraphMailContentSource', () => mail.createGraphMailContentSource({}, { http })],
      ['createGraphDriveContentSource', () => drive.createGraphDriveContentSource({}, { http })],
      ['createReaderTokenProvider', () => token.createReaderTokenProvider({}, registration, {})],
      ['ReaderTokenCache', () => new token.ReaderTokenCache({}, () => ({}))],
      ['certificateSourceFromRef', () => certificate.certificateSourceFromRef({}, 'env:X', 'a'.repeat(64))],
      ['envPemCertificateSource', () => certificate.envPemCertificateSource({}, { pem: '', thumbprint: 'a'.repeat(64) })],
      ['keyVaultCertificateSource', () => certificate.keyVaultCertificateSource({}, { keyId: '', thumbprint: '', getVaultToken: async () => '' })],
      ['managedIdentityVaultToken', () => certificate.managedIdentityVaultToken({})],
      ['createGraphReaderContext', () => reader.createGraphReaderContext({}, registration)],
    ];
    for (const [name, run] of calls) {
      const error = await refusal(run);
      expect(error, name).toBeInstanceOf(MailboxAccessRefusedError);
      expect(error, name).toMatchObject({ reason: 'no_capability' });
    }
    await expect(probe.probeGraphScope({}, http, { kind: 'mailbox', address: 'a@b.example' })).rejects.toMatchObject({
      reason: 'no_capability',
    });
  });

  it('hands the capability out once: a second claim throws', async () => {
    // mailboxAccess/readers.ts claimed it when @/lib/mailboxAccess loaded above.
    const capability = (await import(/* @vite-ignore */ CAPABILITY)) as {
      claimReaderCapability: () => unknown;
    };
    expect(() => capability.claimReaderCapability()).toThrow(/already claimed/);
  });

  it('hands the capability out once across both paths: the old path shares the one instance', async () => {
    const neutral = (await import(/* @vite-ignore */ NEUTRAL_CAPABILITY)) as {
      claimReaderCapability: () => unknown;
      requireReaderCapability: (candidate: unknown) => void;
    };
    const legacy = (await import(/* @vite-ignore */ CAPABILITY)) as typeof neutral;
    expect(() => neutral.claimReaderCapability()).toThrow(/already claimed/);
    expect(() => legacy.claimReaderCapability()).toThrow(/already claimed/);
    expect(legacy.requireReaderCapability).toBe(neutral.requireReaderCapability);
    for (const forged of [{}, Object.freeze({}), null, undefined]) {
      expect(() => neutral.requireReaderCapability(forged)).toThrow(MailboxAccessRefusedError);
      expect(() => legacy.requireReaderCapability(forged)).toThrow(MailboxAccessRefusedError);
    }
  });
});
