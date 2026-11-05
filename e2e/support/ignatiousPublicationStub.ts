import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';

export type StubDuplicateClassification = 'exact' | 'equivalent' | 'similar';

export type StubDuplicateReasonCode =
  | 'identity_match'
  | 'name_match'
  | 'contract_match'
  | 'capability_equivalent'
  | 'capability_similar';

export type StubMatchDirective = {
  targetIndex: number;
  classification: StubDuplicateClassification;
  reasonCode: StubDuplicateReasonCode;
  confidence: number;
};

export type StubFailure =
  | { kind: 'status'; status: number; error?: string }
  | { kind: 'malformed' }
  | { kind: 'hang' };

export type StubProgram = {
  prepare?: { matches?: StubMatchDirective[]; failure?: StubFailure };
  publish?: { failure?: StubFailure };
  lookup?: { status?: 'not_published' | 'prepared' | 'published' };
  retain?: { failure?: StubFailure };
  imports?: { failure?: StubFailure; commitThenDisconnect?: boolean };
};

export type StubRailSkill = {
  key: string;
  source: {
    kind: string;
    skillId?: string;
    versionId?: string;
    name?: string;
    version?: number;
    digest?: string;
  };
};

export type StubRailTarget = {
  key: string;
  operationId: string;
  skillId: string;
  versionId: string;
};

export type CapturedRailCall =
  | {
      seq: number;
      kind: 'retain';
      revisionId: string;
      companyId: string;
      sourceProjectId: string;
      skills: StubRailSkill[];
      authorization: string | null;
    }
  | {
      seq: number;
      kind: 'import';
      requestId: string;
      companyId: string;
      revisionId: string;
      projectId: string;
      targets: StubRailTarget[];
      authorization: string | null;
    };

export const FIELDS_SKILL = {
  skillId: '6a1c0f3e-2b4d-4e5f-9a8b-7c6d5e4f3a2b',
  versionId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  digest: 'b'.repeat(64),
};
export const FIELDS_SKILL_INPUTS = [
  { name: 'asOf', type: 'date', label: 'As of', required: true },
  { name: 'audience', type: 'enum', label: 'Audience', values: ['Board', 'Buyer'], default: 'Board' },
];

export type CapturedCall = {
  seq: number;
  method: string;
  path: string;
  operationId: string;
  authorization: string | null;
  correlationId: string | null;
  body: unknown;
  receivedAt: string;
};

const DIGEST_ALPHABET = '0123456789abcdef';

function digestFrom(seed: string): string {
  let value = 0;
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 31 + seed.charCodeAt(index)) % 0xffffffff;
  }
  let digest = '';
  for (let index = 0; index < 64; index += 1) {
    value = (value * 1103515245 + 12345) % 0xffffffff;
    digest += DIGEST_ALPHABET[value % 16];
  }
  return digest;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function header(request: http.IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

type PreparePayload = {
  candidateDigest?: unknown;
  capabilityContract?: unknown;
  comparisonSetDigest?: unknown;
  targets?: unknown;
  projectId?: unknown;
};

function targetIds(payload: PreparePayload): string[] {
  if (!Array.isArray(payload.targets)) return [];
  return payload.targets
    .map((target) =>
      target && typeof target === 'object'
        ? (target as { targetId?: unknown }).targetId
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string');
}

function preparationBody(
  operationId: string,
  payload: PreparePayload,
  directives: StubMatchDirective[],
) {
  const ids = targetIds(payload);
  return {
    operationId,
    preparationId: randomUUID(),
    candidateDigest: payload.candidateDigest,
    capabilityContract: payload.capabilityContract,
    comparisonSetDigest: payload.comparisonSetDigest,
    assessmentDigest: digestFrom(`assessment:${operationId}`),
    matches: directives
      .filter((directive) => ids[directive.targetIndex] !== undefined)
      .map((directive) => ({
        targetId: ids[directive.targetIndex],
        classification: directive.classification,
        reasonCode: directive.reasonCode,
        confidence: directive.confidence,
      })),
  };
}

type PublishPayload = {
  reservedSkillId?: unknown;
  candidateDigest?: unknown;
  projectId?: unknown;
};

function publicationBody(operationId: string, payload: PublishPayload) {
  return {
    operationId,
    skillId: payload.reservedSkillId,
    versionId: randomUUID(),
    digest: payload.candidateDigest,
    projectId: payload.projectId,
    publishedAt: new Date().toISOString(),
  };
}

type StubState = {
  program: StubProgram;
  calls: CapturedCall[];
  railCalls: CapturedRailCall[];
  seq: number;
  railSeq: number;
  importsDropped: number;
  retainedDigests: Map<string, string>;
  published: Map<string, ReturnType<typeof publicationBody>>;
  prepared: Map<string, ReturnType<typeof preparationBody>>;
};

const RAIL_RETAIN = /^\/v1\/conductia\/rail-templates\/revisions\/([^/]+)\/retain$/;
const RAIL_IMPORT = /^\/v1\/conductia\/rail-templates\/imports\/([^/]+)$/;

/**
 * The digest a retained asset is filed under when it has no skill source
 * digest of its own (a firm mount). A retained skill whose source is not a
 * mount is filed under that source digest, as the real service does, because
 * `publish_rail_template` compares the receipt's `packageDigest` with it.
 * Either way the import receipt must repeat the digest exactly:
 * `rail_template_finalize_creation` matches each imported binding's digest
 * against the `packageDigest` its revision retained, so the stub remembers
 * what it answered per (revisionId, key) in `retainedDigests`, which a program
 * call does not clear, and falls back to this derived value for a pair it
 * never retained.
 */
function assetDigest(revisionId: string, key: string): string {
  return digestFrom(`retain:${revisionId}:${key}`);
}

function retainedKey(revisionId: string, key: string): string {
  return `${revisionId}:${key}`;
}

function retainedDigest(skill: StubRailSkill, revisionId: string): string {
  const digest = skill.source?.digest;
  if (skill.source?.kind !== 'mount' && typeof digest === 'string') return digest;
  return assetDigest(revisionId, skill.key);
}

function retainBody(
  state: StubState,
  revisionId: string,
  payload: { skills?: unknown },
): unknown {
  const skills = Array.isArray(payload.skills) ? (payload.skills as StubRailSkill[]) : [];
  return {
    revisionId,
    assets: skills.map((skill) => {
      const packageDigest = retainedDigest(skill, revisionId);
      state.retainedDigests.set(retainedKey(revisionId, skill.key), packageDigest);
      return { key: skill.key, packageDigest };
    }),
  };
}

function importBody(
  state: StubState,
  requestId: string,
  payload: { projectId?: unknown; revisionId?: unknown; targets?: unknown },
): unknown {
  const targets = Array.isArray(payload.targets) ? (payload.targets as StubRailTarget[]) : [];
  const revisionId = typeof payload.revisionId === 'string' ? payload.revisionId : '';
  return {
    requestId,
    projectId: payload.projectId,
    skills: targets.map((target) => ({
      key: target.key,
      binding: {
        skillId: target.skillId,
        versionId: target.versionId,
        digest:
          state.retainedDigests.get(retainedKey(revisionId, target.key)) ??
          assetDigest(revisionId, target.key),
      },
    })),
  };
}

function parseRail(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type RailCallDraft =
  | Omit<Extract<CapturedRailCall, { kind: 'retain' }>, 'seq'>
  | Omit<Extract<CapturedRailCall, { kind: 'import' }>, 'seq'>;

function recordRail(state: StubState, call: RailCallDraft): void {
  state.railSeq += 1;
  state.railCalls.push({ ...call, seq: state.railSeq } as CapturedRailCall);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function applyFailure(
  response: http.ServerResponse,
  failure: StubFailure | undefined,
): boolean {
  if (!failure) return false;
  if (failure.kind === 'hang') return true;
  if (failure.kind === 'malformed') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"operationId":');
    return true;
  }
  sendJson(response, failure.status, failure.error ? { error: failure.error } : {});
  return true;
}

function operationIdFrom(pathname: string): string | null {
  const match = /^\/v1\/conductia\/skill-publications\/([^/]+)(\/prepare|\/publish)?$/.exec(
    pathname,
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function record(
  state: StubState,
  request: http.IncomingMessage,
  pathname: string,
  operationId: string,
  body: unknown,
): void {
  state.seq += 1;
  state.calls.push({
    seq: state.seq,
    method: request.method ?? '',
    path: pathname,
    operationId,
    authorization: header(request, 'authorization'),
    correlationId: header(request, 'x-correlation-id'),
    body,
    receivedAt: new Date().toISOString(),
  });
}

function handlePrepare(
  state: StubState,
  response: http.ServerResponse,
  operationId: string,
  raw: string,
): void {
  if (applyFailure(response, state.program.prepare?.failure)) return;
  let payload: PreparePayload = {};
  try {
    payload = JSON.parse(raw) as PreparePayload;
  } catch {
    sendJson(response, 422, { error: 'invalid JSON' });
    return;
  }
  const body = preparationBody(
    operationId,
    payload,
    state.program.prepare?.matches ?? [],
  );
  state.prepared.set(operationId, body);
  sendJson(response, 200, body);
}

function handlePublish(
  state: StubState,
  response: http.ServerResponse,
  operationId: string,
  raw: string,
): void {
  if (applyFailure(response, state.program.publish?.failure)) return;
  let payload: PublishPayload = {};
  try {
    payload = JSON.parse(raw) as PublishPayload;
  } catch {
    sendJson(response, 422, { error: 'invalid JSON' });
    return;
  }
  const body = publicationBody(operationId, payload);
  state.published.set(operationId, body);
  sendJson(response, 200, body);
}

function handleLookup(
  state: StubState,
  response: http.ServerResponse,
  operationId: string,
): void {
  const forced = state.program.lookup?.status;
  const published = state.published.get(operationId);
  const prepared = state.prepared.get(operationId);
  if (forced === 'not_published') {
    sendJson(response, 200, { status: 'not_published' });
    return;
  }
  if (forced === 'published' || (forced === undefined && published)) {
    sendJson(response, 200, {
      status: 'published',
      publication: published ?? publicationBody(operationId, {}),
    });
    return;
  }
  if (forced === 'prepared' || (forced === undefined && prepared)) {
    sendJson(response, 200, {
      status: 'prepared',
      preparation: prepared ?? preparationBody(operationId, {}, []),
    });
    return;
  }
  sendJson(response, 200, { status: 'not_published' });
}

export function createIgnatiousPublicationStub(): {
  handler: http.RequestListener;
  state: StubState;
} {
  const state: StubState = {
    program: {},
    calls: [],
    railCalls: [],
    seq: 0,
    railSeq: 0,
    importsDropped: 0,
    retainedDigests: new Map(),
    published: new Map(),
    prepared: new Map(),
  };

  const handler: http.RequestListener = (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;

      if (request.method === 'POST' && pathname === '/__control/program') {
        state.program = JSON.parse(await readBody(request)) as StubProgram;
        state.calls = [];
        state.railCalls = [];
        state.seq = 0;
        state.railSeq = 0;
        state.importsDropped = 0;
        state.published.clear();
        state.prepared.clear();
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && pathname === '/__control/calls') {
        sendJson(response, 200, { calls: state.calls });
        return;
      }

      if (request.method === 'GET' && pathname === '/__control/rail-calls') {
        sendJson(response, 200, { calls: state.railCalls });
        return;
      }

      const retain = request.method === 'POST' ? RAIL_RETAIN.exec(pathname) : null;
      if (retain) {
        const revisionId = decodeURIComponent(retain[1]);
        const payload = parseRail(await readBody(request));
        recordRail(state, {
          kind: 'retain',
          revisionId,
          companyId: String(payload.companyId ?? ''),
          sourceProjectId: String(payload.sourceProjectId ?? ''),
          skills: Array.isArray(payload.skills) ? (payload.skills as StubRailSkill[]) : [],
          authorization: header(request, 'authorization'),
        });
        if (applyFailure(response, state.program.retain?.failure)) return;
        sendJson(response, 200, retainBody(state, revisionId, payload));
        return;
      }

      const imported = request.method === 'POST' ? RAIL_IMPORT.exec(pathname) : null;
      if (imported) {
        const requestId = decodeURIComponent(imported[1]);
        const payload = parseRail(await readBody(request));
        recordRail(state, {
          kind: 'import',
          requestId,
          companyId: String(payload.companyId ?? ''),
          revisionId: String(payload.revisionId ?? ''),
          projectId: String(payload.projectId ?? ''),
          targets: Array.isArray(payload.targets) ? (payload.targets as StubRailTarget[]) : [],
          authorization: header(request, 'authorization'),
        });
        if (applyFailure(response, state.program.imports?.failure)) return;
        if (state.program.imports?.commitThenDisconnect === true && state.importsDropped === 0) {
          state.importsDropped += 1;
          request.socket.destroy();
          return;
        }
        sendJson(response, 200, importBody(state, requestId, payload));
        return;
      }

      if (request.method === 'GET' && pathname === `/v1/conductia/skill-publications/skills/${FIELDS_SKILL.skillId}/lineage`) {
        sendJson(response, 200, {
          lineage: [{ versionId: FIELDS_SKILL.versionId, digest: FIELDS_SKILL.digest, publishedAt: '2026-09-24T12:00:00.000Z', inputs: FIELDS_SKILL_INPUTS }],
        });
        return;
      }

      const operationId = operationIdFrom(pathname);
      if (operationId === null) {
        sendJson(response, 404, { error: 'not found' });
        return;
      }

      const raw =
        request.method === 'POST' ? await readBody(request) : '';
      record(state, request, pathname, operationId, raw.length ? raw : null);

      if (request.method === 'POST' && pathname.endsWith('/prepare')) {
        handlePrepare(state, response, operationId, raw);
        return;
      }
      if (request.method === 'POST' && pathname.endsWith('/publish')) {
        handlePublish(state, response, operationId, raw);
        return;
      }
      if (request.method === 'GET') {
        handleLookup(state, response, operationId);
        return;
      }
      sendJson(response, 404, { error: 'not found' });
    })();
  };

  return { handler, state };
}

export function startIgnatiousPublicationStub(
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { handler } = createIgnatiousPublicationStub();
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}

if (process.argv[1]?.endsWith('ignatiousPublicationStub.ts')) {
  const port = Number(process.env.PUBLICATION_STUB_PORT ?? 4311);
  void startIgnatiousPublicationStub(port).then(({ url }) => {
    console.log(`ignatious publication stub listening on ${url}`);
  });
}
