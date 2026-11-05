import { parsePublicationRead } from "@/lib/skillPublication/clientResponse";
import {
  PUBLICATION_CONFLICT_CODES,
  type DuplicateDecisionCommand,
  type PlacementCommand,
  type PublicationConflictCode,
  type PublicationRead,
  type PublishCommand,
} from "@/lib/skillPublication/types";
import { body, init, path, type Fetcher } from "./httpClient";

export type PublicationClientErrorKind =
  "conflict" | "validation" | "forbidden" | "not_found" | "network" | "unknown";

export type PublicationCommandError = {
  kind: PublicationClientErrorKind;
  code: PublicationConflictCode | null;
};

export class SkillPublicationClientError extends Error {
  readonly kind: PublicationClientErrorKind;
  readonly code: PublicationConflictCode | null;

  constructor(
    kind: PublicationClientErrorKind,
    message: string,
    code: PublicationConflictCode | null = null,
  ) {
    super(message);
    this.name = "SkillPublicationClientError";
    this.kind = kind;
    this.code = code;
  }
}

export function toCommandError(error: unknown): PublicationCommandError {
  return error instanceof SkillPublicationClientError
    ? { kind: error.kind, code: error.code }
    : { kind: "unknown", code: null };
}

function conflictCode(value: unknown): PublicationConflictCode | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { error?: unknown }).error;
  return typeof candidate === "string" &&
    PUBLICATION_CONFLICT_CODES.includes(candidate as never)
    ? (candidate as PublicationConflictCode)
    : null;
}

function conflictFailure(value: unknown): SkillPublicationClientError {
  const code = conflictCode(value);
  return code
    ? new SkillPublicationClientError(
        "conflict",
        "Skill save conflict.",
        code,
      )
    : new SkillPublicationClientError(
        "unknown",
        "Unable to process the skill save request.",
      );
}

function failureFor(
  status: number,
  value: unknown,
): SkillPublicationClientError {
  if (status === 409) return conflictFailure(value);
  if (status === 422)
    return new SkillPublicationClientError(
      "validation",
      "Invalid skill save request.",
    );
  if (status === 403)
    return new SkillPublicationClientError("forbidden", "Not permitted.");
  if (status === 404)
    return new SkillPublicationClientError("not_found", "Not found.");
  return new SkillPublicationClientError(
    "unknown",
    "Unable to process the skill save request.",
  );
}

async function publicationRequest(
  fetcher: Fetcher,
  url: string,
  requestInit: RequestInit,
): Promise<PublicationRead> {
  let response: Response;
  try {
    response = await fetcher(url, requestInit);
  } catch {
    throw new SkillPublicationClientError("network", "Network error.");
  }
  const value = await body(response);
  if (!response.ok) throw failureFor(response.status, value);
  const parsed = parsePublicationRead(value);
  if (!parsed || parsed.available === false)
    throw new SkillPublicationClientError(
      "unknown",
      "Invalid skill save response.",
    );
  return parsed;
}

export type PublicationOperations = {
  publish: (
    dealId: string,
    draftId: string,
    command: PublishCommand,
  ) => Promise<PublicationRead>;
  decideDuplicate: (
    dealId: string,
    publicationId: string,
    command: DuplicateDecisionCommand,
  ) => Promise<PublicationRead>;
  replacePlacement: (
    dealId: string,
    publicationId: string,
    command: PlacementCommand,
  ) => Promise<PublicationRead>;
};

export function createPublicationOperations(
  fetcher: Fetcher,
): PublicationOperations {
  return {
    publish: (dealId: string, draftId: string, command: PublishCommand) =>
      publicationRequest(
        fetcher,
        path(dealId, "skill-drafts", draftId, "publish"),
        init("POST", command),
      ),
    decideDuplicate: (
      dealId: string,
      publicationId: string,
      command: DuplicateDecisionCommand,
    ) =>
      publicationRequest(
        fetcher,
        path(dealId, "skill-publications", publicationId, "duplicate-decision"),
        init("POST", command),
      ),
    replacePlacement: (
      dealId: string,
      publicationId: string,
      command: PlacementCommand,
    ) =>
      publicationRequest(
        fetcher,
        path(dealId, "skill-publications", publicationId, "placement"),
        init("POST", command),
      ),
  };
}
