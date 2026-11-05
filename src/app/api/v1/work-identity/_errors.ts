import { NextResponse } from 'next/server';
import { workIdentityErrorCopy } from '@/lib/auth/workIdentity';
import type { WorkIdentityErrorCode } from '@/lib/constants/workIdentity';
import { httpStatusFor } from '@/app/auth/work/_shared';

/** `{ error: <plain sentence>, code }`, the shape the invite routes already use. */
export function workIdentityError(code: WorkIdentityErrorCode, status = httpStatusFor(code)): NextResponse {
  return NextResponse.json({ error: workIdentityErrorCopy(code).message, code }, { status });
}
