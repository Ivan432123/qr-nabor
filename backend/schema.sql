-- База партнёрской программы «Цифровой набор для кафе»
-- Выполнить один раз в консоли базы D1 (Cloudflare → D1 → ваша база → Console)

CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT,
  code TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  UNIQUE (partner_id, day, ip_hash)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  cafe TEXT NOT NULL,
  phone TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'unknown',
  partner_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  months INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  ip_hash TEXT
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT,
  check_received INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clicks_partner_day ON clicks (partner_id, day);
CREATE INDEX IF NOT EXISTS idx_leads_partner ON leads (partner_id);
CREATE INDEX IF NOT EXISTS idx_payouts_partner ON payouts (partner_id);
