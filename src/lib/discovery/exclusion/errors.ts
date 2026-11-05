// What a pass throws when the tenant has no usable exclusion policy (#263, R5).
// Neither carries rule content: worker/sync.ts maps them by name to fixed
// last_error codes, which the admin reads in ingestion health.

/** A live tenant with no policy version. Connecting a bank needs one audited write, even an empty one. */
export class NoExclusionPolicyError extends Error {
  constructor() {
    super('discovery: the tenant has no exclusion policy');
    this.name = 'NoExclusionPolicyError';
  }
}

/** The tenant's current policy version fails validation, so nothing is read under it. */
export class InvalidExclusionPolicyError extends Error {
  constructor() {
    super('discovery: the current exclusion policy is invalid');
    this.name = 'InvalidExclusionPolicyError';
  }
}

/** A provider whose reader cannot enforce a non-empty policy yet (Microsoft, until #272) refuses to read under one. */
export class ExclusionNotEnforcedError extends Error {
  constructor(provider: string) {
    super(`Exclusion policy is not enforced on ${provider} yet (#272)`);
    this.name = 'ExclusionNotEnforcedError';
  }
}
