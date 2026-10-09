import { describe, expect, it } from "vitest";
import { readMessageStream } from "../../lib/llm";
import { FOLLOWUP_MARKER, splitFollowups, visibleWhileStreaming } from "../../lib/chat-format";

// A server-sent event stream cut into arbitrary chunks, the way it arrives
// over the network.
function sse(events: unknown[], chunk = 7, crlf = false): ReadableStream<Uint8Array> {
  const nl = crlf ? "\r\n" : "\n";
  const text = events
    .map((e) => `event: ${(e as { type: string }).type}${nl}data: ${JSON.stringify(e)}${nl}${nl}`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

const start = {
  type: "message_start",
  message: { model: "claude-opus-5-5-20260901", usage: { input_tokens: 120, cache_read_input_tokens: 80 } },
};
const stop = [
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];

describe("reading a streamed model reply", () => {
  it("joins text deltas, reports each one, and keeps the model the API named", async () => {
    const seen: string[] = [];
    const message = await readMessageStream(
      sse([
        start,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "ping" },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "## Héllo " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "wörld — 😀" } },
        { type: "content_block_stop", index: 0 },
        ...stop,
      ]),
      (d) => seen.push(d)
    );

    expect(seen.join("")).toBe("## Héllo wörld — 😀");
    expect(message.content).toEqual([{ type: "text", text: "## Héllo wörld — 😀" }]);
    expect(message.model).toBe("claude-opus-5-5-20260901");
    expect(message.stopReason).toBe("end_turn");
    expect(message.usage).toMatchObject({ input_tokens: 120, cache_read_input_tokens: 80, output_tokens: 42 });
  });

  it("rebuilds a tool call's input from its JSON fragments", async () => {
    const message = await readMessageStream(
      sse(
        [
          start,
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "get_quote", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"tick' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'er": "NVDA"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ],
        5,
        true
      )
    );

    expect(message.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "tu_1", name: "get_quote", input: { ticker: "NVDA" } },
    ]);
    expect(message.stopReason).toBe("tool_use");
  });

  it("gives a tool with no arguments an empty input", async () => {
    const message = await readMessageStream(
      sse([
        start,
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_2", name: "market_regime", input: {} } },
        { type: "content_block_stop", index: 0 },
        ...stop,
      ])
    );
    expect(message.content).toEqual([{ type: "tool_use", id: "tu_2", name: "market_regime", input: {} }]);
  });

  it("fails on an error event or a stream that ends early", async () => {
    await expect(
      readMessageStream(sse([start, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]))
    ).rejects.toThrow(/model stream failed: Overloaded/);

    await expect(
      readMessageStream(
        sse([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }])
      )
    ).rejects.toThrow(/before the message finished/);

    await expect(readMessageStream(sse([]))).rejects.toThrow(/before the message began/);
  });

  it("keeps reading when a listener throws", async () => {
    const message = await readMessageStream(
      sse([
        start,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fine" } },
        { type: "content_block_stop", index: 0 },
        ...stop,
      ]),
      () => {
        throw new Error("listener broke");
      }
    );
    expect(message.content).toEqual([{ type: "text", text: "fine" }]);
  });
});

describe("follow-up questions", () => {
  it("splits them off the end of an answer", () => {
    const { body, followups } = splitFollowups(
      `NVDA is up.\n\n> [!KEY]\n> It rose.\n\n${FOLLOWUP_MARKER}\n- How risky is NVDA?\n- Compare NVDA with AMD\n* What is its beta?\n`
    );
    expect(body).toBe("NVDA is up.\n\n> [!KEY]\n> It rose.");
    expect(followups).toEqual(["How risky is NVDA?", "Compare NVDA with AMD", "What is its beta?"]);
  });

  it("leaves an answer without the marker alone", () => {
    expect(splitFollowups("  Just an answer.  ")).toEqual({ body: "Just an answer.", followups: [] });
  });

  it("never shows a half-arrived marker while streaming", () => {
    expect(visibleWhileStreaming("Answer text\n\n@@foll")).toBe("Answer text\n\n");
    expect(visibleWhileStreaming("Answer text\n\n@")).toBe("Answer text\n\n");
    expect(visibleWhileStreaming(`Answer${FOLLOWUP_MARKER}\n- Next?`)).toBe("Answer");
    expect(visibleWhileStreaming("Email me at a@b.com")).toBe("Email me at a@b.com");
  });
});
