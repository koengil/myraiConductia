// Fixture: the boot-claim import, from a file that is not src/instrumentation.ts.
// The exemption in tests/agent-surfaces.test.ts is exact, so this is flagged.
export async function register(): Promise<void> {
  await import('@/lib/mailboxAccess/readers');
}
