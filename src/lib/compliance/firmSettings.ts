import type { SupabaseClient } from '@supabase/supabase-js';

import { RISK_BAND, RISK_BANDS, type RiskBand } from '@/lib/constants/outbox';
import { TABLE } from '@/lib/constants/tables';

// Firm compliance settings (Issue #94, Issue #95; D105). Mirror the
// firm_compliance_settings CHECKs; source of truth is
// supabase/migrations/20261020110000_firm_compliance_settings.sql and the
// ceilings in 20261021140000_firm_compliance_settings_save.sql.
//
// The defaults and the allowed range are PROVISIONAL until counsel signs them
// off (Issue #225, PL-13), which gates mail_channel in production.

/**
 * The highest a firm may set each threshold. Heat is clamped to 0-100, so a
 * threshold at 100 would switch off sampling or queueing of compliant mail
 * (Martín's review of PR #640). 90 matches the "90 to 100" example in Issue #94.
 */
export const MAX_QUEUED_FROM = 90;
export const MAX_SAMPLED_FROM = 80;

export const SEND_FRICTION = {
  /** Send goes out on one click (Ignatious). */
  ONE_CLICK: 'one_click',
  /** A confirm step before any send that reaches outside the firm. */
  CONFIRM_EXTERNAL: 'confirm_external',
} as const;

export type SendFriction = (typeof SEND_FRICTION)[keyof typeof SEND_FRICTION];
export const SEND_FRICTIONS = Object.values(SEND_FRICTION) as SendFriction[];

export type FirmComplianceSettings = {
  /** A compliant send whose heat is at or above this is Queued. */
  queuedFrom: number;
  /** At or above this, and below queuedFrom, it is Sampled. */
  sampledFrom: number;
  /** The lowest band for a send the AI pass did not check. */
  uncheckedFloor: RiskBand;
  sendFriction: SendFriction;
};

/** No row = these, which are the behaviour before the settings existed. */
export const DEFAULT_FIRM_COMPLIANCE_SETTINGS: FirmComplianceSettings = {
  queuedFrom: 70,
  sampledFrom: 40,
  uncheckedFloor: RISK_BAND.ROUTINE,
  sendFriction: SEND_FRICTION.ONE_CLICK,
};

type Row = {
  queued_from: number;
  sampled_from: number;
  unchecked_floor: string;
  send_friction: string;
};

export const FIRM_COMPLIANCE_SELECT = 'queued_from, sampled_from, unchecked_floor, send_friction';

export function settingsFromRow(row: Row | null | undefined): FirmComplianceSettings {
  if (!row) return DEFAULT_FIRM_COMPLIANCE_SETTINGS;
  return {
    queuedFrom: Number(row.queued_from),
    sampledFrom: Number(row.sampled_from),
    uncheckedFloor: RISK_BANDS.includes(row.unchecked_floor as RiskBand)
      ? (row.unchecked_floor as RiskBand)
      : DEFAULT_FIRM_COMPLIANCE_SETTINGS.uncheckedFloor,
    sendFriction: SEND_FRICTIONS.includes(row.send_friction as SendFriction)
      ? (row.send_friction as SendFriction)
      : DEFAULT_FIRM_COMPLIANCE_SETTINGS.sendFriction,
  };
}

/**
 * The firm's settings, or the defaults when it has none. A read error throws:
 * the send path must not quietly fall back to looser thresholds than the CCO set.
 */
export async function loadFirmComplianceSettings(
  admin: SupabaseClient,
  tenantId: string,
): Promise<FirmComplianceSettings> {
  const { data, error } = await admin
    .from(TABLE.FIRM_COMPLIANCE_SETTINGS)
    .select(FIRM_COMPLIANCE_SELECT)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Compliance settings unavailable (${error.code ?? 'unknown'})`);
  return settingsFromRow(data as Row | null);
}

/** Validates a full settings object from a request body; returns an error message or the settings. */
export function parseFirmComplianceSettings(raw: unknown): FirmComplianceSettings | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a settings object';
  const body = raw as Record<string, unknown>;
  const whole = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
  if (!whole(body.queuedFrom, MAX_QUEUED_FROM)) return `queuedFrom must be a whole number from 1 to ${MAX_QUEUED_FROM}`;
  if (!whole(body.sampledFrom, MAX_SAMPLED_FROM)) return `sampledFrom must be a whole number from 1 to ${MAX_SAMPLED_FROM}`;
  if ((body.sampledFrom as number) > (body.queuedFrom as number)) {
    return 'sampledFrom must not be above queuedFrom';
  }
  if (!RISK_BANDS.includes(body.uncheckedFloor as RiskBand)) {
    return `uncheckedFloor must be one of ${RISK_BANDS.join(', ')}`;
  }
  if (!SEND_FRICTIONS.includes(body.sendFriction as SendFriction)) {
    return `sendFriction must be one of ${SEND_FRICTIONS.join(', ')}`;
  }
  return {
    queuedFrom: body.queuedFrom as number,
    sampledFrom: body.sampledFrom as number,
    uncheckedFloor: body.uncheckedFloor as RiskBand,
    sendFriction: body.sendFriction as SendFriction,
  };
}
