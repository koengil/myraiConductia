import { describe, expect, it } from 'vitest';

import { buildCrmNetworkPayload } from '@/lib/leads/crmNetwork';
import {
  companyFlowNodeId,
  estimatePersonNodeSize,
  layoutClusterPeople,
  layoutNetworkPositions,
  networkToFlowElements,
} from '@/lib/leads/crmNetworkGraph';
import { networkClusterCompanies } from '@/lib/leads/crmNetwork';

const samplePayload = buildCrmNetworkPayload({
  leads: [
    { id: 'lead-a', name: 'Alpha Co' },
    { id: 'lead-b', name: 'Beta Co' },
  ],
  clientCompany: { id: 'cust-1', name: 'Tokmail' },
  people: [
    { id: 'p1', name: 'Alex Chen' },
    { id: 'p2', name: 'Sarah Chen' },
    { id: 'p3', name: 'Jamie Rivera' },
  ],
  stakeholders: [
    { company_id: 'lead-a', person_id: 'p1', name: 'Alex Chen' },
    { company_id: 'lead-a', person_id: 'p2', name: 'Sarah Chen' },
  ],
  relationships: [{ company_id: 'lead-b', person_id: 'p3', person_name: 'Jamie Rivera', relationship_type: 'investor' }],
  paths: [
    {
      company_id: 'lead-a',
      path_type: 'warm',
      relationship_id: 'rel-1',
      stakeholder_id: 'stk-1',
    },
  ],
  stakeholderPersonIds: new Map([
    ['stk-1', 'p1'],
    ['lead-a:alex chen', 'p1'],
  ]),
  relationshipPersonIds: new Map([
    ['rel-1', 'p3'],
    ['lead-b:jamie rivera', 'p3'],
  ]),
});

describe('buildCrmNetworkPayload', () => {
  it('maps CRM people to lead companies and warm-path edges', () => {
    expect(samplePayload.clientCompany?.name).toBe('Tokmail');
    expect(samplePayload.companies.map((company) => company.name).sort()).toEqual(['Alpha Co', 'Beta Co']);
    expect(samplePayload.people).toHaveLength(3);
    expect(samplePayload.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'p1', to: 'p3', kind: 'warm_path', label: 'warm path' }),
        expect.objectContaining({ from: 'p3', to: 'lead-b', kind: 'relationship', label: 'investor' }),
      ]),
    );
  });

  it('clusters relationship contacts on the client org', () => {
    const employee = samplePayload.people.find((person) => person.id === 'p3');
    expect(employee?.companyId).toBe('cust-1');
    expect(employee?.leadId).toBe('lead-b');
  });

  it('includes lead companies that only have relationships', () => {
    const relationshipOnly = buildCrmNetworkPayload({
      leads: [{ id: 'lead-furrel', name: 'Furrel' }],
      clientCompany: { id: 'cust-1', name: 'Tokmail' },
      people: [{ id: 'p9', name: 'Rob Employee' }],
      stakeholders: [],
      relationships: [
        {
          company_id: 'lead-furrel',
          person_id: 'p9',
          person_name: 'Rob Employee',
          relationship_type: 'colleague',
        },
      ],
      paths: [],
      stakeholderPersonIds: new Map(),
      relationshipPersonIds: new Map([['lead-furrel:rob employee', 'p9']]),
    });

    expect(relationshipOnly.companies).toEqual([
      expect.objectContaining({ id: 'lead-furrel', name: 'Furrel' }),
    ]);
    expect(relationshipOnly.edges).toEqual([
      expect.objectContaining({
        from: 'p9',
        to: 'lead-furrel',
        kind: 'relationship',
        label: 'colleague',
      }),
    ]);
  });
});

describe('layoutClusterPeople', () => {
  it('sizes the cluster to fit every person row including labels', () => {
    const people = [
      { id: 'p1', name: 'Board Guy 1', companyId: 'lead-a', leadId: 'lead-a' },
      { id: 'p2', name: 'Board Guy 2', companyId: 'lead-a', leadId: 'lead-a' },
      { id: 'p3', name: 'Board Guy 3', companyId: 'lead-a', leadId: 'lead-a' },
      { id: 'p4', name: 'Md Line', companyId: 'lead-a', leadId: 'lead-a' },
    ];
    const layout = layoutClusterPeople(people);

    expect(layout.width).toBeGreaterThan(estimatePersonNodeSize('Board Guy 1').width * 2);
    expect(layout.height).toBeGreaterThan(estimatePersonNodeSize('Board Guy 1').height * 2);

    for (const item of layout.placed) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeGreaterThanOrEqual(30);
      expect(item.x + item.width).toBeLessThanOrEqual(layout.width);
      expect(item.y + item.height).toBeLessThanOrEqual(layout.height);
    }
  });
});

describe('networkToFlowElements', () => {
  it('maps live network data into React Flow nodes and edges', () => {
    const flow = networkToFlowElements(samplePayload, { width: 800, height: 400, padding: 50 });
    expect(flow.nodes).toHaveLength(6);
    expect(flow.edges).toHaveLength(2);

    const personNode = flow.nodes.find((node) => node.id === 'p1');
    expect(personNode).toMatchObject({
      type: 'person',
      parentId: companyFlowNodeId('lead-a'),
      origin: [0, 0],
      position: { x: expect.any(Number), y: expect.any(Number) },
      data: {
        nodeKind: 'person',
        name: 'Alex Chen',
        companyId: 'lead-a',
        leadId: 'lead-a',
        color: expect.stringMatching(/^#/),
      },
    });

    const companyNode = flow.nodes.find((node) => node.id === companyFlowNodeId('lead-a'));
    expect(companyNode?.data).toMatchObject({
      nodeKind: 'company',
      name: 'Alpha Co',
      width: expect.any(Number),
      height: expect.any(Number),
    });

    expect(flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'warm_path', source: 'p1', target: 'p3' }),
        expect.objectContaining({
          kind: 'relationship',
          source: 'p3',
          target: companyFlowNodeId('lead-b'),
        }),
      ]),
    );
  });
});

describe('layoutNetworkPositions', () => {
  it('keeps cluster boxes inside the viewport', () => {
    const { clusters } = layoutNetworkPositions(samplePayload, {
      width: 800,
      height: 400,
      padding: 50,
    });

    for (const cluster of clusters.values()) {
      expect(cluster.topLeft.x).toBeGreaterThanOrEqual(0);
      expect(cluster.topLeft.y).toBeGreaterThanOrEqual(0);
      expect(cluster.topLeft.x + cluster.width).toBeLessThanOrEqual(800);
      expect(cluster.topLeft.y + cluster.height).toBeLessThanOrEqual(400);
    }
  });

  it('includes the client org in cluster layout', () => {
    const clusters = networkClusterCompanies(samplePayload);
    expect(clusters[0]?.kind).toBe('client');
    expect(clusters[0]?.name).toBe('Tokmail');
  });
});
