"use client";

import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface PricePoint {
  date: string;
  close: number | null;
  low: number | null;
  range: number | null; // high − low, stacked on low to shade the day's range
}

// A month of bars: the close as a line, the high-to-low range shaded behind it.
// The range is carried as a height above the low because that is what a stacked
// area needs, and it keeps both ends of the bar honest.
export function PriceChart({ data, up }: { data: PricePoint[]; up: boolean }) {
  if (data.length < 2) {
    return (
      <p className="missing">
        No price history stored — run <code>npm run fetch-prices</code>.
      </p>
    );
  }

  const line = up ? "var(--up)" : "var(--down)";

  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
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
          formatter={(value, name) => {
            const shown = typeof value === "number" ? value.toFixed(2) : String(value);
            return [shown, name === "range" ? "high − low" : String(name)];
          }}
        />
        <Area
          type="monotone"
          dataKey="low"
          stackId="band"
          stroke="none"
          fill="transparent"
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="range"
          stackId="band"
          stroke="none"
          fill={line}
          fillOpacity={0.12}
          isAnimationActive={false}
        />
        <Line type="monotone" dataKey="close" name="Close" stroke={line} strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
