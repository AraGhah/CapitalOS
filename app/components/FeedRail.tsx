import type { FeedStatus } from "@/lib/desk";

// One row per feed, showing what it has delivered. A feed with nothing stored
// says so plainly instead of showing a zero that could equally mean "fetched and
// found nothing" or "never ran".
export function FeedRail({ feeds }: { feeds: FeedStatus[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Feeds</h2>
        <span className="hint">what is stored</span>
      </div>
      <ul className="rail">
        {feeds.map((feed) => (
          <li key={feed.name}>
            <span
              className="dot idle"
              style={{ background: feed.count > 0 ? "var(--up)" : "var(--faint)" }}
            />
            <span className="feed-name" title={feed.detail}>
              {feed.name}
            </span>
            {feed.count > 0 ? (
              <span className="count" title={feed.latest ? `through ${feed.latest}` : undefined}>
                {feed.count.toLocaleString()}
              </span>
            ) : (
              <span className="count offline">offline</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
