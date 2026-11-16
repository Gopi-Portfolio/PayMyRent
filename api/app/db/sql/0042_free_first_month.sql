-- The first month of any plan is free, once per owner account (one per mobile number): the plan starts at once, with no order, payment or invoice.
-- To carry on after the month, the owner renews and pays as usual. An account that has ever held a plan, free or paid, is not eligible again.
ALTER TABLE owner_subscriptions ADD COLUMN IF NOT EXISTS is_free_trial boolean NOT NULL DEFAULT false;

CREATE FUNCTION rg_start_free_month(p_owner uuid, p_plan uuid, p_grace_days int DEFAULT 7, p_demo boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SET timezone = 'Asia/Kolkata' AS $$
DECLARE pl subscription_plans; new_id uuid;
BEGIN
  PERFORM 1 FROM owner_accounts WHERE id = p_owner FOR UPDATE;            -- serialise with other checkouts of this owner
  IF EXISTS (SELECT 1 FROM owner_subscriptions WHERE owner_account_id = p_owner) THEN RETURN 'not_eligible'; END IF;
  SELECT * INTO pl FROM subscription_plans WHERE id = p_plan AND status = 'active';
  IF NOT FOUND THEN RETURN 'unknown_plan'; END IF;
  INSERT INTO owner_subscriptions(owner_account_id, plan_id, plan_code, price_paise, max_units, status, period_start, period_end, grace_until, is_demo, is_free_trial)
  VALUES (p_owner, pl.id, pl.code, pl.price_paise, pl.max_units, 'active', now(), now() + interval '1 month',
          now() + interval '1 month' + make_interval(days => p_grace_days), p_demo, true)
  RETURNING id INTO new_id;
  PERFORM rg_ensure_ai_balance(new_id, 0, 0, 0);
  INSERT INTO subscription_events(owner_account_id, subscription_id, type, data)
  VALUES (p_owner, new_id, 'free_month_started', jsonb_build_object('plan', pl.code));
  INSERT INTO user_roles(user_id, role)
  SELECT primary_user_id, 'owner' FROM owner_accounts WHERE id = p_owner ON CONFLICT DO NOTHING;
  RETURN 'started';
END $$;
GRANT EXECUTE ON FUNCTION rg_start_free_month(uuid, uuid, int, boolean) TO pmr_app;
