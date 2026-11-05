/**
 * AI spend aggregation (#109): the four cuts the issue asks for, by deal,
 * person, task and model, computed over ledger rows in one pass. Pure, so the
 * route and the tests share it.
 */

import { catalogChoice } from '@/lib/rail/railTemplateCatalog';

export type AiUsageRow = {
  deal_id: string | null;
  deal_code?: string | null;
  deal_codename?: string | null;
  actor_id: string | null;
  actor_name?: string | null;
  source: string;
  task: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | string | null;
  created_at: string;
};

export type SpendLine = {
  key: string;
  label: string;
  calls: number;
  /** Calls whose cost is on record (null cost = unpriced model). */
  pricedCalls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export type SpendSummary = {
  totalCostUsd: number;
  calls: number;
  unpricedCalls: number;
  byDeal: SpendLine[];
  byPerson: SpendLine[];
  byTask: SpendLine[];
  byModel: SpendLine[];
};

/** The person bucket of a ledger row with no user actor (discovery_extract). */
const DISCOVERY_WORKER_KEY = 'discovery-worker';

const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

function bucket(
  rows: AiUsageRow[],
  keyOf: (r: AiUsageRow) => string,
  labelOf: (r: AiUsageRow) => string,
): SpendLine[] {
  const lines = new Map<string, SpendLine>();
  for (const r of rows) {
    const key = keyOf(r);
    const line = lines.get(key) ?? {
      key,
      label: labelOf(r),
      calls: 0,
      pricedCalls: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const cost = r.cost_usd == null ? null : Number(r.cost_usd);
    line.calls += 1;
    if (cost != null && Number.isFinite(cost)) {
      line.pricedCalls += 1;
      line.costUsd = round(line.costUsd + cost);
    }
    line.inputTokens += r.input_tokens ?? 0;
    line.outputTokens += r.output_tokens ?? 0;
    lines.set(key, line);
  }
  return [...lines.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

/** Human label for a task key: a house rail step shows its rail title, a custom step keeps its id. */
export function taskLabel(task: string): string {
  switch (task) {
    case 'mail_screen':
      return 'Mail screen (draft)';
    case 'mail_send_screen':
      return 'Mail screen (send)';
    case 'mail_send_second_opinion':
      return 'Mail screen second opinion (send)';
    case 'lead_presearch':
      return 'Lead presearch';
    case 'lead_debrief':
      return 'Lead debrief';
    case 'codename_suggest':
      return 'Code name suggestions';
    case 'bench_chat':
      return 'Skill bench chat';
    case 'milestone_extract':
      return 'Milestone extraction';
    case 'deal_proposal':
      return 'Deal proposal (demo)';
    default:
      return catalogChoice(task)?.title ?? task;
  }
}

export function summarizeSpend(rows: AiUsageRow[]): SpendSummary {
  const priced = rows.filter((r) => r.cost_usd != null && Number.isFinite(Number(r.cost_usd)));
  return {
    totalCostUsd: round(priced.reduce((sum, r) => sum + Number(r.cost_usd), 0)),
    calls: rows.length,
    unpricedCalls: rows.length - priced.length,
    byDeal: bucket(
      rows,
      (r) => r.deal_id ?? 'none',
      (r) => (r.deal_id ? r.deal_codename || r.deal_code || r.deal_id : 'Outside a deal'),
    ),
    byPerson: bucket(
      rows,
      (r) => r.actor_id ?? DISCOVERY_WORKER_KEY,
      (r) => r.actor_name || r.actor_id || 'Discovery worker',
    ),
    byTask: bucket(rows, (r) => r.task, (r) => taskLabel(r.task)),
    byModel: bucket(
      rows,
      (r) => r.model ?? (r.source === 'agent_run' ? 'agent_run:unknown' : 'unknown'),
      (r) => r.model ?? (r.source === 'agent_run' ? 'Ignatious agent run (model not reported)' : 'Model not reported'),
    ),
  };
}
