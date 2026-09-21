"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SeriesPoint } from "@/lib/timeseries";

export function BenchmarkChart({ data }: { data: SeriesPoint[] }) {
  if (data.length === 0) {
    return <p>Not enough price history yet to chart this — run the price fetch script first.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={40} />
        <YAxis tick={{ fontSize: 12 }} domain={["auto", "auto"]} />
        <Tooltip />
        <Line type="monotone" dataKey="portfolioIndex" name="Portfolio" stroke="#1a7f37" dot={false} strokeWidth={2} />
        <Line type="monotone" dataKey="benchmarkIndex" name="SPY" stroke="#888888" dot={false} strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}
