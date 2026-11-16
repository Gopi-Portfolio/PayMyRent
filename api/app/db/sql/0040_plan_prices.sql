-- New plan prices: Starter ₹50, Growth ₹100, Business ₹500 a month, with no separate "regular" price. The Max plan is retired from the catalogue.
-- A plan is changed by adding a new version; the old version stays as history, and people already on a plan keep the price they signed up at
-- until they change plan.
DO $$
DECLARE r record; old_id uuid; new_id uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('starter', 5000::bigint), ('growth', 10000::bigint), ('business', 50000::bigint)) AS t(code, price) LOOP
    SELECT id INTO old_id FROM subscription_plans WHERE code = r.code AND status = 'active';
    CONTINUE WHEN old_id IS NULL;
    UPDATE subscription_plans SET status = 'retired' WHERE id = old_id;
    INSERT INTO subscription_plans(code, version, label, price_paise, max_units, max_properties, sort_order)
    SELECT code, (SELECT max(version) + 1 FROM subscription_plans WHERE code = r.code), label, r.price, max_units, max_properties, sort_order
      FROM subscription_plans WHERE id = old_id RETURNING id INTO new_id;
    INSERT INTO plan_ai_entitlements(plan_id, ai_enabled, features, model_allowlist, monthly_token_allowance, per_request_max_tokens, per_request_max_output,
                                     voice_seconds_allowance, max_concurrent_requests, requests_per_minute, monthly_cost_ceiling_paise)
    SELECT new_id, ai_enabled, features, model_allowlist, monthly_token_allowance, per_request_max_tokens, per_request_max_output,
           voice_seconds_allowance, max_concurrent_requests, requests_per_minute, monthly_cost_ceiling_paise
      FROM plan_ai_entitlements WHERE plan_id = old_id;
    INSERT INTO plan_message_limits(plan_id, paid_units, email_messages)
    SELECT new_id, paid_units, email_messages FROM plan_message_limits WHERE plan_id = old_id;
  END LOOP;
  UPDATE subscription_plans SET status = 'retired' WHERE code = 'max' AND status = 'active';
END $$;
