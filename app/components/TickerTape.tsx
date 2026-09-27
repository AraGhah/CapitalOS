import Link from "next/link";
import { getTape, type TapeRow } from "@/lib/desk";

// The list is rendered twice inside one track so the marquee can loop from 0 to
// -50% without ever showing a gap.
export async function TickerTape() {
  let rows: TapeRow[] = [];
  try {
    rows = await getTape();
  } catch {
    // No database reachable yet — the tape is decoration, so it stays quiet
    // rather than taking the whole page down with it.
    return null;
  }

  const priced = rows.filter((r) => r.close !== null);
  if (priced.length === 0) return null;

  return (
    <div className="tape" aria-label="Tracked tickers">
      <div className="tape-track">
        {[0, 1].map((copy) => (
          <div key={copy} style={{ display: "flex" }} aria-hidden={copy === 1}>
            {priced.map((row) => (
              <Link key={`${copy}-${row.ticker}`} href={`/research/${row.ticker}`} className="tape-item">
                <span className="sym">{row.ticker}</span>
                <span className="px">{row.close!.toFixed(2)}</span>
                {row.changePct !== null && (
                  <span className={`px ${row.changePct >= 0 ? "up" : "down"}`}>
                    {row.changePct >= 0 ? "+" : ""}
                    {row.changePct.toFixed(2)}%
                  </span>
                )}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
