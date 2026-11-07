-- The Starter plan now costs ₹10 a month (it was ₹1). A plan is changed by adding a new version; the old version stays in the catalogue as history.
-- People already on Starter keep the price they signed up at until they change plan.
UPDATE subscription_plans SET status = 'retired' WHERE code = 'starter' AND version = 2 AND status = 'active';
INSERT INTO subscription_plans(code, version, label, price_paise, max_units, max_properties, sort_order)
SELECT code, 3, label, 1000, max_units, max_properties, sort_order FROM subscription_plans WHERE code = 'starter' AND version = 2
ON CONFLICT (code, version) DO NOTHING;
INSERT INTO plan_ai_entitlements(plan_id, ai_enabled, features, model_allowlist, monthly_token_allowance, per_request_max_tokens, per_request_max_output,
                                 voice_seconds_allowance, max_concurrent_requests, requests_per_minute, monthly_cost_ceiling_paise)
SELECT n.id, e.ai_enabled, e.features, e.model_allowlist, e.monthly_token_allowance, e.per_request_max_tokens, e.per_request_max_output,
       e.voice_seconds_allowance, e.max_concurrent_requests, e.requests_per_minute, e.monthly_cost_ceiling_paise
FROM subscription_plans n JOIN subscription_plans o ON o.code = n.code AND o.version = 2 JOIN plan_ai_entitlements e ON e.plan_id = o.id
WHERE n.code = 'starter' AND n.version = 3
ON CONFLICT DO NOTHING;
INSERT INTO plan_message_limits(plan_id, paid_units, email_messages)
SELECT n.id, l.paid_units, l.email_messages
FROM subscription_plans n JOIN subscription_plans o ON o.code = n.code AND o.version = 2 JOIN plan_message_limits l ON l.plan_id = o.id
WHERE n.code = 'starter' AND n.version = 3
ON CONFLICT DO NOTHING;
