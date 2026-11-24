CREATE TABLE writers (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1))
);
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  writer_id TEXT NOT NULL REFERENCES writers(id),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
  created_at INTEGER NOT NULL,
  html_key TEXT,
  product_count INTEGER NOT NULL,
  images_archived INTEGER NOT NULL DEFAULT 0,
  failures_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(writer_id, request_id)
);
CREATE INDEX shares_writer_created ON shares(writer_id,created_at);
CREATE TABLE quota_counters (
  key TEXT PRIMARY KEY,
  used INTEGER NOT NULL,
  max_count INTEGER NOT NULL,
  CHECK (used >= 0 AND max_count >= 0)
);
CREATE TRIGGER quota_limit_insert BEFORE INSERT ON quota_counters
WHEN NEW.used > NEW.max_count
BEGIN SELECT RAISE(ABORT,'RATE_LIMIT'); END;
CREATE TRIGGER quota_limit_update BEFORE UPDATE ON quota_counters
WHEN NEW.used > NEW.max_count
BEGIN SELECT RAISE(ABORT,'RATE_LIMIT'); END;
