// A month of closes at thumbnail size. Flat or single-point series get a flat
// line rather than a divide-by-zero, and an empty one renders nothing at all.
export function Sparkline({
  values,
  width = 64,
  height = 18,
  tone,
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: "up" | "down" | "flat";
}) {
  if (values.length < 2) return <span className="subtle">—</span>;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pad = 1.5;
  const usable = height - pad * 2;

  const points = values
    .map((v, i) => `${(i * step).toFixed(2)},${(pad + usable - ((v - min) / span) * usable).toFixed(2)}`)
    .join(" ");

  const direction =
    tone ?? (values[values.length - 1] > values[0] ? "up" : values[values.length - 1] < values[0] ? "down" : "flat");
  const stroke =
    direction === "up" ? "var(--up)" : direction === "down" ? "var(--down)" : "var(--border-strong)";

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
