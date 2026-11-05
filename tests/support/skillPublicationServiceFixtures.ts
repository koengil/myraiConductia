export const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
export const PREPARATION_ID = "22222222-2222-4222-8222-222222222222";
export const SKILL_ID = "44444444-4444-4444-8444-444444444444";
export const VERSION_ID = "55555555-5555-4555-8555-555555555555";
export const PROJECT_ID = "66666666-6666-4666-8666-666666666666";
export const DIGEST =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export function validCapabilityContract() {
  return {
    purpose: "Summarize deal status.",
    expectedInput: "A reporting period.",
    expectedOutput: "A concise update.",
  };
}

export function validPrepareRequest() {
  return {
    candidateId: SKILL_ID,
    candidateDigest: DIGEST,
    candidateName: "Deal Summarizer",
    reservedSkillId: SKILL_ID,
    companyId: PROJECT_ID,
    projectId: PROJECT_ID,
    displayName: "Deal Summarizer",
    capabilityContract: validCapabilityContract(),
    comparisonSetDigest: DIGEST,
    targets: [],
  };
}

export function validPreparationReceipt() {
  return {
    operationId: OPERATION_ID,
    preparationId: PREPARATION_ID,
    candidateDigest: DIGEST,
    capabilityContract: validCapabilityContract(),
    comparisonSetDigest: DIGEST,
    assessmentDigest: DIGEST,
    matches: [],
  };
}

export function validPublishRequest() {
  return {
    preparationId: PREPARATION_ID,
    assessmentDigest: DIGEST,
    candidateId: SKILL_ID,
    candidateDigest: DIGEST,
    reservedSkillId: SKILL_ID,
    companyId: PROJECT_ID,
    projectId: PROJECT_ID,
  };
}

export function validPublicationReceipt() {
  return {
    operationId: OPERATION_ID,
    skillId: SKILL_ID,
    versionId: VERSION_ID,
    digest: DIGEST,
    projectId: PROJECT_ID,
    publishedAt: "2026-09-10T12:00:00.000Z",
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function erroringBodyResponse(status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new DOMException("Timeout", "TimeoutError"));
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "application/json" },
  });
}
