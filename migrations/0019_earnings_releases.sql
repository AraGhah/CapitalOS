-- CapitalOS — the days companies announced their earnings
--
-- A 10-Q or 10-K can be filed weeks after the earnings press release, and the
-- market reacts to the press release. The date of the release is the 8-K filed
-- under Item 2.02 (Results of Operations), so those filings are kept here,
-- apart from `filings`, which holds the periodic reports the fundamentals come
-- from and which the autopilot watches for new ones. The post-earnings drift
-- read (lib/earnings) dates a quarter's announcement from this table and falls
-- back to the periodic filing's date when a release is not stored.
--
-- Public market data, not the person's: not trimmed, and shared by everyone.

CREATE TABLE earnings_releases (
  accession TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  announced_on DATE NOT NULL,
  url TEXT
);

CREATE INDEX earnings_releases_company ON earnings_releases (company_id, announced_on DESC);
