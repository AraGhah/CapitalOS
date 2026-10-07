import { route } from "@/lib/http/route";
import { HttpError, parseJson } from "@/lib/http/errors";
import { ChatQuestion } from "@/lib/http/schemas";
import { ask, claimChatTurn, clearTranscript, loadTranscript, saveMessage, toHistory } from "@/lib/chat";
import { hasModel, NoModelError } from "@/lib/llm";
import { limitUser } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = route(async (_req, { actor }) =>
  Response.json({ messages: await loadTranscript(actor.userId), model: hasModel() })
);

export const DELETE = route(async (_req, { actor }) => {
  await clearTranscript(actor.userId);
  return Response.json({ ok: true });
});

export const POST = route(async (req, { actor }) => {
  const { question } = await parseJson(req, ChatQuestion);
  await limitUser(actor.userId, "chat", 10);
  if (!hasModel()) {
    throw new HttpError(503, "The desk needs an ANTHROPIC_API_KEY before it can hold a conversation.", "no_model");
  }

  // History is read before the question is written, so the question is not
  // in its own context twice.
  const history = toHistory(await loadTranscript(actor.userId, 20));
  await claimChatTurn(actor.userId, question);

  try {
    const turn = await ask(actor, question, history);
    await saveMessage(actor.userId, "assistant", turn.reply, turn.toolCalls);
    return Response.json({ reply: turn.reply, toolCalls: turn.toolCalls });
  } catch (err) {
    if (err instanceof NoModelError) throw new HttpError(503, err.message, "no_model");
    throw err;
  }
});
