-- gcalf-logs schema v1
-- Writes once per served request (both 402 and paid-200). Seeds the Level 2
-- (odds history) and Level 3 (payer-attention) moats.

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                  -- unix epoch seconds
  endpoint TEXT NOT NULL,               -- '/api/polymarket/odds' etc
  source TEXT,                          -- 'polymarket' | 'kalshi' | null (for batch or pre-upstream failures)
  market_id TEXT,                       -- slug / ticker, null for batch root row
  outcomes_json TEXT,                   -- JSON array of {name,price,probability} or null
  volume_24h REAL,
  liquidity REAL,
  active INTEGER,                       -- 0 | 1 | null
  closed INTEGER,                       -- 0 | 1 | null
  status INTEGER NOT NULL,              -- HTTP status served to caller
  latency_ms INTEGER,                   -- request wall time
  paid INTEGER NOT NULL DEFAULT 0,      -- 1 if X-PAYMENT header present
  payer_wallet TEXT,                    -- extracted from X-PAYMENT payload if parseable
  facilitator TEXT                      -- facilitator URL at time of serve
);

CREATE INDEX IF NOT EXISTS idx_snap_ts         ON odds_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_snap_market     ON odds_snapshots(source, market_id, ts);
CREATE INDEX IF NOT EXISTS idx_snap_payer      ON odds_snapshots(payer_wallet, ts);
CREATE INDEX IF NOT EXISTS idx_snap_endpoint   ON odds_snapshots(endpoint, ts);
