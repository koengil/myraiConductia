import { describe, expect, it } from 'vitest';

import {
  DEAL_CLOSE_DATE_MIN_ISO,
  DEAL_FEE_USD_MAX,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_NAME_MAX_LENGTH,
  LEAD_NAME_MAX_LENGTH,
  LEAD_NAME_MIN_LENGTH,
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
  PROFILE_FULL_NAME_MAX_LENGTH,
  checkDocumentUpload,
  checkFeeUsd,
  checkLeadName,
  checkProfileDisplayName,
  checkProfileFullName,
  checkTargetCloseDate,
  maxTargetCloseDateIso,
} from '@/lib/validation/inputPolicy';

const NOW = new Date('2026-09-01T00:00:00Z');

describe('lead names', () => {
  it('refuses whitespace, one character and anything past the cap', () => {
    expect(checkLeadName('   ').ok).toBe(false);
    expect(checkLeadName('A').ok).toBe(false);
    expect(checkLeadName('Z'.repeat(LEAD_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it('accepts both bounds and trims', () => {
    expect(checkLeadName('Z'.repeat(LEAD_NAME_MIN_LENGTH))).toEqual({ ok: true, value: 'ZZ' });
    expect(checkLeadName('Z'.repeat(LEAD_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(checkLeadName('  Atlassian  ')).toEqual({ ok: true, value: 'Atlassian' });
  });

  it('treats a SQL-looking string as ordinary text within the bounds', () => {
    expect(checkLeadName("'; DROP TABLE deals;--")).toEqual({
      ok: true,
      value: "'; DROP TABLE deals;--",
    });
  });
});

describe('profile names', () => {
  it('caps the full name and refuses an empty one', () => {
    expect(checkProfileFullName('').ok).toBe(false);
    expect(checkProfileFullName('Z'.repeat(PROFILE_FULL_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(checkProfileFullName('Z'.repeat(PROFILE_FULL_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it('treats a blank nickname as cleared and caps the rest', () => {
    expect(checkProfileDisplayName('  ')).toEqual({ ok: true, value: null });
    expect(checkProfileDisplayName(null)).toEqual({ ok: true, value: null });
    expect(checkProfileDisplayName('Z'.repeat(PROFILE_DISPLAY_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(checkProfileDisplayName('Z'.repeat(PROFILE_DISPLAY_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('document uploads', () => {
  const base = { fileName: 'cim.pdf', sizeBytes: 1024 };

  it('accepts a document at the size ceiling', () => {
    expect(checkDocumentUpload({ ...base, sizeBytes: DOCUMENT_MAX_BYTES }).ok).toBe(true);
  });

  it('refuses an empty file and one byte past the ceiling', () => {
    expect(checkDocumentUpload({ ...base, sizeBytes: 0 }).ok).toBe(false);
    expect(checkDocumentUpload({ ...base, sizeBytes: DOCUMENT_MAX_BYTES + 1 }).ok).toBe(false);
  });

  it('refuses an executable and any type outside the allowlist', () => {
    expect(checkDocumentUpload({ ...base, fileName: 'evil.exe' }).ok).toBe(false);
    expect(checkDocumentUpload({ ...base, fileName: 'big.bin' }).ok).toBe(false);
    expect(checkDocumentUpload({ ...base, fileName: 'noextension' }).ok).toBe(false);
  });

  it('refuses a disallowed display name over an allowed file', () => {
    expect(checkDocumentUpload({ ...base, displayName: 'evil.exe' }).ok).toBe(false);
  });

  it('caps the display name length', () => {
    const long = `${'z'.repeat(DOCUMENT_NAME_MAX_LENGTH)}.pdf`;
    expect(checkDocumentUpload({ ...base, displayName: long }).ok).toBe(false);
  });

  it('keeps the display name when it is allowed', () => {
    expect(checkDocumentUpload({ ...base, displayName: ' Project CIM.pdf ' })).toEqual({
      ok: true,
      value: 'Project CIM.pdf',
    });
  });
});

describe('fee bounds', () => {
  it('accepts zero, the ceiling and null', () => {
    expect(checkFeeUsd(0).ok).toBe(true);
    expect(checkFeeUsd(DEAL_FEE_USD_MAX).ok).toBe(true);
    expect(checkFeeUsd(null)).toEqual({ ok: true, value: null });
  });

  it('refuses a negative fee, a fraction and anything past the ceiling', () => {
    expect(checkFeeUsd(-1).ok).toBe(false);
    expect(checkFeeUsd(1.5).ok).toBe(false);
    expect(checkFeeUsd(DEAL_FEE_USD_MAX + 1).ok).toBe(false);
    expect(checkFeeUsd(999999999999999).ok).toBe(false);
  });

  it('speaks to the MD, not to the type system', () => {
    const refusal = checkFeeUsd(-1);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.message).not.toMatch(/feeUsd|2\^53|null/);
  });
});

describe('target close date bounds', () => {
  it('accepts both ends of the window', () => {
    expect(checkTargetCloseDate(DEAL_CLOSE_DATE_MIN_ISO, NOW).ok).toBe(true);
    expect(checkTargetCloseDate(maxTargetCloseDateIso(NOW), NOW).ok).toBe(true);
    expect(checkTargetCloseDate(null, NOW)).toEqual({ ok: true, value: null });
  });

  it('refuses a distant past, a distant future and a non-date', () => {
    expect(checkTargetCloseDate('1900-01-01', NOW).ok).toBe(false);
    expect(checkTargetCloseDate('9999-12-31', NOW).ok).toBe(false);
    expect(checkTargetCloseDate('2026-13-45', NOW).ok).toBe(false);
    expect(checkTargetCloseDate('next friday', NOW).ok).toBe(false);
  });

  it('puts the window ten years out', () => {
    expect(maxTargetCloseDateIso(NOW)).toBe('2036-09-01');
  });
});
