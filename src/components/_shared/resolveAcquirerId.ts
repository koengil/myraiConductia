import type { Acquirer } from '@/lib/api/types';

/**
 * Resolve the acquirer id the deep-dive should operate on.
 *
 * `selectedAcquirerId` is set by the Landscape stage (experience-spine § Step
 * 3) when the MD picks an acquirer. The golden path always carries that
 * selection into Step 4. If it is null OR not present in the fetched acquirer
 * list, the Landscape selection did not propagate — a real wiring fault, not a
 * normal state. Rather than silently swallowing it with `?? 'anthropic'` we
 * make it LOUD (a single warn) so the fault is visible in the demo console,
 * then still recover (first acquirer, else the hero acquirer 'anthropic') so
 * the wow beat never dead-ends in front of a founder.
 *
 * Pure + side-effect-light (one console.warn on the fault path only); shared
 * by Canvas and DeepDive so the fallback policy + justification live in ONE
 * place. Additive file — no frozen-contract surface touched.
 */
export function resolveAcquirerId(
  selectedAcquirerId: string | null,
  acquirers: Acquirer[],
): string {
  const valid =
    selectedAcquirerId !== null &&
    acquirers.some((a) => a.id === selectedAcquirerId);

  if (valid) {
    return selectedAcquirerId as string;
  }

  console.warn(
    '[Conductia] selectedAcquirerId missing/invalid (Landscape selection did not propagate), falling back',
    { selectedAcquirerId },
  );

  return acquirers.length > 0 ? acquirers[0].id : 'anthropic';
}
