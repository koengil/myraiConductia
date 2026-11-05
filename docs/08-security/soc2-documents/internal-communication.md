# Internal Communication for System Updates

Conductia, Inc. Prepared 2026-10-25; reviewed and approved by Martin Casado.

The team learns about system changes through GitHub and Slack. Every change is a reviewed pull request on the delivery board, every production release is a tagged GitHub release listing its pull requests and migrations, and releases, incidents and system updates are announced in the Slack channel **\#internal-conductia**.

| What changes | How the team hears about it | Source |
|----|----|----|
| Planned work | GitHub project "Conductia delivery", weekly milestones and statuses | `docs/03-engineering/delivery-model.md` |
| Staging promotion | Daily or at the weekly build sync | Delivery model |
| Production release | `vX.Y.Z` GitHub release listing every PR and migration since the last tag, every 1 to 2 weeks; announced in \#internal-conductia | Promote staging to main workflow |
| Emergency bypass | Recorded in the release notes | Delivery model |
| Broken `develop` | CI opens or comments on a "develop-is-red" GitHub issue | `.github/workflows/ci.yml` |
| Architecture decisions | Decision log | `docs/07-decisions/decision-log.md` |
| Failing compliance tests | Owners notified through Slack and GitHub issues | SOC 2 program |
| Customer-facing changes | Public changelog at conductia.com/changelog, from each release's Customer notes | Release process |
