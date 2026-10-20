import { Suspense } from "react";
import { requirePageActor } from "@/lib/auth/current";
import { SentimentBenchmarkPanel } from "@/app/components/SentimentBenchmarkPanel";
import { SentimentStudyPanel } from "@/app/components/SentimentStudyPanel";

export const dynamic = "force-dynamic";

export default async function SentimentPage() {
  await requirePageActor();

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Intelligence · how far the headline labels can be trusted</p>
          <h1>Sentiment Lab</h1>
        </div>
      </div>

      <div className="stack">
        <SentimentBenchmarkPanel />

        <Suspense
          fallback={
            <section className="panel" id="study">
              <div className="panel-head">
                <h2>Did the labels line up with the stock?</h2>
              </div>
              <p className="missing" style={{ padding: "0.9rem" }}>
                Reading the labelled headlines and the prices around them…
              </p>
            </section>
          }
        >
          <SentimentStudyPanel />
        </Suspense>
      </div>
    </div>
  );
}
