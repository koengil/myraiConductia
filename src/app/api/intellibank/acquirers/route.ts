import { getApi } from '@/lib/api';
import { DEFAULT_PROJECT_ID } from '@/lib/project/resolveProjectId';

// GET /api/intellibank/acquirers — the acquirer list, served over HTTP.
//
// Phase F of the sandbox merge (2026-05-20). Adopts the network-boundary
// pattern from intelibank-sandbox/app/api/llm/<method>/route.ts (the
// engineering review's architectural lesson): every ConductiaAPI method
// can be surfaced as a thin route handler that delegates to getApi().
// Existing UI keeps consuming through getApi() directly for in-process
// speed; this handler exists as (a) a curl-able JSON surface for external
// tools, and (b) the future-backend swap point. When a real backend
// replaces MockConductiaAPI, route handlers like this stay; their guts
// change.
//
// This is ONE representative endpoint. Adding the remaining 12
// ConductiaAPI methods (seller, peers, skills, team, score, runSkill,
// compliance.check, sendMessage, valuation, synergy, founder-read,
// culture-matrix) follows the same shape (each is 3 lines of code). They
// are deferred to a polish phase to avoid adding 12 files without a
// concrete consumer; the pattern is on record here.
export async function GET() {
  const acquirers = await getApi().getAcquirers(DEFAULT_PROJECT_ID);
  return Response.json(acquirers);
}
