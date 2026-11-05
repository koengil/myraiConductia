import { DEFAULT_FIRM_COMPLIANCE_SETTINGS, type FirmComplianceSettings } from '@/lib/compliance/firmSettings';
import { RISK_BAND, type RiskBand } from '@/lib/constants/outbox';

/**
 * The risk band of a screened outbound message (#192, decided 2026-08-24).
 *
 * Dan/Storm's written decision: the platform stores the BAND, never the raw
 * score, under the agreed names — Routine / Sampled / Queued (low/elevated/
 * severe rejected for their legal implications). The band drives the
 * post-send supervision surfaces: Queued lands in the CCO review queue,
 * Sampled feeds the periodic sampling view, Routine is covered by
 * traceability alone.
 *
 * PROVISIONAL thresholds (counsel review pending, Issue #225 PL-13: counsel
 * signs off the defaults and the range a firm may set before mail_channel is
 * enabled in production): any non-compliant
 * screen read or a high heat is Queued; a mid heat or a sender sign-off is
 * Sampled (an acknowledged risk is exactly what sampling exists to
 * spot-check); everything else is Routine. The heat number itself is used
 * here and then dropped — it never leaves this function.
 *
 * A send whose rule flag Jev cleared (D82, proposed option A) is never
 * Routine: it floors at Sampled, so the CCO's sample sees what the model
 * overruled.
 *
 * The heat thresholds are the firm's own (Issue #94, D105): its CCO sets
 * where Sampled and Queued start, and the lowest band for a send the AI pass
 * did not check. Without settings they are the provisional 40 / 70 above.
 */
const BAND_RANK: Record<RiskBand, number> = { routine: 0, sampled: 1, queued: 2 };

export function riskBandFor(
  screened: {
    verdict: 'compliant' | 'hold' | 'blocked';
    heat?: number;
    llmChecked?: boolean;
    preApproved?: string[];
    secondOpinion?: { outcome: string };
  },
  settings: Pick<FirmComplianceSettings, 'queuedFrom' | 'sampledFrom' | 'uncheckedFloor'> = DEFAULT_FIRM_COMPLIANCE_SETTINGS,
): RiskBand {
  if (screened.verdict !== 'compliant') return RISK_BAND.QUEUED;
  const heat = screened.heat ?? 0;
  let band: RiskBand = RISK_BAND.ROUTINE;
  if (heat >= settings.queuedFrom) band = RISK_BAND.QUEUED;
  else if (heat >= settings.sampledFrom || (screened.preApproved?.length ?? 0) > 0) band = RISK_BAND.SAMPLED;
  else if (screened.secondOpinion?.outcome === 'cleared') band = RISK_BAND.SAMPLED;
  // The rules alone passed it: no heat was read, so the heat bands above
  // could not fire. The firm decides how much that is worth a look.
  // llmChecked is also false when the AI pass is skipped on a rules block,
  // but a block is non-compliant and already returned Queued above, so the
  // floor never applies to it.
  if (screened.llmChecked === false && BAND_RANK[settings.uncheckedFloor] > BAND_RANK[band]) {
    band = settings.uncheckedFloor;
  }
  return band;
}
