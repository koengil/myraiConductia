import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { MD_STATE_PATH } from './e2e/auth/session';
import { refuseNonLoopbackSupabase } from './e2e/support/loopback';
import { PROCESSOR_SWEEP_TOKEN } from './e2e/support/publicationDraftFixture';
import { vercelBypassHeaders } from './e2e/support/vercelBypass';

/**
 * Two tiers, one codebase (design D1). `hermetic` gates merges and carries no
 * third-party credentials; `live` runs against a deployed environment and is
 * structurally incapable of gating a merge (its workflow has no pull_request
 * trigger). Journey specs are project-agnostic: the same file runs under both.
 */
const LIVE_BASE_URL = process.env.E2E_BASE_URL;

// The hermetic tier runs against a local Supabase stack only (e2e/support/loopback.ts), and under the #173 rehearsal
// (REHEARSAL_STACK) against w9-m365cap only: refused here, before auth setup or any webServer starts.
if (LIVE_BASE_URL && process.env.REHEARSAL_STACK !== undefined) {
  throw new Error('Hermetic e2e refused: the rehearsal runs the hermetic tier only, never E2E_BASE_URL.');
}
if (!LIVE_BASE_URL) refuseNonLoopbackSupabase();

// 'localhost', not '127.0.0.1': the app's route handlers derive the invite
// link's redirect origin from `new URL(request.url).origin`, which under
// `next start` resolves to http://localhost:<port> regardless of the Host
// header the client actually sent. Every origin in the invite-onboarding
// journey has to agree — this baseURL, the storage-state cookie domain
// (e2e/auth/session.ts, e2e/auth/setup.ts), and the invite link's redirect
// target — or a session cookie minted on one origin is invisible to a
// navigation against the other (Chromium scopes cookies by origin). The bind
// address below is unaffected: a server bound to 127.0.0.1 is still reachable
// as 'localhost' on this machine.
const HERMETIC_BASE_URL = 'http://localhost:3000';
const MAIL_STUB_PORT = 4310;
const MAIL_STUB_URL = `http://127.0.0.1:${MAIL_STUB_PORT}`;
const PUBLICATION_STUB_PORT = 4311;
const PUBLICATION_STUB_URL = `http://127.0.0.1:${PUBLICATION_STUB_PORT}`;
const PROCESSOR_TOKEN = PROCESSOR_SWEEP_TOKEN;

export default defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['html', { open: 'never' }],
        ['github'],
        ['list'],
        // Machine-readable, at the repo root rather than inside
        // playwright-report/: the HTML reporter clears its own output folder,
        // so a sibling file there is not guaranteed to survive. Read by
        // scripts/e2e-summary.mjs to build the PR comment.
        ['json', { outputFile: 'e2e-results.json' }],
      ]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Kept on failure alongside the trace. The trace's filmstrip covers most
    // of the same ground, but a video plays without the trace viewer and
    // survives being handed to someone who does not have the repo checked
    // out. `retain-on-failure` records every test and deletes the passing
    // ones, so a green run leaves nothing behind.
    video: 'retain-on-failure',
  },

  // Three servers: the mail stub and the Ignatious publication stub first, so
  // both are reachable from the Next server process the moment an invite is
  // sent (design D7) or a skill publication is admitted, then the app. No
  // webServer at all when a live target is named.
  webServer: LIVE_BASE_URL
    ? undefined
    : [
        {
          command: `node --import tsx e2e/support/mailStub.ts`,
          url: `${MAIL_STUB_URL}/messages`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { MAIL_STUB_PORT: String(MAIL_STUB_PORT) },
        },
        {
          command: `node --import tsx e2e/support/ignatiousPublicationStub.ts`,
          url: `${PUBLICATION_STUB_URL}/__control/calls`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PUBLICATION_STUB_PORT: String(PUBLICATION_STUB_PORT) },
        },
        {
          // NEXT_PUBLIC_* are inlined at build time, so the build must run under
          // this env block, not just the server.
          command: 'npm run build && npm run start -- --port 3000 --hostname 127.0.0.1',
          url: HERMETIC_BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 240_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            NEXT_PUBLIC_APP_ENV: 'dev',
            DISABLE_MFA: '1',
            MFA_ENFORCEMENT: 'invite_only',
            STORAGE_PROVIDER: 'local',
            EMAIL_PROVIDER: 'noop',
            NEXT_TELEMETRY_DISABLED: '1',
            // The hermetic tier is zero-third-party-credentials BY CONSTRUCTION
            // (D4/D6), not merely by omission: Next.js auto-loads .env.local for
            // any variable not already present in process.env, so a developer's
            // gitignored .env.local (kept around for live-tier Ignatious/Claude
            // work) would otherwise leak real credentials into this "hermetic"
            // build and silently mask the degraded state the spine asserts.
            // Pinning these to '' here wins over .env.local (Next never
            // overrides an already-present env var) and reads as unconfigured to
            // every caller: readIgnatiousConfig() treats a blank
            // IGNATIOUS_CONTROL_PLANE_URL/IGNATIOUS_API_KEY as absent, and both
            // model call sites (src/lib/gate0/codenameLlm.ts,
            // src/lib/compliance/llm.ts) go through postGatewayMessages, which
            // returns at once, with no request, when AI_GATEWAY_API_KEY is
            // blank — so neutralizing the key also neutralizes
            // SCREEN_LLM_MODEL's effect; no separate pin needed for it. No app
            // code reads ANTHROPIC_API_KEY (tests/model-egress-fence.test.ts), so
            // it needs no pin. The same
            // holds for Box: getBoxConfig() trims each
            // value and returns null on a blank one (src/lib/box/types.ts), so
            // getBoxClient() falls back to the in-memory mock, and BoxStorage
            // checks BOX_DEV_TOKEN for truthiness. Microsoft Graph mail is gated
            // by graphConfigured() (src/lib/email/graph.ts), which needs all four
            // MS_*/MAILBOX_TOKEN_KEY values, and the Google reader refuses a
            // blank GOOGLE_APPLICATION_CREDENTIALS (src/lib/google/reader/credentials.ts).
            BOX_CLIENT_ID: '',
            BOX_CLIENT_SECRET: '',
            BOX_DEV_TOKEN: '',
            BOX_ENTERPRISE_ID: '',
            BOX_SECRET: '',
            MS_CLIENT_ID: '',
            MS_CLIENT_SECRET: '',
            MS_REDIRECT_URI: '',
            MAILBOX_TOKEN_KEY: '',
            GOOGLE_APPLICATION_CREDENTIALS: '',
            IGNATIOUS_CONTROL_PLANE_URL: '',
            IGNATIOUS_API_URL: '',
            IGNATIOUS_API_KEY: '',
            IGNATIOUS_SKILL_BENCH_URL: PUBLICATION_STUB_URL,
            IGNATIOUS_PUBLICATION_SERVICE_TOKEN: 'e2e-publication-stub-token',
            IGNATIOUS_AUTHORING_SERVICE_TOKEN: '',
            SKILL_PUBLICATION_PROCESSOR_TOKEN: PROCESSOR_TOKEN,
            CONDUCTIA_PUBLIC_URL: '',
            NEXT_PUBLIC_APP_URL: '',
            VERCEL_URL: '',
            AI_GATEWAY_API_KEY: '',
            // Invite delivery (design D7). RESEND_API_BASE points the send path
            // at the in-suite stub; the key is a dummy non-empty value because
            // both send functions throw without one, and nothing it could
            // authenticate is ever contacted.
            RESEND_API_BASE: MAIL_STUB_URL,
            RESEND_API_KEY: 'e2e-stub-key',
            RESEND_FROM: 'Conductia E2E <invites@e2e.local>',
            // The challenge digest's HMAC pepper. CI exports it
            // (.github/workflows/ci.yml); locally the fallback keeps the suite
            // runnable without a .env.local.
            INVITE_VERIFICATION_PEPPER:
              process.env.INVITE_VERIFICATION_PEPPER ?? 'e2e-hermetic-pepper',
          },
        },
      ],

  projects: [
    {
      name: 'setup',
      testDir: path.join(__dirname, 'e2e/auth'),
      testMatch: /setup\.ts$/,
      use: { baseURL: LIVE_BASE_URL ?? HERMETIC_BASE_URL },
    },
    {
      name: 'hermetic',
      testDir: path.join(__dirname, 'e2e/journeys'),
      testMatch: /.*\.spec\.ts$/,
      // The demo journeys mutate discovery state, so they run after every other journey (T6) or on their own stack.
      testIgnore: /(discovery-demo|team-inbox-demo)\.spec\.ts$/,
      dependencies: ['setup'],
      teardown: 'cleanup',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: HERMETIC_BASE_URL,
        storageState: MD_STATE_PATH,
        // Capture expensive recordings on retry; keep first-failure screenshots.
        trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
        video: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
      },
    },
    {
      // Its own project so it can depend on `hermetic`: it runs once every other
      // journey has finished, and hermetic's cleanup teardown runs after it too.
      name: 'hermetic-discovery-demo',
      testDir: path.join(__dirname, 'e2e/journeys'),
      testMatch: /discovery-demo\.spec\.ts$/,
      dependencies: ['hermetic'],
      metadata: { mailPath: 'graph' },
      use: {
        ...devices['Desktop Chrome'],
        baseURL: HERMETIC_BASE_URL,
        storageState: MD_STATE_PATH,
        trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
        video: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
      },
    },
    {
      // The same journey on the Gmail replay (cdt-261-demo-gmail D6). Not in test:e2e: it needs its own reset
      // stack seeded with --google-replay --corpus demo, so it runs in its own CI job (E2E discovery demo
      // (Gmail replay)) or alone: npm run test:e2e:discovery-gmail. It depends on setup only, never on
      // hermetic-discovery-demo (that would run the Graph journey first on the same stack). A bare
      // `npx playwright test` runs both on one stack: the wrong-path one fails at its first step, unmutated.
      name: 'hermetic-discovery-demo-gmail',
      testDir: path.join(__dirname, 'e2e/journeys'),
      testMatch: /discovery-demo\.spec\.ts$/,
      dependencies: ['setup'],
      metadata: { mailPath: 'gmail-replay' },
      use: {
        ...devices['Desktop Chrome'],
        baseURL: HERMETIC_BASE_URL,
        storageState: MD_STATE_PATH,
        trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
        video: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
      },
    },
    {
      // The admin-managed team inbox journey (#581 phase 12). Not in test:e2e: it connects a Gmail team inbox, which
      // needs the Gmail replay registration, and the demo it promotes is the same Kestrel the discovery journeys do, so
      // it has its own reset stack seeded with --google-replay --corpus demo --phase seeded --personas morgan (Storm has
      // no personal source; everything he sees is his membership). It runs in its own CI job (E2E team inbox) or alone:
      // npm run test:e2e:team-inbox. It depends on setup only, never on a discovery journey (that would mutate the stack
      // first). Video is kept for every run: the owner watches it to confirm it tells the story.
      name: 'hermetic-team-inbox-demo',
      testDir: path.join(__dirname, 'e2e/journeys'),
      testMatch: /team-inbox-demo\.spec\.ts$/,
      dependencies: ['setup'],
      metadata: { mailPath: 'gmail-replay' },
      use: {
        ...devices['Desktop Chrome'],
        baseURL: HERMETIC_BASE_URL,
        storageState: MD_STATE_PATH,
        trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
        // The owner watches this video to confirm the story: full size, and slowed so each beat can be read.
        video: { mode: 'on', size: { width: 1280, height: 720 } },
        launchOptions: { slowMo: 400 },
      },
    },
    {
      name: 'cleanup',
      testDir: path.join(__dirname, 'e2e/support'),
      testMatch: /teardown\.ts$/,
      use: { baseURL: HERMETIC_BASE_URL },
    },
    {
      name: 'live',
      testDir: path.join(__dirname, 'e2e/journeys'),
      testMatch: /.*\.spec\.ts$/,
      testIgnore: /(discovery-demo|team-inbox-demo)\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: LIVE_BASE_URL ?? HERMETIC_BASE_URL,
        storageState: MD_STATE_PATH,
        extraHTTPHeaders: vercelBypassHeaders(),
      },
    },
  ],
});
