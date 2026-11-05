import { NextResponse } from 'next/server';

export type ConductiaErrorCode =
  | 'authentication'
  | 'scope_denied'
  | 'not_found'
  | 'validation'
  | 'version_conflict'
  | 'server_error';

export function conductiaError(
  code: ConductiaErrorCode,
  message: string,
  status: number,
  detail: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    { error: { code, message, alert: false, retryable: false, detail } },
    { status },
  );
}
