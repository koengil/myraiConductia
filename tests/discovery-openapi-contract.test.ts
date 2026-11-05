// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAILBOX_READING_REASONS,
  TEAM_MAILBOX_AUDIT_VIEWS,
  TEAM_MAILBOX_CHECK_REASONS,
  TEAM_MAILBOX_CHECK_STATUSES,
} from '@/lib/constants/discovery';

/**
 * The discovery consent, site and health contract as openapi/phase1.json and docs/03-engineering/api-v1.md state it
 * (#262). The responses come from SQL functions (mailbox_consent_status, mailbox_consent_grant, site_register,
 * discovery_site_registrations, discovery_ingestion_health), so nothing else would notice a description that still
 * promises the behaviour an earlier revision had.
 */

type Json = Record<string, unknown>;
const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi/phase1.json'), 'utf8')) as {
  paths: Record<string, Record<string, { description?: string }>>;
  components: { schemas: Record<string, Json> };
};
const docs = readFileSync(join(process.cwd(), 'docs/03-engineering/api-v1.md'), 'utf8');

const description = (path: string, verb: string): string => spec.paths[path]?.[verb]?.description ?? '';
const docsRow = (verb: string, path: string): string =>
  docs.split('\n').find((line) => line.startsWith(`| ${verb} | \`${path}\``)) ?? '';

describe('MailboxConsentStatus', () => {
  const schema = spec.components.schemas.MailboxConsentStatus as {
    required: string[];
    properties: Record<string, { type?: unknown; enum?: unknown[]; description?: string }>;
  };

  it('carries the readiness the card reads, with the reasons the SQL and the TS mirror share', () => {
    expect(schema.required).toEqual(expect.arrayContaining(['eligible', 'consented', 'reading']));
    expect(schema.properties.reading?.type).toBe('boolean');
    expect(schema.properties.readingReason?.enum).toEqual([...MAILBOX_READING_REASONS, null]);
  });

  it('says what reading means: database eligibility, not a promise of a pass, and consent alone is not reading', () => {
    const reading = schema.properties.reading?.description ?? '';
    expect(reading).toMatch(/Database eligibility/);
    expect(reading).toMatch(/exactly when the guard allows/);
    expect(reading).toMatch(/owned by the caller/);
    expect(reading).toMatch(/active/);
    expect(reading).toMatch(/does not say a pass has run or will run/);
    expect(reading).toMatch(/Consent alone is not reading/);
    expect(reading).not.toMatch(/next pass/);
    expect(description('/discovery/mailbox-consent', 'get')).toMatch(/database eligibility/);
    expect(description('/discovery/mailbox-consent', 'get')).not.toMatch(/on the next pass/);
  });

  it('gives readingReason in the guard\'s vocabulary, with the three member-facing reasons named as such', () => {
    const reason = schema.properties.readingReason?.description ?? '';
    for (const guardReason of ['no_source', 'no_consent', 'owner_mismatch', 'source_paused', 'registration_inactive']) {
      expect(schema.properties.readingReason?.enum, guardReason).toContain(guardReason);
      expect(reason, guardReason).toContain(guardReason);
    }
    for (const retired of ['multi_provider', 'no_owner', 'other_owner', 'paused', 'provider']) {
      expect(schema.properties.readingReason?.enum, retired).not.toContain(retired);
    }
    expect(reason).toMatch(/guard's own reason, in the guard's order/);
    expect(reason).toMatch(/describe the member and not the address/);
  });

  it('no longer says consented holds whatever the eligibility', () => {
    const get = description('/discovery/mailbox-consent', 'get');
    expect(get).not.toContain('whatever their eligibility');
    expect(get).toContain('staleConsent');
    expect(get).toContain('reading');
    expect(get).toContain('readingReason');
    expect(get).toMatch(/not reported as consented|is not consented/);
  });

  it('describes the opt-in adopting an ownerless source', () => {
    const post = description('/discovery/mailbox-consent', 'post');
    expect(post).toContain('sourceAdopted');
    expect(post).toMatch(/no owner/);
    expect(post).toContain('reading');
  });

  it('qualifies the takeover: only an ownerless source with no stored items, never one that holds items (audit round 4)', () => {
    const post = description('/discovery/mailbox-consent', 'post');
    // The unqualified statement that an ownerless row "is adopted" contradicted the archive rule below it.
    expect(post).not.toMatch(/with no owner is adopted/);
    expect(post).not.toMatch(/\bis adopted\b/);
    expect(post).toMatch(/no owner and no stored items is taken over, not archived/);
    expect(post).toMatch(/with no owner that still holds stored items is not adopted but archived/);
    expect(post).toMatch(/fresh active source[^.]*on the archived row's provider while a registration of that provider may still read the address/);
    expect(post).toMatch(/the guard's last refusal for the address is forgotten/);
  });
});

describe('site registrations', () => {
  it('list a stale flag, and say registering replaces a stale row', () => {
    const items = (spec.components.schemas.SiteRegistrationList as { properties: { sites: { items: { properties: Json; required: string[] } } } })
      .properties.sites.items;
    expect(items.properties).toHaveProperty('stale');
    expect(items.required).toContain('stale');
    expect(description('/discovery/sites', 'get')).toContain('stale');
    expect(description('/discovery/sites', 'post')).toMatch(/replaces|replaced/);
  });
});

describe('archived mailbox sources (audit round 3, H1)', () => {
  it('says the opt-in archives an ownerless source that holds items, and how a firm admin merges it', () => {
    const post = description('/discovery/mailbox-consent', 'post');
    expect(post).toContain('archivedSourceId');
    expect(post).toMatch(/archived/);
    expect(post).toContain('/discovery/mailbox-sources/unify');
    const unify = description('/discovery/mailbox-sources/unify', 'post');
    expect(unify).toContain('firm admin');
    expect(unify).toContain('unify_already_unified');
    expect(unify).toContain('discovery.mailbox_sources_unified');
    expect(unify).toMatch(/target must be active, on the archived row's provider/);
    expect(unify).toMatch(/RPC checks deal_discovery itself/);
    expect(unify).toMatch(/routing_ledger rows/);
    const unifyResponses = (spec.paths['/discovery/mailbox-sources/unify']?.post as { responses: Record<string, { description: string }> })
      .responses;
    expect(unifyResponses['409'].description).toContain('unify_target_not_active');
    expect(unifyResponses['409'].description).toContain('unify_provider_mismatch');
    expect(unifyResponses['404'].description).toMatch(/again by the RPC/);
    const result = spec.components.schemas.MailboxSourceUnifyResult as { required: string[] };
    expect(result.required).toEqual(
      expect.arrayContaining(['archivedSourceId', 'targetSourceId', 'moved', 'alreadyLinked', 'candidatesRefreshed']),
    );
    const responses = (spec.paths['/discovery/mailbox-sources/unify']?.post as { responses?: Record<string, unknown> }).responses ?? {};
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400', '401', '403', '404', '409', '500']));
  });

  it('is in docs/03-engineering/api-v1.md', () => {
    const row = docsRow('POST', '/discovery/mailbox-sources/unify');
    expect(row).toContain('discovery_unify_mailbox_sources()');
    expect(row).toContain('unify_already_unified');
    expect(docsRow('POST', '/discovery/mailbox-consent')).toContain('adopts');
    expect(docs).toContain('`archivedSourceId`');
  });
});

describe('the one-click opt-in (A2)', () => {
  const schema = spec.components.schemas.MailboxConsentStatus as {
    properties: Record<string, { enum?: unknown[]; description?: string }>;
  };

  it('says the opt-in needs MD or deal team on a deal, and that the firm admins are told', () => {
    const post = description('/discovery/mailbox-consent', 'post');
    expect(post).toMatch(/MD or deal team on at least one deal/);
    expect(post).toContain('not_on_a_deal');
    expect(post).toContain('mailbox_connected');
    expect(post).toMatch(/firm admin of the tenant and the CCO seated in the bank's own firm/);
    expect(post).toMatch(/and the archived source too when there was one/);
    expect(post).toMatch(/clears its checkpoint/);
    expect(JSON.stringify(spec.paths['/discovery/mailbox-consent']?.post)).toContain('or not MD or deal team on any deal');
  });

  it('lists not_on_a_deal as a reason on both fields, and says it is a grant-time check', () => {
    expect(schema.properties.reason?.enum).toContain('not_on_a_deal');
    expect(schema.properties.readingReason?.description).toMatch(/not_on_a_deal: no open consent/);
    expect(schema.properties.readingReason?.description).toMatch(/grant-time precondition/);
  });

  it('is documented beside the other mailbox paragraphs', () => {
    expect(docs).toContain('One click needs a deal');
    expect(docs).toContain('`mailbox_connected`');
  });
});

describe('ingestion health', () => {
  it('answers an admin or CCO of a tenant whose registration names no firm with the empty shape, not 404', () => {
    const health = description('/discovery/health', 'get');
    expect(health).not.toMatch(/tenant whose registration names no firm all get the same 404/);
    expect(health).toMatch(/names no firm[^.]*registration: null/);
  });

  it("lists each source's ingestion window and its lock (#353)", () => {
    const health = description('/discovery/health', 'get');
    expect(health).toContain('backfillSince');
    expect(health).toMatch(/always null for a Microsoft source/);
    expect(health).toContain('windowLocked');
  });
});

describe('deal email (Deal Folder view)', () => {
  const path = '/discovery/deal-email';
  const item = spec.components.schemas.DealEmailItem as {
    required: string[];
    properties: Record<string, { type?: unknown }>;
  };

  it('is a GET behind deal_discovery that takes the deal code', () => {
    const get = spec.paths[path]?.get as { parameters?: Array<{ name: string; in: string; required: boolean }>; responses: Record<string, unknown> } | undefined;
    expect(get).toBeDefined();
    expect(get?.parameters).toEqual([expect.objectContaining({ name: 'deal', in: 'query', required: true })]);
    expect(Object.keys(get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '401', '404', '500']));
    expect(spec.paths[path]).not.toHaveProperty('post');
  });

  it('promises server-side redaction, RLS only, no body, and no existence oracle', () => {
    const text = description(path, 'get');
    expect(text).toMatch(/requireApiUserScoped/);
    expect(text).toMatch(/redacted on the server/);
    expect(text).toMatch(/No message body is read or returned/);
    expect(text).toMatch(/no existence oracle/);
  });

  it('types the item with the redactable fields nullable and no body', () => {
    expect(item.required).toEqual(['sourceItemId', 'sentDay', 'fromDomain', 'sender', 'subject', 'own', 'opensThread']);
    for (const field of ['sentDay', 'fromDomain', 'sender', 'subject']) {
      expect(item.properties[field]?.type, field).toEqual(['string', 'null']);
    }
    expect(item.properties.own?.type).toBe('boolean');
    expect(item.properties.opensThread?.type).toBe('boolean');
    expect(item.properties).not.toHaveProperty('body');
    expect(item.properties).not.toHaveProperty('bodyText');
  });
});

describe('deal thread (Deal email view, #339)', () => {
  const path = '/discovery/deal-email/thread';
  const message = spec.components.schemas.DealThreadMessage as { required: string[] };

  it('is a GET behind deal_discovery that takes the deal code and the item', () => {
    const get = spec.paths[path]?.get as { parameters?: Array<{ name: string; in: string; required: boolean }>; responses: Record<string, unknown> } | undefined;
    expect(get).toBeDefined();
    expect(get?.parameters).toEqual([
      expect.objectContaining({ name: 'deal', in: 'query', required: true }),
      expect.objectContaining({ name: 'item', in: 'query', required: true }),
    ]);
    expect(Object.keys(get?.responses ?? {}).sort()).toEqual(['200', '400', '401', '403', '404', '500']);
  });

  it("promises RLS only, the caller's own mail only, and no existence oracle, in the spec and the docs", () => {
    for (const text of [description(path, 'get'), docsRow('GET', path)]) {
      expect(text).toMatch(/own/);
      expect(text).toContain('discovery_item_metadata');
      expect(text).toContain('source_item_texts');
      expect(text).toMatch(/same `?404`?/);
    }
    expect(description(path, 'get')).toMatch(/requireApiUserScoped/);
  });

  it('returns the signed reply token beside the messages', () => {
    const thread = spec.components.schemas.DealThread as { required: string[] };
    expect(thread.required).toEqual(['conversationId', 'messages', 'replyToken']);
  });

  it('types every field a reply needs', () => {
    expect(message.required).toEqual(['sourceItemId', 'sentAt', 'from', 'to', 'cc', 'subject', 'body', 'internetMessageId', 'fromSelf']);
  });
});

describe('team inboxes (#581)', () => {
  const list = '/discovery/team-mailboxes';
  const one = '/discovery/team-mailboxes/{teamMailboxId}';
  const registration = spec.components.schemas.TeamMailboxRegistration as {
    required: string[];
    properties: Record<string, { enum?: unknown[] }>;
  };
  const extra = (spec.components.schemas.TeamMailbox as { allOf: Array<{ required?: string[] }> }).allOf[1];
  const statuses = (path: string, verb: string): string[] =>
    Object.keys((spec.paths[path]?.[verb] as { responses?: Record<string, unknown> } | undefined)?.responses ?? {});

  it('has the three operations, each with the statuses the routes answer', () => {
    expect(Object.keys(spec.paths[list] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(spec.paths[one] ?? {})).toEqual(['delete']);
    expect(statuses(list, 'get')).toEqual(expect.arrayContaining(['200', '401', '403', '404', '500']));
    expect(statuses(list, 'post')).toEqual(
      expect.arrayContaining(['200', '201', '400', '401', '403', '404', '409', '422', '500']),
    );
    expect(statuses(one, 'delete')).toEqual(expect.arrayContaining(['204', '400', '401', '403', '404', '409', '500']));
  });

  it('names every refusal code the connect route answers', () => {
    const post = spec.paths[list]?.post as { responses: Record<string, { description: string }> };
    expect(post.responses['409'].description).toContain('person_address');
    for (const code of ['provider_unresolved', 'provider_unsupported', 'out_of_range', 'invalid_address', 'attestation_required']) {
      expect(post.responses['422'].description, code).toContain(code);
    }
    expect(post.responses['403'].description).toContain('not_eligible');
    expect(statuses(one, 'delete')).toContain('409');
    expect((spec.paths[one]?.delete as { responses: Record<string, { description: string }> }).responses['409'].description).toContain(
      'not_removable',
    );
  });

  it('shares the check vocabulary with the constants and the SQL CHECK', () => {
    expect(registration.properties.checkStatus?.enum).toEqual([...TEAM_MAILBOX_CHECK_STATUSES]);
    expect(registration.properties.checkReason?.enum).toEqual([...TEAM_MAILBOX_CHECK_REASONS, null]);
    expect(extra.required).toEqual(['lastCheckError', 'sourceStatus', 'removable', 'members', 'eligible']);
    const body = (spec.paths[list]?.post as { requestBody: { content: { 'application/json': { schema: { required: string[] } } } } })
      .requestBody.content['application/json'].schema;
    expect(body.required).toEqual(['address', 'attestationVersion']);
  });

  it('says the audit carries ids only, that Gmail is the only provider, and that DELETE is not flag-gated', () => {
    expect(description(list, 'post')).toMatch(/ids and the attestation version only \(never the address\)/);
    expect(description(list, 'post')).toMatch(/Gmail only/);
    expect(description(list, 'post')).toMatch(/nothing is read until the worker has checked the address/);
    expect(description(one, 'delete')).toMatch(/Not gated by deal_discovery/);
    expect(description(one, 'delete')).toMatch(/ids and the reason only/);
  });

  it('is in docs/03-engineering/api-v1.md', () => {
    expect(docsRow('GET', '/discovery/team-mailboxes')).toContain('discovery_team_mailboxes()');
    expect(docsRow('POST', '/discovery/team-mailboxes')).toContain('discovery_connect_team_mailbox()');
    expect(docsRow('POST', '/discovery/team-mailboxes')).toContain('person_address');
    expect(docsRow('DELETE', '/discovery/team-mailboxes/{teamMailboxId}')).toContain('not_removable');
  });

  describe('members (phase 8)', () => {
    const members = '/discovery/team-mailboxes/{teamMailboxId}/members';
    const member = '/discovery/team-mailboxes/{teamMailboxId}/members/{userId}';
    const person = spec.components.schemas.TeamMailboxPerson as { required: string[]; properties: Record<string, unknown> };
    const entry = spec.components.schemas.TeamMailbox as {
      allOf: Array<{ properties?: Record<string, { type?: string; items?: { $ref?: string } }> }>;
    };

    it('has the two operations, each with the statuses the routes answer', () => {
      expect(Object.keys(spec.paths[members] ?? {})).toEqual(['post']);
      expect(Object.keys(spec.paths[member] ?? {})).toEqual(['delete']);
      expect(statuses(members, 'post')).toEqual(
        expect.arrayContaining(['200', '201', '400', '401', '403', '404', '422', '500']),
      );
      expect(statuses(member, 'delete')).toEqual(expect.arrayContaining(['204', '400', '401', '403', '404', '500']));
      expect(statuses(member, 'delete')).not.toContain('409');
      const post = spec.paths[members]?.post as { responses: Record<string, { description: string }> };
      expect(post.responses['422'].description).toContain('not_eligible_member');
    });

    it('types the member, the eligible person and the two new list fields', () => {
      expect(person.required).toEqual(['userId', 'name', 'email']);
      expect(Object.keys(person.properties)).not.toContain('address');
      const extraProperties = entry.allOf[1].properties ?? {};
      expect(extraProperties.members?.type).toBe('array');
      expect(extraProperties.members?.items?.$ref).toBe('#/components/schemas/TeamMailboxMember');
      expect(extraProperties.eligible?.type).toBe('array');
      expect(extraProperties.eligible?.items?.$ref).toBe('#/components/schemas/TeamMailboxPerson');
      const memberSchema = spec.components.schemas.TeamMailboxMember as { allOf: Array<{ required?: string[] }> };
      expect(memberSchema.allOf[1].required).toEqual(['addedAt']);
    });

    it('says what it audits, that adding is idempotent and takes the lock, and that DELETE is not flag-gated', () => {
      expect(description(members, 'post')).toMatch(/takes the tenant's discovery lock first/);
      expect(description(members, 'post')).toMatch(/audits discovery\.team_mailbox_member_added with ids only/);
      expect(description(members, 'post')).toMatch(/grants nothing by itself/);
      expect(description(members, 'post')).toMatch(/200 instead of 201/);
      expect(description(member, 'delete')).toMatch(/Not gated by deal_discovery/);
      expect(description(member, 'delete')).toMatch(/closed, never deleted/);
      expect(description(member, 'delete')).toMatch(/deal memberships are not touched/);
    });

    it('is in docs/03-engineering/api-v1.md', () => {
      expect(docsRow('POST', members)).toContain('discovery_add_team_mailbox_member()');
      expect(docsRow('POST', members)).toContain('not_eligible_member');
      expect(docsRow('DELETE', member)).toContain('discovery_remove_team_mailbox_member()');
      expect(docsRow('DELETE', member)).toContain('seat_lost');
      expect(docsRow('GET', '/discovery/team-mailboxes')).toContain('members, eligible');
    });
  });
});

describe('PUT /discovery/sources/{sourceId}/window (#353)', () => {
  const put = spec.paths['/discovery/sources/{sourceId}/window']?.put as
    | {
        requestBody?: { content: { 'application/json': { schema: { required: string[]; properties: Record<string, { format?: string }> } } } };
        responses: Record<string, unknown>;
      }
    | undefined;

  it('types the body and every outcome the route answers', () => {
    expect(put).toBeDefined();
    const body = put!.requestBody!.content['application/json'].schema;
    expect(body.required).toEqual(['since']);
    expect(body.properties.since?.format).toBe('date');
    expect(Object.keys(put!.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '500']);
  });

  it('states the owner decision, the lock and the audit the same way in the spec and the docs', () => {
    const row = docsRow('PUT', '/discovery/sources/{sourceId}/window');
    for (const text of [description('/discovery/sources/{sourceId}/window', 'put'), row]) {
      expect(text).toContain('discovery_set_mailbox_source_window()');
      expect(text).toMatch(/730 days/);
      expect(text).toContain('window_locked');
      expect(text).toContain('window_set');
      expect(text).toContain('deal_discovery');
      expect(text).toMatch(/[Oo]nly before the first read/);
    }
  });
});

describe('docs/03-engineering/api-v1.md', () => {
  it('states the same contract', () => {
    const get = docsRow('GET', '/discovery/mailbox-consent');
    expect(get).toContain('reading');
    expect(get).toContain('readingReason');
    expect(get).not.toContain('whatever');
    const post = docsRow('POST', '/discovery/mailbox-consent');
    expect(post).toContain('adopt');
    expect(docsRow('GET', '/discovery/sites')).toContain('stale');
    expect(docsRow('GET', '/discovery/health')).not.toMatch(/tenant whose registration names no firm gets `404`/);
    for (const reason of MAILBOX_READING_REASONS) expect(docs, reason).toContain(`\`${reason}\``);
  });

  it('documents reading as database eligibility from one decision, and the stale site registrant', () => {
    expect(docs).toContain('`reading` is database eligibility, from one decision');
    expect(docs).toContain('`mailbox_guard_verdict()`');
    expect(docs).toContain('`source_paused`');
    expect(docs).toContain('`site_registrant_lost`');
    expect(docsRow('GET', '/discovery/mailbox-consent')).toContain('database eligibility');
    expect(docs).not.toContain('says "Reading starts on the next pass"');
  });
});

describe('the team inbox audit trail (#173 G-03)', () => {
  const path = '/discovery/team-mailboxes/audit';
  const get = spec.paths[path]?.get as
    | { parameters?: Array<{ name: string; in: string; required: boolean; schema: { enum?: unknown[] } }>; responses: Record<string, unknown> }
    | undefined;
  const row = spec.components.schemas.TeamMailboxAuditRow as { required: string[] };
  const page = spec.components.schemas.TeamMailboxAuditPage as { required: string[] };

  it('is a GET only, with the optional view, before and limit, and the statuses the route answers', () => {
    expect(Object.keys(spec.paths[path] ?? {})).toEqual(['get']);
    expect(get?.parameters?.map((p) => [p.name, p.in, p.required])).toEqual([
      ['view', 'query', false],
      ['before', 'query', false],
      ['limit', 'query', false],
    ]);
    expect(get?.parameters?.[0].schema.enum).toEqual([...TEAM_MAILBOX_AUDIT_VIEWS]);
    expect(Object.keys(get?.responses ?? {}).sort()).toEqual(['200', '400', '401', '403', '404', '500']);
  });

  it('types the page and the row the RPC returns', () => {
    expect(page.required).toEqual(['inboxes', 'rows', 'next']);
    expect(row.required).toEqual([
      'id',
      'ts',
      'action',
      'actorType',
      'actorName',
      'serviceIdentity',
      'subjectName',
      'inboxId',
      'detail',
    ]);
  });

  it('lists the AI passes and the capability switches, with their detail keys and never the decision reference (G-01)', () => {
    const action = (spec.components.schemas.TeamMailboxAuditRow as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(action).toEqual(
      expect.arrayContaining([
        'discovery.team_mailbox_proposal_started',
        'discovery.team_mailbox_proposal_finished',
        'discovery.tenant_approval_changed',
      ]),
    );
    const detail = spec.components.schemas.TeamMailboxAuditDetail as { properties: Record<string, { type?: unknown }> };
    for (const key of ['path', 'outcome', 'capability']) expect(detail.properties[key]?.type, key).toBe('string');
    for (const key of ['asked', 'deal', 'notDeal', 'invalid', 'failed']) expect(detail.properties[key]?.type, key).toBe('integer');
    expect(detail.properties.on?.type).toBe('boolean');
    for (const key of ['decisionRef', 'runId', 'passId', 'lastRenewedAt']) expect(detail.properties[key], key).toBeUndefined();
  });

  it('lists the rule detector passes with their two counts, never the run id (G-07 slice 5)', () => {
    const action = (spec.components.schemas.TeamMailboxAuditRow as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(action).toContain('discovery.team_mailbox_milestones_detected');
    const detail = spec.components.schemas.TeamMailboxAuditDetail as { properties: Record<string, { type?: unknown }> };
    for (const key of ['items', 'events']) expect(detail.properties[key]?.type, key).toBe('integer');
    expect(detail.properties.runId).toBeUndefined();
  });

  it('promises the session, the firm-company scope, no address in a row and one 404, in the spec and the docs', () => {
    for (const text of [description(path, 'get'), docsRow('GET', path)]) {
      expect(text).toContain('discovery_team_mailbox_audit()');
      expect(text).toContain('auth.uid()');
      expect(text).toMatch(/firm company/);
      expect(text).toMatch(/never an address/);
      expect(text).toMatch(/same `?404`? as when/);
    }
    expect(description(path, 'get')).toMatch(/requireApiUserScoped/);
  });
});
