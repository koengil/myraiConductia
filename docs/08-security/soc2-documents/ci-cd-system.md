# Conductia CI/CD System

Conductia, Inc. Prepared 2026-10-25; reviewed and approved by Martin Casado.

Conductia uses GitHub for source control and GitHub Actions for CI; Vercel deploys the web app and a GitHub Actions workflow migrates the hosted databases. No change reaches production without a reviewed pull request and green checks.

## Branch protection (GitHub rulesets, as of 2026-10-24)

| Repository | Branch | Rules | Bypass |
|----|----|----|----|
| Conductia | `develop` | PR with 1 approval, 4 required checks, no deletion, no force push | None |
| Conductia | `staging`, `main` | Fast-forward promotion only, linear history, no deletion, no force push | None |
| conductia-agents-backend | `main`, `prod` | PR with 1 approval, no deletion, no force push | None |
| conductia-site | `main`, `v12-staging` | PR with 1 approval, required Netlify deploy preview, no deletion, no force push | None |

The PR author cannot approve their own PR, and CODEOWNERS auto-requests reviewers.

## Required checks on `develop`

1.  **Lint, typecheck, test, build**: ESLint, TypeScript, migration ordering and lint, unit suites, eval harness, Next.js production build.
2.  **Phase 1 integration test**: API tests against a local Supabase stack.
3.  **E2E (hermetic)**: Playwright end-to-end tests.
4.  **Dependency vulnerability audit**: `npm audit` in CI.

Also in CI: gitleaks secret scan (required), Semgrep CE static analysis (advisory), Dependabot alerts and version updates, GitHub secret scanning with push protection.

## Promotion and deployment

1.  A squash-merged PR lands on `develop`; Vercel deploys it to the dev environment.
2.  The Promote develop to staging workflow fast-forwards `staging`; the migrate workflow applies migrations to the staging database before staging moves.
3.  The Promote staging to main workflow fast-forwards `main`, which deploys production at app.conductia.com and migrates the production database (GitHub environment `db-production`).
4.  Each release on `main` is tagged `vX.Y.Z`.

The agents backend runs its own Platform CI (install with a frozen lockfile, typecheck, lint, test) on PRs to `main`.
