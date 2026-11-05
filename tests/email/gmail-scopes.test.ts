// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GMAIL_SEND_ALLOWED_GRANTED_SCOPES,
  GMAIL_SEND_REQUESTED_SCOPES,
} from '@/lib/constants/mailboxSend';
import { GMAIL_SEND_SCOPES, gmailSendAuthUrl } from '@/lib/email/gmail';

/*
 * Scope pin for the Gmail sending client (#490, design R2 and Q2). The sending
 * client asks for exactly openid, email and gmail.send, and accepts back only
 * those (Google may report email as userinfo.email). Nothing under
 * src/lib/email, nor the sending constants, names a Gmail read, modify or
 * compose scope: reading stays on the fenced DWD reader
 * (tests/google/no-send-path.test.ts), drafts stay in Conductia.
 * Plain text matching, so a comment naming a scope counts too.
 */

const root = process.cwd();
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const USERINFO_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const sendingFiles = [...walk(join(root, 'src/lib/email')), join(root, 'src/lib/constants/mailboxSend.ts')];

describe('the Gmail sending client names only openid, email and gmail.send', () => {
  it('requests exactly those three scopes', () => {
    expect([...GMAIL_SEND_REQUESTED_SCOPES].sort()).toEqual(['email', GMAIL_SEND, 'openid']);
    expect(GMAIL_SEND_SCOPES.split(' ').sort()).toEqual(['email', GMAIL_SEND, 'openid']);
    const url = new URL(gmailSendAuthUrl({ state: 's', challenge: 'c', loginHint: '', hd: '' }));
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', GMAIL_SEND, 'openid']);
  });

  it('accepts back only those, with userinfo.email as the alias of email', () => {
    expect([...GMAIL_SEND_ALLOWED_GRANTED_SCOPES].sort()).toEqual(['email', GMAIL_SEND, USERINFO_EMAIL, 'openid']);
  });

  it('finds the sending files', () => {
    expect(sendingFiles.some((file) => file.endsWith('gmail.ts'))).toBe(true);
  });

  it('names no other Google scope URL under src/lib/email or in the sending constants', () => {
    const allowed = new Set([GMAIL_SEND, USERINFO_EMAIL]);
    for (const file of sendingFiles) {
      const scopes = [...readFileSync(file, 'utf8').matchAll(/https:\/\/www\.googleapis\.com\/auth\/[a-z._-]+/g)].map((m) => m[0]);
      expect(scopes.filter((s) => !allowed.has(s)), relative(root, file)).toEqual([]);
    }
  });

  it('names no Gmail read, modify, compose or full-mailbox scope, in any spelling', () => {
    // Short names (gmail.readonly), any auth URL form other than gmail.send, and the full-mailbox scope.
    const forbidden = /\bgmail\.(?:readonly|metadata|modify|compose|insert|labels|settings|addons)\b|auth\/gmail\.(?!send\b)|mail\.google\.com/;
    for (const file of sendingFiles) {
      const hits = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => forbidden.test(line));
      expect(hits, relative(root, file)).toEqual([]);
    }
  });
});

describe('the Gmail sending client never revokes at Google (#490 audit 1)', () => {
  it('names no revoke endpoint under src/lib/email or in the sending constants', () => {
    // Google's revoke can end every grant the account gave the Cloud project,
    // Google sign-in included. A refused connect stores nothing instead.
    for (const file of sendingFiles) {
      expect(readFileSync(file, 'utf8'), relative(root, file)).not.toMatch(/oauth2\.googleapis\.com\/revoke|accounts\.google\.com\/o\/oauth2\/revoke/);
    }
  });
});
