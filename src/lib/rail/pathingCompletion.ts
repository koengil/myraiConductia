/** Copy and labels for a completed Relationship Pathing step. */

export type PathingPath = {
  approved: boolean;
  path_type: string;
  stakeholder_id: string;
  relationship_id: string | null;
  approved_by?: string | null;
  approved_on?: string | null;
};

export type PathingStakeholder = {
  id: string;
  name: string;
};

export type PathingRelationship = {
  id: string;
  person_name: string;
};

export function describeApprovedPath(
  path: PathingPath,
  stakeholders: readonly PathingStakeholder[],
  relationships: readonly PathingRelationship[],
): string {
  const who =
    stakeholders.find((row) => row.id === path.stakeholder_id)?.name.trim() || 'a stakeholder';
  if (path.path_type === 'cold' || !path.relationship_id) {
    return `Cold path to ${who}`;
  }
  const introducer =
    relationships.find((row) => row.id === path.relationship_id)?.person_name.trim() ||
    'an introducer';
  return `Warm path to ${who} via ${introducer}`;
}

export function pathingApprovedWhat(
  paths: readonly PathingPath[],
  stakeholders: readonly PathingStakeholder[],
  relationships: readonly PathingRelationship[],
): string {
  const approved = paths.filter((path) => path.approved);
  if (!approved.length) {
    return 'Relationship pathing was marked complete.';
  }
  return `${approved
    .map((path) => describeApprovedPath(path, stakeholders, relationships))
    .join('. ')}.`;
}

export function pathingApproverLabel(paths: readonly PathingPath[]): {
  approvedBy: string;
  approvedOn: string;
} {
  const approved = paths.filter((path) => path.approved);
  const names = [
    ...new Set(
      approved
        .map((path) => path.approved_by?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const dated = approved.find((path) => path.approved_on?.trim());
  return {
    approvedBy: names.join(', ') || 'On record',
    approvedOn: dated?.approved_on?.trim() || '',
  };
}
