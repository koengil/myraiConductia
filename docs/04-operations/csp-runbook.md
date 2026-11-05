# Content-Security-Policy runbook

What the app's Content-Security-Policy allows, how to check that an environment serves it, how to switch it to report-only if it breaks something, and how to switch it back. Written for the merge of the `[226 2/3]` slice of issue #226 (part A, the zero-click exits for prompt-injected output). Status: Proposed. The owner decided on 2026-10-16 to enforce the policy on merge (decision-log entry D96 at merge).

Three placeholders below are marked `TODO(owner)`. They are owner knowledge or an unmeasured number, and nobody should guess them. Fill them before the Oct 30 demo.

## What the policy is for

Model output and inbound mail must not make the browser load anything from another origin. The policy blocks images, media, plugins, `<base>` hijacks, framing and network calls to any origin the app does not use. It ships as an enforced `Content-Security-Policy` header on every route (`next.config.ts`, the `/:path*` rule), together with `X-DNS-Prefetch-Control: off`.

What it does not do: `script-src` keeps `'unsafe-inline'` (there is no nonce), so this is an **egress policy for content that cannot run script, not XSS protection**. Injected script would still run, and script can leave by navigation, which no CSP blocks. `connect-src` raises the cost of such an attack but does not prevent it. Do not count the header as a defense against script injection.

The policy, as served in production (the exact string is pinned by `tests/security-headers.test.ts`):

```text
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self' data:;
connect-src 'self' <origin of NEXT_PUBLIC_SUPABASE_URL>;
frame-src 'self';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none'
```

- The Supabase origin is derived at build from `NEXT_PUBLIC_SUPABASE_URL`, port included and path dropped. Preview, staging and Production each carry their own. With the variable unset the policy carries `connect-src 'self'` alone, and sign-in breaks.
- `script-src` also carries `'unsafe-eval'` when `NODE_ENV=development`, for `next dev`. Production builds never do.

## What the policy allows: host inventory

The browser talks to exactly two origins: the app itself and the Supabase Auth origin. Everything else is either server-side, so no browser directive governs it, or a top-level navigation, which `connect-src`, `img-src` and `frame-src` do not govern. Checked on `origin/develop` at `23eaee94` for every surface the owner named.

| Host or source | Does the browser load or connect? | Where | CSP treatment |
|---|---|---|---|
| App origin (`'self'`): pages, `/_next/static/*`, `/api/v1/*` (including the skill-run stream via `fetch`), fonts | Yes | Everywhere | `'self'` in every directive |
| Fonts (Inter, Geist Mono) | Yes, self-hosted | `next/font/google` emits `/_next/static/media/*.woff2` (`src/app/layout.tsx:17-27`). No `fonts.googleapis.com` anywhere | `font-src 'self'` |
| Supabase Auth (`NEXT_PUBLIC_SUPABASE_URL` origin, `/auth/v1/*`) | Yes | Sign-in, two-factor, accept-invite, sign-out, `getUser` (`src/lib/supabase/client.ts:7-17`) | `connect-src` carries that exact origin |
| Supabase Storage (`/storage/v1/*`), Realtime (websocket) | No | No `createSignedUrl`, `getPublicUrl`, `/storage/v1` or `.channel(` in `src` | Not allowed |
| Box (`api.box.com`, `upload.box.com`, `app.box.com`) | No | Server-only (`src/lib/box/*`, `src/lib/storage/box.ts`). The deal folder and data room upload to same-origin `/api/v1/deals/{id}/documents` and download through `/download` (`DealFolderLive.tsx:91`, `DataRoomLive.tsx:202`). `boxFolderUrl` is returned by the API but no component renders it | Not allowed |
| Ignatious skill bench and control plane (`agents.conductia.com`) | No | Server-only (`src/lib/ignatious/config.ts:1-2`). Skills, the skill builder and the rail all call `/api/v1/*` | Not allowed |
| Resend, Microsoft Graph, Gmail API | No | Server-only (`src/lib/email/transport.ts:54`, `src/lib/email/graph.ts:25-26`, `src/lib/google/reader/*`) | Not allowed |
| Vercel Analytics, Speed Insights, toolbar packages | No package in `package.json` | None in `src` | Not allowed. The Vercel toolbar that Vercel itself injects on Preview deployments (`vercel.live`) is blocked, so expect `vercel.live` console errors on a Preview and nowhere else |
| Any CDN (unpkg, jsdelivr, cdnjs), analytics or error SDKs | No | None | Not allowed |
| `data:` images | Yes | TOTP QR (`two-factor/page.client.tsx:65-69, 258`), profile photo `backgroundImage` (`profile/page.tsx:193`, `Sidebar.tsx:351`), Swagger CSS on `/dev-api`, data-room preview HTML | `img-src data:` |
| `blob:` | Download anchor only | Audit export (`AuditTrail.tsx:197-200`) | Not governed (navigation or download) |
| Same-origin iframe `/data-room-previews/*` | Only with `platform_onboarding` off | `DataRoom.tsx:303-308` | `frame-src 'self'`. The existing `X-Frame-Options: DENY` still refuses it, so a blank preview there is not a regression |
| Google and Microsoft work sign-in (`/auth/work/signin`, then Supabase `/auth/v1/authorize`, then the provider) | Navigation | `sign-in/page.client.tsx:155`, `auth/work/signin/route.ts:44-49`. Buttons only with `work_identity_onboarding` on. No form `action` anywhere, so `form-action` is not involved | Not governed. **Inventory only: off the smoke path, because demo sign-in is by password** (owner) |
| Microsoft 365 mailbox connect (`login.microsoftonline.com`), `groups.google.com` link, Markdown and mail links | Navigation | `MailClient.tsx:807-808`, `MailboxConsentCard.tsx:137, 347` | Not governed |
| Remote `<img>` in model Markdown | Would have loaded before the fix | `Markdown.tsx` | Removed by the renderer (`[226 1/3]`). The CSP is the backstop |
| Remote `<img>` in inbound mail HTML | Would load without the CSP | `MailClient.tsx:468-469`, `format.ts:36-42` | **Blocked on purpose.** Remote images in inbound mail double as sender tracking pixels. A remote image shows as broken, which is expected. The cosmetic follow-up (no broken-image icon) is tracked separately |
| Unsplash images | Dead code | `ui/demo.tsx:85`, not rendered | Blocked, no change |

Not reachable by the hermetic Playwright tier, and therefore covered only by the smoke checklist below: real Box (the hermetic tier uses `STORAGE_PROVIDER=local`), real Ignatious output (the stream answers 503), a populated inbox, the flag-off data-room iframe, `/dev-api` and OAuth sign-in.

## Smoke test

Run it on the Vercel preview of the PR before merge, and on the demo environment after every deploy that carries a policy change. The demo environment gets only the script and the read-only checklist, so no test data is written there.

### The script

```bash
scripts/csp-smoke.sh https://<host> https://<project-ref>.supabase.co
scripts/csp-smoke.sh http://127.0.0.1:3000     # a local production build
```

The second argument is the Supabase origin the target environment was built with (that environment's `NEXT_PUBLIC_SUPABASE_URL`; a path is ignored). Without it the script falls back to `NEXT_PUBLIC_SUPABASE_URL` from your shell and prints which source it used. Check that it names the target's project, because a shell profile may export another environment's value. A non-loopback target with neither fails.

It runs `curl -sI` on three unauthenticated paths (`/sign-in`, `/terms` and `/conductia/email/conductia-mark-ink.png`), which answer without a session. For each path it prints `enforced`, `report-only` or `MISSING`, then checks three directives: `img-src 'self' data:`, `frame-ancestors 'none'`, and a `connect-src` that is exactly `'self'` plus the expected Supabase origin. A wrong, missing or extra origin fails. On a loopback target with no expected origin, the `connect-src` comparison is skipped and the script says so.

Read the last line, not the exit code:

| Last line | Meaning |
|---|---|
| `result: enforced` | Every path carries the enforced header with the key directives. Exit 0 |
| `result: report-only (CSP is NOT blocking anything)` | Every path carries the report-only header. Exit 0 as well, so the exit code alone cannot tell the two apart |
| `result: FAIL` | A path has no CSP header, a key directive is absent, or `connect-src` is not exactly `'self'` plus the expected origin. Exit 1 |

A target that is behind Vercel login or deployment protection needs a protection bypass. Export `VERCEL_PROTECTION_BYPASS` in your shell and the script sends it as `x-vercel-protection-bypass`. The script never prints the value, and the value never goes into a transcript, a PR or this repo. No bypass is documented today (staging sits behind Vercel login), so on a protected environment the owner runs the script or supplies one.

### The checklist

Open DevTools, Console, filter on `Content-Security-Policy`, and enable "Preserve log". Then:

| # | Page or action | Pass |
|---|---|---|
| 1 | `scripts/csp-smoke.sh <url> <supabase-origin>` | `result: enforced`, exit 0 |
| 2 | `/sign-in`, sign in with the demo password account | Lands on `/projects`, no CSP error |
| 3 | Project picker at `/projects` | The deal list renders |
| 4 | Open the demo deal, then the rail. Open a step with a skill result or draft | Markdown renders. A link shows `(host)` and opens the "Leaving Conductia" panel. Cancel closes it |
| 5 | Deal folder: the list loads. Open or download one document (upload only if the demo script includes it) | The file list comes from Box and the download starts |
| 6 | Discovery: the list, then one candidate | Both render |
| 7 | Mail: the inbox and one message. Open the composer and do not send | Renders. A remote image in a real inbound mail shows as broken, which is expected |
| 8 | Skills: the list, then open the skill builder | Renders |
| 9 | Profile | Renders, and the photo shows if one is set |
| 10 | Console after all steps | **Zero** `Content-Security-Policy` errors, except `vercel.live` on a Preview |

Fail means any CSP error naming `'self'`, the Supabase origin, `data:`, `inline` or `eval`, or a page that does not render. On a fail, run the rollback below and record the console line, with the blocked origin only, as the evidence.

### Where to record the result

- Before merge: the PR body of the `[226 2/3]` slice, under the Risk line. Where the preview is protected and no bypass exists, the owner runs it.
- After deploy to the demo environment: a comment on issue #226 (Proposed), with the date, the environment, the `result:` line and rows 1 to 10 as pass or fail.

## Rollback to report-only

A build with `CSP_REPORT_ONLY=1` sends the same policy under the name `Content-Security-Policy-Report-Only`, which blocks nothing. The header is chosen when `next.config.ts` is evaluated at build, so **changing the variable does nothing until a new build**. Hence the redeploy in step 3.

Use it when the smoke checklist or a user report shows the policy blocking something first-party that the hermetic tests did not catch.

1. **Who.** A member of the Vercel `conductia` team with permission to edit the project's environment variables. An implementation session never does this. Names: `TODO(owner)` (T12).
2. **Switch.** Set `CSP_REPORT_ONLY` to `1` on the one environment that needs it, as a **non-sensitive** variable. A sensitive variable, or one added after a build started, exists only at runtime (`src/lib/ignatious/config.ts:30-35`), and this switch is read at build.
   - CLI: `vercel env add CSP_REPORT_ONLY <production|preview|staging> --no-sensitive`, then enter `1` when asked.
   - Dashboard: the Conductia project, Settings, Environment Variables, add `CSP_REPORT_ONLY` = `1`, scoped to that environment only, Sensitive off.
   - The environments differ: `develop` and every other branch deploy as Preview, `staging` is a custom environment at `conductia-env-staging-conductia.vercel.app`, and Production deploys from `main` at `app.conductia.com`. Setting the variable on Preview switches every Preview build, not one PR. The environment that runs the Oct 30 demo: `TODO(owner)` (T12).
3. **Redeploy** the current deployment of that environment.
   - CLI: `vercel redeploy <current-deployment-url> --target <environment>`.
   - Dashboard: Deployments, the current deployment, Redeploy.
4. **Confirm** that only the report-only header is served.

   ```bash
   curl -sI https://<host>/sign-in | grep -i content-security-policy
   ```

   Add `-H "x-vercel-protection-bypass: $VERCEL_PROTECTION_BYPASS"` for a protected environment. Pass: the only matching line starts with `content-security-policy-report-only:`. Or run `scripts/csp-smoke.sh https://<host> https://<project-ref>.supabase.co`, which must print `result: report-only (CSP is NOT blocking anything)`. Then re-run checklist rows 2 to 9: the pages now load even where the policy would have blocked something.
5. **How long.** The env change takes about a minute. The rest is one Vercel build plus deploy, the same length as that environment's last build. A local production build with `CSP_REPORT_ONLY=1` took 33 seconds. The Vercel build time is unmeasured: `TODO(owner)`, from the Deployments list for the demo environment, before the demo. Expected total is well under 15 minutes, to be confirmed by that measurement.
6. **Faster fallback, Production only.** Vercel Instant Rollback to the last pre-CSP deployment takes seconds, but it also reverts everything merged since. Use it only if the build path is blocked. See also Break-glass in `docs/03-engineering/delivery-model.md`.

Report-only is a temporary state. While it holds, the browser blocks nothing: a remote image in inbound mail loads again, and so does anything else the renderers miss. Record the cause and fix it in code.

## Back to enforced

1. Remove the variable: `vercel env rm CSP_REPORT_ONLY <environment>`, or delete the entry in the dashboard.
2. Redeploy as in step 3 of the rollback.
3. Confirm: `curl -sI https://<host>/sign-in | grep -i content-security-policy` now shows a `content-security-policy:` line and no `-report-only` line, and `scripts/csp-smoke.sh https://<host> https://<project-ref>.supabase.co` prints `result: enforced`.
4. Re-enable enforcement only after the cause is fixed in code: a narrow directive plus an update to `tests/security-headers.test.ts`, never a wildcard.

Unset means enforced. Any value other than `1`, including `0`, also enforces.

## Changing the policy

- Widen the narrowest directive that fixes the problem, naming the one origin. Never add `*`, `https:` or a bare scheme to a fetch directive.
- Change `contentSecurityPolicy()` in `next.config.ts` and the expected string in `tests/security-headers.test.ts` in the same PR. The test pins the exact value, so a widening that skips it fails CI.
- Add the host to the inventory table above, with the file that needs it. If the browser does not load it, it does not belong in the policy.
- The hermetic Playwright suite fails on any `securitypolicyviolation` in every spec (`e2e/support/cspViolations.ts`, `e2e/support/fixtures.ts`), and `e2e/journeys/csp-surfaces.spec.ts` walks the main surfaces. Run them on the PR. They cannot reach the items listed under the inventory, so also run the smoke checklist.
- Introducing a nonce-based `script-src` is a separate piece of work. It needs every page rendered dynamically and the middleware rename. Until then, this policy is an egress policy and nothing more.
