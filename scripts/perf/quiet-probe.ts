/**
 * #162 uncontended per-request cost. Signs in as the book MD on the throwaway
 * stack and issues strictly sequential requests (one in flight at a time, no
 * browser, no prefetch): a bare Supabase Auth getUser(), then GET /api/v1/deals
 * and GET /api/v1/deals/{code}/rail against the running `next start`. The wall
 * time of those requests is the handler cost without the concurrency of a real
 * page load, to set beside the harness numbers. Builds from Phases 1-3 also sent
 * per-stage Server-Timing; Phase 4 removed it, so `stages` is empty on later
 * builds.
 *
 *   scripts/perf/with-local-stack.sh node --import tsx scripts/perf/quiet-probe.ts --label phase1-baseline [--runs 20]
 *
 * Writes scripts/perf/out/<label>/quiet-probe.json. The session cookie value is
 * never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServerClient } from '@supabase/ssr';
import { PERF_APP_PORT, assertLocalBaseUrl } from './localStack.mjs';
import { localAdmin } from './set-local-flags';

const BOOK_MD_EMAIL = 'book-md.intelibank@dev.com';
const ROOT = path.resolve(__dirname, '..', '..');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const RUNS = Number(arg('runs') ?? 20);
// Pinned to the local next start before any session cookie is minted for it.
const BASE_URL = assertLocalBaseUrl(arg('base-url') ?? `http://127.0.0.1:${PERF_APP_PORT}`);
const LABEL = arg('label') ?? `probe-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const OUT_DIR = path.join(ROOT, 'scripts', 'perf', 'out', LABEL);

function parseServerTiming(value: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (value ?? '').split(',')) {
    const [name, ...params] = part.trim().split(';');
    const dur = params.map((param) => param.trim()).find((param) => param.startsWith('dur='));
    if (name && dur) out[name] = Number(dur.slice(4));
  }
  return out;
}

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}

async function main(): Promise<void> {
  if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error('--runs must be a positive integer');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const password = process.env.SEED_PASSWORD;
  if (!url || !key || !password) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SEED_PASSWORD are required');
  }
  const { data: deal, error: dealError } = await localAdmin()
    .from('deals')
    .select('code')
    .eq('codename', 'Mesa')
    .maybeSingle();
  if (dealError || !deal) throw new Error('the mock book deal "Mesa" is missing: run scripts/perf/seed-rail-scale.sh');
  const dealCode = (arg('deal') ?? deal.code) as string;

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
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

  const samples: Array<{
    getUserMs: number;
    deals: { ms: number; status: number; stages: Record<string, number> };
    rail: { ms: number; status: number; stages: Record<string, number> };
  }> = [];
  const timed = async (target: string) => {
    const started = performance.now();
    const res = await fetch(`${BASE_URL}${target}`, {
      headers: { cookie: cookieHeader(), accept: 'application/json' },
    });
    await res.arrayBuffer();
    return { ms: performance.now() - started, status: res.status, stages: parseServerTiming(res.headers.get('server-timing')) };
  };

  // One warm-up pass so the first sample is not a cold route compile/load.
  await timed('/api/v1/deals');
  await timed(`/api/v1/deals/${encodeURIComponent(dealCode)}/rail`);

  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    const { error: userError } = await client.auth.getUser();
    if (userError) throw new Error(`getUser failed: ${userError.message}`);
    const getUserMs = performance.now() - started;
    const deals = await timed('/api/v1/deals');
    const rail = await timed(`/api/v1/deals/${encodeURIComponent(dealCode)}/rail`);
    samples.push({ getUserMs, deals, rail });
  }

  const stageMedians = (pick: (sample: (typeof samples)[number]) => Record<string, number>) => {
    const names = [...new Set(samples.flatMap((sample) => Object.keys(pick(sample))))];
    return Object.fromEntries(names.map((name) => [name, median(samples.map((sample) => pick(sample)[name] ?? NaN))]));
  };
  const summary = {
    runs: RUNS,
    dealCode,
    baseUrl: BASE_URL,
    getUserMs: { median: median(samples.map((s) => s.getUserMs)), max: Math.round(Math.max(...samples.map((s) => s.getUserMs))) },
    deals: {
      statuses: [...new Set(samples.map((s) => s.deals.status))],
      wallMs: median(samples.map((s) => s.deals.ms)),
      stages: stageMedians((s) => s.deals.stages),
    },
    rail: {
      statuses: [...new Set(samples.map((s) => s.rail.status))],
      wallMs: median(samples.map((s) => s.rail.ms)),
      stages: stageMedians((s) => s.rail.stages),
    },
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'quiet-probe.json'), JSON.stringify({ summary, samples }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
