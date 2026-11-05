'use client';

import * as React from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useRouter } from 'next/navigation';

import type { CrmNetworkPayload } from '@/lib/leads/crmNetwork';
import {
  networkToFlowElements,
  type CrmNetworkFlowEdge,
  type CrmNetworkFlowNodeData,
} from '@/lib/leads/crmNetworkGraph';
import {
  buildCrmLeadsHref,
  crmLeadsHrefForNetworkNode,
  pushCrmFocus,
} from '@/lib/leads/crmLeadsNavigation';

const GRAPH_HEIGHT = 416;
const GRAPH_MIN_WIDTH = 320;

function CrmNetworkPersonNode({ data }: NodeProps<Node<CrmNetworkFlowNodeData>>) {
  if (data.nodeKind !== 'person') return null;

  return (
    <button
      type="button"
      className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0"
      aria-label={data.name}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-transparent !opacity-0" />
      <span
        aria-hidden="true"
        className="inline-block size-3 shrink-0 rounded-full border border-white shadow-sm"
        style={{ backgroundColor: data.color }}
      />
      <span className="whitespace-nowrap text-[length:var(--text-xs)] text-[var(--ink)]">
        {data.name}
      </span>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent !opacity-0" />
    </button>
  );
}

function CrmNetworkCompanyNode({ data }: NodeProps<Node<CrmNetworkFlowNodeData>>) {
  if (data.nodeKind !== 'company') return null;

  const interactive = data.kind === 'lead';

  return (
    <div
      className={`relative box-border rounded-[var(--radius-card)] border-2 bg-[var(--surface)]/90 shadow-sm ${interactive ? 'cursor-pointer' : 'pointer-events-none'}`}
      style={{
        width: data.width,
        height: data.height,
        borderColor: data.color,
      }}
      aria-label={data.name}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-transparent !opacity-0" />
      <div
        className="flex items-center justify-center gap-[var(--space-2)] border-b px-[var(--space-2)] py-[var(--space-1)]"
        style={{ borderColor: `${data.color}33` }}
      >
        <span
          aria-hidden="true"
          className="inline-block size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: data.color }}
        />
        <span className="truncate text-[length:var(--text-xs)] font-medium text-[var(--ink)]">
          {data.name}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent !opacity-0" />
    </div>
  );
}

const nodeTypes = {
  person: CrmNetworkPersonNode,
  company: CrmNetworkCompanyNode,
};

function flowEdgeStyle(edge: CrmNetworkFlowEdge): Edge {
  if (edge.kind === 'relationship') {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: 'default',
      style: {
        stroke: 'rgba(71, 85, 105, 0.7)',
        strokeWidth: 1.5,
        strokeDasharray: '6 4',
      },
      labelStyle: { fill: 'var(--ink-secondary)', fontSize: 10 },
    };
  }

  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: 'default',
    style: { stroke: 'rgba(100, 116, 139, 0.55)', strokeWidth: 1.75 },
    labelStyle: { fill: 'var(--ink-secondary)', fontSize: 10 },
  };
}

function FitViewOnLoad({ networkKey }: { networkKey: string }) {
  const { fitView } = useReactFlow();

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: 0.18, duration: 250 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, networkKey]);

  return null;
}

function useModifierPanHeld(): boolean {
  const [held, setHeld] = React.useState(false);

  React.useEffect(() => {
    const sync = (event: KeyboardEvent | MouseEvent) => {
      setHeld(event.metaKey || event.ctrlKey);
    };

    const onBlur = () => setHeld(false);

    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('mousemove', sync);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('mousemove', sync);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return held;
}

function CrmNetworkFlowCanvas({ network }: { network: CrmNetworkPayload }) {
  const router = useRouter();
  const modifierPanHeld = useModifierPanHeld();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(GRAPH_MIN_WIDTH);
  const networkKey = React.useMemo(
    () =>
      [
        ...network.people.map((person) => person.id),
        ...network.companies.map((company) => company.id),
        ...network.edges.map((edge) => `${edge.kind}:${edge.from}:${edge.to}`),
      ].join('|'),
    [network],
  );

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const syncWidth = () => {
      const next = Math.max(Math.round(element.getBoundingClientRect().width), GRAPH_MIN_WIDTH);
      setWidth((current) => (current === next ? current : next));
    };

    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { nodes, edges } = React.useMemo(
    () =>
      networkToFlowElements(network, {
        width,
        height: GRAPH_HEIGHT,
        padding: 72,
      }),
    [network, width],
  );

  const flowEdges = React.useMemo(() => edges.map(flowEdgeStyle), [edges]);

  return (
    <div
      ref={containerRef}
      className="h-[26rem] w-full min-w-[20rem] overflow-hidden rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface-warm)] [&_.react-flow\_\_attribution]:hidden"
    >
      <ReactFlow
        key={networkKey}
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        nodeOrigin={[0, 0]}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={modifierPanHeld}
        panActivationKeyCode={null}
        zoomOnScroll
        zoomOnDoubleClick={false}
        minZoom={0.35}
        maxZoom={2.5}
        preventScrolling
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_event, node) => {
          const data = node.data;
          if (data.nodeKind === 'person') {
            pushCrmFocus(router, crmLeadsHrefForNetworkNode(data.leadId, data.name), data.name);
            return;
          }
          if (data.nodeKind === 'company' && data.kind === 'lead') {
            pushCrmFocus(
              router,
              buildCrmLeadsHref({ tab: 'companies', leadId: data.companyId }),
              undefined,
            );
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(100, 116, 139, 0.15)" />
        <FitViewOnLoad networkKey={networkKey} />
      </ReactFlow>
    </div>
  );
}

export function CrmNetworkGraph({ network }: { network: CrmNetworkPayload }) {
  return (
    <ReactFlowProvider>
      <CrmNetworkFlowCanvas network={network} />
    </ReactFlowProvider>
  );
}
