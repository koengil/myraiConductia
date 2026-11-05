import type { Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';

/**
 * Turns the browser's own Content-Security-Policy enforcement into a test
 * signal. Every `securitypolicyviolation` event (it fires under the enforced
 * header and under Content-Security-Policy-Report-Only alike, so the same suite
 * proves "nothing first-party breaks" before and after a rollback) is sent to
 * Node the moment it fires.
 *
 * Nothing is buffered inside the page. An in-page buffer is per document: every
 * full navigation would drop it, and a walk across several pages would only
 * ever see its last one. The list lives here, keyed by context, and survives
 * every navigation, frame and page of that context.
 *
 * Reading the list is preceded by `flushCspReports`, so a report raised just
 * before teardown or before an extra context closes is still counted.
 *
 * Browser contexts are opened only through `newCollectedContext`
 * (tests/e2e-csp-collector-guard.test.ts enforces that), so no page in the
 * suite runs uncollected.
 */

export type CspViolation = {
  directive: string;
  blockedURI: string;
  sourceFile: string;
  line: number;
  /** URL of the page that reported it, at the moment it was reported. */
  page: string;
};

type Reported = Omit<CspViolation, 'page'>;

const BINDING = '__cspViolation';
const PENDING = '__cspViolationsInFlight';
/** Long enough for a violation event already queued in the page to fire. */
const FLUSH_WAIT_MS = 50;

const lists = new WeakMap<BrowserContext, CspViolation[]>();
const registered = new Set<BrowserContext>();

/** Installs the collector on a context. Idempotent. */
export async function withCspCollector(context: BrowserContext): Promise<void> {
  if (lists.has(context)) return;
  const list: CspViolation[] = [];
  lists.set(context, list);

  await context.exposeBinding(BINDING, ({ page }, v: Reported) => {
    list.push({ ...v, page: page?.url() ?? '' });
  });
  await context.addInitScript(
    ({ binding, pending }: { binding: string; pending: string }) => {
      const w = window as unknown as Record<string, unknown>;
      // Each send resolves only once Node has run the handler, so awaiting the
      // in-flight sends is proof the report is on the Node-side list.
      const inFlight = new Set<Promise<unknown>>();
      w[pending] = inFlight;
      document.addEventListener('securitypolicyviolation', (e) => {
        const send = w[binding] as ((v: unknown) => Promise<unknown>) | undefined;
        if (!send) return;
        const sent = Promise.resolve(
          send({
            directive: e.violatedDirective,
            blockedURI: e.blockedURI,
            sourceFile: e.sourceFile,
            line: e.lineNumber,
          }),
        ).catch(() => undefined);
        inFlight.add(sent);
        void sent.finally(() => inFlight.delete(sent));
      });
    },
    { binding: BINDING, pending: PENDING },
  );
}

/**
 * Waits until every report a context's open pages have raised so far has
 * reached Node. Per frame, one browser round trip: a short wait lets violation
 * events still queued in the page fire, then the in-flight sends are awaited.
 * Teardown calls it before reading the list, and a collected context calls it
 * before it closes, so a report raised just before the end is not missed.
 */
export async function flushCspReports(context: BrowserContext): Promise<void> {
  const frames = context.pages().flatMap((page) => (page.isClosed() ? [] : page.frames()));
  await Promise.all(
    frames.map((frame) =>
      frame
        .evaluate(
          async ({ pending, waitMs }: { pending: string; waitMs: number }) => {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            const inFlight = (window as unknown as Record<string, Set<Promise<unknown>> | undefined>)[pending];
            if (inFlight) await Promise.all([...inFlight]);
          },
          { pending: PENDING, waitMs: FLUSH_WAIT_MS },
        )
        // A frame that navigated or detached mid-flush has nothing left to send.
        .catch(() => undefined),
    ),
  );
}

/**
 * The only sanctioned `browser.newContext` call in e2e/. Installs the
 * collector and registers the context, so the fixtures assert on it at
 * teardown even after the spec has closed it.
 */
export async function newCollectedContext(
  browser: Browser,
  options?: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await withCspCollector(context);
  registered.add(context);
  // Specs close their extra contexts themselves, before teardown reads the
  // list, so the flush has to happen here while the pages are still open.
  const close = context.close.bind(context);
  context.close = async (closeOptions) => {
    await flushCspReports(context);
    return close(closeOptions);
  };
  return context;
}

/**
 * Contexts opened through `newCollectedContext` since the last call. Returns
 * them and forgets them, so each test asserts on its own.
 */
export function takeRegisteredContexts(): BrowserContext[] {
  const taken = [...registered];
  registered.clear();
  return taken;
}

/**
 * The Vercel toolbar is injected into Preview deployments by Vercel, not by
 * the app, and the policy blocks it. It only exists on a deployed target.
 */
function isVercelToolbar(blockedURI: string): boolean {
  if (!process.env.E2E_BASE_URL) return false;
  try {
    const host = new URL(blockedURI).hostname;
    return host === 'vercel.live' || host.endsWith('.vercel.live');
  } catch {
    return false;
  }
}

/** The violations recorded for a context, from Node's side. */
export function cspViolations(context: BrowserContext): CspViolation[] {
  return (lists.get(context) ?? []).filter((v) => !isVercelToolbar(v.blockedURI));
}
