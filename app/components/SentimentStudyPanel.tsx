import { sentimentStudy, type Labeller, type SentimentStudyRead } from "@/lib/sentiment/data";
import { STUDY_RULES, type Group, type StudyResult, type Verdict, type Window } from "@/lib/sentiment/study";
import type { Sentiment } from "@/lib/sentiment";

const ORDER: readonly Sentiment[] = ["bullish", "neutral", "bearish"];
const VERDICT_TONE: Record<Verdict, string> = { followed: "good", reversed: "bad", no_difference: "info", not_enough: "" };
const VERDICT_LABEL: Record<Verdict, string> = {
  followed: "bullish days did better",
  reversed: "bullish days did worse",
  no_difference: "no reliable difference",
  not_enough: "not enough days",
};

const pct = (n: number | null, digits = 2) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(digits)}%`);
const share = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);

function Row({ label, group }: { label: Sentiment; group: Group }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{group.n}</td>
      <td className="num">{pct(group.mean)}</td>
      <td className="num">{group.se === null ? "—" : `±${(group.se * 100).toFixed(2)}%`}</td>
      <td className="num">{share(group.positive)}</td>
    </tr>
  );
}

function WindowTable({ window }: { window: Window }) {
  return (
    <div className="stack-sm">
      <p>
        <strong>{window.label}</strong>{" "}
        {window.concurrent ? (
          <span className="pill">concurrent: shown, not tested</span>
        ) : (
          <span className={`pill ${VERDICT_TONE[window.verdict]}`}>{VERDICT_LABEL[window.verdict]}</span>
        )}
      </p>
      <table>
        <thead>
          <tr>
            <th>News that day</th>
            <th className="num">Days</th>
            <th className="num">Mean return less the market</th>
            <th className="num">Std. error</th>
            <th className="num">Beat the market</th>
          </tr>
        </thead>
        <tbody>
          {ORDER.map((label) => (
            <Row key={label} label={label} group={window.groups[label]} />
          ))}
        </tbody>
      </table>
      {!window.concurrent && window.spread && (
        <p className="subtle">
          Bullish days less bearish days: {pct(window.spread.value)} ± {(window.spread.se * 100).toFixed(2)}% (z = {window.spread.z.toFixed(1)}; the
          bar is {STUDY_RULES.z}).
        </p>
      )}
      {window.note && <p className="subtle">{window.note}</p>}
    </div>
  );
}

function Block({ title, headlines, study }: { title: string; headlines: number; study: StudyResult }) {
  return (
    <div className="stack-sm">
      <h3>
        {title} <span className="subtle">· {headlines} headlines</span>
      </h3>
      {study.status === "unmeasured" ? (
        <p className="missing">{study.reason}</p>
      ) : (
        <>
          <p className="subtle">
            {study.days} company-days across {study.companies} {study.companies === 1 ? "company" : "companies"}, {study.from} to {study.to}.
          </p>
          {study.windows.map((w) => (
            <WindowTable key={w.key} window={w} />
          ))}
        </>
      )}
    </div>
  );
}

const LABELLER_TITLE: Record<Labeller, string> = {
  rules: "Labelled by the rules",
  "word list": "Labelled by the old word list",
  model: "Labelled by a model",
};

// Whether the days the desk's news read bullish or bearish were followed by the
// stock doing better or worse than the market. Pure over the read, so it
// renders without a database.
export function SentimentStudyView({ read }: { read: SentimentStudyRead }) {
  const split = read.by.length > 1;

  return (
    <section className="panel" id="study">
      <div className="panel-head">
        <h2>Did the labels line up with the stock?</h2>
        <span className="hint">stored prices only</span>
      </div>
      <div className="panel-body stack-sm">
        <p>
          <span className="pill good">{read.byLabel.bullish} bullish</span> <span className="pill">{read.byLabel.neutral} neutral</span>{" "}
          <span className="pill bad">{read.byLabel.bearish} bearish</span>{" "}
          <span className="subtle">labelled headlines from the last 540 days</span>
        </p>

        {split ? (
          read.by.map((b) => <Block key={b.labeller} title={LABELLER_TITLE[b.labeller]} headlines={b.headlines} study={b.study} />)
        ) : (
          <Block title="All labelled headlines" headlines={read.headlines} study={read.all} />
        )}

        <p className="subtle">
          For each company and day, the news counts as bullish if it has more bullish headlines than bearish, bearish if more, neutral
          otherwise. The windows start at the close of the day the news appeared, so they leave out most of the reaction to it; the same-day
          row is shown for reading and is never the test. Returns are the stock&rsquo;s less the S&amp;P 500&rsquo;s, and a window that spans a
          split or a gap in the stored prices is dropped. A group needs {STUDY_RULES.minPerGroup} days before it is compared. The error bars
          assume each day is independent, which overlapping windows and news that moves a whole sector make untrue, so they are narrower than
          they should be. This measures the past; it is not a forecast, and the committee does not read it.
        </p>
      </div>
    </section>
  );
}

// Rendered inside Suspense: it reads every labelled headline and the closes
// around them from the database. No outside feed and no model is asked.
export async function SentimentStudyPanel() {
  let read;
  try {
    read = await sentimentStudy();
  } catch (err) {
    return (
      <section className="panel" id="study">
        <div className="panel-head">
          <h2>Did the labels line up with the stock?</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          The study could not be read: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }
  return <SentimentStudyView read={read} />;
}
