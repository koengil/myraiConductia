export const SETUP_WALKTHROUGH_CONTENT_VERSION = 1;

export const SETUP_WALKTHROUGH_TRACK = {
  USER: 'user',
  ADMINISTRATOR: 'administrator',
} as const;

export type SetupWalkthroughTrack =
  (typeof SETUP_WALKTHROUGH_TRACK)[keyof typeof SETUP_WALKTHROUGH_TRACK];

export type SetupWalkthroughStep = {
  id: string;
  title: string;
  summary: string;
  guidance: readonly string[];
};

export type SetupWalkthroughDefinition = {
  track: SetupWalkthroughTrack;
  title: string;
  description: string;
  steps: readonly SetupWalkthroughStep[];
};

export const SETUP_WALKTHROUGHS: Record<
  SetupWalkthroughTrack,
  SetupWalkthroughDefinition
> = {
  [SETUP_WALKTHROUGH_TRACK.USER]: {
    track: SETUP_WALKTHROUGH_TRACK.USER,
    title: 'User walkthrough',
    description: 'How Conductia protects deal information and screens communications.',
    steps: [
      {
        id: 'data_security',
        title: 'Work inside the access you were given',
        summary: 'Company, deal, room, classification, and phase boundaries are enforced server-side.',
        guidance: [
          'Use only the company and deal workspaces assigned to the account.',
          'Do not share passwords, verification codes, mailbox tokens, or downloaded deal material.',
          'Report unexpected access or an unexpected not-found response to an administrator.',
        ],
      },
      {
        id: 'data_room_boundaries',
        title: 'Respect data-room boundaries',
        summary: 'A document may be hidden by room, classification, or external-seat phase.',
        guidance: [
          'Internal Deal Folder material and external Data Room material are separate surfaces.',
          'Classification 4 and MNPI documents remain limited to authorized internal seats.',
          'A not-found response can be an intentional information wall, not a missing file.',
        ],
      },
      {
        id: 'communications_screening',
        title: 'Understand communications screening',
        summary: 'Messages are screened before release and may be sent, held, blocked, or rejected.',
        guidance: [
          'Sent means the message passed screening and was released through the configured channel.',
          'Held messages wait for an authorized reviewer and have not been delivered.',
          'Blocked and rejected messages never leave the platform unless edited and resubmitted.',
        ],
      },
    ],
  },
  [SETUP_WALKTHROUGH_TRACK.ADMINISTRATOR]: {
    track: SETUP_WALKTHROUGH_TRACK.ADMINISTRATOR,
    title: 'Administrator walkthrough',
    description: 'How to administer people and company authority without widening deal access.',
    steps: [
      {
        id: 'access_governance',
        title: 'Grant the minimum company authority',
        summary: 'Custom roles and direct grants are additive and limited by the administrator grant envelope.',
        guidance: [
          'Use custom roles for repeatable responsibility and direct grants only for narrow exceptions.',
          'Directors and firm administrators are protected roots and cannot receive custom assignments.',
          'Company permissions never grant deal seats, document access, workflow authority, or mail-review authority.',
        ],
      },
      {
        id: 'invitation_controls',
        title: 'Confirm the access on every invitation',
        summary: 'Recipient identity, company, role, and any deal seat must be confirmed before sending.',
        guidance: [
          'Company invitation permission is send-only and does not grant deal invitation authority.',
          'Research, trading, external, and protected-seat rules remain enforced independently.',
          'Use the access preview as the final check before releasing an invitation.',
        ],
      },
      {
        id: 'audit_accountability',
        title: 'Treat access changes as auditable decisions',
        summary: 'Role, permission, invitation, and walkthrough changes create durable audit evidence.',
        guidance: [
          'Review the source of effective access before adding or removing an assignment.',
          'A role grant can continue to provide authority after a direct grant is removed.',
          'Removing company membership does not suspend the account or change the employer\'s offboarding process.',
        ],
      },
    ],
  },
};

export const SETUP_WALKTHROUGH_TRACKS = Object.values(SETUP_WALKTHROUGH_TRACK);

export function isSetupWalkthroughTrack(value: unknown): value is SetupWalkthroughTrack {
  return SETUP_WALKTHROUGH_TRACKS.some((track) => track === value);
}

export function setupWalkthroughStepIds(track: SetupWalkthroughTrack): string[] {
  return SETUP_WALKTHROUGHS[track].steps.map((step) => step.id);
}

export function normalizeSetupWalkthroughSteps(
  track: SetupWalkthroughTrack,
  values: readonly string[],
): string[] | null {
  const selected = new Set(values);
  const valid = setupWalkthroughStepIds(track);
  if (selected.size !== values.length || [...selected].some((value) => !valid.includes(value))) {
    return null;
  }
  return valid.filter((value) => selected.has(value));
}
