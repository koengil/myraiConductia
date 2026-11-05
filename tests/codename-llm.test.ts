import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CODENAME_SUGGESTIONS_PER_THEME } from '../src/lib/gate0/codenameTypes';
import { fallbackCodenameThemes } from '../src/lib/gate0/codenameFallback';
import {
  sanitizeCodenameThemes,
  suggestCodenames,
} from '../src/lib/gate0/codenameLlm';
import { GATEWAY_MESSAGES_URL, __resetWarnOnceForTests } from '../src/lib/modelGateway/gatewayClient';
import type { SearchableCompany } from '../src/lib/rail/deals';
import { captureConsole, type ConsoleCapture } from './helpers/consoleCapture';
import type { ModelCallDecision } from '../src/lib/ai/modelPolicy';
import { allowedDecision, withheldDecision } from './helpers/modelDecision';

const CANVA: SearchableCompany = {
  id: 'canva',
  name: 'Canva',
  sector: 'Visual design platform',
};

/** The model_outcome lines a console.error spy saw, without the measured ms (#474). */
function outcomes(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((c) => typeof c[0] === 'string' && c[0].startsWith('{"evt":"model_outcome"'))
    .map((c) => {
      const line = JSON.parse(c[0] as string) as Record<string, unknown>;
      delete line.ms;
      return line;
    });
}

const FIVE = [
  'Project Falcon',
  'Project Osprey',
  'Project Kestrel',
  'Project Heron',
  'Project Raven',
];

// The model gate (#339): the open decision is the DEV tenant on a local dev
// stack; the withheld one is a real tenant on a hosted URL.
const allowed = allowedDecision('codename_suggest');
const withheld = withheldDecision('codename_suggest');

beforeEach(() => {
  __resetWarnOnceForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sanitizeCodenameThemes', () => {
  it('rejects suggestions that contain the target name', () => {
    const out = sanitizeCodenameThemes(
      [
        {
          id: 'bad',
          label: 'Design',
          suggestions: ['Project Canva', ...FIVE.slice(1)],
        },
      ],
      CANVA,
    );
    expect(out).toHaveLength(0);
  });

  it('normalizes bare words to Project format', () => {
    const out = sanitizeCodenameThemes(
      [
        {
          id: 'birds',
          label: 'Birds',
          suggestions: [
            'Falcon',
            'project osprey',
            'Project Kestrel',
            'Heron',
            'Raven',
          ],
        },
      ],
      CANVA,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.suggestions).toEqual(FIVE);
  });
});

describe('fallbackCodenameThemes', () => {
  it('returns three deterministic themes with masked suggestions', () => {
    const { themes, source } = fallbackCodenameThemes(CANVA);
    expect(source).toBe('fallback');
    expect(themes).toHaveLength(3);
    for (const theme of themes) {
      expect(theme.suggestions).toHaveLength(CODENAME_SUGGESTIONS_PER_THEME);
      for (const name of theme.suggestions) {
        expect(name).toMatch(/^Project /);
        expect(name.toLowerCase()).not.toContain('canva');
      }
    }
  });
});

describe('suggestCodenames', () => {
  it('falls back without AI_GATEWAY_API_KEY, logs a no_key line per call, and never calls fetch', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await suggestCodenames(CANVA, 0, allowed);
    expect(result.source).toBe('fallback');
    expect(result.themes).toHaveLength(3);
    expect((await suggestCodenames(CANVA, 0, allowed)).source).toBe('fallback');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    const line = { evt: 'model_outcome', feature: 'codename_suggest', outcome: 'no_key' };
    expect(outcomes(err)).toEqual([line, line]);
  });

  it('uses the LLM when it returns three valid themes', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              themes: [
                {
                  label: 'Canvas craft',
                  suggestions: [
                    'Project Palette',
                    'Project Studio',
                    'Project Frame',
                    'Project Ink',
                    'Project Draft',
                  ],
                },
                {
                  label: 'Visual flow',
                  suggestions: [
                    'Project Prism',
                    'Project Lens',
                    'Project Gradient',
                    'Project Pixel',
                    'Project Hue',
                  ],
                },
                {
                  label: 'Creative spark',
                  suggestions: [
                    'Project Ember',
                    'Project Spark',
                    'Project Muse',
                    'Project Glow',
                    'Project Forge',
                  ],
                },
              ],
            }),
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await suggestCodenames(CANVA, 0, allowed);
    expect(result.source).toBe('llm');
    expect(result.themes).toHaveLength(3);
    expect(result.themes[0]?.label).toBe('Canvas craft');
    expect(result.themes[0]?.suggestions).toHaveLength(CODENAME_SUGGESTIONS_PER_THEME);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GATEWAY_MESSAGES_URL);
    expect(init.headers).toEqual({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('anthropic/claude-sonnet-5');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.providerOptions).toEqual({ gateway: { zeroDataRetention: true, only: ['anthropic'] } });
  });

  it('CODENAME_LLM_MODEL, then SCREEN_LLM_MODEL, accept a bare or a prefixed id', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const reply = {
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              themes: [
                { label: 'A', suggestions: FIVE },
                { label: 'B', suggestions: FIVE },
                { label: 'C', suggestions: FIVE },
              ],
            }),
          },
        ],
      }),
    };
    const modelSent = async () => {
      const fetchMock = vi.fn().mockResolvedValue(reply);
      vi.stubGlobal('fetch', fetchMock);
      await suggestCodenames(CANVA, 0, allowed);
      return JSON.parse(fetchMock.mock.calls[0][1].body as string).model as string;
    };

    vi.stubEnv('CODENAME_LLM_MODEL', '');
    vi.stubEnv('SCREEN_LLM_MODEL', 'claude-haiku-4-5');
    expect(await modelSent()).toBe('anthropic/claude-haiku-4-5');

    vi.stubEnv('CODENAME_LLM_MODEL', 'anthropic/claude-opus-5');
    expect(await modelSent()).toBe('anthropic/claude-opus-5');
  });

  it('reports the bare model name to onUsage', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubEnv('CODENAME_LLM_MODEL', '');
    vi.stubEnv('SCREEN_LLM_MODEL', '');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'anthropic/claude-sonnet-5',
          usage: { input_tokens: 11, output_tokens: 7 },
          content: [{ type: 'text', text: 'not json' }],
        }),
      }),
    );
    const onUsage = vi.fn();

    expect((await suggestCodenames(CANVA, 0, allowed, onUsage)).source).toBe('fallback');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5' });
  });

  it('reports usage to onUsage when a billed reply has content that cannot be read', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubEnv('CODENAME_LLM_MODEL', '');
    vi.stubEnv('SCREEN_LLM_MODEL', '');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ model: 'anthropic/claude-sonnet-5', usage: { input_tokens: 11, output_tokens: 7 }, content: 'not a list' }),
      }),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onUsage = vi.fn();

    expect((await suggestCodenames(CANVA, 0, allowed, onUsage)).source).toBe('fallback');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5', inputTokens: 11, outputTokens: 7 });
    err.mockRestore();
  });

  it('a ZDR refusal serves the fallback sets and logs one line per call', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({ type: 'error', error: { type: 'permission_denied', message: 'Zero Data Retention (ZDR) is only available for Pro and Enterprise plans canary-zdr' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await suggestCodenames(CANVA, 0, allowed)).source).toBe('fallback');
    expect((await suggestCodenames(CANVA, 1, allowed)).source).toBe('fallback');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    const line = { evt: 'model_outcome', feature: 'codename_suggest', outcome: 'zdr_unavailable', failure: 'upstream_status', zdrReason: 'permission_denied', status: 403 };
    expect(err).toHaveBeenCalledTimes(2);
    expect(outcomes(err)).toEqual([line, line]);
    expect(JSON.stringify(err.mock.calls)).not.toContain('canary-zdr');
    warn.mockRestore();
    err.mockRestore();
  });

  it('falls back when the LLM leaks the target name', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                themes: [
                  {
                    label: 'Leaky',
                    suggestions: [
                      'Project Canva',
                      'Project Canva2',
                      'Project Canva3',
                      'Project Canva4',
                      'Project Canva5',
                    ],
                  },
                ],
              }),
            },
          ],
        }),
      }),
    );

    const result = await suggestCodenames(CANVA, 0, allowed);
    expect(result.source).toBe('fallback');
    expect(result.themes).toHaveLength(3);
  });
});

describe('suggestCodenames failure paths keep provider text out of the console (#331)', () => {
  const CANARY = 'CANARY-331 Quarterly Board Memo for Project Falcon';
  let capture: ConsoleCapture | undefined;

  afterEach(() => {
    capture?.restore();
    capture = undefined;
  });

  it('logs the status only when the gateway answers an error body, never its code', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: CANARY } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    capture = captureConsole();

    const result = await suggestCodenames(CANVA, 0, allowed);
    expect(result.source).toBe('fallback');
    expect(capture.output()).toContain('AI Gateway');
    expect(capture.output()).toContain('400');
    expect(capture.output()).not.toContain('invalid_request_error');
    expect(capture.output()).toContain('{"evt":"model_outcome","feature":"codename_suggest","outcome":"http","failure":"upstream_status","status":400,');
    expect(capture.output()).not.toContain('CANARY-331');
  });

  // A code-shaped token in the error body passes errorCodeFromBody, and a 5-letter
  // one can be a deal code (#474 audit): no field of the body reaches a line.
  it.each([
    ['error.type', { error: { type: 'FALCO', message: CANARY } }],
    ['error.code', { error: { code: 'FALCO' } }],
    ['error.name', { error: { name: 'FALCO' } }],
    ['the top-level name', { name: 'FALCO' }],
    ['the top-level code', { code: 'FALCO' }],
  ])('logs no code-shaped canary from %s of an error body', async (_label, body) => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 400 })));
    capture = captureConsole();

    expect((await suggestCodenames(CANVA, 0, allowed)).source).toBe('fallback');
    expect(capture.output()).toContain('{"evt":"model_outcome","feature":"codename_suggest","outcome":"http","failure":"upstream_status","status":400,');
    expect(capture.output()).not.toContain('FALCO');
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('logs nothing from an error body that is not JSON', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(CANARY, { status: 502 })));
    capture = captureConsole();

    expect((await suggestCodenames(CANVA, 0, allowed)).source).toBe('fallback');
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it.each([
    ['a reply that is not JSON', CANARY],
    ['a reply whose themes leak the target', JSON.stringify({ themes: [{ label: CANARY, suggestions: ['Project Canva'] }] })],
  ])('logs nothing of the model result for %s', async (_label, text) => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) }),
    );
    capture = captureConsole();

    expect((await suggestCodenames(CANVA, 0, allowed)).source).toBe('fallback');
    expect(capture.output()).not.toContain('CANARY-331');
  });
});

describe('suggestCodenames behind the model gate (#339)', () => {
  it('a withheld decision returns the deterministic fallback and makes no model call', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onUsage = vi.fn();
    const result = await suggestCodenames(CANVA, 0, withheld, onUsage);
    expect(result).toEqual(fallbackCodenameThemes(CANVA, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('a hand-built { allowed: true } is rejected before any model call', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const forged = { allowed: true, basis: 'verified_processor' } as unknown as ModelCallDecision;
    await expect(suggestCodenames(CANVA, 0, forged)).rejects.toThrow(/minted by modelCallsAllowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a decision minted for a mail screen cannot open a codename call', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(suggestCodenames(CANVA, 0, allowedDecision('mail_screen'))).rejects.toThrow(
      /minted for mail_screen/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
