import type { CrmNetworkPayload, CrmNetworkPerson } from '@/lib/leads/crmNetwork';
import { networkClusterCompanies } from '@/lib/leads/crmNetwork';

export type CrmNetworkFlowNodeData =
  | {
      nodeKind: 'person';
      name: string;
      color: string;
      companyId: string;
      leadId: string;
    }
  | {
      nodeKind: 'company';
      name: string;
      color: string;
      companyId: string;
      kind: 'client' | 'lead';
      width: number;
      height: number;
    };

export type CrmNetworkFlowNode = {
  id: string;
  type: 'person' | 'company';
  position: { x: number; y: number };
  parentId?: string;
  origin?: [number, number];
  data: CrmNetworkFlowNodeData;
  zIndex?: number;
};

export type CrmNetworkFlowEdge = {
  id: string;
  source: string;
  target: string;
  kind: 'warm_path' | 'relationship';
  label?: string;
};

export type CrmNetworkFlowElements = {
  nodes: CrmNetworkFlowNode[];
  edges: CrmNetworkFlowEdge[];
};

export type GraphLayout = {
  width: number;
  height: number;
  padding?: number;
};

const CLUSTER_PADDING = 18;
const CLUSTER_HEADER = 30;
const CLUSTER_MIN_WIDTH = 108;
const CLUSTER_MIN_HEIGHT = 72;
const PERSON_DOT = 12;
const PERSON_GAP = 8;
const CHAR_WIDTH = 6.5;
const PERSON_HEIGHT = 18;

export function companyFlowNodeId(companyId: string): string {
  return `company-${companyId}`;
}

/** Approximate rendered person row size (dot + label) for cluster bounds. */
export function estimatePersonNodeSize(name: string): { width: number; height: number } {
  const labelWidth = Math.max(name.length * CHAR_WIDTH, 24);
  return {
    width: PERSON_DOT + PERSON_GAP + labelWidth,
    height: PERSON_HEIGHT,
  };
}

type ClusterBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type PlacedPerson = {
  person: CrmNetworkPerson;
  x: number;
  y: number;
  width: number;
  height: number;
};

function emptyClusterBounds(): ClusterBounds {
  return { minX: 0, maxX: CLUSTER_MIN_WIDTH, minY: 0, maxY: CLUSTER_MIN_HEIGHT - CLUSTER_HEADER };
}

function boundsFromPlaced(placed: PlacedPerson[]): ClusterBounds {
  if (placed.length === 0) return emptyClusterBounds();

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const item of placed) {
    minX = Math.min(minX, item.x);
    maxX = Math.max(maxX, item.x + item.width);
    minY = Math.min(minY, item.y);
    maxY = Math.max(maxY, item.y + item.height);
  }

  return { minX, maxX, minY, maxY };
}

/** Lay out people inside a cluster using local top-left coordinates. */
export function layoutClusterPeople(people: CrmNetworkPerson[]): {
  placed: PlacedPerson[];
  width: number;
  height: number;
} {
  if (people.length === 0) {
    return {
      placed: [],
      width: CLUSTER_MIN_WIDTH,
      height: CLUSTER_MIN_HEIGHT,
    };
  }

  const sizes = people.map((person) => ({
    person,
    ...estimatePersonNodeSize(person.name),
  }));

  const count = sizes.length;
  const orbitRadius =
    count === 1 ? 0 : Math.max(56, Math.min(120, 32 + count * 14));
  const contentCenterX =
    Math.max(...sizes.map((item) => item.width)) / 2 +
    orbitRadius +
    CLUSTER_PADDING;
  const contentCenterY =
    CLUSTER_HEADER +
    CLUSTER_PADDING +
    orbitRadius +
    Math.max(...sizes.map((item) => item.height)) / 2;

  const placed: PlacedPerson[] = sizes.map((item, index) => {
    const angle = count === 1 ? 0 : (Math.PI * 2 * index) / count - Math.PI / 2;
    const centerX = contentCenterX + Math.cos(angle) * orbitRadius;
    const centerY = contentCenterY + Math.sin(angle) * orbitRadius;
    return {
      person: item.person,
      x: centerX - item.width / 2,
      y: centerY - item.height / 2,
      width: item.width,
      height: item.height,
    };
  });

  const bounds = boundsFromPlaced(placed);
  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  const width = Math.max(CLUSTER_MIN_WIDTH, contentWidth + CLUSTER_PADDING * 2);
  const height = Math.max(
    CLUSTER_MIN_HEIGHT,
    contentHeight + CLUSTER_PADDING * 2 + CLUSTER_HEADER,
  );

  const shiftX = CLUSTER_PADDING - bounds.minX + (width - contentWidth - CLUSTER_PADDING * 2) / 2;
  const shiftY =
    CLUSTER_HEADER + CLUSTER_PADDING - bounds.minY +
    (height - CLUSTER_HEADER - contentHeight - CLUSTER_PADDING * 2) / 2;

  return {
    placed: placed.map((item) => ({
      ...item,
      x: item.x + shiftX,
      y: item.y + shiftY,
    })),
    width,
    height,
  };
}

type ClusterLayout = {
  clusters: Map<
    string,
    {
      topLeft: { x: number; y: number };
      width: number;
      height: number;
      placed: PlacedPerson[];
    }
  >;
  orphanPositions: Map<string, { x: number; y: number }>;
};

/** Place sized company clusters and person positions on the canvas. */
export function layoutNetworkPositions(
  payload: CrmNetworkPayload,
  layout: GraphLayout,
): ClusterLayout {
  const padding = layout.padding ?? 72;
  const centerX = layout.width / 2;
  const centerY = layout.height / 2;
  const companies = networkClusterCompanies(payload);

  const clusterSpecs = companies.map((company) => {
    const clusterPeople = payload.people.filter((person) => person.companyId === company.id);
    const local = layoutClusterPeople(clusterPeople);
    return { company, ...local };
  });

  const maxClusterWidth = Math.max(...clusterSpecs.map((spec) => spec.width), CLUSTER_MIN_WIDTH);
  const maxClusterHeight = Math.max(...clusterSpecs.map((spec) => spec.height), CLUSTER_MIN_HEIGHT);
  const clusterRadius =
    Math.min(layout.width, layout.height) * 0.3 +
    Math.max(maxClusterWidth, maxClusterHeight) * 0.12;
  const companyAngleStep = companies.length > 0 ? (Math.PI * 2) / companies.length : 0;

  const clusters = new Map<
    string,
    {
      topLeft: { x: number; y: number };
      width: number;
      height: number;
      placed: PlacedPerson[];
    }
  >();

  clusterSpecs.forEach((spec, companyIndex) => {
    const clusterAngle = companyAngleStep * companyIndex - Math.PI / 2;
    const clusterCenterX = centerX + Math.cos(clusterAngle) * clusterRadius;
    const clusterCenterY = centerY + Math.sin(clusterAngle) * clusterRadius;
    clusters.set(spec.company.id, {
      topLeft: {
        x: clusterCenterX - spec.width / 2,
        y: clusterCenterY - spec.height / 2,
      },
      width: spec.width,
      height: spec.height,
      placed: spec.placed,
    });
  });

  const orphanPositions = new Map<string, { x: number; y: number }>();
  for (const [index, person] of payload.people.entries()) {
    if (clusters.has(person.companyId)) continue;
    orphanPositions.set(person.id, {
      x: padding + ((index * 47) % (layout.width - padding * 2)),
      y: padding + ((index * 29) % (layout.height - padding * 2)),
    });
  }

  return { clusters, orphanPositions };
}

export function networkToFlowElements(
  payload: CrmNetworkPayload,
  layout: GraphLayout,
): CrmNetworkFlowElements {
  const colors = new Map(
    networkClusterCompanies(payload).map((company) => [company.id, company.color]),
  );
  const { clusters, orphanPositions } = layoutNetworkPositions(payload, layout);

  const leadCompanyIds = new Set(payload.companies.map((company) => company.id));
  const companyNodes: CrmNetworkFlowNode[] = [];
  const personNodes: CrmNetworkFlowNode[] = [];

  if (payload.clientCompany) {
    const cluster = clusters.get(payload.clientCompany.id);
    if (cluster) {
      companyNodes.push({
        id: companyFlowNodeId(payload.clientCompany.id),
        type: 'company',
        position: cluster.topLeft,
        origin: [0, 0],
        zIndex: 0,
        data: {
          nodeKind: 'company',
          name: payload.clientCompany.name,
          color: payload.clientCompany.color,
          companyId: payload.clientCompany.id,
          kind: 'client',
          width: cluster.width,
          height: cluster.height,
        },
      });
    }
  }

  for (const company of payload.companies) {
    if (!leadCompanyIds.has(company.id)) continue;
    const cluster = clusters.get(company.id);
    if (!cluster) continue;
    companyNodes.push({
      id: companyFlowNodeId(company.id),
      type: 'company',
      position: cluster.topLeft,
      origin: [0, 0],
      zIndex: 0,
      data: {
        nodeKind: 'company',
        name: company.name,
        color: company.color,
        companyId: company.id,
        kind: 'lead',
        width: cluster.width,
        height: cluster.height,
      },
    });
  }

  for (const [companyId, cluster] of clusters) {
    const parentId = companyFlowNodeId(companyId);
    if (!companyNodes.some((node) => node.id === parentId)) continue;

    for (const item of cluster.placed) {
      personNodes.push({
        id: item.person.id,
        type: 'person',
        parentId,
        origin: [0, 0],
        position: { x: item.x, y: item.y },
        zIndex: 1,
        data: {
          nodeKind: 'person',
          name: item.person.name,
          color: colors.get(item.person.companyId) ?? '#64748b',
          companyId: item.person.companyId,
          leadId: item.person.leadId,
        },
      });
    }
  }

  for (const person of payload.people) {
    const orphanPosition = orphanPositions.get(person.id);
    if (!orphanPosition) continue;
    personNodes.push({
      id: person.id,
      type: 'person',
      origin: [0, 0],
      position: orphanPosition,
      zIndex: 1,
      data: {
        nodeKind: 'person',
        name: person.name,
        color: colors.get(person.companyId) ?? '#64748b',
        companyId: person.companyId,
        leadId: person.leadId,
      },
    });
  }

  const personIds = new Set(payload.people.map((person) => person.id));
  const companyNodeIds = new Set(companyNodes.map((node) => node.id));

  const edges: CrmNetworkFlowEdge[] = [];
  for (const [index, edge] of payload.edges.entries()) {
    if (edge.kind === 'relationship') {
      const target = companyFlowNodeId(edge.to);
      if (!personIds.has(edge.from) || !companyNodeIds.has(target)) continue;
      edges.push({
        id: `edge-rel-${edge.from}-${edge.to}-${index}`,
        source: edge.from,
        target,
        kind: 'relationship',
        label: edge.label,
      });
      continue;
    }

    if (!personIds.has(edge.from) || !personIds.has(edge.to)) continue;
    edges.push({
      id: `edge-warm-${edge.from}-${edge.to}-${index}`,
      source: edge.from,
      target: edge.to,
      kind: 'warm_path',
      label: edge.label,
    });
  }

  return {
    nodes: [...companyNodes, ...personNodes],
    edges,
  };
};
