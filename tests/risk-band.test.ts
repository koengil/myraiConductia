import { describe, expect, it } from 'vitest';

import { riskBandFor } from '../src/lib/compliance/riskBand';

/*
 * The risk band (#192, written decision 2026-08-24): Routine / Sampled /
 * Queued, band only, never the raw score. Thresholds provisional pending
 * counsel — these tests pin the DECIDED shape (three bands, these names,
 * non-compliant always queues, a sign-off is at least sampled), so a
 * threshold tune shows up as an explicit diff here.
 */

describe('riskBandFor', () => {
  it('any non-compliant screen read queues, whatever the heat', () => {
    expect(riskBandFor({ verdict: 'hold', heat: 5 })).toBe('queued');
    expect(riskBandFor({ verdict: 'blocked' })).toBe('queued');
  });

  it('high heat queues even when the verdict is compliant', () => {
    expect(riskBandFor({ verdict: 'compliant', heat: 70 })).toBe('queued');
  });

  it('mid heat samples; a sender sign-off is at least sampled', () => {
    expect(riskBandFor({ verdict: 'compliant', heat: 40 })).toBe('sampled');
    // An acknowledged risk is exactly what sampling exists to spot-check.
    expect(
      riskBandFor({ verdict: 'compliant', heat: 0, preApproved: ['we guarantee'] }),
    ).toBe('sampled');
  });

  it('clean and cool is routine; missing heat means no heat', () => {
    expect(riskBandFor({ verdict: 'compliant', heat: 10 })).toBe('routine');
    expect(riskBandFor({ verdict: 'compliant' })).toBe('routine');
  });
});

// Issue #94 (D105): the firm's CCO sets the heat thresholds and the lowest
// band for a send the AI pass did not check. Defaults are the values above.
describe('riskBandFor with firm settings', () => {
  const strict = { queuedFrom: 90, sampledFrom: 60, uncheckedFloor: 'routine' as const };

  it('uses the firm thresholds instead of 40 / 70', () => {
    expect(riskBandFor({ verdict: 'compliant', heat: 80 }, strict)).toBe('sampled');
    expect(riskBandFor({ verdict: 'compliant', heat: 90 }, strict)).toBe('queued');
    expect(riskBandFor({ verdict: 'compliant', heat: 50 }, strict)).toBe('routine');
  });

  it('keeps the floors no threshold can lower: non-compliant queues, a sign-off samples', () => {
    expect(riskBandFor({ verdict: 'hold', heat: 0 }, strict)).toBe('queued');
    expect(riskBandFor({ verdict: 'compliant', heat: 0, preApproved: ['we guarantee'] }, strict)).toBe('sampled');
  });

  it('raises a send the AI pass did not check to the firm floor, never lowers one', () => {
    const floor = { ...strict, uncheckedFloor: 'sampled' as const };
    expect(riskBandFor({ verdict: 'compliant', llmChecked: false }, floor)).toBe('sampled');
    expect(riskBandFor({ verdict: 'compliant', heat: 95, llmChecked: false }, floor)).toBe('queued');
    // Checked sends are unaffected by the floor.
    expect(riskBandFor({ verdict: 'compliant', heat: 10, llmChecked: true }, floor)).toBe('routine');
    // The default floor changes nothing.
    expect(riskBandFor({ verdict: 'compliant', llmChecked: false })).toBe('routine');
  });
});
