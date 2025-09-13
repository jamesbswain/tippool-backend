-- Valets: each has a Stripe connected account
CREATE TABLE IF NOT EXISTS valets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  stripe_account_id TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Cuts: a pool between roster changes
CREATE TABLE IF NOT EXISTS cuts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cut_code TEXT UNIQUE,
  shift_id TEXT,
  date TEXT,
  start_time TEXT,
  end_time TEXT,
  roster_text TEXT,
  tips_cents INTEGER DEFAULT 0,
  people_count INTEGER DEFAULT 0,
  per_person_cents INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open',
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Allocations: one row per valet per cut
CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cut_id INTEGER NOT NULL,
  valet_name TEXT NOT NULL,
  stripe_account_id TEXT,
  payout_cents INTEGER DEFAULT 0,
  payout_status TEXT DEFAULT 'pending',
  FOREIGN KEY (cut_id) REFERENCES cuts(id)
);
