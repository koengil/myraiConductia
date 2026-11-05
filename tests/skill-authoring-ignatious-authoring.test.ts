import { describe, expect, it, vi } from "vitest";
import type { IgnatiousConfig } from "@/lib/ignatious/config";
import {
  streamAuthoringTurn,
  type TurnRequest,
} from "@/lib/skillAuthoring/ignatiousAuthoring";

const SHARED_WIRE_CONTRACT =
  [
    '{"type":"text","text":"Here is a draft "}',
    '{"type":"text","text":"for the buyer tracker."}',
    '{"type":"candidate","providerCandidateId":"6a1f2c9e-3b7d-5e10-8c4a-2f9b1d7e6a53","contentDigest":"66d2f3cda3148430b408c141dd7c6d644b11b543f280db363611ea88e03f22da","schemaVersion":1,"preview":{"name":"buyer-outreach-tracker","purpose":"Track buyer outreach","expectedInput":"Buyer list","expectedOutput":"Outreach table"}}',
    '{"type":"done"}',
  ].join("\n") + "\n";

const CONFIG: IgnatiousConfig = {
  baseUrl: "http://control.test",
  apiKey: "bench-key",
  tenantId: "tn_demo",
  leadIdOverride: null,
  benchUrl: "http://bench.test",
  conductiaBaseUrl: null,
};

const TURN_REQUEST: TurnRequest = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  history: [],
  message: "draft a buyer outreach tracker",
  currentCandidate: {
    name: "buyer-outreach-tracker",
    purpose: "Track buyer outreach",
    expectedInput: "Buyer list",
    expectedOutput: "Outreach table",
    inputs: [
      {
        name: "asOf",
        label: "As of",
        description: null,
        type: "date",
        values: [],
        required: false,
        default: null,
      },
    ],
  },
  basis: null,
  seedRun: { input: "", inputs: { asOf: "2026-09-30" }, output: "" },
};

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("streamAuthoringTurn", () => {
  it("posts the turn with the bench key and yields parsed lines across chunk boundaries", async () => {
    const chunks = [
      SHARED_WIRE_CONTRACT.slice(0, 25),
      SHARED_WIRE_CONTRACT.slice(25),
    ];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(streamOf(chunks), { status: 200 }),
    );
    const lines = [];
    for await (const line of streamAuthoringTurn(
      CONFIG,
      TURN_REQUEST,
      new AbortController().signal,
      fetchImpl,
    )) {
      lines.push(line);
    }
    expect(lines.map((line) => line.type)).toEqual([
      "text",
      "text",
      "candidate",
      "done",
    ]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://bench.test/v1/bench/authoring/turns");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("bench-key");
    expect(JSON.parse(String(init?.body))).toEqual(TURN_REQUEST);
  });

  it("cancels the response body when the consumer stops reading early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(SHARED_WIRE_CONTRACT));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const generator = streamAuthoringTurn(
      CONFIG,
      TURN_REQUEST,
      new AbortController().signal,
      fetchImpl,
    );

    const first = await generator.next();
    expect(first.done).toBe(false);
    await generator.return(undefined);

    expect(cancelled).toBe(true);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const iterate = async () => {
      for await (const _line of streamAuthoringTurn(
        CONFIG,
        TURN_REQUEST,
        new AbortController().signal,
        fetchImpl,
      )) {
        expect(_line).toBeDefined();
      }
    };
    await expect(iterate()).rejects.toThrow("401");
  });
});
