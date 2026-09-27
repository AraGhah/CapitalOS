import { getFeedStatus } from "@/lib/desk";
import { ageInDays } from "@/lib/format";

// The dot only breathes when the desk is actually holding fresh data. Anything
// older than a few days reads "stale", which is a fact about the last ingest run
// rather than a mood.
const FRESH_DAYS = 4;

export async function DeskStatus() {
  let latest: string | null = null;

  try {
    const feeds = await getFeedStatus();
    const dates = feeds.map((f) => f.latest).filter((d): d is string => Boolean(d));
    latest = dates.sort().at(-1) ?? null;
  } catch {
    return (
      <span className="live">
        <span className="dot idle" />
        no database
      </span>
    );
  }

  if (!latest) {
    return (
      <span className="live">
        <span className="dot idle" />
        empty
      </span>
    );
  }

  const fresh = ageInDays(latest) <= FRESH_DAYS;

  return (
    <span className="live" title={`Newest stored data: ${latest}`}>
      <span className={fresh ? "dot" : "dot idle"} />
      {fresh ? "live" : `stale · ${latest}`}
    </span>
  );
}
