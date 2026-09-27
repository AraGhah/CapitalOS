/* ---------------------------------------------------------------------------
   The ring reports coverage, not confidence. A model's own certainty score is
   unfalsifiable; how many of the expected inputs actually arrived is a count.
--------------------------------------------------------------------------- */

export function CoverageRing({
  present,
  expected,
  size = 62,
  label = "inputs retrieved",
}: {
  present: number;
  expected: number;
  size?: number;
  label?: string;
}) {
  const share = expected > 0 ? Math.min(1, present / expected) : 0;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="ring">
      <svg width={size} height={size} role="img" aria-label={`${present} of ${expected} ${label}`}>
        <circle
          className="track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - share)}
        />
      </svg>
      <div>
        <div className="ring-label">
          {present}
          <span style={{ color: "var(--faint)" }}>/{expected}</span>
        </div>
        <div className="ring-sub">{label}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Where a company sits against its sector. The marker slides to its new spot
   each time the scorer runs, which is the only thing that can move it.
--------------------------------------------------------------------------- */

export function PercentileGauge({
  percentile,
  low = "weakest in sector",
  high = "strongest",
}: {
  percentile: number | null;
  low?: string;
  high?: string;
}) {
  if (percentile === null) {
    return <p className="missing">Not scored yet.</p>;
  }

  const clamped = Math.max(0, Math.min(100, percentile));

  return (
    <div className="gauge">
      <div
        className="gauge-bar"
        role="img"
        aria-label={`${clamped.toFixed(0)} of 100 against its sector`}
      >
        <span className="gauge-mark" style={{ left: `${clamped}%` }} />
      </div>
      <div className="gauge-scale">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

export function Meter({ share }: { share: number }) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  return (
    <span className="meter" aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/* ---------------------------------------------------------------------------
   The desk's own pipeline: what each stage has produced, and where it stopped.
   The connecting line fills as a stage completes, handing off to the next.
--------------------------------------------------------------------------- */

export interface Stage {
  name: string;
  count: number;
}

export function Pipeline({ stages }: { stages: Stage[] }) {
  const firstEmpty = stages.findIndex((s) => s.count === 0);

  function stateOf(index: number): string {
    if (firstEmpty === -1) return "done";
    if (index < firstEmpty) return "done";
    if (index === firstEmpty) return "active";
    return "";
  }

  return (
    <div className="stages">
      {stages.map((stage, i) => (
        <div key={stage.name} style={{ display: "contents" }}>
          {i > 0 && (
            <div className="stage-link">
              <span style={{ width: stateOf(i) === "" ? "0%" : "100%" }} />
            </div>
          )}
          <div className={`stage ${stateOf(i)}`.trim()}>
            <span className="bead" />
            <span className="name">{stage.name}</span>
            <span className="count">{stage.count === 0 ? "—" : stage.count.toLocaleString()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
