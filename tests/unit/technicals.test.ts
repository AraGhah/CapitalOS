import { describe, expect, it } from "vitest";
import { atr, bollinger, ema, macd, rsi, sma, technicalSnapshot, vwma, type OhlcvBar } from "../../lib/technicals";

const bar = (i: number, close: number, extra: Partial<OhlcvBar> = {}): OhlcvBar => ({
  date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1000,
  ...extra,
});

// Deterministic pseudo-random walk, so a failure reproduces.
function walk(n: number, seed = 7, start = 100): OhlcvBar[] {
  let s = seed;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let price = start;
  return Array.from({ length: n }, (_, i) => {
    price = Math.max(1, price * (1 + (next() - 0.48) * 0.03));
    const close = Number(price.toFixed(2));
    return {
      date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
      open: close,
      high: Number((close * 1.01).toFixed(2)),
      low: Number((close * 0.99).toFixed(2)),
      close,
      volume: 1_000_000 + Math.floor(next() * 500_000),
    };
  });
}

describe("moving averages", () => {
  it("sma averages the window and warms up with nulls", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("ema is seeded with the simple average, then smooths with 2 / (n + 1)", () => {
    // seed (1+2+3)/3 = 2; alpha 0.5; 3 → 2 + 0.5 * (4 - 2); 5.5 → 3 + 0.5 * (8 - 3)
    expect(ema([1, 2, 3, 4, 8], 3)).toEqual([null, null, 2, 3, 5.5]);
  });

  it("returns all nulls when the history is shorter than the period", () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });

  it("refuses a period that is not a positive integer", () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => ema([1, 2, 3], 2.5)).toThrow(RangeError);
  });
});

describe("rsi", () => {
  // The closes of the worked example that is widely published for Wilder's
  // RSI. Its printed table is rounded along the way (70.53 for the first
  // value); the exact figure is derived by hand below.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22,
    45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
  ];

  it("derives the first value from the first 14 changes, by hand", () => {
    // gains .06 + .72 + .50 + .27 + .32 + .42 + .24 + .14 + .67 = 3.34; losses .25 + .54 + .19 + .42 = 1.40
    const out = rsi(closes, 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(out[14]).toBeCloseTo(100 - 100 / (1 + 3.34 / 1.4), 8);
    // the published table agrees to within its own rounding
    expect(out[14]).toBeCloseTo(70.53, 0);
  });

  it("smooths the way Wilder describes: (previous average * 13 + today) / 14", () => {
    // an independent, plainly written reference
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d / 14;
      else avgLoss += -d / 14;
    }
    const expected: number[] = [100 - 100 / (1 + avgGain / avgLoss)];
    for (let i = 15; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
      avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
      expected.push(100 - 100 / (1 + avgGain / avgLoss));
    }
    const out = rsi(closes, 14).slice(14);
    expect(out).toHaveLength(expected.length);
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
  });

  it("is 100 when nothing fell, 0 when nothing rose and 50 when nothing moved", () => {
    const up = Array.from({ length: 20 }, (_, i) => 10 + i);
    const down = [...up].reverse();
    expect(rsi(up).at(-1)).toBe(100);
    expect(rsi(down).at(-1)).toBe(0);
    expect(rsi(new Array(20).fill(10)).at(-1)).toBe(50);
  });

  it("stays between 0 and 100 on a random walk", () => {
    for (const v of rsi(walk(300).map((b) => b.close))) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("macd", () => {
  it("is zero on a flat series, with the line from the slow period and the signal nine sessions later", () => {
    const out = macd(new Array(60).fill(50));
    expect(out.line.findIndex((v) => v !== null)).toBe(25);
    expect(out.signal.findIndex((v) => v !== null)).toBe(33);
    expect(out.line.at(-1)).toBeCloseTo(0, 10);
    expect(out.histogram.at(-1)).toBeCloseTo(0, 10);
  });

  it("is positive when the price has been rising", () => {
    const out = macd(Array.from({ length: 80 }, (_, i) => 100 + i));
    expect(out.line.at(-1)!).toBeGreaterThan(0);
  });

  it("refuses a fast period that is not shorter than the slow one", () => {
    expect(() => macd([1, 2, 3], 26, 12)).toThrow(RangeError);
  });

  it("histogram is line minus signal", () => {
    const closes = walk(120).map((b) => b.close);
    const out = macd(closes);
    const i = closes.length - 1;
    expect(out.histogram[i]!).toBeCloseTo(out.line[i]! - out.signal[i]!, 10);
  });
});

describe("bollinger", () => {
  it("uses the population standard deviation", () => {
    const out = bollinger([1, 2, 3, 4, 5], 5, 2);
    expect(out.middle[4]).toBe(3);
    // variance (4 + 1 + 0 + 1 + 4) / 5 = 2
    expect(out.upper[4]).toBeCloseTo(3 + 2 * Math.SQRT2, 10);
    expect(out.lower[4]).toBeCloseTo(3 - 2 * Math.SQRT2, 10);
  });

  it("collapses to the average when the price does not move", () => {
    const out = bollinger(new Array(25).fill(8), 20, 2);
    expect(out.upper.at(-1)).toBe(8);
    expect(out.lower.at(-1)).toBe(8);
  });
});

describe("atr", () => {
  const bars: OhlcvBar[] = [
    { date: "d0", open: 10, high: 11, low: 9, close: 10, volume: 1 },
    { date: "d1", open: 10, high: 12, low: 9, close: 11, volume: 1 }, // TR 3
    { date: "d2", open: 11, high: 13, low: 10, close: 12, volume: 1 }, // TR 3
    { date: "d3", open: 12, high: 12, low: 8, close: 9, volume: 1 }, // TR 4 (low against the prior close)
    { date: "d4", open: 9, high: 10, low: 7, close: 8, volume: 1 }, // TR 3
  ];

  it("seeds with the mean of the first period's true ranges, then smooths (Wilder)", () => {
    const out = atr(bars, 3);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).toBeCloseTo(10 / 3, 10);
    expect(out[4]).toBeCloseTo(((10 / 3) * 2 + 3) / 3, 10);
  });

  it("re-seeds after a bar with no high or low instead of computing across the gap", () => {
    const gapped = bars.map((b, i) => (i === 3 ? { ...b, high: null, low: null } : b));
    const out = atr(gapped, 3);
    expect(out[3]).toBeNull();
    expect(out[4]).toBeNull();
  });
});

describe("vwma", () => {
  it("weights each close by its volume", () => {
    expect(vwma([10, 20], [1, 3], 2)).toEqual([null, 17.5]);
  });

  it("is null while any volume in the window is missing", () => {
    expect(vwma([10, 20, 30], [1, null, 3], 2)).toEqual([null, null, null]);
  });
});

describe("technicalSnapshot", () => {
  it("has nothing to say about fewer than two bars", () => {
    expect(technicalSnapshot([])).toBeNull();
    expect(technicalSnapshot([bar(0, 10)])).toBeNull();
  });

  it("leaves out what the history is too short for, and nothing else", () => {
    const s = technicalSnapshot(walk(30))!;
    expect(s.rsi14).not.toBeNull();
    expect(s.sma50).toBeNull();
    expect(s.sma200).toBeNull();
    expect(s.macd).toBeNull();
    expect(s.readings.trend).toBeNull();
    expect(s.bollinger).not.toBeNull();
  });

  it("fills every field from a year of bars", () => {
    const s = technicalSnapshot(walk(260))!;
    for (const value of [s.ema10, s.sma50, s.sma200, s.vsSma50, s.vsSma200, s.rsi14, s.atr14, s.atrPct, s.vwma20, s.volumeRatio]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(Number.isFinite(s.macd!.histogram)).toBe(true);
    expect(s.bollinger!.upper).toBeGreaterThan(s.bollinger!.lower);
    expect(s.asOf).toBe(walk(260).at(-1)!.date);
  });

  it("reads only the bars it is given: cutting the series cuts the reading", () => {
    const all = walk(260);
    const earlier = technicalSnapshot(all.slice(0, 220))!;
    const closes = all.slice(0, 220).map((b) => b.close);
    expect(earlier.asOf).toBe(all[219].date);
    expect(earlier.sma50).toBeCloseTo(closes.slice(-50).reduce((s, c) => s + c, 0) / 50, 10);
  });

  it("calls a steady climb an uptrend and a steady fall a downtrend", () => {
    const climb = Array.from({ length: 260 }, (_, i) => bar(i, 50 + i * 0.5));
    const fall = Array.from({ length: 260 }, (_, i) => bar(i, 200 - i * 0.5));
    expect(technicalSnapshot(climb)!.readings.trend).toBe("uptrend");
    expect(technicalSnapshot(fall)!.readings.trend).toBe("downtrend");
    expect(technicalSnapshot(climb)!.readings.rsiZone).toBe("overbought");
    expect(technicalSnapshot(fall)!.readings.rsiZone).toBe("oversold");
  });

  it("dates a golden cross by the sessions since it happened", () => {
    // flat for 200 sessions, then a climb that carries the 50-day over the 200-day
    const series = (n: number) =>
      Array.from({ length: n }, (_, i) => bar(i, i < 200 ? 100 : 100 + (i - 199) * 2));
    let first = -1;
    for (let n = 201; n <= 260; n++) {
      if (technicalSnapshot(series(n))!.smaCross?.sessionsAgo === 0) {
        first = n;
        break;
      }
    }
    expect(first).toBeGreaterThan(0);
    expect(technicalSnapshot(series(first))!.smaCross).toEqual({ kind: "golden", sessionsAgo: 0 });
    expect(technicalSnapshot(series(first + 5))!.smaCross).toEqual({ kind: "golden", sessionsAgo: 5 });
  });

  it("reports a death cross when the 50-day falls through the 200-day", () => {
    const series = (n: number) =>
      Array.from({ length: n }, (_, i) => bar(i, i < 200 ? 100 : Math.max(1, 100 - (i - 199) * 2)));
    const found = Array.from({ length: 60 }, (_, k) => technicalSnapshot(series(201 + k))!.smaCross).find((c) => c?.sessionsAgo === 0);
    expect(found?.kind).toBe("death");
  });

  it("measures today's volume against the 20 sessions before it, not against itself", () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i, 100, { volume: i === 39 ? 3000 : 1000 }));
    expect(technicalSnapshot(bars)!.volumeRatio).toBe(3);
  });

  it("has no volume ratio, and no VWMA, when volumes are missing", () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i, { volume: null }));
    const s = technicalSnapshot(bars)!;
    expect(s.volumeRatio).toBeNull();
    expect(s.vwma20).toBeNull();
  });
});
