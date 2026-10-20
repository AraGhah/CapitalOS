import { Suspense } from "react";
import { requirePageActor } from "@/lib/auth/current";
import { PlanCheckPanel, TrackRecordPanel } from "@/app/components/TrackPanels";

export const dynamic = "force-dynamic";

export default async function TrackPage() {
  const { actor } = await requirePageActor();

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Intelligence · how the desk&rsquo;s own calls have turned out</p>
          <h1>Track Record</h1>
        </div>
      </div>

      <div className="stack">
        <Suspense
          fallback={
            <section className="panel" id="track">
              <div className="panel-head">
                <h2>Track record</h2>
              </div>
              <p className="missing" style={{ padding: "0.9rem" }}>
                Measuring your decisions against what the stocks did…
              </p>
            </section>
          }
        >
          <TrackRecordPanel userId={actor.userId} />
        </Suspense>

        <Suspense
          fallback={
            <section className="panel" id="plan-check">
              <div className="panel-head">
                <h2>Do the plan&rsquo;s stops and reward levels hold up?</h2>
              </div>
              <p className="missing" style={{ padding: "0.9rem" }}>
                Walking the plan through the stored price history…
              </p>
            </section>
          }
        >
          <PlanCheckPanel />
        </Suspense>
      </div>
    </div>
  );
}
