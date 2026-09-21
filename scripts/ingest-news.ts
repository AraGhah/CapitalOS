import "../lib/env";
import { pool } from "../lib/db";
import { clusterArticles, embedTitles, fetchArticles, searchName, storeClusters } from "../lib/news";

function flag(name: string, fallback: string): string {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

async function main() {
  const timespan = flag("timespan", "7d");
  const threshold = Number(flag("threshold", "0.55"));
  const windowHours = Number(flag("window", "24"));

  const { rows: companies } = await pool.query(
    "SELECT id, ticker, name FROM companies WHERE active = true ORDER BY ticker"
  );

  for (const company of companies) {
    const query = searchName(company.name) || company.ticker;

    try {
      const articles = await fetchArticles(query, { timespan });
      if (articles.length === 0) {
        console.log(`${company.ticker}: no articles for "${query}"`);
        continue;
      }

      const { provider, vectorByUrl, vectors } = await embedTitles(articles, [query, company.ticker]);
      const clusters = clusterArticles(articles, vectors, { threshold, windowHours });
      const stored = await storeClusters(company.id, clusters, vectorByUrl);

      const largest = Math.max(...clusters.map((c) => c.members.length));
      console.log(
        `${company.ticker}: ${articles.length} articles -> ${stored.events} events ` +
          `(largest ${largest} sources, embeddings ${provider})`
      );
    } catch (err) {
      console.error(`${company.ticker}: ${(err as Error).message}`);
    }
  }

  await pool.end();
}

main();
