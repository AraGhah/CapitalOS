import type { NextRequest } from "next/server";
import {
  ask,
  clearTranscript,
  loadTranscript,
  saveMessage,
  toHistory,
} from "@/lib/chat";
import { hasModel, NoModelError } from "@/lib/llm";

export const dynamic = "force-dynamic";
// A committee convened from the chat can run several minutes.
export const maxDuration = 800;

export async function GET() {
  return Response.json({ messages: await loadTranscript(), model: hasModel() });
}

export async function DELETE() {
  await clearTranscript();
  return Response.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { question?: string };
  const question = body.question?.trim();

  if (!question) {
    return Response.json({ error: "ask something" }, { status: 400 });
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
    return Response.json(
      { error: err instanceof Error ? err.message : "the desk could not answer" },
      { status: 500 }
    );
  }
}
