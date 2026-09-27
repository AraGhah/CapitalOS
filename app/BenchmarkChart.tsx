"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SeriesPoint } from "@/lib/timeseries";
import { BENCHMARK_TICKER } from "@/lib/constants";

// Colours come from the same CSS variables as the rest of the interface, so the
// chart re-themes with everything else instead of keeping its own palette.
export function BenchmarkChart({ data }: { data: SeriesPoint[] }) {
  if (data.length === 0) {
    return (
      <p className="missing">
        Not enough price history to chart yet — run <code>npm run fetch-prices</code>.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id="cos-portfolio" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "var(--faint)" }}
          stroke="var(--border)"
          minTickGap={48}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--faint)" }}
          stroke="var(--border)"
          domain={["auto", "auto"]}
          width={52}
        />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
            boxShadow: "var(--shadow-lift)",
          }}
          labelStyle={{ color: "var(--muted)" }}
          itemStyle={{ color: "var(--text)" }}
          formatter={(value) => (typeof value === "number" ? value.toFixed(1) : String(value))}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} iconType="plainline" />
        <Area
          type="monotone"
          dataKey="portfolioIndex"
          name="Portfolio"
          stroke="var(--accent)"
          strokeWidth={2}
          fill="url(#cos-portfolio)"
          dot={false}
        />
        <Area
          type="monotone"
          dataKey="benchmarkIndex"
          name={BENCHMARK_TICKER}
          stroke="var(--faint)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          fill="none"
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
