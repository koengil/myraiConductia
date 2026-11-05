import { isRecord } from "@/lib/skillPublication/parse";

export type SkillInputType = "string" | "textarea" | "number" | "date" | "enum" | "boolean";
export type SkillInputValue = string | number | boolean;
export type SkillInputField = {
  name: string;
  label: string;
  description: string | null;
  type: SkillInputType;
  values: string[];
  required: boolean;
  default: SkillInputValue | null;
};
export type SkillInputValues = Record<string, SkillInputValue>;
export type InputProblem = { name: string | null; message: string };

export const MAX_INSTRUCTIONS = 20_000;
const MAX_FIELDS = 12;
const TYPES: readonly SkillInputType[] = ["string", "textarea", "number", "date", "enum", "boolean"];

function isScalar(value: unknown): value is SkillInputValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function parseField(raw: unknown): SkillInputField | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") return null;
  if (!TYPES.includes(raw.type as SkillInputType)) return null;
  const type = raw.type as SkillInputType;
  const values = Array.isArray(raw.values) ? raw.values.filter((v): v is string => typeof v === "string") : [];
  if (type === "enum" && values.length === 0) return null;
  return {
    name: raw.name,
    label: typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label : raw.name,
    description: typeof raw.description === "string" && raw.description.trim() !== "" ? raw.description : null,
    type,
    values,
    required: raw.required === true,
    default: isScalar(raw.default) ? raw.default : null,
  };
}

export function parseSkillInputFields(value: unknown): SkillInputField[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_FIELDS) {
    console.warn("parseSkillInputFields: invalid field list, defaulting to []");
    return [];
  }
  const fields = value.map(parseField);
  if (fields.some((field) => field === null)) {
    console.warn("parseSkillInputFields: invalid field list, defaulting to []");
    return [];
  }
  return fields as SkillInputField[];
}

export function parseInputValues(value: unknown): SkillInputValues | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_FIELDS * 4 || !entries.every(([, v]) => isScalar(v))) return null;
  return Object.fromEntries(entries) as SkillInputValues;
}

export function coerceFieldValue(field: SkillInputField, raw: string | boolean): SkillInputValue | undefined {
  if (typeof raw === "boolean") return raw;
  if (raw.trim() === "") return undefined;
  if (field.type === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return raw;
}

export function collectRunInputs(fields: SkillInputField[], values: SkillInputValues): SkillInputValues {
  const out: SkillInputValues = {};
  for (const field of fields) {
    const value = values[field.name];
    const hasValue = value !== undefined && !(typeof value === "string" && value.trim() === "");
    if (hasValue) {
      out[field.name] = value;
    } else if (field.default !== null) {
      out[field.name] = field.default;
    }
  }
  return out;
}

export function missingRequired(fields: SkillInputField[], values: SkillInputValues): SkillInputField | null {
  const sent = collectRunInputs(fields, values);
  return fields.find((field) => field.required && field.default === null && sent[field.name] === undefined) ?? null;
}

export function sameInputValues(a: SkillInputValues, b: SkillInputValues): boolean {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && a[key] === b[key]);
}

export function parseInputProblems(body: unknown): InputProblem[] | null {
  if (!isRecord(body) || !isRecord(body.error) || !isRecord(body.error.detail)) return null;
  const problems = body.error.detail.problems;
  if (!Array.isArray(problems)) return null;
  return problems.flatMap((problem) =>
    isRecord(problem) && typeof problem.message === "string"
      ? [{ name: typeof problem.name === "string" ? problem.name : null, message: problem.message }]
      : [],
  );
}
