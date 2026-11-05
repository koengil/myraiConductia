// The Supabase store behind the rule detector's run (#173 G-07 slice 3b; service role, worker only). Stored text
// leaves the database through discovery_detect_batch alone and stays in this process: the detector is pure and sends
// nothing anywhere. Its failures are codes, never a database message (ADR-0017 decision 5), and nothing here prints.

import type { SupabaseClient } from '@supabase/supabase-js';

import type { DetectedEvent } from './rules.v1';

/** One message the batch hands the detector: its id, content hash, sent time, stored text and approved team inboxes. */
export type DetectItem = {
  id: string;
  contentHash: string;
  sentAt: string | null;
  bodyText: string;
  /** The item's team inboxes whose firm approved milestone_rules: the audiences a pass is recorded for. */
  teamMailboxIds: string[];
};

/**
 * The writer found no approved audience for the item (42501 capability_not_approved): the approval was revoked
 * after the batch was read. The run stops writing; what it wrote before stays, and stops counting at once.
 */
export class DetectionRefusedError extends Error {
  constructor() {
    super('record detection failed: capability_not_approved');
    this.name = 'DetectionRefusedError';
  }
}

/** The team inbox is no longer allowed in the tenant (22023), so its pass is not recorded. */
export class TeamPassRefusedError extends Error {
  constructor() {
    super('record team detection pass failed: team_inbox_not_allowed');
    this.name = 'TeamPassRefusedError';
  }
}

export interface DetectStore {
  /** Up to `limit` messages with an approved audience not yet settled for this rules version. */
  detectBatch(tenantId: string, rulesVersion: string, limit: number): Promise<DetectItem[]>;
  /** Settles one item: the ledger row, its events and an audit row. Returns the detection id. */
  recordDetection(
    tenantId: string,
    detection: { sourceItemId: string; contentHash: string; rulesVersion: string },
    events: DetectedEvent[],
  ): Promise<string>;
  /** One audit row for what this run did with one team inbox's mail. */
  recordTeamPass(tenantId: string, teamMailboxId: string, runId: string, counts: { items: number; events: number }): Promise<void>;
}

const failWith = (what: string, error: { code?: string } | null): never => {
  throw new Error(`${what} failed (${error?.code ?? 'unknown'})`);
};

type BatchRow = { item_id: string; content_hash: string; sent_at: string | null; body_text: string; team_mailbox_ids: string[] | null };

export function supabaseDetectStore(db: SupabaseClient): DetectStore {
  return {
    async detectBatch(tenantId, rulesVersion, limit) {
      const { data, error } = await db.rpc('discovery_detect_batch', {
        p_tenant_id: tenantId,
        p_rules_version: rulesVersion,
        p_limit: limit,
      });
      if (error) failWith('read detect batch', error);
      return ((data ?? []) as BatchRow[]).map((r) => ({
        id: r.item_id,
        contentHash: r.content_hash,
        sentAt: r.sent_at,
        bodyText: r.body_text ?? '',
        teamMailboxIds: r.team_mailbox_ids ?? [],
      }));
    },

    async recordDetection(tenantId, detection, events) {
      const { data, error } = await db.rpc('discovery_record_detection', {
        p_tenant_id: tenantId,
        p_detection: {
          source_item_id: detection.sourceItemId,
          content_hash: detection.contentHash,
          rules_version: detection.rulesVersion,
        },
        // Types, dates, offsets and confidence: never the sentence.
        p_events: events.map((e) => ({
          type: e.type,
          occurred_at: e.occurredAt,
          span_start: e.spanStart,
          span_end: e.spanEnd,
          confidence: e.confidence,
        })),
      });
      if (error?.code === '42501') throw new DetectionRefusedError();
      if (error) failWith('record detection', error);
      return data as string;
    },

    async recordTeamPass(tenantId, teamMailboxId, runId, counts) {
      const { error } = await db.rpc('discovery_record_team_detection_pass', {
        p_tenant_id: tenantId,
        p_team_mailbox_id: teamMailboxId,
        p_run_id: runId,
        p_counts: { items: counts.items, events: counts.events },
      });
      if (error?.code === '22023') throw new TeamPassRefusedError();
      if (error) failWith('record team detection pass', error);
    },
  };
}
