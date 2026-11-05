// A gate's refusal, logged (#474, design Q4). Each failure branch of an auth gate
// wraps the response it already returns, so the body a caller sees is unchanged and
// the branch edit is one line.

import type { NextResponse } from 'next/server';

import type { LineFor } from './fields';
import { logServerEvent } from './index';

export type AuthLine = LineFor<'auth_denied'> | LineFor<'auth_unavailable'>;

export function refuse(response: NextResponse, line: AuthLine): { ok: false; response: NextResponse } {
  logServerEvent(line);
  return { ok: false, response };
}
