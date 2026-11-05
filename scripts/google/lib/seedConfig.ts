import { readFileSync } from 'node:fs';

/** .secrets/google/seeding.json: test domains, seeding identities and the persona map. */
export type SeedingConfig = {
  testDomains: string[];
  seedingServiceAccountEmail: string;
  driveProbeServiceAccountEmail?: string;
  sharedDriveId?: string;
  /** Persona address (as the fixture and the reader see it) to the trial address that holds the copy. */
  personas: Record<string, string>;
};

export function parseSeedingConfig(raw: unknown): SeedingConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SeedingConfig>;
  const errors: string[] = [];
  if (!Array.isArray(r.testDomains) || r.testDomains.length === 0 || r.testDomains.some((d) => typeof d !== 'string')) {
    errors.push('testDomains must list at least one domain');
  }
  if (typeof r.seedingServiceAccountEmail !== 'string' || !r.seedingServiceAccountEmail.includes('@')) {
    errors.push('seedingServiceAccountEmail is required');
  }
  if (!r.personas || typeof r.personas !== 'object' || Object.keys(r.personas).length === 0) {
    errors.push('personas must map persona addresses to trial addresses');
  }
  if (errors.length > 0) throw new Error(`Invalid seeding.json: ${errors.join('; ')}`);
  return {
    testDomains: (r.testDomains as string[]).map((d) => d.toLowerCase()),
    seedingServiceAccountEmail: r.seedingServiceAccountEmail as string,
    driveProbeServiceAccountEmail: r.driveProbeServiceAccountEmail,
    sharedDriveId: r.sharedDriveId,
    personas: Object.fromEntries(
      Object.entries(r.personas as Record<string, string>).map(([persona, trial]) => [persona.toLowerCase(), trial.toLowerCase()]),
    ),
  };
}

export function loadSeedingConfig(path: string): SeedingConfig {
  return parseSeedingConfig(JSON.parse(readFileSync(path, 'utf8')));
}

/** The one domain every trial address belongs to. Refuses a mixed map. */
export function trialDomain(config: SeedingConfig): string {
  const domains = new Set(Object.values(config.personas).map((a) => a.split('@')[1]));
  if (domains.size !== 1) throw new Error('every trial address in seeding.json must share one domain');
  return [...domains][0];
}
