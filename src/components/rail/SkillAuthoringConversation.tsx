"use client";

import * as React from "react";

import { Button } from "@/components/atoms/Button";
import { Markdown } from "@/components/atoms/Markdown";
import type { AttemptRead, DraftRead } from "@/lib/skillAuthoring/types";

type ConversationMessage = DraftRead["messages"][number];

const PANE_CLASS =
  "flex min-h-64 flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] md:min-h-0";
const PANE_HEADER_CLASS =
  "eyebrow shrink-0 border-b border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)]";
const TRANSCRIPT_CLASS =
  "min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--space-3)] py-[var(--space-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]";

const PIN_THRESHOLD_PX = 48;

function newestFailedMessageId(
  messages: readonly ConversationMessage[],
): string | null {
  let winner: { ordinal: number; id: string } | null = null;
  for (const message of messages) {
    const last = message.attempts[message.attempts.length - 1];
    if (last?.status !== "failed") continue;
    if (!winner || message.ordinal > winner.ordinal)
      winner = { ordinal: message.ordinal, id: message.id };
  }
  return winner?.id ?? null;
}

function transcriptSignature(
  messages: readonly ConversationMessage[],
): string {
  const last = messages[messages.length - 1];
  const attempt = last?.attempts[last.attempts.length - 1];
  return [
    messages.length,
    last?.attempts.length ?? 0,
    attempt?.responseText.length ?? 0,
    attempt?.status ?? "",
  ].join(":");
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function scrollToBottom(node: HTMLElement) {
  if (!prefersReducedMotion() && typeof node.scrollTo === "function") {
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    return;
  }
  node.scrollTop = node.scrollHeight;
}

function useTranscriptAutoScroll(signature: string) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const pinnedRef = React.useRef(true);
  const onScroll = React.useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedRef.current = distance <= PIN_THRESHOLD_PX;
  }, []);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || !pinnedRef.current) return;
    scrollToBottom(node);
  }, [signature]);
  return [ref, onScroll] as const;
}

function AttemptStatusLine({ attempt }: { attempt: AttemptRead }) {
  if (attempt.status === "running")
    return (
      <p
        role="status"
        className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
      >
        Generating
      </p>
    );
  return null;
}

function AttemptFailure({
  attempt,
  canRetry,
  onRetry,
}: {
  attempt: AttemptRead;
  canRetry: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-[var(--space-2)] rounded-[var(--radius-input)] border border-[color-mix(in_srgb,var(--negative-deep)_28%,transparent)] bg-[color-mix(in_srgb,var(--negative-fill)_40%,var(--surface))] p-[var(--space-3)]">
      <p className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
        {attempt.error?.message ?? "That attempt failed."}
      </p>
      {canRetry ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          className="mt-[var(--space-2)]"
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function AttemptBody({
  attempt,
  canRetry,
  onRetry,
}: {
  attempt: AttemptRead;
  canRetry: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-[var(--space-2)]">
      <AttemptStatusLine attempt={attempt} />
      {attempt.responseText ? (
        <Markdown>{attempt.responseText}</Markdown>
      ) : null}
      {attempt.status === "failed" ? (
        <AttemptFailure
          attempt={attempt}
          canRetry={canRetry}
          onRetry={onRetry}
        />
      ) : null}
    </div>
  );
}

function MessageBlock({
  message,
  showRetry,
  onRetry,
}: {
  message: ConversationMessage;
  showRetry: boolean;
  onRetry: (messageId: string) => void;
}) {
  return (
    <div className="mb-[var(--space-4)] border-l-2 border-[var(--stroke-strong)] pl-[var(--space-3)]">
      <p className="whitespace-pre-wrap text-[length:var(--text-sm)] text-[var(--ink)]">
        <span className="font-medium">You: </span>
        {message.text}
      </p>
      {message.attempts.map((attempt, index) => (
        <AttemptBody
          key={attempt.id}
          attempt={attempt}
          canRetry={showRetry && index === message.attempts.length - 1}
          onRetry={() => onRetry(message.id)}
        />
      ))}
    </div>
  );
}

function TranscriptEmptyState() {
  return (
    <div className="py-[var(--space-8)] text-center">
      <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
        Describe the skill you want to build.
      </p>
    </div>
  );
}

function MessageList({
  messages,
  retryableId,
  onRetry,
}: {
  messages: readonly ConversationMessage[];
  retryableId: string | null;
  onRetry: (messageId: string) => void;
}) {
  if (messages.length === 0) return <TranscriptEmptyState />;
  return (
    <>
      {messages.map((message) => (
        <MessageBlock
          key={message.id}
          message={message}
          showRetry={message.id === retryableId}
          onRetry={onRetry}
        />
      ))}
    </>
  );
}

function useFitToText(value: string) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (value === "") {
      node.style.height = "";
      return;
    }
    if (node.scrollHeight <= node.clientHeight) return;
    node.style.height = `${String(node.scrollHeight + node.offsetHeight - node.clientHeight)}px`;
  }, [value]);
  return ref;
}

function ComposerInput({
  composerValue,
  onComposerChange,
  composerDisabled,
}: {
  composerValue: string;
  onComposerChange: (value: string) => void;
  composerDisabled: boolean;
}) {
  const ref = useFitToText(composerValue);
  return (
    <textarea
      ref={ref}
      aria-label="Message"
      placeholder="Describe what this step should do."
      value={composerValue}
      disabled={composerDisabled}
      onChange={(event) => onComposerChange(event.target.value)}
      rows={2}
      className="min-h-[64px] max-h-28 w-full resize-none md:max-h-60 rounded-[var(--radius-input)] border border-[var(--stroke-strong)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] leading-[1.5] text-[var(--ink)] transition-colors placeholder:text-[var(--ink-quiet)] hover:border-[var(--ink-quiet)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:opacity-60"
    />
  );
}

function Composer({
  composerValue,
  onComposerChange,
  composerDisabled,
  onSend,
  sendDisabled,
}: {
  composerValue: string;
  onComposerChange: (value: string) => void;
  composerDisabled: boolean;
  onSend: () => void;
  sendDisabled: boolean;
}) {
  return (
    <div className="shrink-0 border-t border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
      <div className="flex items-end gap-[var(--space-2)]">
        <ComposerInput
          composerValue={composerValue}
          onComposerChange={onComposerChange}
          composerDisabled={composerDisabled}
        />
        <Button
          onClick={onSend}
          disabled={sendDisabled || composerValue.trim().length === 0}
          className="shrink-0"
        >
          Send
        </Button>
      </div>
    </div>
  );
}

type ConversationProps = {
  messages: readonly ConversationMessage[];
  composerValue: string;
  onComposerChange: (value: string) => void;
  composerDisabled: boolean;
  onSend: () => void;
  sendDisabled: boolean;
  onRetry: (messageId: string) => void;
  retryDisabled?: boolean;
};

export function SkillAuthoringConversation({
  messages,
  composerValue,
  onComposerChange,
  composerDisabled,
  onSend,
  sendDisabled,
  onRetry,
  retryDisabled,
}: ConversationProps) {
  const retryableId = retryDisabled ? null : newestFailedMessageId(messages);
  const [transcriptRef, onTranscriptScroll] = useTranscriptAutoScroll(
    transcriptSignature(messages),
  );
  return (
    <section className={PANE_CLASS}>
      <p className={PANE_HEADER_CLASS}>Conversation</p>
      <div
        ref={transcriptRef}
        onScroll={onTranscriptScroll}
        tabIndex={0}
        role="region"
        aria-label="Conversation"
        className={TRANSCRIPT_CLASS}
      >
        <MessageList
          messages={messages}
          retryableId={retryableId}
          onRetry={onRetry}
        />
      </div>
      <Composer
        composerValue={composerValue}
        onComposerChange={onComposerChange}
        composerDisabled={composerDisabled}
        onSend={onSend}
        sendDisabled={sendDisabled}
      />
    </section>
  );
}
