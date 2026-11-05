import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { devApiEnabled } from '@/lib/api/v1/devApi';

// The document maps the whole v1 surface (tests/openapi-route-coverage.test.ts
// keeps it in step with the handlers) — every route, its auth rules, its
// feature flag and its permission names. It is served unauthenticated so the
// explorer can load it before you sign in, so it rides the same gate as the
// explorer itself rather than standing open on staging and prod.
export async function GET() {
  if (!devApiEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const path = join(process.cwd(), 'openapi', 'phase1.json');
  const spec = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return NextResponse.json(spec);
}
