// The recorder's fallback transport (T2): a direct Anthropic Messages call,
// used only if the owner chooses it. It is not an app transport (R8): nothing
// under src/ imports it, and the worker never selects it.

import { usageFromAnthropicReply } from '@/lib/ai/usage';
import type { ModelCallResult } from '@/lib/modelGateway';
import { promptFor, type ModelTransport } from '@/lib/modelGateway/transports';

export const ANTHROPIC_DIRECT_MODEL = 'claude-sonnet-5';
const TIMEOUT_MS = 25_000;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Identity-linked keys (personal / service account) also need
 * ANTHROPIC_WORKSPACE_ID (Settings, Workspaces in the Claude Console).
 * Workspace-scoped keys omit it.
 */
function anthropicRequestHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  if (workspaceId) headers['anthropic-workspace-id'] = workspaceId;
  return headers;
}

export function anthropicDirectTransport(opts: { apiKey?: string } = {}): ModelTransport {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return {
    // Recorded output is stamped 'gateway' | 'anthropic-direct' in the file;
    // to the extract loop this is a live call, so it reports as a gateway kind.
    kind: 'gateway',
    async send(req): Promise<ModelCallResult> {
      const started = Date.now();
      const fail = (code: 'no_key' | 'timeout' | 'http') =>
        ({ ok: false, outcome: 'failed', code, transport: 'gateway', latencyMs: Date.now() - started }) as const;
      if (!apiKey) return fail('no_key');
      const prompt = promptFor(req);
      try {
        const res = await fetch(ANTHROPIC_MESSAGES_URL, {
          method: 'POST',
          headers: anthropicRequestHeaders(apiKey),
          body: JSON.stringify({
            model: ANTHROPIC_DIRECT_MODEL,
            max_tokens: 2048,
            thinking: { type: 'disabled' },
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return fail('http');
        const data = (await res.json()) as { id?: string; content?: Array<{ type: string; text?: string }> };
        return {
          ok: true,
          text: data.content?.find((c) => c.type === 'text')?.text ?? '',
          responseId: data.id ?? '',
          usage: usageFromAnthropicReply(data),
          transport: 'gateway',
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        return fail(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'http');
      }
    },
  };
}
