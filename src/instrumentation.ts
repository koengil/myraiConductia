// Next server boot (#262, audit round 2, item 1). The reader capability is
// claimed once per module instance, when src/lib/mailboxAccess/readers.ts
// loads. Loading it here, before the server takes a request, means a hostile
// module that claimed the capability first makes the boot throw, instead of
// leaving a process that reads with no guard call.
//
// The import sits inside the Node-runtime branch, so the edge bundle drops it
// (Next replaces NEXT_RUNTIME at build time) and never contains a reader.
// tests/mailbox-access/boot-claim.test.ts pins this file and its counterparts
// at the top of worker/classify.ts and each script that can reach a reader.

import type { Instrumentation } from 'next';

import { logServerEvent } from '@/lib/log';
import { requestErrorLine } from '@/lib/log/requestError';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@/lib/mailboxAccess/readers');
  }
}

// An error that escaped a route, a render, a server action or the proxy (#474):
// one request_error line, by class only. Next still prints the error itself, and
// this does not change that print (thread T7). The logger imports no Node
// built-in, so both runtimes can load this file.
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  logServerEvent(requestErrorLine(err, request.method, context.routeType));
};
