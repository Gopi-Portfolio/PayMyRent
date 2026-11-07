-- Plan catalogue v1. Prices are the WHOLE tier price per monthly billing period (not per unit).
-- AI entitlements are provisional product limits, admin-configurable by inserting a new version.
INSERT INTO subscription_plans(code, version, label, price_paise, max_units, sort_order) VALUES
  ('starter',  1, 'Starter',    100,   1, 1),   -- ₹1
  ('growth',   1, 'Growth',    5000, 100, 2),   -- ₹50
  ('business', 1, 'Business', 10000, 250, 3);   -- ₹100

INSERT INTO plan_ai_entitlements(plan_id, ai_enabled, features, model_allowlist, monthly_token_allowance,
                                 per_request_max_tokens, per_request_max_output, voice_seconds_allowance,
                                 max_concurrent_requests, requests_per_minute, monthly_cost_ceiling_paise)
SELECT id,
       code <> 'starter',
       CASE code WHEN 'starter' THEN '{}'::text[]
                 WHEN 'growth' THEN '{ask,reminder_draft,voice_ask}'::text[]
                 ELSE '{ask,reminder_draft,voice_ask}'::text[] END,
       CASE code WHEN 'starter' THEN '{}'::text[] ELSE '{mock-small,bedrock-small}'::text[] END,
       CASE code WHEN 'starter' THEN 0 WHEN 'growth' THEN 10000 ELSE 50000 END,
       CASE code WHEN 'starter' THEN 0 WHEN 'growth' THEN 3500 ELSE 5000 END,     -- per-request cap
       CASE code WHEN 'starter' THEN 0 WHEN 'growth' THEN 300 ELSE 500 END,
       CASE code WHEN 'starter' THEN 0 WHEN 'growth' THEN 120 ELSE 900 END,      -- speech-to-text seconds
       CASE code WHEN 'starter' THEN 0 ELSE 2 END,
       CASE code WHEN 'starter' THEN 0 WHEN 'growth' THEN 6 ELSE 12 END,
       CASE code WHEN 'starter' THEN 0 WHEN 'growth' THEN 1500 ELSE 6000 END     -- ₹15 / ₹60 provider spend ceiling
FROM subscription_plans WHERE version = 1;
