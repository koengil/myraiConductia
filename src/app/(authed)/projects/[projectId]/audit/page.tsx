import { AuditTrail } from '@/components/audit/AuditTrail';

/**
 * /projects/[projectId]/audit — the Audit Trail destination.
 *
 * A thin server shell around the client screen. AuditTrail reads the log from
 * the browser (localStorage) and subscribes to live change events; it does not
 * read searchParams, so no Suspense boundary is required.
 */
export default function AuditPage() {
  return <AuditTrail />;
}
