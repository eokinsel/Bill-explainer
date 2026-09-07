ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'inactive';
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_period_end TEXT;
ALTER TABLE users ADD COLUMN usage_month TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users DROP COLUMN credits;
ALTER TABLE users DROP COLUMN free_use_used;
