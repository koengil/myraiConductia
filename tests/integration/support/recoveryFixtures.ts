import type {
  CapabilityContract,
  SkillStepDefinitionV1,
} from "@/lib/skillPublication/types";

export const RECOVERY_DEAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const RECOVERY_OTHER_DEAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const RECOVERY_TENANT_ID = "60000000-0000-4000-8000-000000000001";
export const RECOVERY_ACTOR_ID = "30000000-0000-4000-8000-000000000001";

export const RECOVERY_CANDIDATE_ID = "40000000-0000-4000-8000-000000000009";
export const RECOVERY_PROVIDER_CANDIDATE_ID =
  "a0000000-0000-4000-8000-000000000001";
export const RECOVERY_CANDIDATE_NAME = "Weekly project update candidate";
export const RECOVERY_CANDIDATE_DIGEST =
  "f19ac37b173d6feb7db778adbbffeb05c710a6f89fb771fb7bac54c2d2ac84d8";

export const RECOVERY_PURPOSE = "Summarize the deal for the working group.";
export const RECOVERY_EXPECTED_INPUT = "Recent deal activity.";
export const RECOVERY_EXPECTED_OUTPUT = "A short written summary.";

export function recoveryCapabilityContract(
  overrides: Partial<CapabilityContract> = {},
): CapabilityContract {
  return {
    purpose: RECOVERY_PURPOSE,
    expectedInput: RECOVERY_EXPECTED_INPUT,
    expectedOutput: RECOVERY_EXPECTED_OUTPUT,
    ...overrides,
  };
}

export function similarCapabilityContract(): CapabilityContract {
  return {
    purpose: "Summarize the deal for the working group each week.",
    expectedInput: "Recent deal activity and notes.",
    expectedOutput: "A short written weekly summary.",
  };
}

export function skillStepDefinition(
  title: string,
  purpose: string,
  expectedInput: string,
  binding: { skillId: string; versionId: string; digest: string },
): SkillStepDefinitionV1 {
  return {
    schemaVersion: 1,
    type: "skill",
    title,
    description: purpose,
    inputs: [
      {
        key: "primary",
        kind: "text",
        label: "Input",
        helperText: expectedInput,
        required: true,
      },
    ],
    skillBinding: binding,
  };
}

let uuidCounter = 0;

export function nextRecoveryUuid(prefix: string): string {
  uuidCounter += 1;
  const suffix = uuidCounter.toString(16).padStart(12, "0");
  return `${prefix}-0000-4000-8000-${suffix}`;
}
