import type { NextRequest } from "next/server";
import {
  ask,
  chatTurnsLeft,
  clearTranscript,
  loadTranscript,
  saveMessage,
  toHistory,
} from "@/lib/chat";
import { BudgetExhaustedError, hasModel, NoModelError } from "@/lib/llm";
import { CommitteeBudgetError } from "@/lib/ai/committee";

export const dynamic = "force-dynamic";
// A committee convened from the chat can run several minutes.
export const maxDuration = 800;

// Long enough for any real question; a pasted document is not a question.
const MAX_QUESTION_CHARS = 4000;

export async function GET() {
  return Response.json({ messages: await loadTranscript(), model: hasModel() });
}

export async function DELETE() {
  await clearTranscript();
  return Response.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { question?: unknown };
  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (!question) {
    return Response.json({ error: "ask something" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return Response.json({ error: `keep the question under ${MAX_QUESTION_CHARS} characters` }, { status: 413 });
  }

  if ((await chatTurnsLeft()) <= 0) {
    return Response.json(
      { error: "the daily limit of copilot questions is used up (DAILY_CHAT_BUDGET)" },
      { status: 429 }
    );
  }

  const history = toHistory(await loadTranscript(20));
  await saveMessage("user", question);

  try {
    const turn = await ask(question, history);
    await saveMessage("assistant", turn.reply, turn.toolCalls);
    return Response.json({ reply: turn.reply, toolCalls: turn.toolCalls });
  } catch (err) {
    if (err instanceof NoModelError) {
      return Response.json(
        {
          error:
            "The desk needs an ANTHROPIC_API_KEY in .env.local before it can hold a conversation.",
        },
        { status: 503 }
      );
    }
    if (err instanceof BudgetExhaustedError || err instanceof CommitteeBudgetError) {
      return Response.json({ error: err.message }, { status: 429 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "the desk could not answer" },
      { status: 500 }
    );
  }
}
