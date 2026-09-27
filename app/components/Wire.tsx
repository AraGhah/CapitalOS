"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { domainOf } from "@/lib/format";

export interface WireItem {
  id: string;
  title: string;
  url: string;
  ago: string;
  ticker?: string;
  // how many outlets carried the story, where the wire is built from event clusters
  sourceCount?: number;
  // how the analyst labelled it, where the wire is built from tagged headlines
  sentiment?: "bullish" | "neutral" | "bearish" | null;
  feed?: string;
}

// The full feed, filterable by outlet. Relative times arrive already formatted
// from the server so the markup the browser gets is the markup it keeps.
export function Wire({ items, filterable = true }: { items: WireItem[]; filterable?: boolean }) {
  const [outlet, setOutlet] = useState<string | null>(null);

  const outlets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const d = domainOf(item.url);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [items]);

  const shown = outlet ? items.filter((i) => domainOf(i.url) === outlet) : items;

  if (items.length === 0) {
    return (
      <p className="missing" style={{ padding: "0.9rem" }}>
        Nothing on the wire yet — run <code>npm run ingest-news</code>.
      </p>
    );
  }

  return (
    <>
      {filterable && outlets.length > 1 && (
        <div className="filters" style={{ padding: "0.7rem 0.9rem", borderBottom: "1px solid var(--border)" }}>
          <button type="button" className="chip" aria-pressed={outlet === null} onClick={() => setOutlet(null)}>
            All {items.length}
          </button>
          {outlets.slice(0, 8).map(([domain, count]) => (
            <button
              key={domain}
              type="button"
              className="chip"
              aria-pressed={outlet === domain}
              onClick={() => setOutlet(outlet === domain ? null : domain)}
            >
              {domain} {count}
            </button>
          ))}
        </div>
      )}

      <ul className="wire">
        {shown.map((item) => {
          const domain = domainOf(item.url);
          return (
            <li key={item.id}>
              <span className="favicon" title={domain}>
                {domain.slice(0, 1)}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
                  alt=""
                  loading="lazy"
                  width={20}
                  height={20}
                />
              </span>
              <div className="body">
                <a className="headline" href={item.url} target="_blank" rel="noreferrer">
                  {item.title}
                </a>
                <div className="meta">
                  {item.ticker && (
                    <Link href={`/research/${item.ticker}`} className="sym">
                      {item.ticker}
                    </Link>
                  )}
                  <span>{domain}</span>
                  <span>·</span>
                  <span>{item.ago}</span>
                  {item.sourceCount !== undefined && (
                    <>
                      <span>·</span>
                      {/* Coverage, not confidence: how many outlets ran this story. */}
                      <span title="outlets that carried this story">
                        {item.sourceCount} {item.sourceCount === 1 ? "outlet" : "outlets"}
                      </span>
                    </>
                  )}
                  {item.feed && (
                    <>
                      <span>·</span>
                      <span>{item.feed}</span>
                    </>
                  )}
                  {item.sentiment && <span className={`tag ${item.sentiment}`}>{item.sentiment}</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
