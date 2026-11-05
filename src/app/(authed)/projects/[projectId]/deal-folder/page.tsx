import { DealFolderSwitch } from '@/components/dataroom';

/**
 * `/projects/[projectId]/deal-folder` — our INTERNAL work product.
 *
 * The Deal Folder is the bank's own material, structured as the Ignatious
 * eight-folder taxonomy (Sample-ignatious-Project structure, folders only).
 * Internal-only by intent: the client cannot reach it through the nav
 * (`access.ts`: only the MD's perspective lists `dealFolder`).
 *
 * platform_onboarding ON: live documents filed into that taxonomy. Files stay
 * where they are uploaded — moving is not offered.
 * platform_onboarding OFF: the empty taxonomy explorer.
 *
 * NOTE (compliance, honest): nav gating is presentation only. Real
 * document-level enforcement lands with the backend swap — tracked in ADR-0009.
 */
export default function DealFolderPage() {
  return <DealFolderSwitch />;
}
