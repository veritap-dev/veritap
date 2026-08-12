-- Free-plan usage warning.
--
-- Cloudflare offers no Workers request-usage notification on this plan (the
-- Usage Based Billing alert only lists R2 products), so the warning is built
-- here. It matters because on the free plan the cap does not bill you — it
-- REJECTS requests. A rejected demand event is lost forever, which for this
-- project is worse than a bill.
ALTER TABLE daily_counters ADD COLUMN usage_alerted INTEGER NOT NULL DEFAULT 0;
