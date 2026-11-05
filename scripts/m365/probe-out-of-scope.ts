// First import, on purpose: it claims the reader capability before any other
// module loads (tests/mailbox-access/boot-claim.test.ts pins the order). The
// registration's credential is used only inside it (#262).
import { probeReaderScope, type ScopeProbeTarget } from '../../src/lib/mailboxAccess/readers';

import { createClient } from '@supabase/supabase-js';

import { TABLE } from '../../src/lib/constants/tables';

// Step 4 of scripts/m365/README.md: prove the reader's grant is as narrow as
// it claims (ADR-005). With the registration's own certificate credential it
// asks Graph for one message id from a mailbox OUTSIDE the RBAC for
// Applications scope group, and expects 403. Optionally it also asks for one
// from a mailbox inside the scope (expects 200), and lists a SharePoint site
// that was NOT granted under Sites.Selected (expects 403).
//
//   node --env-file=<env> --import tsx scripts/m365/probe-out-of-scope.ts \
//     --tenant <Conductia tenant uuid> --out-of-scope <mailbox> \
//     [--in-scope <mailbox>] [--site-out-of-scope <site id>]
//
// It reads only ids ($select=id, $top=1) and prints only statuses and Graph
// error codes, never a subject or a body. Exit 0 when every expectation
// holds, 1 otherwise. It needs the same environment as the worker: the
// Supabase service credentials (to read the registration) and the
// certificate source the registration names (Key Vault access, or the PEM
// variable for the test tenant).

type Expectation = { label: string; target: ScopeProbeTarget; expected: number };

function arg(argv: string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

async function main(argv: string[]): Promise<void> {
  const tenantId = arg(argv, '--tenant');
  const outOfScope = arg(argv, '--out-of-scope');
  if (!tenantId || !outOfScope) {
    throw new Error(
      'Usage: probe-out-of-scope.ts --tenant <uuid> --out-of-scope <mailbox> [--in-scope <mailbox>] [--site-out-of-scope <site id>]',
    );
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: registration, error } = await db
    .from(TABLE.GRAPH_READER_REGISTRATIONS)
    .select('tenant_id, ms_tenant_id, client_id, cert_thumbprint, cert_secret_ref')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`registration lookup failed: ${error.message}`);
  if (!registration) throw new Error(`No reader registration for tenant ${tenantId}`);

  const expectations: Expectation[] = [
    { label: `mailbox outside the scope (${outOfScope})`, target: { kind: 'mailbox', address: outOfScope }, expected: 403 },
  ];
  const inScope = arg(argv, '--in-scope');
  if (inScope) {
    expectations.push({ label: `mailbox inside the scope (${inScope})`, target: { kind: 'mailbox', address: inScope }, expected: 200 });
  }
  const site = arg(argv, '--site-out-of-scope');
  if (site) expectations.push({ label: `site not granted (${site})`, target: { kind: 'site', siteId: site }, expected: 403 });

  // One attempt each, statuses only (src/lib/graph/reader/probe.ts).
  const results = await probeReaderScope(
    {
      tenantId: registration.tenant_id as string,
      msTenantId: registration.ms_tenant_id as string,
      clientId: registration.client_id as string,
      certThumbprint: registration.cert_thumbprint as string | null,
      certSecretRef: registration.cert_secret_ref as string | null,
    },
    expectations.map((expectation) => expectation.target),
  );

  let failed = 0;
  for (const [index, expectation] of expectations.entries()) {
    const { status, code } = results[index];
    const ok = status === expectation.expected;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${expectation.label}: ${status}${code ? ` ${code}` : ''} (expected ${expectation.expected})`);
  }
  if (failed > 0) {
    console.error(`${failed} probe(s) did not match. Do not start the worker against this tenant until they do.`);
    process.exit(1);
  }
  console.log('The reader is confined to its scope.');
}

if (process.argv[1]?.endsWith('probe-out-of-scope.ts')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
