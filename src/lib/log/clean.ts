// The value cleaners and the line cleaner of the server logger (#474, design Q1).
// A cleaner passes a member of its closed set, a UUID or an integer in range, and
// turns anything else into 'invalid'. No text-shape regex: a shape cannot tell a code
// from a subject line. cleanLine() builds a NEW object from the table's keys for the
// event and never copies the input, so an extra key such as `subject` cannot reach a line.

export const INVALID = 'invalid';
export type Invalid = typeof INVALID;

/** What a cleaner accepts, read by the contract test. */
export type Shape = { oneOf: readonly (string | number)[] } | { uuid: true } | { int: readonly [number, number] };

export type Cleaner<T> = ((value: unknown) => T | Invalid) & { readonly shape: Shape };

export type FieldSpec = { readonly clean: Cleaner<unknown>; readonly required: boolean };
export type EventTable = { readonly [evt: string]: { readonly [field: string]: FieldSpec } };

function cleaner<T>(shape: Shape, accept: (value: unknown) => T | Invalid): Cleaner<T> {
  return Object.assign(accept, { shape });
}

export function oneOf<T extends string | number>(set: readonly T[]): Cleaner<T> {
  return cleaner({ oneOf: set }, (value) => ((set as readonly unknown[]).includes(value) ? (value as T) : INVALID));
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuid: Cleaner<string> = cleaner({ uuid: true }, (value) =>
  typeof value === 'string' && UUID_SHAPE.test(value) ? value.toLowerCase() : INVALID,
);

export function int(min: number, max: number): Cleaner<number> {
  return cleaner({ int: [min, max] }, (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : INVALID,
  );
}

/**
 * The cleaned line, or null when `line` names no event in the table. Walks the
 * table's fields for the event: a missing required field becomes 'invalid', a
 * missing optional one is left out, and every other input key is never read.
 */
export function cleanLine(table: EventTable, line: unknown): Record<string, unknown> | null {
  if (!line || typeof line !== 'object') return null;
  const input = line as Record<string, unknown>;
  const evt = input.evt;
  if (typeof evt !== 'string' || !Object.hasOwn(table, evt)) return null;
  const out: Record<string, unknown> = { evt };
  for (const [key, spec] of Object.entries(table[evt])) {
    const value = input[key];
    if (value === undefined) {
      if (spec.required) out[key] = INVALID;
      continue;
    }
    out[key] = spec.clean(value);
  }
  return out;
}
