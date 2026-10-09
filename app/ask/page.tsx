import { AskTheDesk } from "@/app/components/AskTheDesk";
import { hasModel } from "@/lib/llm";

export const dynamic = "force-dynamic";

export default async function AskPage({ searchParams }: PageProps<"/ask">) {
  const { q } = await searchParams;
  const question = typeof q === "string" ? q : undefined;

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Every answer names the tools and the AI models behind it</p>
          <h1>Capital Copilot</h1>
        </div>
      </div>

      {!hasModel() && (
        <p className="alert" style={{ marginBottom: "1rem" }}>
          No <code>ANTHROPIC_API_KEY</code> in <code>.env.local</code> — the desk can gather news and
          score companies without one, but it cannot hold a conversation.
        </p>
      )}

      <AskTheDesk initialQuestion={question} />
    </div>
  );
}
