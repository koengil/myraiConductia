import type { ProjectRailStep } from "@/lib/rail/projectRail";
import type {
  ManifestSkill,
  RailManifest,
  TemplateDefinition,
  TemplateSkill,
} from "@/lib/railTemplates/types";
import type { SkillReference } from "@/lib/skillRun/types";
import type {
  SkillBinding,
  SkillStepDefinitionV1,
} from "@/lib/skillPublication/types";

export const CUSTOM_ROW_ID = "11111111-1111-4111-8111-111111111111";
export const CATALOG_ROW_ID = "11111111-1111-4111-8111-111111111112";
export const SEEDED_ID_A = "22222222-2222-4222-8222-222222222222";
export const SEEDED_ID_B = "33333333-3333-4333-8333-333333333333";
export const SEEDED_ID_C = "44444444-4444-4444-8444-444444444444";

export const SKILL_ID = "55555555-5555-4555-8555-555555555555";
export const VERSION_ORIGINAL = "66666666-6666-4666-8666-666666666661";
export const VERSION_SELECTED = "66666666-6666-4666-8666-666666666662";
export const VERSION_ONE_OFF = "66666666-6666-4666-8666-666666666663";
export const DIGEST_ORIGINAL = "a".repeat(64);
export const DIGEST_SELECTED = "b".repeat(64);
export const DIGEST_ONE_OFF = "c".repeat(64);

export type FixtureStep = ProjectRailStep & {
  effectiveSkill: Omit<TemplateSkill, "key"> | null;
};

function sourceKey(source: SkillReference): string {
  return source.kind === "publication"
    ? `publication:${source.skillId}:${source.versionId}:${source.digest}`
    : `mount:${source.name}:${source.version}:${source.digest}`;
}

function templateDefinition(step: FixtureStep): TemplateDefinition | null {
  const definition = step.definition;
  if (step.origin === "catalog" || definition === null) return null;
  if ("type" in definition) {
    return {
      schemaVersion: definition.schemaVersion,
      type: definition.type,
      title: definition.title,
      description: definition.description,
      inputs: definition.inputs,
    };
  }
  return { title: definition.title, description: definition.description };
}

export function manifestOf(
  steps: FixtureStep[],
  censusVersion: string,
): RailManifest {
  const active = steps
    .filter((step) => step.removedAt === null)
    .sort(
      (a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id),
    );
  const skills: ManifestSkill[] = [];
  const keys = new Map<string, string>();

  return {
    schemaVersion: 2,
    censusVersion,
    steps: active.map((step, index) => {
      let skillKey: string | null = null;
      if (step.effectiveSkill !== null) {
        const source = sourceKey(step.effectiveSkill.source);
        const known = keys.get(source);
        skillKey = known ?? `s${skills.length}`;
        if (known === undefined) {
          keys.set(source, skillKey);
          skills.push({ key: skillKey, ...step.effectiveSkill });
        }
      }
      return {
        key: `t${index}`,
        templateStepKey:
          step.origin === "catalog" ? step.stepId : `custom-${step.id}`,
        catalogStepId: step.origin === "catalog" ? step.stepId : null,
        seq: step.origin === "catalog" ? step.seq : null,
        phaseIndex: step.phaseIndex,
        displayOrder: index + 1,
        definition: templateDefinition(step),
        skillKey,
      };
    }),
    skills,
  };
}

export function customStep(
  overrides: Partial<FixtureStep> = {},
): FixtureStep {
  return {
    id: CUSTOM_ROW_ID,
    stepId: "custom:source",
    origin: "custom",
    phaseIndex: 2,
    displayOrder: 10,
    seq: null,
    status: "complete",
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    definition: { title: "Weekly memo", description: "Draft a memo" },
    effectiveSkill: null,
    ...overrides,
  };
}

export function catalogStep(
  overrides: Partial<FixtureStep> = {},
): FixtureStep {
  return customStep({
    id: CATALOG_ROW_ID,
    stepId: "p1-s10",
    origin: "catalog",
    phaseIndex: 1,
    displayOrder: 1,
    seq: 10,
    definition: null,
    ...overrides,
  });
}

export function binding(versionId: string, digest: string): SkillBinding {
  return { skillId: SKILL_ID, versionId, digest };
}

export function skillDefinition(boundTo: SkillBinding): SkillStepDefinitionV1 {
  return {
    schemaVersion: 1,
    type: "skill",
    title: "Weekly memo",
    description: "Draft a memo",
    inputs: [
      {
        key: "primary",
        kind: "text",
        label: "Input",
        helperText: "A reporting period.",
        required: true,
      },
    ],
    skillBinding: boundTo,
  };
}

export function publishedSkill(
  versionId: string,
  digest: string,
): Omit<TemplateSkill, "key"> {
  return {
    source: { kind: "publication", skillId: SKILL_ID, versionId, digest },
    name: "Weekly memo",
    contract: {
      purpose: "Draft a weekly memo.",
      expectedInput: "A reporting period.",
      expectedOutput: "A concise memo.",
    },
  };
}

export function manifestFixture(): RailManifest {
  return manifestOf([customStep()], "test");
}

export function queryStub(rows: Array<Record<string, unknown>>) {
  let current = rows;
  const self = {
    select: () => self,
    eq: (column: string, value: unknown) => {
      current = current.filter((row) => row[column] === value);
      return self;
    },
    is: (column: string, value: unknown) => {
      current = current.filter((row) => (row[column] ?? null) === value);
      return self;
    },
    in: (column: string, values: unknown[]) => {
      current = current.filter((row) => values.includes(row[column]));
      return self;
    },
    not: (column: string) => {
      current = current.filter((row) => row[column] != null);
      return self;
    },
    order: (column: string) => {
      current = [...current].sort((a, b) => {
        const left = String(a[column]);
        const right = String(b[column]);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      return self;
    },
    limit: (count: number) => {
      current = current.slice(0, count);
      return self;
    },
    upsert: async (values: Array<Record<string, unknown>>) => {
      rows.push(...values);
      return { data: null, error: null };
    },
    maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
    single: async () =>
      current[0] === undefined
        ? { data: null, error: { message: "no rows" } }
        : { data: current[0], error: null },
    then: (resolve: (value: unknown) => void) =>
      resolve({ data: current, error: null }),
  };
  return self;
}

export function skillManifest(): RailManifest {
  return manifestOf(
    [
      customStep({
        definition: skillDefinition(binding(VERSION_SELECTED, DIGEST_SELECTED)),
        effectiveSkill: publishedSkill(VERSION_SELECTED, DIGEST_SELECTED),
      }),
    ],
    "test",
  );
}
