-- Plans: a plan covers ONE property (Starter 10 places, Growth 100, Business 250); each property is billed separately.
-- The new MAX plan covers up to 100 properties and 1,000 places under one price.
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_properties integer NOT NULL DEFAULT 1 CHECK (max_properties >= 1);
ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS subscription_plans_code_check;
ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_code_check CHECK (code IN ('starter','growth','business','max'));

INSERT INTO subscription_plans(code, version, label, price_paise, max_units, max_properties, sort_order)
VALUES ('max', 1, 'Max', 100000, 1000, 100, 4) ON CONFLICT (code, version) DO NOTHING;      -- ₹1,000 a month

-- AI: voice and text questions and findings from Growth up. Monthly tokens: Growth 1 lakh, Business 5 lakh, Max 10 lakh. Starter has no AI.
UPDATE plan_ai_entitlements e SET monthly_token_allowance = CASE p.code WHEN 'growth' THEN 100000 WHEN 'business' THEN 500000 END
  FROM subscription_plans p WHERE p.id = e.plan_id AND p.code IN ('growth', 'business') AND p.status = 'active';
INSERT INTO plan_ai_entitlements(plan_id, ai_enabled, features, model_allowlist, monthly_token_allowance, per_request_max_tokens, per_request_max_output,
                                 voice_seconds_allowance, max_concurrent_requests, requests_per_minute, monthly_cost_ceiling_paise)
SELECT m.id, true, '{ask,reminder_draft,voice_ask,translate}'::text[], '{mock-small,bedrock-small}'::text[], 1000000, 5000, 500, 1800, 4, 20, 12000
FROM subscription_plans m WHERE m.code = 'max' AND m.version = 1
ON CONFLICT DO NOTHING;
INSERT INTO plan_message_limits(plan_id, paid_units, email_messages)
SELECT m.id, 1000, 10000 FROM subscription_plans m WHERE m.code = 'max' AND m.version = 1
ON CONFLICT DO NOTHING;
-- subscribers already on Growth / Business get the larger allowance in the period they are in
UPDATE ai_usage_balances b SET token_allowance = CASE p.code WHEN 'growth' THEN 100000 ELSE 500000 END
  FROM owner_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
 WHERE b.subscription_id = s.id AND s.status = 'active' AND p.code IN ('growth', 'business') AND b.token_allowance > 0 AND b.token_allowance < CASE p.code WHEN 'growth' THEN 100000 ELSE 500000 END;

-- how many properties an account may hold: its current plan's limit (1 when it has no plan yet); older multi-property accounts keep theirs
CREATE FUNCTION rg_property_allowance(p_owner uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT pl.max_properties FROM owner_subscriptions s JOIN subscription_plans pl ON pl.id = s.plan_id
                    WHERE s.owner_account_id = p_owner AND s.status = 'active' AND s.period_end > now() ORDER BY s.period_start DESC LIMIT 1), 1) $$;
GRANT EXECUTE ON FUNCTION rg_property_allowance(uuid) TO pmr_app;

CREATE OR REPLACE FUNCTION rg_properties_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- keys are always derived here, never trusted from a caller
  IF TG_OP = 'INSERT' OR NEW.address IS DISTINCT FROM OLD.address OR NEW.pincode IS DISTINCT FROM OLD.pincode THEN
    NEW.address_key := rg_address_key(NEW.address, NEW.pincode);
    IF TG_OP = 'UPDATE' AND position('#' in OLD.address_key) > 0 THEN NEW.address_key := OLD.address_key; END IF;
  END IF;
  NEW.proof_ref_key := rg_ref_key(NEW.proof_ref);

  IF TG_OP = 'INSERT' THEN
    NEW.review_flags := jsonb_build_object('near_duplicates', rg_near_duplicates(NEW.address, NEW.pincode));   -- for the reviewer
    -- 2. properties per owner account: one, unless the plan allows more (Max: up to 100); older multi-property accounts are left as they were
    IF current_user = 'pmr_app' AND NOT (SELECT legacy_multi_property FROM owner_accounts WHERE id = NEW.owner_account_id)
       AND (SELECT count(*) FROM properties WHERE owner_account_id = NEW.owner_account_id AND archived_at IS NULL AND verification_status <> 'rejected')
           >= rg_property_allowance(NEW.owner_account_id) THEN
      RAISE EXCEPTION 'PROPERTY_NEEDS_SUBSCRIPTION: your plan covers % propert% - each further property needs its own subscription; add it as a new property',
        rg_property_allowance(NEW.owner_account_id), CASE WHEN rg_property_allowance(NEW.owner_account_id) = 1 THEN 'y' ELSE 'ies' END USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 3. only the system (admin review) can verify or reject; the signed-in application role cannot, and cannot rewrite a verified property
  IF current_user = 'pmr_app' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.verification_status := 'submitted'; NEW.reviewed_at := NULL; NEW.review_note := NULL;
    ELSE
      IF NEW.verification_status IS DISTINCT FROM OLD.verification_status OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
         OR NEW.review_note IS DISTINCT FROM OLD.review_note THEN
        RAISE EXCEPTION 'FORBIDDEN: only a reviewer can change the verification status' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.verification_status = 'verified' AND (NEW.address, NEW.pincode, NEW.proof_type, NEW.proof_ref, NEW.owner_account_id)
                                         IS DISTINCT FROM (OLD.address, OLD.pincode, OLD.proof_type, OLD.proof_ref, OLD.owner_account_id) THEN
        RAISE EXCEPTION 'IMMUTABLE_RECORD: a verified property''s address and ownership proof cannot be changed' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
