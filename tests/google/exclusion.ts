import type { ExclusionContext, PolicyRule } from '@/lib/discovery/exclusion/types';

/** Version 0: no rules. What a fixture run reads under when no policy was seeded. */
export const NO_EXCLUSION: ExclusionContext = { policy: { version: 0, rules: [] }, threadTaint: new Map() };

/**
 * A policy version with these rules, and the threads already excluded (thread id to the rule ids): what the worker
 * hands the reader from the persisted taint. None by default.
 */
export function exclusionWith(rules: PolicyRule[], version = 1, taint: Record<string, string[]> = {}): ExclusionContext {
  return { policy: { version, rules }, threadTaint: new Map(Object.entries(taint).map(([thread, ids]) => [thread, new Set(ids)])) };
}

/** The same rule at thread scope (the helpers below build message-scoped rules). */
export const inThread = (rule: PolicyRule): PolicyRule => ({ ...rule, scope: 'thread' });

export const domainRule = (id: string, ...domains: string[]): PolicyRule => ({
  id,
  category: 'never_read',
  scope: 'message',
  kind: 'participant_domain',
  domains,
});

export const addressRule = (id: string, ...addresses: string[]): PolicyRule => ({
  id,
  category: 'hr',
  scope: 'message',
  kind: 'participant_address',
  addresses,
});

export const markerRule = (id: string, header: 'sensitivity' | 'msip_labels', contains: string): PolicyRule => ({
  id,
  category: 'confidential',
  scope: 'message',
  kind: 'header_marker',
  header,
  contains,
});

export const labelRule = (id: string, ...names: string[]): PolicyRule => ({
  id,
  category: 'privileged',
  scope: 'message',
  kind: 'label',
  names,
});

export const classificationRule = (id: string, labelId: string, fieldId?: string, selectionId?: string): PolicyRule => ({
  id,
  category: 'confidential',
  scope: 'message',
  kind: 'classification',
  labelId,
  ...(fieldId !== undefined ? { fieldId } : {}),
  ...(selectionId !== undefined ? { selectionId } : {}),
});
