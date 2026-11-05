// The exclusion policy's neutral contract (#263). Provider-neutral, pure and
// model-free (ESLint block B): it names no provider, no mailbox-derived table and
// no model. A provider reader maps its message metadata into MessageMetadata and
// asks the evaluator; the Gmail mapping is src/lib/google/reader/policyInput.ts,
// and a Graph mapping fills the same type when #272 lands.

export const RULE_CATEGORIES = ['confidential', 'privileged', 'hr', 'never_read'] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

/**
 * A `thread` rule excludes the whole conversation, later replies included, within
 * a pass and across passes (the thread taint). A `message` rule excludes only the
 * message that matches. A rule without a scope is a `thread` rule (validate.ts).
 */
export const RULE_SCOPES = ['thread', 'message'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

/** The marker headers a rule may match: Sensitivity (RFC 4021) and msip_labels (Microsoft Purview). */
export const MARKER_HEADERS = ['sensitivity', 'msip_labels'] as const;
export type MarkerHeader = (typeof MARKER_HEADERS)[number];

export const RULE_KINDS = ['label', 'classification', 'header_marker', 'participant_domain', 'participant_address'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export type PolicyRule = { id: string; category: RuleCategory; scope: RuleScope } & (
  // Case-insensitive; a provider's system ids (for example CATEGORY_PERSONAL) are allowed.
  | { kind: 'label'; names: string[] }
  | { kind: 'classification'; labelId: string; fieldId?: string; selectionId?: string }
  // Case-insensitive substring of the header's value.
  | { kind: 'header_marker'; header: MarkerHeader; contains: string }
  // The addr-spec's domain of From, To or Cc: exact or a subdomain.
  | { kind: 'participant_domain'; domains: string[] }
  | { kind: 'participant_address'; addresses: string[] }
);

/** A policy version. Version 0 is "none": fixture mode only, never a live tenant. */
export type ExclusionPolicy = { version: number; rules: PolicyRule[] };

/** What a live pass is given when the tenant has no usable policy: the guard wrapper refuses on the first read. */
export type ExclusionUnavailable = { unavailable: 'missing' | 'invalid' };

/**
 * The policy a pass reads under, and the threads already excluded for one source
 * (thread id to the rule ids that tainted it). `policy` may be unavailable: the
 * guard wrapper then refuses before any request.
 */
export type ExclusionContext = {
  policy: ExclusionPolicy | ExclusionUnavailable;
  threadTaint: ReadonlyMap<string, ReadonlySet<string>>;
};

/** A Workspace classification label value on a message: the label, and optionally one field's selection. */
export type ClassificationValue = { labelId: string; fieldId?: string; selectionId?: string };

/**
 * Everything a rule may read, and nothing else: no subject, snippet, body or
 * display name, by construction. What it does hold (marker header values,
 * addr-specs, label names) is untrusted text a sender or the mailbox controls,
 * compared literally and never interpreted.
 */
export type MessageMetadata = {
  /**
   * `ids` are what the message carries; `names` resolve them. `unavailable` is a label the provider's own list
   * did not name (created since it was read): a label rule that does not match on an id then fails closed.
   */
  labels: { ids: string[]; names: string[] | 'unavailable' };
  classification: ClassificationValue[] | 'unavailable';
  /** Addr-specs per address header (lowercased, no display names); unparseable when any one header cannot be read. */
  participants: { from: string[]; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; sender: string[] } | 'unparseable';
  markers: { sensitivity: string | null; msip_labels: string | null };
};

export type ExcludeReason = 'policy_excluded' | 'policy_thread_excluded' | 'policy_unevaluable';
export type Verdict = { result: 'pass' } | { result: 'exclude'; reason: ExcludeReason; ruleId: string };

/** A thread-scoped rule that matched (or could not be evaluated) on one message. */
export type ThreadTaint = { providerThreadId: string; providerItemId: string; ruleId: string; policyVersion: number };

export function isUnavailable(policy: ExclusionPolicy | ExclusionUnavailable): policy is ExclusionUnavailable {
  return 'unavailable' in policy;
}
