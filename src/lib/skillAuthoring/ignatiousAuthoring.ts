import type { IgnatiousConfig } from "@/lib/ignatious/config";
import type { SkillInputField, SkillInputValues } from "@/lib/skillRun/inputs";
import type { SkillReference } from "@/lib/skillRun/types";

export type TurnCandidatePreview = {
  name: string;
  purpose: string;
  expectedInput: string;
  expectedOutput: string;
  inputs: SkillInputField[];
};

export type TurnSeedRun = { input: string; inputs: SkillInputValues; output: string };

export type TurnRequest = {
  attemptId: string;
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  currentCandidate: TurnCandidatePreview | null;
  basis: SkillReference | null;
  seedRun: TurnSeedRun | null;
};

export type TurnCandidate = {
  providerCandidateId: string;
  contentDigest: string;
  schemaVersion: 1;
  preview: TurnCandidatePreview;
};

export type TurnLine =
  | { type: "text"; text: string }
  | ({ type: "candidate" } & TurnCandidate)
  // Since agents-backend PR #147 the done line prices the turn: `costUsd` is
  // null when nothing priceable ran, `modelId` is the catalog id.
  | { type: "done"; costUsd?: number | null; model?: string | null; modelId?: string | null }
  | { type: "error"; code: string; message: string };

const TURN_PATH = "/v1/bench/authoring/turns";

export async function* streamAuthoringTurn(
  config: IgnatiousConfig,
  request: TurnRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<TurnLine> {
  const response = await fetchImpl(`${config.benchUrl}${TURN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.apiKey },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Authoring turn request failed with ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as TurnLine;
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as TurnLine;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
