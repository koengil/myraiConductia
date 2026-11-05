import { notFound } from 'next/navigation';
import { devApiEnabled } from '@/lib/api/v1/devApi';
import DevApiPage from './page.client';

// Dev-only API console. The gate it shares with /api/v1/openapi.json, the route
// that serves the document rendered below, lives in lib/api/v1/devApi.
export const dynamic = 'force-dynamic';

export default function DevApiRoute() {
  if (!devApiEnabled()) {
    notFound();
  }

  return <DevApiPage />;
}
