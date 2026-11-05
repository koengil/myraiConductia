/**
 * #162 deal-rail cold-load harness. Measures a production build of the rail
 * page (`next start`) against the throwaway stack, in Chromium, and writes raw
 * JSON per scenario plus a summary to scripts/perf/out/<label>/ (gitignored).
 *
 *   scripts/perf/with-local-stack.sh --write node --import tsx scripts/perf/rail-cold-load.ts --runs 10
 *
 * --write is required: every scenario writes flags and resets
 * pg_stat_statements, so the wrapper first confirms the running containers
 * are the cdt162-rail stack's (localStack.mjs assertRunningStack).
 *
 * Options:
 *   --runs N               cold loads per scenario (each followed by one warm reload)    [10]
 *   --variants a,b         baseline | no-store | dedupe-sim | near-expiry                [all]
 *   --views a,b            array | focus                                                  [both]
 *   --shells a,b           sidebar (workbench_top_nav off) | topnav                       [both]
 *   --base-url URL         the running `next start`, loopback port 3162 only [http://127.0.0.1:3162]
 *   --deal CODE            deal code (default: the mock book's "Mesa")
 *   --label NAME           output folder under scripts/perf/out                           [run-<time>]
 *   --settle MS            keep recording after the rail is ready (wave 2, prefetch)      [1500]
 *   --no-netlog            skip the Chromium NetLog capture
 *   --resume               skip scenarios whose JSON already exists in the output folder
 *   --browser-libs DIR     LD_LIBRARY_PATH for Chromium only (a host missing its shared
 *                          libraries can borrow them from the Playwright image)
 *
 * Every scenario first sets its flags with set-local-flags (only the four rail
 * flags) and reads the live feature_flags table back into its JSON. The
 * variants change nothing in product code:
 *   no-store     an init script wraps window.fetch: cache:'no-store' on GET /api/v1/*
 *   dedupe-sim   an init script wraps window.fetch: one in-flight read per URL; every
 *                caller gets its own new Response(bodyText, …), never a shared body
 *   near-expiry  the minted session's expires_at is moved 30 s ahead (inside the
 *                90 s refresh margin), so the first hop refreshes the token
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import {
  combineChunks,
  createChunks,
  createServerClient,
  stringFromBase64URL,
  stringToBase64URL,
} from '@supabase/ssr';
import { PERF_APP_PORT, assertLocalBaseUrl, assertWriteChecked } from './localStack.mjs';
import { enablePgStatStatements, resetPgStatStatements, topStatements } from './pg-stat';
import { localAdmin, readFlagSnapshot, setLocalFlags, type FlagSnapshot } from './set-local-flags';

type Variant = 'baseline' | 'no-store' | 'dedupe-sim' | 'near-expiry';
type View = 'array' | 'focus';
type Shell = 'sidebar' | 'topnav';
type CacheMode = 'cold' | 'warm';

const BOOK_MD_EMAIL = 'book-md.intelibank@dev.com';
const ROOT = path.resolve(__dirname, '..', '..');

// ── args ─────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function list<T extends string>(name: string, all: readonly T[]): T[] {
  const raw = arg(name);
  if (!raw) return [...all];
  const picked = raw.split(',').map((value) => value.trim()) as T[];
  for (const value of picked) {
    if (!all.includes(value)) throw new Error(`--${name}: unknown value ${value}`);
  }
  return picked;
}

const RUNS = Number(arg('runs') ?? 10);
const VARIANTS = list<Variant>('variants', ['baseline', 'no-store', 'dedupe-sim', 'near-expiry']);
const VIEWS = list<View>('views', ['array', 'focus']);
const SHELLS = list<Shell>('shells', ['sidebar', 'topnav']);
// Pinned to the local next start before any session cookie is minted for it.
const BASE_URL = assertLocalBaseUrl(arg('base-url') ?? `http://127.0.0.1:${PERF_APP_PORT}`);
const LABEL = arg('label') ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const SETTLE_MS = Number(arg('settle') ?? 1500);
const NETLOG = !process.argv.includes('--no-netlog');
const BROWSER_LIBS = arg('browser-libs');
const RESUME = process.argv.includes('--resume');
const READY_TIMEOUT_MS = 120_000;
const OUT_DIR = path.join(ROOT, 'scripts', 'perf', 'out', LABEL);

// ── session ──────────────────────────────────────────────────────────────────

type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax';
};

async function mintSession(nearExpiry: boolean): Promise<Cookie[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const password = process.env.SEED_PASSWORD;
  if (!url || !key || !password) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SEED_PASSWORD are required');
  }
  const jar = new Map<string, string>();
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          if (cookie.value) jar.set(cookie.name, cookie.value);
          else jar.delete(cookie.name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: BOOK_MD_EMAIL, password });
  if (error) throw new Error(`sign-in failed for ${BOOK_MD_EMAIL}: ${error.message}`);
  if (jar.size === 0) throw new Error('sign-in produced no cookies');

  let entries = [...jar];
  if (nearExpiry) entries = await moveExpiryIntoRefreshMargin(entries);

  const host = new URL(BASE_URL).hostname;
  return entries.map(([name, value]) => ({
    name,
    value,
    domain: host,
    path: '/',
    expires: Math.floor(Date.now() / 1000) + 86_400,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
  }));
}

/** Rewrites the session cookie so expires_at is 30 s away: inside auth-js's 90 s refresh margin. */
async function moveExpiryIntoRefreshMargin(entries: Array<[string, string]>): Promise<Array<[string, string]>> {
  const base = entries.map(([name]) => name.replace(/\.\d+$/, '')).find((name) => name.endsWith('-auth-token'));
  if (!base) throw new Error('no auth-token cookie to rewrite');
  const map = new Map(entries);
  const combined = await combineChunks(base, (name) => map.get(name));
  if (!combined?.startsWith('base64-')) throw new Error('unexpected session cookie encoding');
  const session = JSON.parse(stringFromBase64URL(combined.slice('base64-'.length))) as { expires_at: number };
  session.expires_at = Math.floor(Date.now() / 1000) + 30;
  const encoded = `base64-${stringToBase64URL(JSON.stringify(session))}`;
  const others = entries.filter(([name]) => name !== base && !name.startsWith(`${base}.`));
  return [...others, ...createChunks(base, encoded).map((chunk): [string, string] => [chunk.name, chunk.value])];
}

// ── in-page instruments ──────────────────────────────────────────────────────

/** Records gate and readiness timestamps (performance.now(), ms since navigation start). */
const OBSERVER_SCRIPT = `(() => {
  const r = (window.__railPerf = { loadingSeen: null, loadingGone: null, loadingTexts: [], firstStation: null, focusRegion: null, errorSeen: null, errorText: null });
  const LOADING = /Loading the deal rail|Loading your deal list|Still loading/;
  const ERROR = /could not be loaded|not set up yet/;
  const check = () => {
    const now = performance.now();
    let loading = false;
    for (const el of document.querySelectorAll('[role="status"]')) {
      const text = el.textContent || '';
      if (LOADING.test(text)) {
        loading = true;
        if (!r.loadingTexts.includes(text)) r.loadingTexts.push(text);
      }
      if (r.errorSeen === null && ERROR.test(text)) { r.errorSeen = now; r.errorText = text; }
    }
    if (loading && r.loadingSeen === null) r.loadingSeen = now;
    if (!loading && r.loadingSeen !== null && r.loadingGone === null) r.loadingGone = now;
    if (r.firstStation === null && document.querySelector('[data-testid^="station-"]')) r.firstStation = now;
    if (r.focusRegion === null && document.querySelector('section[aria-label="Deal rail · focus"]')) r.focusRegion = now;
  };
  const observer = new MutationObserver(check);
  observer.observe(document, { subtree: true, childList: true, characterData: true });
})();`;

const NO_STORE_SCRIPT = `(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = ((init && init.method) || (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' && new URL(url, location.href).pathname.startsWith('/api/v1/')) {
      return original(input, { ...(init || {}), cache: 'no-store' });
    }
    return original(input, init);
  };
})();`;

const DEDUPE_SIM_SCRIPT = `(() => {
  const original = window.fetch.bind(window);
  const inflight = new Map();
  window.__dedupeJoins = 0;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = ((init && init.method) || (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const absolute = new URL(url, location.href);
    if (method !== 'GET' || !absolute.pathname.startsWith('/api/v1/')) return original(input, init);
    const key = absolute.href;
    let entry = inflight.get(key);
    if (entry) {
      window.__dedupeJoins += 1;
    } else {
      entry = original(input, init)
        .then(async (res) => ({ status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], bodyText: await res.text() }))
        .finally(() => inflight.delete(key));
      inflight.set(key, entry);
    }
    return entry.then((shared) => new Response(
      shared.status === 204 || shared.status === 304 ? null : shared.bodyText,
      { status: shared.status, statusText: shared.statusText, headers: shared.headers },
    ));
  };
})();`;

// ── CDP request log ──────────────────────────────────────────────────────────

type CdpRequest = {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  issuedAt: number; // monotonic seconds
  rsc: boolean;
  prefetch: boolean;
  status?: number;
  protocol?: string;
  fromCache?: boolean;
  timing?: Record<string, number>;
  serverTiming?: string;
  finishedAt?: number;
  failed?: string;
  setsAuthCookie?: boolean;
};

function recordRequests(cdp: CDPSession): { requests: CdpRequest[]; reset(): void } {
  let byId = new Map<string, CdpRequest>();
  let ordered: CdpRequest[] = [];
  cdp.on('Network.requestWillBeSent', (event) => {
    const headers = Object.fromEntries(
      Object.entries(event.request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]),
    );
    const request: CdpRequest = {
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method,
      type: event.type,
      issuedAt: event.timestamp,
      rsc: headers.rsc === '1' || event.request.url.includes('_rsc='),
      prefetch: headers['next-router-prefetch'] === '1' || headers.purpose === 'prefetch',
    };
    if (byId.has(event.requestId)) return; // redirect hop: keep the first issue time
    byId.set(event.requestId, request);
    ordered.push(request);
  });
  cdp.on('Network.responseReceived', (event) => {
    const request = byId.get(event.requestId);
    if (!request) return;
    const headers = Object.fromEntries(
      Object.entries(event.response.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]),
    );
    request.status = event.response.status;
    request.protocol = event.response.protocol;
    request.fromCache = Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache);
    request.timing = event.response.timing as unknown as Record<string, number> | undefined;
    request.serverTiming = headers['server-timing'];
  });
  // Set-Cookie only surfaces in the extra-info event. Only the cookie NAME is
  // inspected (did this response rotate the session?), never its value.
  cdp.on('Network.responseReceivedExtraInfo', (event) => {
    const request = byId.get(event.requestId);
    if (!request) return;
    const setCookie = Object.entries(event.headers ?? {})
      .filter(([name]) => name.toLowerCase() === 'set-cookie')
      .map(([, value]) => String(value))
      .join('\n');
    if (/(^|\n)\s*sb-[^=;\s]+-auth-token(\.\d+)?=[^;\s]/.test(setCookie)) request.setsAuthCookie = true;
  });
  cdp.on('Network.loadingFinished', (event) => {
    const request = byId.get(event.requestId);
    if (request) request.finishedAt = event.timestamp;
  });
  cdp.on('Network.loadingFailed', (event) => {
    const request = byId.get(event.requestId);
    if (request) {
      request.finishedAt = event.timestamp;
      request.failed = event.errorText;
    }
  });
  return {
    get requests() {
      return ordered;
    },
    reset() {
      byId = new Map();
      ordered = [];
    },
  };
}

// ── one load ─────────────────────────────────────────────────────────────────

type ApiRequestMetric = {
  path: string;
  status?: number;
  protocol?: string;
  issuedMs: number; // since the document request was issued
  queuedMs?: number; // issue → requestTime (Chromium queueing incl. cache lock, socket wait)
  stalledMs?: number; // requestTime → first of dns/connect/send
  ttfbMs?: number; // sendEnd → receiveHeadersEnd
  endMs?: number; // since the document request was issued
  durationMs?: number;
  serverTiming?: Record<string, number>;
  failed?: string;
};

type LoadMetric = {
  cache: CacheMode;
  gateOpenMs: number | null; // DealRailLoading detached (or readiness if the loading copy never rendered)
  readyMs: number | null; // first StationCard (array) / Focus region (focus)
  firstStationMs: number | null;
  focusRegionMs: number | null;
  loadingSeenMs: number | null;
  loadingTexts: string[];
  errorText: string | null;
  timedOut: boolean;
  documentTtfbMs: number | null;
  domContentLoadedMs: number | null;
  documentProtocol: string | null;
  counts: Record<string, number>;
  rscRequests: number;
  rscPrefetches: number;
  /** Browser-side Supabase Auth calls: token refreshes and getUser. */
  authTokenRequests: number;
  authUserRequests: number;
  /** Responses (document, RSC or API) whose Set-Cookie rotated the session cookie. */
  sessionCookieRotations: number;
  dedupeJoins: number | null;
  api: ApiRequestMetric[];
};

function apiPath(url: string): string | null {
  const parsed = new URL(url);
  if (!parsed.pathname.startsWith('/api/v1/')) return null;
  return parsed.pathname.replace(/\/deals\/[^/]+(\/|$)/, '/deals/{id}$1');
}

function parseServerTiming(value: string | undefined): Record<string, number> | undefined {
  if (!value) return undefined;
  const out: Record<string, number> = {};
  for (const part of value.split(',')) {
    const [name, ...params] = part.trim().split(';');
    const dur = params.map((param) => param.trim()).find((param) => param.startsWith('dur='));
    if (name && dur) out[name] = Number(dur.slice(4));
  }
  return out;
}

async function measureLoad(
  page: Page,
  log: ReturnType<typeof recordRequests>,
  view: View,
  cache: CacheMode,
  navigate: () => Promise<unknown>,
): Promise<LoadMetric> {
  log.reset();
  await navigate();
  let timedOut = false;
  try {
    await page.waitForFunction(
      (want) => {
        const r = (window as unknown as { __railPerf?: Record<string, number | null> }).__railPerf;
        if (!r) return false;
        return r.errorSeen !== null || (want === 'array' ? r.firstStation !== null : r.focusRegion !== null);
      },
      view,
      { timeout: READY_TIMEOUT_MS, polling: 50 },
    );
  } catch {
    timedOut = true;
  }
  await page.waitForTimeout(SETTLE_MS);

  const inPage = await page.evaluate(() => {
    const r = (window as unknown as { __railPerf: Record<string, unknown> }).__railPerf;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return {
      perf: r,
      documentTtfbMs: nav ? nav.responseStart : null,
      domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
      documentProtocol: nav ? nav.nextHopProtocol : null,
      dedupeJoins: (window as unknown as { __dedupeJoins?: number }).__dedupeJoins ?? null,
    };
  });
  const perf = inPage.perf as {
    loadingSeen: number | null;
    loadingGone: number | null;
    loadingTexts: string[];
    firstStation: number | null;
    focusRegion: number | null;
    errorText: string | null;
  };

  const requests = log.requests;
  const documentRequest = requests.find((request) => request.type === 'Document');
  const origin = documentRequest?.issuedAt ?? requests[0]?.issuedAt ?? 0;
  const counts: Record<string, number> = {};
  const api: ApiRequestMetric[] = [];
  for (const request of requests) {
    const pathKey = apiPath(request.url);
    if (!pathKey) continue;
    counts[pathKey] = (counts[pathKey] ?? 0) + 1;
    const timing = request.timing;
    const firstOf = (...values: Array<number | undefined>) =>
      values.find((value) => value !== undefined && value >= 0);
    api.push({
      path: pathKey,
      status: request.status,
      protocol: request.protocol,
      issuedMs: (request.issuedAt - origin) * 1000,
      queuedMs: timing ? (timing.requestTime - request.issuedAt) * 1000 : undefined,
      stalledMs: timing ? firstOf(timing.dnsStart, timing.connectStart, timing.sendStart) : undefined,
      ttfbMs: timing ? timing.receiveHeadersEnd - timing.sendEnd : undefined,
      endMs: request.finishedAt !== undefined ? (request.finishedAt - origin) * 1000 : undefined,
      durationMs: request.finishedAt !== undefined ? (request.finishedAt - request.issuedAt) * 1000 : undefined,
      serverTiming: parseServerTiming(request.serverTiming),
      failed: request.failed,
    });
  }
  counts.total = api.length;

  const ready = view === 'array' ? perf.firstStation : perf.focusRegion;
  return {
    cache,
    gateOpenMs: perf.loadingGone ?? (perf.loadingSeen === null ? ready : null),
    readyMs: ready,
    firstStationMs: perf.firstStation,
    focusRegionMs: perf.focusRegion,
    loadingSeenMs: perf.loadingSeen,
    loadingTexts: perf.loadingTexts,
    errorText: perf.errorText,
    timedOut,
    documentTtfbMs: inPage.documentTtfbMs,
    domContentLoadedMs: inPage.domContentLoadedMs,
    documentProtocol: inPage.documentProtocol,
    counts,
    rscRequests: requests.filter((request) => request.rsc).length,
    rscPrefetches: requests.filter((request) => request.rsc && request.prefetch).length,
    authTokenRequests: requests.filter((request) => new URL(request.url).pathname === '/auth/v1/token').length,
    authUserRequests: requests.filter((request) => new URL(request.url).pathname === '/auth/v1/user').length,
    sessionCookieRotations: requests.filter((request) => request.setsAuthCookie).length,
    dedupeJoins: inPage.dedupeJoins,
    api,
  };
}

// ── NetLog ───────────────────────────────────────────────────────────────────

type CacheLockSummary = {
  file: string;
  addToEntryWaits: number;
  waitsOver5ms: number;
  maxWaitMs: number;
  totalWaitMs: number;
  byPath: Record<string, { waits: number; over5ms: number; maxMs: number }>;
  lockTimeouts: number;
  cacheRaces: number;
  error?: string;
};

function summarizeNetLog(file: string): CacheLockSummary {
  const summary: CacheLockSummary = {
    file: path.relative(ROOT, file),
    addToEntryWaits: 0,
    waitsOver5ms: 0,
    maxWaitMs: 0,
    totalWaitMs: 0,
    byPath: {},
    lockTimeouts: 0,
    cacheRaces: 0,
  };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    return { ...summary, error: `no netlog: ${(error as Error).message}` };
  }
  let parsed: { constants: Record<string, Record<string, number>>; events: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(text.replace(/,\s*$/, '') + ']}');
    } catch (error) {
      return { ...summary, error: `unparseable netlog: ${(error as Error).message}` };
    }
  }
  const types = parsed.constants.logEventTypes;
  const phases = parsed.constants.logEventPhase;
  const ADD = types.HTTP_CACHE_ADD_TO_ENTRY;
  const START_JOB = types.URL_REQUEST_START_JOB;
  const urlBySource = new Map<number, string>();
  const openAt = new Map<number, number>();
  for (const event of parsed.events) {
    const source = (event.source as { id: number }).id;
    const type = event.type as number;
    const params = (event.params ?? {}) as Record<string, unknown>;
    if (type === START_JOB && typeof params.url === 'string' && !urlBySource.has(source)) {
      urlBySource.set(source, params.url);
    }
    if (type !== ADD) continue;
    const time = Number(event.time);
    if (event.phase === phases.PHASE_BEGIN) {
      openAt.set(source, time);
    } else if (event.phase === phases.PHASE_END) {
      const began = openAt.get(source);
      openAt.delete(source);
      if (began === undefined) continue;
      const wait = time - began;
      const netError = params.net_error as number | undefined;
      if (netError === -409) summary.lockTimeouts += 1;
      if (netError === -406) summary.cacheRaces += 1;
      const url = urlBySource.get(source);
      const key = (url && apiPath(url)) ?? (url ? new URL(url).pathname : 'unknown');
      const slot = (summary.byPath[key] ??= { waits: 0, over5ms: 0, maxMs: 0 });
      slot.waits += 1;
      summary.addToEntryWaits += 1;
      summary.totalWaitMs += wait;
      if (wait > 5) {
        slot.over5ms += 1;
        summary.waitsOver5ms += 1;
      }
      slot.maxMs = Math.max(slot.maxMs, wait);
      summary.maxWaitMs = Math.max(summary.maxWaitMs, wait);
    }
  }
  return summary;
}

// ── stats ────────────────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function max(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? Math.max(...finite) : null;
}
const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

function summarizeLoads(loads: LoadMetric[]) {
  const pick = (fn: (load: LoadMetric) => number | null | undefined) =>
    loads.map(fn).filter((value): value is number => typeof value === 'number');
  const paths = [...new Set(loads.flatMap((load) => Object.keys(load.counts)))].sort();
  const requestStats = (pathKey: string) => {
    const requests = loads.flatMap((load) => load.api.filter((request) => request.path === pathKey));
    const stages = [...new Set(requests.flatMap((request) => Object.keys(request.serverTiming ?? {})))];
    return {
      n: requests.length,
      medianQueuedMs: round(median(requests.map((r) => r.queuedMs ?? NaN))),
      maxQueuedMs: round(max(requests.map((r) => r.queuedMs ?? NaN))),
      medianStalledMs: round(median(requests.map((r) => r.stalledMs ?? NaN))),
      medianTtfbMs: round(median(requests.map((r) => r.ttfbMs ?? NaN))),
      maxTtfbMs: round(max(requests.map((r) => r.ttfbMs ?? NaN))),
      medianDurationMs: round(median(requests.map((r) => r.durationMs ?? NaN))),
      maxDurationMs: round(max(requests.map((r) => r.durationMs ?? NaN))),
      medianLastEndMs: round(
        median(
          loads.map((load) =>
            Math.max(...load.api.filter((r) => r.path === pathKey).map((r) => r.endMs ?? NaN)),
          ),
        ),
      ),
      protocols: [...new Set(requests.map((r) => r.protocol).filter(Boolean))],
      statuses: [...new Set(requests.map((r) => r.status).filter((s) => s !== undefined))],
      serverTimingMedianMs: Object.fromEntries(
        stages.map((stage) => [stage, round(median(requests.map((r) => r.serverTiming?.[stage] ?? NaN)))]),
      ),
    };
  };
  return {
    runs: loads.length,
    timedOut: loads.filter((load) => load.timedOut).length,
    errors: loads.filter((load) => load.errorText).map((load) => load.errorText),
    gateOpenMs: { median: round(median(pick((l) => l.gateOpenMs))), slowest: round(max(pick((l) => l.gateOpenMs))) },
    readyMs: { median: round(median(pick((l) => l.readyMs))), slowest: round(max(pick((l) => l.readyMs))) },
    documentTtfbMs: { median: round(median(pick((l) => l.documentTtfbMs))), slowest: round(max(pick((l) => l.documentTtfbMs))) },
    documentProtocol: [...new Set(loads.map((load) => load.documentProtocol))],
    medianCounts: Object.fromEntries(paths.map((p) => [p, median(loads.map((load) => load.counts[p] ?? 0))])),
    maxCounts: Object.fromEntries(paths.map((p) => [p, max(loads.map((load) => load.counts[p] ?? 0))])),
    medianRscRequests: median(pick((l) => l.rscRequests)),
    medianRscPrefetches: median(pick((l) => l.rscPrefetches)),
    medianAuthTokenRequests: median(pick((l) => l.authTokenRequests)),
    medianAuthUserRequests: median(pick((l) => l.authUserRequests)),
    medianSessionCookieRotations: median(pick((l) => l.sessionCookieRotations)),
    medianDedupeJoins: median(pick((l) => l.dedupeJoins)),
    loadingTexts: [...new Set(loads.flatMap((load) => load.loadingTexts))],
    requests: Object.fromEntries(paths.filter((p) => p !== 'total').map((p) => [p, requestStats(p)])),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function resolveDealCode(): Promise<string> {
  const explicit = arg('deal');
  if (explicit) return explicit;
  const { data, error } = await localAdmin().from('deals').select('code').eq('codename', 'Mesa').maybeSingle();
  if (error || !data) throw new Error('the mock book deal "Mesa" is missing: run scripts/perf/seed-rail-scale.sh');
  return data.code as string;
}

async function runScenario(dealCode: string, variant: Variant, shell: Shell, view: View) {
  const admin = localAdmin();
  await setLocalFlags(admin, {
    gate0_api_create: true,
    platform_onboarding: true,
    project_rail_model: true,
    workbench_top_nav: shell === 'topnav',
  });
  const flags: FlagSnapshot = await readFlagSnapshot(admin);
  resetPgStatStatements();

  const name = `${variant}-${shell}-${view}`;
  const netlogFile = path.join(OUT_DIR, `${name}.netlog.json`);
  // The browser gets a minimal environment of its own: never the stack keys.
  const browserEnv: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const value = process.env[name];
    if (value) browserEnv[name] = value;
  }
  if (BROWSER_LIBS) browserEnv.LD_LIBRARY_PATH = BROWSER_LIBS;
  const browser: Browser = await chromium.launch({
    headless: true,
    env: browserEnv,
    args: NETLOG ? [`--log-net-log=${netlogFile}`, '--net-log-capture-mode=Default'] : [],
  });
  const url = `${BASE_URL}/projects/${encodeURIComponent(dealCode)}/rail${view === 'focus' ? '?view=focus' : ''}`;
  const loads: LoadMetric[] = [];
  // A renderer lost to host memory pressure is recorded and the run skipped;
  // it never silently shortens the sample.
  const failures: Array<{ run: number; error: string }> = [];
  try {
    for (let run = 0; run < RUNS; run += 1) {
      const cookies = await mintSession(variant === 'near-expiry');
      const context: BrowserContext = await browser.newContext({
        storageState: { cookies, origins: [] },
        viewport: { width: 1440, height: 900 },
      });
      let cold: LoadMetric;
      let warm: LoadMetric;
      try {
        await context.addInitScript({ content: OBSERVER_SCRIPT });
        if (variant === 'no-store') await context.addInitScript({ content: NO_STORE_SCRIPT });
        if (variant === 'dedupe-sim') await context.addInitScript({ content: DEDUPE_SIM_SCRIPT });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        const log = recordRequests(cdp);
        await cdp.send('Network.enable');
        cold = await measureLoad(page, log, view, 'cold', () => page.goto(url, { waitUntil: 'commit' }));
        warm = await measureLoad(page, log, view, 'warm', () => page.reload({ waitUntil: 'commit' }));
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        failures.push({ run, error: message });
        process.stdout.write(`  ${name} run ${run + 1}/${RUNS}: FAILED ${message}\n`);
        await context.close().catch(() => undefined);
        continue;
      }
      loads.push({ ...cold, run } as LoadMetric & { run: number }, { ...warm, run } as LoadMetric & { run: number });
      await context.close();
      process.stdout.write(
        `  ${name} run ${run + 1}/${RUNS}: cold gate ${round(cold.gateOpenMs)} ms (deals ${cold.counts['/api/v1/deals'] ?? 0}, rail ${cold.counts['/api/v1/deals/{id}/rail'] ?? 0})` +
          `, warm gate ${round(warm.gateOpenMs)} ms${cold.timedOut || warm.timedOut ? ' TIMED OUT' : ''}${cold.errorText ? ` ERROR ${cold.errorText}` : ''}\n`,
      );
    }
  } finally {
    await browser.close();
  }

  const statements = topStatements(15);
  const netlog = NETLOG ? summarizeNetLog(netlogFile) : null;
  const scenario = {
    name,
    variant,
    shell,
    view,
    url: url.replace(BASE_URL, ''),
    flags,
    runs: RUNS,
    failures,
    settleMs: SETTLE_MS,
    summary: {
      cold: summarizeLoads(loads.filter((load) => load.cache === 'cold')),
      warm: summarizeLoads(loads.filter((load) => load.cache === 'warm')),
    },
    netlog,
    pgStatStatements: statements,
    loads,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(scenario, null, 2));
  return scenario;
}

async function main(): Promise<void> {
  assertWriteChecked(process.env);
  if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error('--runs must be a positive integer');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const health = await fetch(`${BASE_URL}/sign-in`).catch((error: Error) => error);
  if (health instanceof Error || !health.ok) {
    throw new Error(`no app at ${BASE_URL}: start it with with-local-stack.sh … next start --port 3162 --hostname 127.0.0.1`);
  }
  console.log(`pg_stat_statements ${enablePgStatStatements()}`);
  const dealCode = await resolveDealCode();
  const admin = localAdmin();
  const { data: dealRow } = await admin.from('deals').select('id').eq('code', dealCode).maybeSingle();
  const stepCount = async (activeOnly: boolean) => {
    let query = admin
      .from('deal_steps')
      .select('id', { count: 'exact', head: true })
      .eq('deal_id', (dealRow as { id: string } | null)?.id ?? '');
    if (activeOnly) query = query.is('removed_at', null);
    return (await query).count;
  };
  const { count: bookDeals } = await admin.from('deals').select('id', { count: 'exact', head: true });
  const meta = {
    label: LABEL,
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    dealCode,
    dealStepRows: await stepCount(false),
    dealActiveSteps: await stepCount(true),
    dealsOnStack: bookDeals,
    runs: RUNS,
    variants: VARIANTS,
    views: VIEWS,
    shells: SHELLS,
    settleMs: SETTLE_MS,
    stackProjectId: process.env.PERF_STACK_PROJECT_ID,
    stackTargets: {
      NEXT_PUBLIC_SUPABASE_URL: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid').host,
    },
  };
  console.log(`rail-cold-load: ${JSON.stringify(meta)}`);
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  const summaries: Record<string, unknown> = {};
  for (const variant of VARIANTS) {
    for (const shell of SHELLS) {
      for (const view of VIEWS) {
        const existing = path.join(OUT_DIR, `${variant}-${shell}-${view}.json`);
        const scenario: Awaited<ReturnType<typeof runScenario>> =
          RESUME && fs.existsSync(existing)
            ? JSON.parse(fs.readFileSync(existing, 'utf8'))
            : await runScenario(meta.dealCode, variant, shell, view);
        summaries[scenario.name] = {
          flags: scenario.flags,
          failures: scenario.failures,
          cold: scenario.summary.cold,
          warm: scenario.summary.warm,
          netlog: scenario.netlog && { ...scenario.netlog, file: undefined },
          topSqlByTotal: scenario.pgStatStatements.byTotal.slice(0, 8),
        };
      }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ meta, scenarios: summaries }, null, 2));
  console.log(`rail-cold-load: wrote ${path.relative(ROOT, OUT_DIR)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
