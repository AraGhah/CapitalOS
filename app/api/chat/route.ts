import { route } from "@/lib/http/route";
import { HttpError, parseJson, statusOf } from "@/lib/http/errors";
import { ChatQuestion } from "@/lib/http/schemas";
import { ask, claimChatTurn, clearTranscript, loadTranscript, saveMessage, takeBackLastExchange, toHistory } from "@/lib/chat";
import type { ChatEvent } from "@/lib/chat-format";
import { hasModel, NoModelError } from "@/lib/llm";
import { limitUser } from "@/lib/ratelimit";
import { errorFields, log } from "@/lib/log";
import { reportError } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = route(async (_req, { actor }) =>
  Response.json({ messages: await loadTranscript(actor.userId), model: hasModel() })
);

export const DELETE = route(async (_req, { actor }) => {
  await clearTranscript(actor.userId);
  return Response.json({ ok: true });
});

// The answer streams back as newline-delimited JSON (ChatEvent): text as the
// model writes it, each tool as it starts and finishes, then the saved message.
// Anything that can be refused — the rate limit, a missing key, the daily
// budget — is refused before the stream opens, with an ordinary error status.
export const POST = route(async (req, { actor, requestId }) => {
  const { question, regenerate } = await parseJson(req, ChatQuestion);
  await limitUser(actor.userId, "chat", 10);
  if (!hasModel()) {
    throw new HttpError(503, "The desk needs an ANTHROPIC_API_KEY before it can hold a conversation.", "no_model");
  }

  // A regenerated answer replaces the last exchange: the question is taken
  // back off the transcript and asked again.
  if (regenerate) await takeBackLastExchange(actor.userId, question);

  // History is read before the question is written, so the question is not
  // in its own context twice.
  const history = toHistory(await loadTranscript(actor.userId, 20));
  await claimChatTurn(actor.userId, question);

  const encoder = new TextEncoder();
  let open = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };

      try {
        const turn = await ask(actor, question, history, {
          onText: (delta) => send({ type: "text", delta }),
          onStep: () => send({ type: "step" }),
          onToolStart: (name, input) => send({ type: "tool_start", name, input }),
          onToolEnd: (call) => send({ type: "tool_end", call }),
        });
        // Saved even if the person has left the page, so the answer is there
        // when they come back.
        const message = await saveMessage(actor.userId, "assistant", turn.reply, turn.toolCalls, undefined, turn.meta);
        send({ type: "done", message });
      } catch (err) {
        // The provider's own refusals ("overloaded", "rate limited") are worth
        // showing; anything else stays in the logs.
        const known =
          err instanceof NoModelError ||
          statusOf(err) !== null ||
          /^model (request|stream) failed/.test((err as Error)?.message ?? "");
        if (!known) {
          reportError(err, { requestId });
          log.error({ requestId, userId: actor.userId, ...errorFields(err) }, "copilot turn failed");
        }
        send({
          type: "error",
          message: known
            ? (err as Error).message
            : "The desk could not finish this answer. Try again in a moment; the request id is in the logs.",
          requestId,
        });
      } finally {
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // already closed by the client going away
          }
        }
      }
    },
    cancel() {
      // The person left; the turn carries on and is saved.
      open = false;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // no-transform keeps compression from buffering the stream
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
