import type { DestinationId } from './access';

/** The one declaration of what each destination is called.
 *
 *  Before this module the titles lived in three places: the shell rail
 *  (`AppNav`), the per-deal nav registry (`perDealNav`), and a partial copy
 *  inside the invite perimeter preview that covered three of the ten ids and
 *  printed the raw identifier for the rest. The registries had already drifted
 *  apart from each other on two rows. A single total map is the fix: the
 *  preview cannot print an id, and the two shells cannot disagree.
 *
 *  `Record<DestinationId, string>` is total by construction, so a new
 *  destination fails `tsc --noEmit` here rather than silently leaking its
 *  camelCase id into an invitation. */
export const DESTINATION_TITLES: Record<DestinationId, string> = {
  mandate: 'Dashboard',
  chat: 'Chat',
  rail: 'Rails',
  acquirers: 'Acquirers',
  team: 'Team',
  mail: 'Mail',
  dealFolder: 'Deal Folder',
  dataRoom: 'Data Room',
  skills: 'Skills',
  audit: 'Audit Trail',
};
