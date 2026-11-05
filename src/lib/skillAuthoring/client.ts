import type { SkillReference } from "@/lib/skillRun/types";
import type { DraftRead } from "./types";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class SkillAuthoringHttpError extends Error {
  readonly status: number;
  readonly draft: DraftRead | null;

  constructor(status: number, message: string, draft: DraftRead | null) {
    super(message);
    this.name = "SkillAuthoringHttpError";
    this.status = status;
    this.draft = draft;
  }
}

export type DraftFields = Partial<
  Pick<DraftRead, "name" | "placement" | "composerText">
>;

export type DraftBasisRequest = {
  basisStepId?: string;
  seedRunId?: string;
  teach?: boolean;
};

export type DraftOpen = {
  draft: DraftRead;
  basis: SkillReference | null;
  seedRunId: string | null;
};

export type SkillAuthoringClient = {
  open(projectId: string, basis?: DraftBasisRequest): Promise<DraftOpen>;
  read(projectId: string, draftId: string): Promise<DraftRead>;
  patch(
    projectId: string,
    draftId: string,
    body: { expectedEditRevision: number } & DraftFields,
  ): Promise<DraftRead>;
  send(
    projectId: string,
    draftId: string,
    body: {
      clientMessageId: string;
      expectedEditRevision: number;
      text: string;
    },
  ): Promise<unknown>;
  retry(
    projectId: string,
    draftId: string,
    messageId: string,
    body: { retryRequestId: string },
  ): Promise<unknown>;
  discard(
    projectId: string,
    draftId: string,
    expectedEditRevision: number,
  ): Promise<void>;
};

function path(...parts: string[]): string {
  return `/api/v1/deals/${parts.map(encodeURIComponent).join("/")}`;
}

function init(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
}

function isDraftRead(value: unknown): value is DraftRead {
  return !!value && typeof value === "object" && "id" in value;
}

function draftFromBody(value: unknown): DraftRead | null {
  if (!value || typeof value !== "object") return null;
  const draft = (value as { draft?: unknown }).draft;
  return isDraftRead(draft) ? draft : null;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request(
  fetcher: Fetcher,
  url: string,
  requestInit: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, requestInit);
  const value = await readBody(response);
  if (response.ok) return value;
  const error = value as { error?: unknown } | null;
  throw new SkillAuthoringHttpError(
    response.status,
    typeof error?.error === "string"
      ? error.error
      : "Unable to process skill authoring request.",
    draftFromBody(error),
  );
}

function openBody(basis: DraftBasisRequest | undefined): Record<string, string | boolean> {
  return {
    ...(basis?.basisStepId ? { basisStepId: basis.basisStepId } : {}),
    ...(basis?.seedRunId ? { seedRunId: basis.seedRunId } : {}),
    ...(basis?.teach ? { teach: true } : {}),
  };
}

function referenceFromBody(value: unknown): SkillReference | null {
  if (!value || typeof value !== "object") return null;
  const basis = (value as { basis?: unknown }).basis;
  if (!basis || typeof basis !== "object") return null;
  const kind = (basis as { kind?: unknown }).kind;
  return kind === "publication" || kind === "mount"
    ? (basis as SkillReference)
    : null;
}

function seedRunIdFromBody(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const seedRunId = (value as { seedRunId?: unknown }).seedRunId;
  return typeof seedRunId === "string" ? seedRunId : null;
}

async function requestDraft(
  fetcher: Fetcher,
  url: string,
  requestInit: RequestInit,
): Promise<DraftRead> {
  const value = await request(fetcher, url, requestInit);
  const draft = draftFromBody(value);
  if (!draft)
    throw new SkillAuthoringHttpError(
      500,
      "Invalid skill authoring response.",
      null,
    );
  return draft;
}

export function createSkillAuthoringClient(
  fetcher: Fetcher = fetch,
): SkillAuthoringClient {
  return {
    open: async (projectId, basis) => {
      const value = await request(
        fetcher,
        path(projectId, "skill-drafts"),
        init("POST", openBody(basis)),
      );
      const draft = draftFromBody(value);
      if (!draft)
        throw new SkillAuthoringHttpError(
          500,
          "Invalid skill authoring response.",
          null,
        );
      return {
        draft,
        basis: referenceFromBody(value),
        seedRunId: seedRunIdFromBody(value),
      };
    },
    read: (projectId, draftId) =>
      requestDraft(
        fetcher,
        path(projectId, "skill-drafts", draftId),
        init("GET"),
      ),
    patch: (projectId, draftId, body) =>
      requestDraft(
        fetcher,
        path(projectId, "skill-drafts", draftId),
        init("PATCH", body),
      ),
    send: (projectId, draftId, body) =>
      request(
        fetcher,
        path(projectId, "skill-drafts", draftId, "messages"),
        init("POST", body),
      ),
    retry: (projectId, draftId, messageId, body) =>
      request(
        fetcher,
        path(
          projectId,
          "skill-drafts",
          draftId,
          "messages",
          messageId,
          "retry",
        ),
        init("POST", body),
      ),
    discard: async (projectId, draftId, expectedEditRevision) => {
      await request(
        fetcher,
        path(projectId, "skill-drafts", draftId, "discard"),
        init("POST", { expectedEditRevision }),
      );
    },
  };
}
