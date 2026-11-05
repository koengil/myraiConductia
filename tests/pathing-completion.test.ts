import { describe, expect, it } from 'vitest';

import {
  describeApprovedPath,
  pathingApprovedWhat,
  pathingApproverLabel,
} from '@/lib/rail/pathingCompletion';

const stakeholders = [
  { id: 's1', name: 'test' },
  { id: 's2', name: 'Ada Lovelace' },
];
const relationships = [{ id: 'r1', person_name: 'Marcelo' }];

describe('pathingCompletion', () => {
  it('names a warm path by stakeholder and introducer', () => {
    expect(
      describeApprovedPath(
        {
          approved: true,
          path_type: 'warm',
          stakeholder_id: 's1',
          relationship_id: 'r1',
        },
        stakeholders,
        relationships,
      ),
    ).toBe('Warm path to test via Marcelo');
  });

  it('names a cold path without inventing an introducer', () => {
    expect(
      describeApprovedPath(
        {
          approved: true,
          path_type: 'cold',
          stakeholder_id: 's2',
          relationship_id: null,
        },
        stakeholders,
        relationships,
      ),
    ).toBe('Cold path to Ada Lovelace');
  });

  it('joins approved paths into the step record', () => {
    expect(
      pathingApprovedWhat(
        [
          {
            approved: true,
            path_type: 'warm',
            stakeholder_id: 's1',
            relationship_id: 'r1',
            approved_by: 'Roberto',
            approved_on: '2026-09-02',
          },
          {
            approved: false,
            path_type: 'cold',
            stakeholder_id: 's2',
            relationship_id: null,
          },
        ],
        stakeholders,
        relationships,
      ),
    ).toBe('Warm path to test via Marcelo.');
  });

  it('lists unique path approvers', () => {
    expect(
      pathingApproverLabel([
        {
          approved: true,
          path_type: 'warm',
          stakeholder_id: 's1',
          relationship_id: 'r1',
          approved_by: 'Roberto',
          approved_on: '2026-09-02',
        },
        {
          approved: true,
          path_type: 'cold',
          stakeholder_id: 's2',
          relationship_id: null,
          approved_by: 'Roberto',
          approved_on: '2026-09-02',
        },
      ]),
    ).toEqual({ approvedBy: 'Roberto', approvedOn: '2026-09-02' });
  });
});
