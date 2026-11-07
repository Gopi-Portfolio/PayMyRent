-- DEMO DATA for the hand-made test accounts (Viji +91 98840 38398, Prashanth +91 99409 10444). Local/staging only.
-- Adds 8 shops each with renters and 4 months of history. Existing records are never touched. Safe to run once (guarded).
--   docker compose exec -T db psql -U paymyrent -d paymyrent -v ON_ERROR_STOP=1 < api/app/db/seed/demo_seed_real_accounts.sql
-- Renter logins (code 123456): Viji's shops +91 90000 00021..28, Prashanth's shops +91 90000 00031..38.
DO $$
DECLARE
  m3 date := (date_trunc('month', rg_today()) - interval '3 month')::date;
  owners text[] := ARRAY['+919884038398', '+919940910444'];
  bases int[] := ARRAY[21, 31];
  cities text[] := ARRAY['Chennai', 'Coimbatore'];
  names text[] := ARRAY['Arun Stores','Bhavani Salon','Chandru Hardware','Deepa Fancy','Eswar Mobiles','Fazil Tea Stall','Geetha Tailors','Hari Opticals'];
  rents bigint[] := ARRAY[1200000, 900000, 1500000, 700000, 1100000, 600000, 800000, 1000000];
  u_o uuid; o_o uuid; p uuid; tu uuid; t uuid; inv uuid; ord uuid; ph text; mo date; ow int; k int; i int;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE firebase_uid = 'dev:+919000000021') THEN RAISE NOTICE 'already loaded'; RETURN; END IF;
  FOR ow IN 1..2 LOOP
    SELECT id INTO u_o FROM users WHERE firebase_uid = 'dev:' || owners[ow];
    CONTINUE WHEN u_o IS NULL;
    SELECT id INTO o_o FROM owner_accounts WHERE primary_user_id = u_o;
    CONTINUE WHEN o_o IS NULL;
    -- an owner with no plan gets a demo Growth plan (same function a verified webhook uses), backdated for history
    IF NOT EXISTS (SELECT 1 FROM owner_subscriptions WHERE owner_account_id = o_o) THEN
      INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key, is_demo)
      SELECT o_o, id, 'new', price_paise, 'sandbox', 'seed_real_' || ow, 'seed-real-' || ow, true FROM subscription_plans WHERE code = 'growth' AND status = 'active' RETURNING id INTO ord;
      PERFORM rg_activate_subscription(ord, 'seed_real_pay_' || ow, 5000, 'demo');
      UPDATE owner_subscriptions SET period_start = m3, period_end = m3 + interval '6 months', grace_until = m3 + interval '6 months 7 days' WHERE owner_account_id = o_o;
      UPDATE ai_usage_balances SET period_start = m3, period_end = m3 + interval '6 months' WHERE owner_account_id = o_o;
    END IF;
    INSERT INTO properties(owner_account_id, name, address, city, state, pincode)
    VALUES (o_o, 'Demo Market Complex', '1 Main Road, ' || cities[ow], cities[ow], 'Tamil Nadu', '600001') RETURNING id INTO p;
    FOR k IN 1..8 LOOP
      ph := '+9190000000' || (bases[ow] + k - 1);
      INSERT INTO units(owner_account_id, property_id, identifier) VALUES (o_o, p, 'D-' || lpad(k::text, 2, '0'));
      INSERT INTO users(firebase_uid, full_name, profile_completed_at) VALUES ('dev:' || ph, names[k], now()) RETURNING id INTO tu;
      INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at) VALUES (tu, 'mobile', ph, true, now());
      INSERT INTO notification_preferences(user_id, sms_contact_id) SELECT tu, id FROM user_contacts WHERE user_id = tu;
      INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day, deposit_agreed_paise)
      SELECT o_o, id, ph, m3, rents[k], CASE WHEN k % 3 = 0 THEN 10 ELSE 5 END, rents[k] * 2 FROM units WHERE property_id = p AND identifier = 'D-' || lpad(k::text, 2, '0') RETURNING id INTO t;
      INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, created_by) VALUES (t, names[k], ph, u_o);
      INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (t, rents[k] * 2);
      INSERT INTO recurring_charge_config(tenancy_id, category, enabled, default_amount_paise, carry_forward) VALUES
        (t, 'electricity', true, NULL, false), (t, 'water', true, NULL, false), (t, 'maintenance', true, 30000, true), (t, 'misc', true, NULL, false);
      INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, ph) RETURNING id INTO inv;
      PERFORM rg_accept_invitation(inv, tu);
      PERFORM rg_deposit_txn(t, 'received', rents[k] * 2, NULL, 'seed-r-dep-' || ow || '-' || k, u_o);
      FOR i IN 0..3 LOOP
        mo := (m3 + (i || ' month')::interval)::date;
        PERFORM rg_generate_monthly_invoice(t, mo);
        PERFORM rg_add_charge(t, mo, 'electricity', 35000 + k * 4000 + i * 2000, 'EB bill', u_o);
        -- 1-3 always on time (cash) · 4 half only · 5 stopped paying · 6 late · 7 paid but latest month · 8 online-style bank transfer
        IF k IN (1, 2, 3) OR (k = 7 AND i <= 2) THEN
          PERFORM rg_record_payment(t, 'cash', rents[k] + 30000 + 35000 + k * 4000 + i * 2000, LEAST(mo + 4, rg_today()), 'seed-r-pay-' || ow || '-' || k || '-' || i, u_o);
        ELSIF k = 4 THEN
          PERFORM rg_record_payment(t, 'manual_transfer', rents[k] / 2, LEAST(mo + 6, rg_today()), 'seed-r-pay-' || ow || '-' || k || '-' || i, u_o);
        ELSIF k = 6 AND i <= 2 THEN
          PERFORM rg_record_payment(t, 'cash', rents[k] + 30000 + 35000 + k * 4000 + i * 2000, LEAST(mo + 15, rg_today()), 'seed-r-pay-' || ow || '-' || k || '-' || i, u_o);
        ELSIF k = 8 THEN
          PERFORM rg_record_payment(t, 'manual_transfer', rents[k] + 30000 + 35000 + k * 4000 + i * 2000, LEAST(mo + 3, rg_today()), 'seed-r-pay-' || ow || '-' || k || '-' || i, u_o);
        END IF;
      END LOOP;
      INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body)
      VALUES (o_o, t, 'tenancy', t, u_o, 'owner', 'Agreement renewal due in 6 months.');
    END LOOP;
  END LOOP;
END $$;
SELECT (SELECT count(*) FROM units) units, (SELECT count(*) FROM monthly_invoices) invoices, (SELECT count(*) FROM payments) payments;

-- the demo properties count as verified
UPDATE properties SET verification_status = 'verified', reviewed_at = now(), review_note = 'demo data' WHERE verification_status = 'submitted';
