<!-- Target `develop` and squash-merge (rebase on `origin/develop` before pushing). Never merge to `staging` or `main` with the GitHub button — promote with the "Promote develop to staging" and "Promote staging to main" Actions. -->

## Change type

<!-- Check one (prefix the PR title if helpful, e.g. `feat: …`, `fix: …`). -->

- [ ] **feat** — new capability or MD-facing behavior
- [ ] **fix** — bug or regression
- [ ] **docs** — documentation only (`docs/`, README, ADRs)
- [ ] **chore** — tooling, CI, deps, housekeeping (no product behavior change)
- [ ] **refactor** — structure or clarity, same behavior
- [ ] **test** — tests only
- [ ] **style** — visual/copy polish, no logic change

## Summary

<!-- What changed and why (1–3 sentences). Link ADRs or docs if this encodes a product/engineering decision. -->

## Test plan

- [ ] `nvm use` (Node 22 from `.nvmrc`)
- [ ] `npm ci`
- [ ] `npm run lint`
- [ ] `npx tsc --noEmit`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Manual smoke (if UI): mandate intake → rail destinations touched by this change

## Scope notes

<!-- Optional: seam/API changes, compliance invariant touchpoints, fixture or scoring changes. -->

## Screenshots / recordings

<!-- UI changes only; delete if N/A. -->
