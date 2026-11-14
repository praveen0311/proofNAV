import Database from "better-sqlite3";

export const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = MEMORY");

db.exec(`
CREATE TABLE funds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  nav_frequency TEXT NOT NULL DEFAULT 'DAILY',
  created_at TEXT NOT NULL
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  valuation_method TEXT NOT NULL,
  max_price_age_seconds INTEGER NOT NULL DEFAULT 86400
);
CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quantity TEXT NOT NULL,
  accrued_income TEXT NOT NULL DEFAULT '0',
  accounting_value TEXT,
  as_of TEXT NOT NULL
);
CREATE TABLE liabilities (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  description TEXT NOT NULL,
  amount TEXT NOT NULL,
  as_of TEXT NOT NULL
);
CREATE TABLE price_observations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  price TEXT NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE custody_balances (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  quantity TEXT NOT NULL,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL
);
CREATE TABLE fund_controls (
  fund_id TEXT PRIMARY KEY REFERENCES funds(id),
  eligible_shares TEXT NOT NULL,
  onchain_total_supply TEXT NOT NULL
);
CREATE TABLE nav_snapshots (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  sequence INTEGER NOT NULL,
  valuation_timestamp TEXT NOT NULL,
  gross_assets TEXT NOT NULL,
  liabilities TEXT NOT NULL,
  nav TEXT NOT NULL,
  eligible_shares TEXT NOT NULL,
  nav_per_share TEXT NOT NULL,
  reconciliation_status TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  calculation_version TEXT NOT NULL,
  snapshot_payload TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(fund_id, sequence)
);
CREATE TABLE reconciliation_results (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES nav_snapshots(id),
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  expected TEXT,
  actual TEXT,
  variance TEXT,
  message TEXT NOT NULL
);
`);
