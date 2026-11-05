import { SkillAuthoringHttpError, type SkillAuthoringClient } from '@/lib/skillAuthoring/client';
import {
  SkillPublicationClientError,
  type PublicationOperations,
} from '@/lib/skillAuthoring/publicationClient';
import type { DraftRead, Placement } from '@/lib/skillAuthoring/types';
import type { PublicationRead } from '@/lib/skillPublication/types';

function draftPath(templateId: string, ...rest: string[]): string {
  const tail = rest.map(encodeURIComponent).join('/');
  return `/api/v1/rail-catalog/${encodeURIComponent(templateId)}/skill-drafts${tail ? `/${tail}` : ''}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function draftFrom(value: unknown): DraftRead | null {
  if (!value || typeof value !== 'object') return null;
  const draft = (value as { draft?: unknown }).draft;
  return draft && typeof draft === 'object' && 'id' in draft ? (draft as DraftRead) : null;
}

async function requestDraft(url: string, init?: RequestInit): Promise<DraftRead> {
  const response = await fetch(url, init);
  const value = await readJson(response);
  const draft = draftFrom(value);
  if (!response.ok) {
    const error = value as { error?: unknown } | null;
    throw new SkillAuthoringHttpError(
      response.status,
      typeof error?.error === 'string' ? error.error : 'Unable to process skill authoring request.',
      draft,
    );
  }
  if (!draft) throw new SkillAuthoringHttpError(500, 'Invalid skill authoring response.', null);
  return draft;
}

export function createTemplateSkillAuthoringClient(
  templateId: string,
  placement: Placement,
): { drafts: SkillAuthoringClient; publication: PublicationOperations } {
  return {
    drafts: {
      open: async () => {
        const response = await fetch(draftPath(templateId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ placement }),
        });
        const value = await readJson(response);
        const draft = draftFrom(value);
        if (!response.ok || !draft) {
          throw new SkillAuthoringHttpError(response.status, 'Unable to open the skill builder.', draft);
        }
        return { draft, basis: null, seedRunId: null };
      },
      read: (_projectId, draftId) => requestDraft(draftPath(templateId, draftId)),
      patch: (_projectId, draftId, body) =>
        requestDraft(draftPath(templateId, draftId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      send: async (_projectId, draftId, body) => {
        const response = await fetch(draftPath(templateId, draftId, 'messages'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const value = await readJson(response);
        if (!response.ok) {
          throw new SkillAuthoringHttpError(response.status, 'Unable to send that message.', draftFrom(value));
        }
        return value;
      },
      retry: async (_projectId, draftId, messageId, body) => {
        const response = await fetch(draftPath(templateId, draftId, 'messages', messageId, 'retry'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new SkillAuthoringHttpError(response.status, 'Unable to retry that message.', null);
        return readJson(response);
      },
      discard: async (_projectId, draftId, expectedEditRevision) => {
        const response = await fetch(draftPath(templateId, draftId, 'discard'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedEditRevision }),
        });
        if (!response.ok) throw new SkillAuthoringHttpError(response.status, 'Unable to discard the draft.', null);
      },
    },
    publication: {
      publish: async (_projectId, draftId, command) => {
        const response = await fetch(draftPath(templateId, draftId, 'publish'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(command),
        });
        const value = (await readJson(response)) as { stepId?: unknown; digest?: unknown; error?: unknown } | null;
        if (!response.ok || typeof value?.stepId !== 'string' || typeof value.digest !== 'string') {
          throw new SkillPublicationClientError('unknown', typeof value?.error === 'string' ? value.error : 'Could not add the step.');
        }
        const published: PublicationRead = {
          available: true,
          id: value.stepId,
          state: 'published',
          revision: 1,
          matches: [],
          error: null,
          result: {
            stepId: value.stepId,
            skillBinding: { skillId: value.stepId, versionId: value.stepId, digest: value.digest },
          },
          assessmentDigest: null,
        };
        return published;
      },
      decideDuplicate: async () => {
        throw new SkillPublicationClientError('unknown', 'Could not add the step.');
      },
      replacePlacement: async () => {
        throw new SkillPublicationClientError('unknown', 'Could not add the step.');
      },
    },
  };
}
