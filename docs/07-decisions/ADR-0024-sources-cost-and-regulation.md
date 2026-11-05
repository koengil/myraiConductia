# ADR-0024: Sources for ADR-0020 to ADR-0022: unit prices, regulation and SOC 2

Status: supporting material with no decision of its own. Proposed: numbered ADR-0024 so that ADR-0020 is a single file (it was `ADR-0020-sources-cost-and-regulation.md`).

Supporting material for [ADR-0020](./ADR-0020-mailbox-connection-deployment-and-shared-seam.md) and its companions ([ADR-0021](./ADR-0021-m365-mailbox-connection.md), [ADR-0022](./ADR-0022-google-workspace-mailbox-connection.md)). Read 2026-10-05 by a research agent and checked by the orchestrator.

- **Assumptions:** monthly figures use 730 hours and a one-bank pilot: one 24x7 task at 0.5 to 1 vCPU and 1 to 2 GB, 10 to 50 GB per month of egress, about 50 mailboxes and 5 to 20 GB per month of logs.
- **UNVERIFIED** marks anything not confirmed against a primary source. Check those items before quoting them to a bank.
- **Totals live in ADR-0020** ("Cost by deployment"), sized after the 2026-10-05/06 audits. This file keeps unit prices and sources only. Some per-line ranges here (for example 365-day log retention, GuardDuty runtime monitoring) are larger than the Pilot sizing ADR-0020 adopts. AWS Network Firewall, priced below, is required from Pilot on (ADR-0020 decision 6; Guillermo, 2026-10-08).

## Unit prices (US East list)

| Component | Unit price (source) | Monthly, low / likely / high |
|---|---|---|
| Azure Firewall Basic | $0.395/hr + $0.065/GB (Azure Retail Prices API, `prices.azure.com/api/retail/prices`) | $288 / $290 / $291 |
| Azure Firewall Standard | $1.25/hr + $0.016/GB (API) | about $913 |
| Azure Firewall Premium | $1.75/hr + $0.016/GB (API) | about $1,278 |
| Azure Container Apps, Consumption | $0.000024 per vCPU-second and $0.000003 per GiB-second, after free grants ([billing](https://learn.microsoft.com/en-us/azure/container-apps/billing)) | $34 / ~$50 / $73 |
| Azure Container Apps, plan management fee | Charged when private endpoints are used, even on Consumption (billing doc) | possibly +$73 (applicability UNVERIFIED) |
| Azure Key Vault | Standard: $0.03 per 10k operations. Premium HSM RSA-2048: $1 per key per month (API) | $1 to $2 |
| Azure NSG with service tags | free | $0 |
| Azure NAT Gateway | UNVERIFIED (from memory: about $0.045/hr + $0.045/GB) | about $33 to $36 |
| AWS ECS Fargate, x86 | $0.000011244 per vCPU-second and $0.000001235 per GB-second ([pricing](https://aws.amazon.com/fargate/pricing/)) | $18 / $21 / $36 (ARM about 20% less) |
| AWS NAT Gateway | $0.045/hr + $0.045/GB ([VPC pricing](https://aws.amazon.com/vpc/pricing/)) | $33 / $34 / $35, plus public IPv4 (UNVERIFIED) |
| AWS Network Firewall | $0.395/hr per AZ endpoint + $0.065/GB ([pricing](https://aws.amazon.com/network-firewall/pricing/)) | about $290 per AZ |
| Route 53 Resolver DNS Firewall | $0.60 per million queries + $0.0005 per domain ([Route 53 pricing](https://aws.amazon.com/route53/pricing/)) | $0.1 / $1 / $6 |
| Resolver query logs and VPC flow logs | CloudWatch vended logs, $0.50/GB ([pricing](https://aws.amazon.com/cloudwatch/pricing/)) | under $1 each |
| GuardDuty, including Fargate Runtime Monitoring at $1.50 per vCPU | ([pricing](https://aws.amazon.com/guardduty/pricing/)) | $2 / $5 / $10 |
| CloudTrail | First management trail free ([pricing](https://aws.amazon.com/cloudtrail/pricing/)) | $0 to $2, plus S3 |
| Secrets Manager | $0.40 per secret + $0.05 per 10k calls ([pricing](https://aws.amazon.com/secrets-manager/pricing/)) | $1.5 to $3 |
| KMS | $1 per key + $0.03 per 10k requests ([pricing](https://aws.amazon.com/kms/pricing/)) | $2 to $5 |
| CloudWatch Logs, 365-day retention | first 5 GB free, then $0.50/GB ingest; $0.03 per GB-month stored | $0 / $4 / $15 (high = month 12) |
| ECR | $0.10 per GB-month | under $1 |
| Gmail API | free within quota (80M units per day per project). Google plans charges above quota "later in 2026", with at least 90 days' notice ([quota](https://developers.google.com/workspace/gmail/api/reference/quota)) | $0 |
| Microsoft Graph, mail read | not metered. The only metered API on the list is `assignSensitivityLabel` ([metered list](https://learn.microsoft.com/en-us/graph/metered-api-list)) | $0 |

## Regulatory drivers

Most rule texts were read through summaries; the SEC and FINRA PDFs were unreadable in the fetch. Verify against the primary text before quoting.

| Rule | Bears on | Mandates a specific control? |
|---|---|---|
| SEC 17a-4 (2022 amendments) | An audit trail or WORM for the electronic record system; third-party undertaking; communications kept 3 years ([eCFR](https://www.ecfr.gov/current/title-17/chapter-II/part-240/subpart-A/subject-group-ECFR2cba8fe3d0d8bb7/section-240.17a-4)) | Yes, but for the record system only. Whether Conductia's discovery copy is part of that record system is for the bank's compliance team to determine (ADR-0020) |
| FINRA 4511 | Books and records; 6 years where no other period is specified ([rule](https://www.finra.org/rules-guidance/rulebooks/finra-rules/4511)) | No |
| FINRA 3110(b)(4) | Risk-based review of correspondence by a principal ([rule](https://www.finra.org/rules-guidance/rulebooks/finra-rules/3110)) | No |
| FINRA Regulatory Notice 21-29 | Vendor management; the firm keeps responsibility. Exam findings: undocumented vendor cybersecurity, weak access management and MFA ([notice](https://www.finra.org/rules-guidance/notices/21-29)) | No (guidance) |
| Reg S-P (2024 amendments) | Incident response program; service-provider oversight with provider notice in 72 hours; customer notice within 30 days ([SEC 2024-58](https://www.sec.gov/newsroom/press-releases/2024-58)). The compliance dates (2025-12-03 larger, 2026-06-03 smaller) and the 72-hour figure come from a Sidley summary (UNVERIFIED against SEC text) | No (risk-based program) |
| Reg SCI | Not applicable to broker-dealers generally | n/a |
| Proposed SEC cyber Rule 10 for broker-dealers | Withdrawn 2025-06-12 (secondary source) | n/a |
| NYDFS 23 NYCRR 500 | Only if the bank holds a New York license; final phase 2025-11-01. Sections 500.11 (third parties), 500.12 (MFA), 500.15 (encryption), 500.6 (audit trail) and 500.17 (72-hour notice) not read (UNVERIFIED) | Conditional |
| GLBA Safeguards | Broker-dealers fall under Reg S-P, not the FTC rule | n/a |

**Bottom line:** no rule mandates an egress firewall, a specific key-custody technology or a specific monitoring tool. All are risk-based choices to defend in the vendor-oversight conversation (21-29, Reg S-P).

## SOC 2 (Trust Services Criteria)

The AICPA primary text was not retrievable; the criterion titles below are UNVERIFIED. SOC 2 is criteria-based, so no criterion requires a specific tool.

- **CC6.1, CC6.2, CC6.3:** logical access, least privilege, provisioning and removal.
- **CC6.6:** boundary threats.
- **CC6.7:** restricting the transmission of data.
- **CC6.8:** integrity.
- **CC7.1 to CC7.4:** monitoring, anomalies, evaluation, incident response.
- **CC8.1:** change management.
- **CC9.2:** vendors and business partners.
- **C1.1 and C1.2:** confidential information, and its retention and disposal.
- **A1:** only if Availability is in scope.

**Subservice providers** (Supabase, Vercel, AWS, Azure, Google): the carve-out method is realistic for the large clouds. Conductia collects each provider's SOC 2 report, maps the complementary subservice organization controls, and reviews bridge letters as CC9.2 evidence. Each provider's current SOC 2 report status is UNVERIFIED.

## Open checks before quoting

- Azure NAT Gateway price, and Azure Firewall Basic's throughput and FQDN support.
- AWS public IPv4 charge.
- Primary text for: 17a-4 dates, 17a-3, the Reg S-P thresholds and 72 hours, Reg S-ID, NYDFS 500.x and the AICPA criteria.
- Each subservice provider's SOC 2 report status.
