/**
 * Clamp a number into the inclusive 0–100 score range.
 *
 * Score axes (composite breakdown bars, culture-radar factors, the ScoreDial
 * sweep) are all defined 0–100 by matrices.md. This is the single shared
 * guard so a malformed fixture value can never blow a bar past its track or
 * push a dial offset out of range. Additive util — NOT a frozen-contract
 * change; behavior is bit-identical to the private clamps it replaces.
 */
export const clamp0to100 = (v: number): number => Math.max(0, Math.min(100, v));
