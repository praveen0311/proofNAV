PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS lifecycle_transactions (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('SUBSCRIPTION','REDEMPTION')),
  investor_id TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  share_amount_atomic TEXT,
  nav_sequence INTEGER NOT NULL,
  nav_per_share_raw TEXT NOT NULL,
  payment_or_payout_tx_hash TEXT UNIQUE,
  contract_tx_hash TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_investor ON lifecycle_transactions(investor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_status ON lifecycle_transactions(status);
