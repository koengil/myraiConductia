export class IgnatiousClientError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.name = 'IgnatiousClientError';
    this.status = status;
    this.detail = detail;
  }
}

export const SKILL_SERVICE_UNAVAILABLE_MESSAGE = 'The skill service is not responding.';

export const SKILL_SERVICE_UNCONFIGURED_MESSAGE =
  'Agent skills are not available on this environment.';

export const RUN_UNAVAILABLE_MESSAGE =
  'The run stopped. The skill service is not responding. Nothing was filed on this step.';

export const RUN_FORBIDDEN_MESSAGE = 'You do not have access to run this skill on this deal.';

export const RUN_UNWIRED_MESSAGE = 'A draft is not available for this step yet.';

export const RUN_FAILED_MESSAGE =
  'The run stopped before it finished. Nothing was filed on this step.';

export const SKILL_LIBRARY_UNAVAILABLE_MESSAGE =
  'The skill library is unavailable. Skills cannot be listed or run until it is back.';

export const SKILL_LIBRARY_FORBIDDEN_MESSAGE = 'You do not have access to the skill library.';

export const CATALOG_VERSION_PRUNED_MESSAGE =
  'This catalog version no longer keeps its bytes.';

export const CATALOG_VERSION_UNRECOVERABLE_MESSAGE =
  'This catalog version shipped with a deployment that is gone, so its bytes are not here.';

export function benchErrorCodeMessage(code: unknown): string | null {
  if (code === 'version_pruned') return CATALOG_VERSION_PRUNED_MESSAGE;
  if (code === 'version_not_recoverable') return CATALOG_VERSION_UNRECOVERABLE_MESSAGE;
  return null;
}

function statusOf(error: unknown): number {
  return error instanceof IgnatiousClientError ? error.status : 0;
}

export function runFailureMessage(error: unknown): string {
  if (error instanceof IgnatiousClientError && error.detail !== null) return error.detail;
  const status = statusOf(error);
  if (status === 401 || status === 403) return RUN_FORBIDDEN_MESSAGE;
  if (status === 404) return RUN_UNWIRED_MESSAGE;
  if (status === 0 || status >= 500) return RUN_UNAVAILABLE_MESSAGE;
  return RUN_FAILED_MESSAGE;
}

export function skillRunFailureMessage(error: unknown): string {
  if (error instanceof IgnatiousClientError) return runFailureMessage(error);
  return RUN_FAILED_MESSAGE;
}

export function skillLibraryFailureMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 401 || status === 403) return SKILL_LIBRARY_FORBIDDEN_MESSAGE;
  return SKILL_LIBRARY_UNAVAILABLE_MESSAGE;
}
