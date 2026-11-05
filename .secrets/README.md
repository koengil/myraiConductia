# .secrets

The single configuration point for credentials, secrets and certificate
references (#259, design R16). Everything in this folder is ignored by git
except this README (`.gitignore`: `.secrets/*`, `!.secrets/README.md`).

The layout maps one to one onto a vault: one secret per path. When a vault is
chosen, each row below becomes one vault entry and the path stays the name.

| Path | What | Secret | Provided by | Verified by |
|---|---|---|---|---|
| `google/worker-credentials.json` | External-account config (workload identity federation) or local ADC that impersonates the caller service account. Never a service-account key. | Not a secret for `external_account`; the ADC refresh token is personal | Conductia | P01 |
| `google/registration.json` | Input to `npm run google:write-registration`: tenant, domain, DWD service account email, client ID, directory service account email, ingest group, firm company, status, consentedAt (sources arrive in Phase 2) | No | The bank's super admin (for the trial, the owner) | P02 to P09 |
| `google/seeding.json` | Test domains, seeding service account email, Drive probe service account email, and a persona map (trial address to fixture address) | No | Conductia | The seeders' refusals (a domain not listed here is never written to) |

## Rules

- No file in this folder holds key material. `google:write-registration` and
  `google:probe` refuse a PEM block, a private key field, or a service-account
  key file anywhere in the folder. A registration names where a signer lives; it
  never holds a key.
- The worker signs through IAM Credentials `signJwt` as the DWD service
  account. There is nothing to rotate on our side and nothing to leak from
  here.
- The probe's PASS list (`npm run google:probe`) is the credential request sent
  to the bank. See `docs/03-engineering/google-workspace-reader-admin-guide.md`.
- Nothing here is ever committed. Never `git add` this folder except the README.
