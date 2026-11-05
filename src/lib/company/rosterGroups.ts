/**
 * Settings › Organization groups its roster by role, so a firm of hundreds
 * reads as a few short lists. Firm roles first, then directors, then any
 * custom role names, then the plain member seat last.
 */

export type RoleGroup<T> = {
  /** The role label shared by every member of the group, e.g. "Director". */
  label: string;
  members: T[];
};

const FIRST = ['Administrator', 'Chief Compliance Officer', 'Director'];
const LAST = ['Member', 'Employee'];

function rank(label: string): number {
  const first = FIRST.indexOf(label);
  if (first >= 0) return first;
  const last = LAST.indexOf(label);
  if (last >= 0) return 100 + last;
  return 50;
}

/** Groups `items` by `labelOf`, in role order, keeping each group's input order. */
export function groupByRole<T>(items: readonly T[], labelOf: (item: T) => string): RoleGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = labelOf(item);
    const list = groups.get(label);
    if (list) list.push(item);
    else groups.set(label, [item]);
  }
  return [...groups.entries()]
    .map(([label, members]) => ({ label, members }))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
}
