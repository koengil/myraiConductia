# Pre-release sandbox Gmail generator (#658)

Generates about 200-300 realistic deal emails from the cast/deals fixture and imports them into **conductia-sandbox.com** Workspace mailboxes via `messages.import` and the shared Google operator kit. Part of epic [#662](https://github.com/Conductia/Conductia/issues/662).

Fixture (approved cast + deals): `fixtures/cast_deals.yaml` ([#656](https://github.com/Conductia/Conductia/issues/656) / [#657](https://github.com/Conductia/Conductia/issues/657)).

## Prerequisites

- Google operator identity **`sandbox-mailer@conductia-sandbox.iam.gserviceaccount.com`** with domain-wide delegation on `conductia-sandbox.com`, using the same keyless **`googleOperatorKit()`** path as `scripts/google/seed-gmail.ts` (no downloaded SA JSON in the repo).
- Scopes: `gmail.insert` for import; `gmail.modify` for `--reset` only.

## Delivery model

The script uses **`users.messages.import`** with `internalDateSource=dateHeader` into each sender's mailbox, impersonating only allow-listed firm addresses. **`threadId`** is tracked per mailbox so reply chains stay in one Gmail thread per cast member. Deterministic **`Message-ID`** values plus **`X-Conductia-Sandbox-Run-Tag`** labels make re-runs idempotent (`rfc822msgid:` search).

## Commands

Dry-run (no network; writes `.eml.b64url`, per-message JSON, and `manifest.json`):

```bash
npm run sandbox:generate-gmail -- --dry-run --out /tmp/sandbox-mail --seed 65842
```

Demo Producer: **OSPREY only** (`demo_safe`, no deliberate mistakes):

```bash
npm run sandbox:generate-gmail -- --dry-run --deal OSPREY --out /tmp/osprey-mail
```

Live import (requires Google ADC / workload identity and explicit domain confirmation):

```bash
npm run sandbox:generate-gmail -- --live --confirm-domain conductia-sandbox.com --run-tag sandbox-v1
```

Reset a prior run (trash by run label `ConductiaSandbox/<run-tag>`):

```bash
npm run sandbox:generate-gmail -- --live --confirm-domain conductia-sandbox.com --run-tag sandbox-v1 --reset
```

## Flags

| Flag | Purpose |
|------|---------|
| `--dry-run` | Write files under `--out` (default: `./.sandbox-mail-out`) |
| `--out <dir>` | Dry-run output directory |
| `--deal CODE` | Comma-separated deal filter (e.g. `OSPREY`) |
| `--seed <n>` | Deterministic generation seed (default `65842`) |
| `--run-start ISO` | Calendar date for fixture day `0` (default `2026-10-01`) |
| `--run-tag <tag>` | Idempotency / reset label value (default `sandbox-v1`) |
| `--fixture <path>` | Alternate YAML fixture |
| `--live` | Import via Gmail API (refused in CI) |
| `--confirm-domain` | Must match fixture workspace domain (`conductia-sandbox.com`) |
| `--reset` | Trash messages for `--run-tag` before sending |

## Manifest

Dry-run and live runs share the same generator. **`manifest.json`** lists every message; entries with **`deliberate_mistake`** tags map to fixture **triggers** and their **expected** screening/dedupe outcomes for QA checklists.

## Safety

- Hard allow-list: every From/To/Cc address must be on one of the four firm subdomains (`halvorsen.`, `corvane.`, `ashgrove.`, `thistlewood.conductia-sandbox.com`). The bare **`conductia-sandbox.com`** parent is never allowed.
- Mail domains are hardcoded in `lib/domains.ts`; the fixture cannot widen them.
- `--live` and seed `--apply` refuse to run when `CI=true`.

## Database seed (#746)

Provision the sandbox orgs and Halvorsen Ridge cast seats on dev or staging (never production):

```bash
npm run sandbox:seed-firm
SEED_PASSWORD='…' SANDBOX_TENANT_ID='<tenant-uuid>' npm run sandbox:seed-firm -- --apply
```

Requires `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `EXPECT_SUPABASE_REF` (defaults to dev `sqyjqdjazefceixkjtdp`). Dry-run by default; pass `--apply` to upsert companies, verified domains, and firm_a auth accounts. Production Supabase ref `fsaucpwponmzajupvsey`, custom domains, and `NEXT_PUBLIC_APP_ENV=prod` are refused. An existing cast email on another tenant is refused rather than moved.
