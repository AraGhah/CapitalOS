/* ---------------------------------------------------------------------------
   Technical indicators, computed by code.

   The market analyst in TauricResearch/TradingAgents picks indicators for a
   model to read; here the same set — moving averages, MACD, RSI, Bollinger
   bands, ATR, VWMA and volume — is computed from the stored bars and handed to
   the committee as evidence, so no model ever produces one of these figures.

   Everything here is pure: bars in, numbers out, no clock, no network, no
   database. Every function sees only the bars it is given, so calling it with
   the bars up to a date is a point-in-time reading. A series is returned the
   same length as its input, with null where the indicator has not warmed up.

   Conventions (the textbook ones, as in TA-Lib):
   - EMA is seeded with the simple average of its first `period` values.
   - RSI and ATR use Wilder's smoothing.
   - Bollinger bands use the population standard deviation.
   - The thresholds below are conventions, not predictions.
--------------------------------------------------------------------------- */

export interface OhlcvBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export type Series = Array<number | null>;

export const THRESHOLDS = {
  rsiOverbought: 70,
  rsiOversold: 30,
  // a cross older than this many sessions is history, not a reading
  smaCrossWindow: 20,
  macdCrossWindow: 10,
} as const;

/* ------------------------------------------------------------- building blocks */

export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Seeded with the average of the first `period` values, then
// ema = prev + alpha * (value - prev) with alpha = 2 / (period + 1).
export function ema(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = prev + alpha * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

// Wilder's relative strength index. A window with no losses is 100, and one
// with no movement at all is 50 rather than a division by zero.
export function rsi(closes: readonly number[], period = 14): Series {
  assertPeriod(period);
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  out[period] = rsiOf(gain, loss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (change > 0 ? change : 0)) / period;
    loss = (loss * (period - 1) + (change < 0 ? -change : 0)) / period;
    out[i] = rsiOf(gain, loss);
  }
  return out;
}

function rsiOf(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface MacdSeries {
  line: Series;
  signal: Series;
  histogram: Series;
}

export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  if (fast >= slow) throw new RangeError("the fast period must be shorter than the slow one");
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line: Series = closes.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null ? (fastEma[i] as number) - (slowEma[i] as number) : null
  );

  // The signal line is an EMA of the MACD line from where that line begins.
  const first = line.findIndex((v) => v !== null);
  const signal: Series = new Array(closes.length).fill(null);
  if (first >= 0) {
    const tail = ema(line.slice(first) as number[], signalPeriod);
    tail.forEach((v, i) => {
      signal[first + i] = v;
    });
  }
  const histogram: Series = line.map((v, i) => (v !== null && signal[i] !== null ? v - (signal[i] as number) : null));
  return { line, signal, histogram };
}

export interface BollingerSeries {
  middle: Series;
  upper: Series;
  lower: Series;
}

export function bollinger(closes: readonly number[], period = 20, width = 2): BollingerSeries {
  assertPeriod(period);
  const middle = sma(closes, period);
  const upper: Series = new Array(closes.length).fill(null);
  const lower: Series = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i] as number;
    let squares = 0;
    for (let j = i - period + 1; j <= i; j++) squares += (closes[j] - mean) ** 2;
    const deviation = Math.sqrt(squares / period);
    upper[i] = mean + width * deviation;
    lower[i] = mean - width * deviation;
  }
  return { middle, upper, lower };
}

// Average true range, Wilder-smoothed. A bar with no high or low breaks the
// chain, so the average is re-seeded from `period` complete bars after it
// rather than computed across a gap.
export function atr(bars: readonly OhlcvBar[], period = 14): Series {
  assertPeriod(period);
  const out: Series = new Array(bars.length).fill(null);
  let run: number[] = [];
  let prevAtr: number | null = null;

  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i];
    const prevClose = bars[i - 1].close;
    if (high === null || low === null) {
      run = [];
      prevAtr = null;
      continue;
    }
    const range = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    if (prevAtr === null) {
      run.push(range);
      if (run.length === period) {
        prevAtr = run.reduce((s, v) => s + v, 0) / period;
        out[i] = prevAtr;
      }
    } else {
      prevAtr = (prevAtr * (period - 1) + range) / period;
      out[i] = prevAtr;
    }
  }
  return out;
}

// Volume-weighted moving average. Null while any bar in the window has no volume.
export function vwma(closes: readonly number[], volumes: ReadonlyArray<number | null>, period = 20): Series {
  assertPeriod(period);
  const out: Series = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let weighted = 0;
    let total = 0;
    let complete = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = volumes[j];
      if (v === null || v === undefined) {
        complete = false;
        break;
      }
      weighted += closes[j] * v;
      total += v;
    }
    if (complete && total > 0) out[i] = weighted / total;
  }
  return out;
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`period must be a positive integer, got ${period}`);
}

/* ------------------------------------------------------------------ snapshot */

export interface Cross {
  kind: "golden" | "death" | "bullish" | "bearish";
  sessionsAgo: number;
}

export type Trend = "uptrend" | "downtrend" | "mixed";
export type RsiZone = "overbought" | "oversold" | "neutral";
export type BandPosition = "above the upper band" | "below the lower band" | "upper half of the bands" | "lower half of the bands";

export interface TechnicalSnapshot {
  asOf: string;
  sessions: number;
  last: number;
  ema10: number | null;
  sma50: number | null;
  sma200: number | null;
  // last close against each average, as a ratio (0.05 = 5% above)
  vsSma50: number | null;
  vsSma200: number | null;
  rsi14: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  bollinger: {
    middle: number;
    upper: number;
    lower: number;
    // 0 at the lower band, 1 at the upper band
    percentB: number | null;
    // band width as a share of the middle band
    bandwidth: number | null;
  } | null;
  atr14: number | null;
  atrPct: number | null;
  vwma20: number | null;
  // the last session's volume against the average of the 20 before it
  volumeRatio: number | null;
  smaCross: Cross | null;
  macdCross: Cross | null;
  readings: {
    trend: Trend | null;
    rsiZone: RsiZone | null;
    macdMomentum: "bullish" | "bearish" | null;
    // whether the MACD histogram is above or below the one before it
    macdSlope: "rising" | "falling" | null;
    bandPosition: BandPosition | null;
  };
}

const at = (series: Series, i: number): number | null => (i >= 0 && i < series.length ? series[i] : null);

// The most recent sign change of (a − b) inside the window, if there is one.
function lastCross(a: Series, b: Series, window: number, up: Cross["kind"], down: Cross["kind"]): Cross | null {
  const end = a.length - 1;
  for (let back = 0; back < window; back++) {
    const i = end - back;
    const now = diff(a, b, i);
    const before = diff(a, b, i - 1);
    if (now === null || before === null) return null;
    if (before <= 0 && now > 0) return { kind: up, sessionsAgo: back };
    if (before >= 0 && now < 0) return { kind: down, sessionsAgo: back };
  }
  return null;
}

function diff(a: Series, b: Series, i: number): number | null {
  const x = at(a, i);
  const y = at(b, i);
  return x === null || y === null ? null : x - y;
}

// The latest reading of every indicator, from bars oldest first. An indicator
// the history is too short for is null, never a guess.
export function technicalSnapshot(bars: readonly OhlcvBar[]): TechnicalSnapshot | null {
  if (bars.length < 2) return null;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const n = bars.length - 1;
  const last = closes[n];

  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const macdSeries = macd(closes);
  const bands = bollinger(closes);
  const atrSeries = atr(bars);
  const rsiSeries = rsi(closes);

  const sma50Now = sma50[n];
  const sma200Now = sma200[n];
  const atrNow = atrSeries[n];

  const macdNow =
    macdSeries.line[n] !== null && macdSeries.signal[n] !== null
      ? { line: macdSeries.line[n] as number, signal: macdSeries.signal[n] as number, histogram: macdSeries.histogram[n] as number }
      : null;

  const upper = bands.upper[n];
  const lower = bands.lower[n];
  const middle = bands.middle[n];
  const bollingerNow =
    upper !== null && lower !== null && middle !== null
      ? {
          middle,
          upper,
          lower,
          percentB: upper > lower ? (last - lower) / (upper - lower) : null,
          bandwidth: middle !== 0 ? (upper - lower) / middle : null,
        }
      : null;

  // Today's volume against the 20 sessions before it, so a spike is not
  // averaged into its own baseline.
  let volumeRatio: number | null = null;
  const today = volumes[n];
  const prior = volumes.slice(Math.max(0, n - 20), n);
  if (today !== null && prior.length === 20 && prior.every((v) => v !== null)) {
    const mean = (prior as number[]).reduce((s, v) => s + v, 0) / 20;
    if (mean > 0) volumeRatio = today / mean;
  }

  const rsiNow = rsiSeries[n];
  const prevHistogram = macdSeries.histogram[n - 1];

  const trend: Trend | null =
    sma50Now !== null && sma200Now !== null
      ? last > sma50Now && sma50Now > sma200Now
        ? "uptrend"
        : last < sma50Now && sma50Now < sma200Now
          ? "downtrend"
          : "mixed"
      : null;

  const percentB = bollingerNow?.percentB ?? null;

  return {
    asOf: bars[n].date,
    sessions: bars.length,
    last,
    ema10: ema(closes, 10)[n],
    sma50: sma50Now,
    sma200: sma200Now,
    vsSma50: sma50Now !== null && sma50Now !== 0 ? last / sma50Now - 1 : null,
    vsSma200: sma200Now !== null && sma200Now !== 0 ? last / sma200Now - 1 : null,
    rsi14: rsiNow,
    macd: macdNow,
    bollinger: bollingerNow,
    atr14: atrNow,
    atrPct: atrNow !== null && last !== 0 ? atrNow / last : null,
    vwma20: vwma(closes, volumes, 20)[n],
    volumeRatio,
    smaCross: lastCross(sma50, sma200, THRESHOLDS.smaCrossWindow, "golden", "death"),
    macdCross: lastCross(macdSeries.line, macdSeries.signal, THRESHOLDS.macdCrossWindow, "bullish", "bearish"),
    readings: {
      trend,
      rsiZone:
        rsiNow === null
          ? null
          : rsiNow >= THRESHOLDS.rsiOverbought
            ? "overbought"
            : rsiNow <= THRESHOLDS.rsiOversold
              ? "oversold"
              : "neutral",
      macdMomentum: macdNow === null ? null : macdNow.histogram >= 0 ? "bullish" : "bearish",
      macdSlope:
        macdNow === null || prevHistogram === null || prevHistogram === undefined || macdNow.histogram === prevHistogram
          ? null
          : macdNow.histogram > prevHistogram
            ? "rising"
            : "falling",
      bandPosition:
        percentB === null
          ? null
          : percentB > 1
            ? "above the upper band"
            : percentB < 0
              ? "below the lower band"
              : percentB >= 0.5
                ? "upper half of the bands"
                : "lower half of the bands",
    },
  };
}
