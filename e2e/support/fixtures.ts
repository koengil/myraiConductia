import { test as base, expect, request as playwrightRequest } from '@playwright/test';
import { MD_STATE_PATH } from '../auth/session';
import {
  cspViolations,
  flushCspReports,
  takeRegisteredContexts,
  withCspCollector,
} from './cspViolations';
import { Evidence } from './evidence';
import { newRunId } from './runId';
import { vercelBypassHeaders } from './vercelBypass';

export const test = base.extend<{
  runId: string;
  since: string;
  evidence: Evidence;
  cspExtraContexts: void;
}>({
  // Every journey is a Content-Security-Policy check: the page the test drives,
  // and every extra context opened through newCollectedContext, fail the test
  // on any violation (enforced or report-only). A spec that blocks something on
  // purpose does not use this `test`; it installs the collector by hand (see
  // csp-collector.spec.ts) and says why.
  context: async ({ context }, use) => {
    await withCspCollector(context);
    await use(context);
    await flushCspReports(context);
    expect(cspViolations(context), 'CSP violations in the test context').toEqual([]);
  },
  // Auto, so a spec that opens contexts without ever touching `page` or
  // `context` is still checked.
  cspExtraContexts: [
    async ({}, use) => {
      takeRegisteredContexts();
      await use();
      for (const extra of takeRegisteredContexts()) {
        // A context the spec already closed was flushed by its close().
        await flushCspReports(extra);
        expect(cspViolations(extra), 'CSP violations in an extra browser context').toEqual([]);
      }
    },
    { auto: true },
  ],
  runId: async ({}, use) => {
    await use(newRunId());
  },
  since: async ({}, use) => {
    // The lower bound for every audit assertion in this test.
    await use(new Date(Date.now() - 5_000).toISOString());
  },
  evidence: async ({ baseURL }, use) => {
    const context = await playwrightRequest.newContext({
      baseURL,
      storageState: MD_STATE_PATH,
      extraHTTPHeaders: vercelBypassHeaders(),
    });
    await use(new Evidence(context));
    await context.dispose();
  },
});

export { expect };
