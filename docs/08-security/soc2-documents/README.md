# SOC 2 documents

Source copies of the engineering documents uploaded to Vanta as evidence for document tests. Vanta holds the submitted PDFs, their version history and the screenshots or exports attached to them; this folder holds the reviewed text so each renewal starts from the last approved version.

| Document | Vanta test | Submitted | Renew before |
|---|---|---|---|
| [System description](./system-description.md) | System Description (Section III) | 2026-10-25 | 2027-10-25 |
| [Network diagram](./network-diagram.md) | Network diagram | 2026-10-25 | 2027-10-25 |
| [CI/CD system](./ci-cd-system.md) | CI/CD system in use | 2026-10-25 | 2027-10-25 |
| [Customer support](./customer-support.md) | Customer support site or email alias | 2026-10-25 | 2027-10-25 |
| [Internal communication](./internal-communication.md) | Internal communication for system updates | 2026-10-25 | 2027-10-25 |
| [Vulnerability scanning](./vulnerability-scanning.md) | Vulnerability scan | 2026-10-25 | 2027-01-24 |
| [Data inventory map](./data-inventory-map.md) | Maintain data inventory map | 2026-10-25 | 2027-10-25 |

## Updating a document

1. Change the Markdown here in a PR to `develop` with the `compliance: soc2` label.
2. Once merged, render it to PDF, attach the current screenshots or exports the test asks for, and upload it on the Vanta test with **New draft**.
3. Update the dates in this table.

Screenshots, Slack exports and anything with customer data stay in Vanta, not in this repo (see the working rules in [the program](../soc2-type1-program.md)). Policies live in Vanta.
