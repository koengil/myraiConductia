// A tool that builds its own reader through a dynamic import. Even where the
// static fences miss it, the reader factory refuses at run time: it has no
// reader capability (tests/mailbox-access/reader-capability.test.ts).
export async function tool() {
  const reader = await import('@/lib/graph/reader');
  const getContentSource = reader.getContentSource as unknown as (...args: unknown[]) => unknown;
  return getContentSource('mailbox', 'fixture');
}
