-- The ₹100 plan (Growth) covers up to 50 places (it was 100) and up to 5 properties. A plan is changed by adding a new version; the old version stays as
-- history, and people already on Growth keep the limits they signed up with until they change plan.
DO $$
DECLARE old_id uuid; new_id uuid;
BEGIN
  SELECT id INTO old_id FROM subscription_plans WHERE code = 'growth' AND status = 'active';
  IF old_id IS NULL THEN RETURN; END IF;
  UPDATE subscription_plans SET status = 'retired' WHERE id = old_id;
  INSERT INTO subscription_plans(code, version, label, price_paise, max_units, max_properties, sort_order)
  SELECT code, (SELECT max(version) + 1 FROM subscription_plans WHERE code = 'growth'), label, 10000, 50, 5, sort_order
    FROM subscription_plans WHERE id = old_id RETURNING id INTO new_id;
  INSERT INTO plan_ai_entitlements(plan_id, ai_enabled, features, model_allowlist, monthly_token_allowance, per_request_max_tokens, per_request_max_output,
                                   voice_seconds_allowance, max_concurrent_requests, requests_per_minute, monthly_cost_ceiling_paise)
  SELECT new_id, ai_enabled, features, model_allowlist, monthly_token_allowance, per_request_max_tokens, per_request_max_output,
         voice_seconds_allowance, max_concurrent_requests, requests_per_minute, monthly_cost_ceiling_paise
    FROM plan_ai_entitlements WHERE plan_id = old_id;
  INSERT INTO plan_message_limits(plan_id, paid_units, email_messages)
  SELECT new_id, LEAST(paid_units, 50), email_messages FROM plan_message_limits WHERE plan_id = old_id;
END $$;
