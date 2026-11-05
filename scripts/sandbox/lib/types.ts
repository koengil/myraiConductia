export type FixtureOrg = {
  name: string;
  short: string;
  kind: string;
  /** Verified mail domain for this org (a subdomain of fixture.domain, never the bare parent). */
  domain: string;
  tenant_under_test?: boolean;
  external?: boolean;
};

export type FixtureCastMember = {
  id: string;
  email: string;
  display_name: string;
  org: string;
  role: string;
  seniority: string;
  tone: string;
  behaviours: string[];
  mistakes: string[];
  visibility: { sees: string[]; walled_off: string[]; oversight?: boolean };
  signature: string;
};

export type FixtureTimelineEvent = {
  day: number;
  event: string;
  desc: string;
};

export type FixtureTrigger = {
  id: string;
  type: string;
  actor: string | string[];
  desc: string;
  expected: string;
};

export type FixtureDeal = {
  code: string;
  type: string;
  stage: string;
  target: string;
  buyer: string;
  client: string;
  cast: Record<string, { side: string; role: string }>;
  timeline: FixtureTimelineEvent[];
  attachments: string[];
  triggers: FixtureTrigger[];
  walled_off?: string[];
  demo_safe?: boolean;
};

export type SandboxFixture = {
  version: number;
  domain: string;
  run_start: string;
  admin: { email: string; name: string; role: string; in_cast: boolean };
  orgs: Record<string, FixtureOrg>;
  cast: FixtureCastMember[];
  deals: FixtureDeal[];
};

export type Address = { name?: string; address: string };

export type SandboxAttachment = {
  filename: string;
  contentType: string;
  content: Uint8Array;
};

export type SandboxMessage = {
  /** Stable scripted id (deal-scoped). */
  key: string;
  dealCode: string;
  dayOffset: number;
  date: Date;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  html?: string;
  attachments: SandboxAttachment[];
  inReplyTo?: string;
  references?: string[];
  /** Logical thread id for generation (maps to Gmail threadId on send). */
  threadKey: string;
  messageId: string;
  customHeaders: Record<string, string>;
  triggerId?: string;
  expectedOutcome?: string;
  tags: string[];
  kind: 'timeline' | 'filler' | 'trigger';
};

export type ManifestEntry = {
  key: string;
  deal: string;
  triggerId?: string;
  expected?: string;
  tags: string[];
  subject: string;
  from: string;
  to: string[];
  messageId: string;
  threadKey: string;
  attachmentNames: string[];
};

export type GenerationPlan = {
  messages: SandboxMessage[];
  manifest: ManifestEntry[];
};
