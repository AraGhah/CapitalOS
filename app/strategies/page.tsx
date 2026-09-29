import Link from "next/link";
import { BACKTEST_METRICS, PRESETS } from "@/lib/strategy/backtest";
import { METRICS } from "@/lib/scanner";
import { BacktestLab } from "@/app/components/BacktestLab";

export const dynamic = "force-dynamic";

export default function StrategiesPage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Strategies · backtesting lab</p>
          <h1>Backtesting Lab</h1>
        </div>
        <Link href="/risk" className="chip">
          Scenario simulator →
        </Link>
      </div>

      <div className="split">
        <BacktestLab
          presets={PRESETS}
          metrics={BACKTEST_METRICS.map((k) => ({ key: k, label: METRICS[k].label, unit: METRICS[k].unit }))}
        />

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>No peeking</h2>
            </div>
            <div className="panel-body stack-sm subtle">
              <p>
                On each rebalance date a company&apos;s annual figures count only once the 10-K reporting them had been
                filed — a restatement only from the day it was filed. Momentum, 52-week highs and the 200-day average use
                closes up to that day and no further.
              </p>
              <p>
                Every trade pays commission and slippage on the dollars that change hands. Money not invested sits in
                cash at zero.
              </p>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2>What it cannot fix</h2>
            </div>
            <div className="panel-body stack-sm subtle">
              <p>
                The universe is the companies on the desk today. The ones that failed along the way are missing, which
                makes any strategy on today&apos;s survivors look better than it would have been.
              </p>
              <p>
                A good backtest is a reason to research a strategy further, not a forecast. Try it on{" "}
                <Link href="/paper">paper</Link> before money.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
