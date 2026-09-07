CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  insurance_plan TEXT,
  avatar TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_period_end TEXT,
  usage_month TEXT NOT NULL DEFAULT '',
  usage_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_users_username_lower ON users (LOWER(username));
CREATE UNIQUE INDEX idx_users_email_lower ON users (LOWER(email));

CREATE TABLE history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  explanation TEXT,
  bill_snippet TEXT,
  disputed_amount REAL NOT NULL DEFAULT 0,
  provider TEXT
);

CREATE INDEX idx_history_user_id ON history (user_id);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
