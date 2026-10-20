import { benchmarkSummary, LABELS, type BenchmarkResult, type BenchmarkSummary } from "@/lib/sentiment/benchmark";

const pct = (n: number | null, digits = 1) => (n === null ? "—" : `${(n * 100).toFixed(digits)}%`);

const TONE = (accuracy: number) => (accuracy >= 0.85 ? "good" : accuracy >= 0.7 ? "warn" : "bad");

function Scores({ rows }: { rows: Array<{ split: string; n: number; result: BenchmarkResult }> }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Headlines</th>
          <th>Tagger</th>
          <th className="num">n</th>
          <th className="num">Accuracy</th>
          <th className="num">95% interval</th>
          <th className="num">Macro F1</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ split, n, result }) => (
          <tr key={`${split}|${result.name}`}>
            <td>{split}</td>
            <td>{result.name}</td>
            <td className="num">{n}</td>
            <td className="num">{pct(result.accuracy)}</td>
            <td className="num">
              {pct(result.interval[0])} – {pct(result.interval[1])}
            </td>
            <td className="num">{pct(result.macroF1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Confusion({ result }: { result: BenchmarkResult }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Reader said ↓ / tagger said →</th>
          {LABELS.map((l) => (
            <th key={l} className="num">
              {l}
            </th>
          ))}
          <th className="num">Recall</th>
          <th className="num">Precision</th>
        </tr>
      </thead>
      <tbody>
        {LABELS.map((expected) => (
          <tr key={expected}>
            <td>{expected}</td>
            {LABELS.map((got) => (
              <td key={got} className="num" style={expected === got ? { fontWeight: 600 } : undefined}>
                {result.confusion[expected][got]}
              </td>
            ))}
            <td className="num">{pct(result.perClass[expected].recall)}</td>
            <td className="num">{pct(result.perClass[expected].precision)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// How the rule-based headline tagger scores against headlines labelled by hand.
// Pure over the summary, so it renders without a database; nothing here asks a
// model or a feed for anything.
export function SentimentBenchmarkView({ summary }: { summary: BenchmarkSummary }) {
  const { heldOut, dev } = summary;
  const result = heldOut.rules;

  return (
    <section className="panel" id="benchmark">
      <div className="panel-head">
        <h2>Labelling accuracy</h2>
        <span className="hint">{heldOut.n + dev.n} hand-labelled headlines · no model is asked</span>
      </div>
      <div className="panel-body stack-sm">
        <p>
          <span className={`pill ${TONE(result.accuracy)}`}>{pct(result.accuracy)} on headlines it was not fitted to</span>{" "}
          <span className="pill info">
            interval {pct(result.interval[0], 0)} – {pct(result.interval[1], 0)}
          </span>{" "}
          <span className="pill">old word list {pct(heldOut.wordList.accuracy, 0)}</span>{" "}
          <span className="pill">guessing the commonest label {pct(heldOut.majority, 0)}</span>
        </p>
        <p>
          The desk labels each headline bullish, neutral or bearish with a fixed set of rules (negation, &ldquo;but&rdquo; and
          &ldquo;despite&rdquo; clauses, hypotheticals, percentage moves, the direction of the thing that moved) and no model. Scored
          against {heldOut.n} headlines it was not fitted to, it agrees with the hand label {pct(result.accuracy, 0)} of the time, with a macro F1 of{" "}
          {pct(result.macroF1, 0)}. The word list it replaced agrees {pct(heldOut.wordList.accuracy, 0)} of the time, mostly by calling things neutral.
        </p>

        <Scores
          rows={[
            { split: "held out", n: heldOut.n, result: heldOut.rules },
            { split: "held out", n: heldOut.n, result: heldOut.wordList },
            { split: "development", n: dev.n, result: dev.rules },
            { split: "development", n: dev.n, result: dev.wordList },
          ]}
        />

        <h3>Where the held-out headlines went</h3>
        <Confusion result={result} />

        <h3>By kind of headline</h3>
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th className="num">Headlines</th>
              <th className="num">Rules</th>
              <th className="num">Word list</th>
            </tr>
          </thead>
          <tbody>
            {result.byKind.map((k) => (
              <tr key={k.kind}>
                <td>{k.kind}</td>
                <td className="num">{k.n}</td>
                <td className="num">{pct(k.accuracy, 0)}</td>
                <td className="num">{pct(heldOut.wordList.byKind.find((w) => w.kind === k.kind)?.accuracy ?? null, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {result.misses.length > 0 && (
          <>
            <h3>The {result.misses.length} it got wrong</h3>
            <ul className="stack-sm">
              {result.misses.map((m) => (
                <li key={m.title}>
                  {m.title}
                  <br />
                  <span className="subtle">
                    read as {m.expected}, tagged {m.got}
                    {m.why ? ` · ${m.why}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="subtle">
          Read this as an upper bound. The headlines were written by the same hands as the rules, so the rules were shaped by the kind of
          sentence the author thinks of. The first fresh set scored 83% before any vocabulary was added for it; those headlines then joined
          the development set, and the held-out set above was written afterwards and scored once. Treat 83% as the cautious figure.{" "}
          <code>npm run benchmark-sentiment -- --gold=yours.json</code> scores the rules on headlines you label yourself, which is the number
          worth trusting.
        </p>
      </div>
    </section>
  );
}

// No database and no outside call, so this is not wrapped in Suspense.
export function SentimentBenchmarkPanel() {
  return <SentimentBenchmarkView summary={benchmarkSummary()} />;
}
