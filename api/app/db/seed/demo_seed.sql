-- DEMO DATA — local/staging only. Every subscription here is marked is_demo; no real money.
-- Demo logins (dev OTP simulator, code 123456):
--   +91 90000 00001  Gopi     Owner (Growth, 8 shops, Madurai)
--   +91 90000 00002  Ravi     Tenant of Gopi (S-01) AND of Lakshmi (G-1)
--   +91 90000 00003  Lakshmi  Owner (Starter, 1 shop, Chennai)
--   +91 90000 00004  Kavya    Both: owns 1 house (Starter) and rents S-02 from Gopi
--   +91 90000 00005  Imran    Tenant invited by Gopi for S-08, not yet accepted
--   +91 90000 00006 .. 00010  Renters of Gopi (S-03 .. S-07)      +91 90000 00011  Arjun, renter of Kavya (H-1)
DO $$
DECLARE
  m0 date := date_trunc('month', rg_today())::date;
  m1 date := (date_trunc('month', rg_today()) - interval '1 month')::date;
  m2 date := (date_trunc('month', rg_today()) - interval '2 month')::date;
  u_gopi uuid; u_ravi uuid; u_lak uuid; u_kav uuid; u_imran uuid;
  o_gopi uuid; o_lak uuid; o_kav uuid;
  p_mdu uuid; p_che uuid; p_kav uuid; ord uuid; t uuid; inv uuid; sub uuid;
  names text[] := ARRAY['Ravi Kumar','Kavya Iyer','முருகன் ஸ்டோர்ஸ்','राजेश शर्मा','Selvi Textiles','Anwar Mobiles','Meena Bakery','Imran Traders'];
  phones text[] := ARRAY['+919000000002','+919000000004','+919000000006','+919000000007','+919000000008','+919000000009','+919000000010','+919000000005'];
  rents bigint[] := ARRAY[1000000, 850000, 1200000, 900000, 1500000, 700000, 1100000, 950000];
  tenant_user uuid;
BEGIN
  -- users ------------------------------------------------------------------
  INSERT INTO users(firebase_uid, full_name, preferred_language, profile_completed_at) VALUES ('dev:+919000000001', 'Gopi Raghu', 'en', now()) RETURNING id INTO u_gopi;
  INSERT INTO users(firebase_uid, full_name, preferred_language, profile_completed_at) VALUES ('dev:+919000000002', 'Ravi Kumar', 'ta', now()) RETURNING id INTO u_ravi;
  INSERT INTO users(firebase_uid, full_name, preferred_language, profile_completed_at) VALUES ('dev:+919000000003', 'Lakshmi Narayanan', 'ta', now()) RETURNING id INTO u_lak;
  INSERT INTO users(firebase_uid, full_name, preferred_language, profile_completed_at) VALUES ('dev:+919000000004', 'Kavya Iyer', 'en', now()) RETURNING id INTO u_kav;
  INSERT INTO users(firebase_uid, full_name, preferred_language, profile_completed_at) VALUES ('dev:+919000000005', 'Imran Khan', 'hi', now()) RETURNING id INTO u_imran;
  INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at) VALUES
    (u_gopi, 'mobile', '+919000000001', true, now()), (u_ravi, 'mobile', '+919000000002', true, now()),
    (u_lak, 'mobile', '+919000000003', true, now()), (u_kav, 'mobile', '+919000000004', true, now()),
    (u_imran, 'mobile', '+919000000005', true, now()), (u_gopi, 'email', 'gopi@example.in', true, now()),
    (u_ravi, 'mobile', '+919000000020', false, now());
  INSERT INTO notification_preferences(user_id, sms_contact_id, whatsapp_contact_id, email_contact_id)
  SELECT u.id, c.id, c.id, e.id FROM users u JOIN user_contacts c ON c.user_id = u.id AND c.kind = 'mobile' AND c.is_primary
  LEFT JOIN user_contacts e ON e.user_id = u.id AND e.kind = 'email' AND e.verified_at IS NOT NULL;
  INSERT INTO user_roles(user_id, role) VALUES (u_gopi, 'owner'), (u_ravi, 'tenant'), (u_lak, 'owner'), (u_kav, 'owner'), (u_kav, 'tenant'), (u_imran, 'tenant');

  -- owners + demo subscriptions (activated through the same function a verified webhook uses)
  INSERT INTO owner_accounts(primary_user_id, display_name) VALUES (u_gopi, 'Gopi Raghu') RETURNING id INTO o_gopi;
  INSERT INTO owner_accounts(primary_user_id, display_name) VALUES (u_lak, 'Lakshmi Narayanan') RETURNING id INTO o_lak;
  INSERT INTO owner_accounts(primary_user_id, display_name) VALUES (u_kav, 'Kavya Iyer') RETURNING id INTO o_kav;
  INSERT INTO owner_memberships(owner_account_id, user_id, role) VALUES (o_gopi, u_gopi, 'owner'), (o_lak, u_lak, 'owner'), (o_kav, u_kav, 'owner');
  INSERT INTO reminder_rules(owner_account_id) VALUES (o_gopi), (o_lak), (o_kav);
  INSERT INTO identity_verifications(user_id, status, provider, provider_session_id, method, liveness_passed, face_matched, name_matched, consent_version, expires_at) VALUES
    (u_gopi, 'verified', 'sandbox', 'seed_kyc_gopi', 'sandbox', true, true, true, 'kyc-v1', now() + interval '1 year'),
    (u_lak, 'verified', 'sandbox', 'seed_kyc_lak', 'sandbox', true, true, true, 'kyc-v1', now() + interval '1 year');
  INSERT INTO owner_verifications(owner_account_id, legal_name, pan, address, proof_type, proof_ref, status, reviewed_at) VALUES
    (o_gopi, 'Gopi Raghu', 'ABCPR1234A', '12 Market Road, Madurai', 'property_tax', 'PT-MDU-001', 'verified', now()),
    (o_lak, 'Lakshmi Narayanan', 'ABCPN5678B', '4 Temple Street, Madurai', 'electricity_bill', 'EB-778899', 'verified', now()),
    (o_kav, 'Kavya Iyer', 'ABCPI9012C', '9 Lake Road, Madurai', 'sale_deed', 'SD-2019-4412', 'submitted', NULL);

  INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key, is_demo)
  SELECT o_gopi, id, 'new', price_paise, 'sandbox', 'seed_order_gopi', 'seed-gopi', true FROM subscription_plans WHERE code = 'growth' AND status = 'active' RETURNING id INTO ord;
  PERFORM rg_activate_subscription(ord, 'seed_pay_gopi', 5000, 'demo');
  INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key, is_demo)
  SELECT o_lak, id, 'new', price_paise, 'sandbox', 'seed_order_lak', 'seed-lak', true FROM subscription_plans WHERE code = 'starter' AND status = 'active' RETURNING id INTO ord;
  PERFORM rg_activate_subscription(ord, 'seed_pay_lak', 100, 'demo');
  INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key, is_demo)
  SELECT o_kav, id, 'new', price_paise, 'sandbox', 'seed_order_kav', 'seed-kav', true FROM subscription_plans WHERE code = 'starter' AND status = 'active' RETURNING id INTO ord;
  PERFORM rg_activate_subscription(ord, 'seed_pay_kav', 100, 'demo');
  -- backdate the demo periods so last two months' bills can exist
  UPDATE owner_subscriptions SET period_start = m2, period_end = m2 + interval '4 months', grace_until = m2 + interval '4 months 7 days';
  UPDATE ai_usage_balances SET period_start = m2, period_end = m2 + interval '4 months';
  UPDATE subscription_orders SET is_demo = true;

  -- properties -------------------------------------------------------------
  INSERT INTO properties(owner_account_id, name, address, city, state, pincode) VALUES
    (o_gopi, 'Main Bazaar Complex', '12 Market Road, Madurai', 'Madurai', 'Tamil Nadu', '625001') RETURNING id INTO p_mdu;
  INSERT INTO properties(owner_account_id, name, address, city, state, pincode) VALUES
    (o_lak, 'Lakshmi Arcade', '4 Usman Road, T. Nagar, Chennai', 'Chennai', 'Tamil Nadu', '600017') RETURNING id INTO p_che;
  INSERT INTO properties(owner_account_id, name, address, city, state, pincode, kind) VALUES
    (o_kav, 'Kavya Residence', '22 Lake View Street, Coimbatore', 'Coimbatore', 'Tamil Nadu', '641001', 'residential') RETURNING id INTO p_kav;

  -- Gopi: 8 shops, 7 accepted tenants + 1 pending invitation ---------------
  FOR i IN 1..8 LOOP
    INSERT INTO units(owner_account_id, property_id, identifier) VALUES (o_gopi, p_mdu, 'S-' || lpad(i::text, 2, '0'));
    INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day, deposit_agreed_paise)
    SELECT o_gopi, id, phones[i], m2, rents[i], CASE WHEN i % 3 = 0 THEN 31 ELSE 5 END, rents[i] * 3
      FROM units WHERE property_id = p_mdu AND identifier = 'S-' || lpad(i::text, 2, '0') RETURNING id INTO t;
    INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, created_by) VALUES (t, names[i], phones[i], u_gopi);
    INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (t, rents[i] * 3);
    INSERT INTO recurring_charge_config(tenancy_id, category, enabled, default_amount_paise, carry_forward) VALUES
      (t, 'electricity', true, NULL, false), (t, 'water', true, NULL, false), (t, 'maintenance', i <= 4, 50000, i <= 4), (t, 'misc', true, NULL, false);
    INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, phones[i]) RETURNING id INTO inv;
    IF i = 8 THEN CONTINUE; END IF;     -- Imran has not accepted yet: sees nothing about S-08
    SELECT id INTO tenant_user FROM users WHERE firebase_uid = 'dev:' || phones[i];
    IF tenant_user IS NULL THEN
      INSERT INTO users(firebase_uid, full_name, profile_completed_at) VALUES ('dev:' || phones[i], names[i], now()) RETURNING id INTO tenant_user;
      INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at) VALUES (tenant_user, 'mobile', phones[i], true, now());
      INSERT INTO notification_preferences(user_id, sms_contact_id) SELECT tenant_user, id FROM user_contacts WHERE user_id = tenant_user;
    END IF;
    PERFORM rg_accept_invitation(inv, tenant_user);
    PERFORM rg_deposit_txn(t, 'received', rents[i] * 3, NULL, 'seed-dep-' || i, u_gopi);
    PERFORM rg_generate_monthly_invoice(t, m2);
    PERFORM rg_generate_monthly_invoice(t, m1);
    PERFORM rg_generate_monthly_invoice(t, m0);
    PERFORM rg_add_charge(t, m1, 'electricity', 60000 + i * 7500, 'EB bill', u_gopi);
    PERFORM rg_add_charge(t, m1, 'water', 15000, 'Water', u_gopi);
    -- payment patterns: 1 fully paid, 2 partial, 3 unpaid, others paid up to last month
    IF i = 1 THEN
      PERFORM rg_record_payment(t, 'cash', 700000, m1 + 6, 'seed-pay-1a', u_gopi);           -- ₹7,000 of ₹10,000
    ELSIF i = 2 THEN
      PERFORM rg_record_payment(t, 'cash', 2000000, m1 + 4, 'seed-pay-2a', u_gopi);
    ELSIF i = 3 THEN
      NULL;                                                                                   -- overdue tenant
    ELSE
      PERFORM rg_record_payment(t, 'cash', rents[i] * 2 + 50000 * (CASE WHEN i <= 4 THEN 2 ELSE 0 END) + 60000 + i * 7500 + 15000,
                                m1 + 5, 'seed-pay-' || i, u_gopi);
    END IF;
  END LOOP;

  -- Ravi disputes nothing yet but has a pending electricity proposal for this month
  SELECT id INTO t FROM tenancies WHERE owner_account_id = o_gopi AND invited_phone = '+919000000002';
  INSERT INTO charge_submissions(tenancy_id, period_month, category, reading_previous, reading_current, amount_paise, submitted_by, submitter_role)
  VALUES (t, m0, 'electricity', 4120, 4236, 87000, u_ravi, 'tenant');
  INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body)
  VALUES (o_gopi, t, 'tenancy', t, u_gopi, 'owner', 'பாக்கி ₹3,000 அடுத்த வாரம் தருவதாகச் சொன்னார்.');

  -- Lakshmi (Starter, 1 unit) rents G-1 to Ravi: tenant with two independent owners
  INSERT INTO units(owner_account_id, property_id, identifier) VALUES (o_lak, p_che, 'G-1');
  INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day, deposit_agreed_paise)
  SELECT o_lak, id, '+919000000002', m1, 1800000, 10, 4500000 FROM units WHERE property_id = p_che RETURNING id INTO t;
  INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, created_by) VALUES (t, 'Ravi Kumar', '+919000000002', u_lak);
  INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (t, 4500000);
  INSERT INTO recurring_charge_config(tenancy_id, category) VALUES (t, 'electricity'), (t, 'water');
  INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, '+919000000002') RETURNING id INTO inv;
  PERFORM rg_accept_invitation(inv, u_ravi);
  PERFORM rg_deposit_txn(t, 'received', 4500000, NULL, 'seed-lak-dep', u_lak);
  PERFORM rg_deposit_txn(t, 'applied_to_dues', 1500000, 'Tenant asked to adjust first month against deposit', 'seed-lak-adj', u_lak);
  PERFORM rg_generate_monthly_invoice(t, m1);
  PERFORM rg_generate_monthly_invoice(t, m0);

  -- Kavya (Both): owns one house, rented to a tenant who pays online (demo gateway)
  INSERT INTO units(owner_account_id, property_id, identifier, kind) VALUES (o_kav, p_kav, 'H-1', 'house');
  INSERT INTO users(firebase_uid, full_name, profile_completed_at) VALUES ('dev:+919000000011', 'Arjun Menon', now()) RETURNING id INTO tenant_user;
  INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at) VALUES (tenant_user, 'mobile', '+919000000011', true, now());
  INSERT INTO notification_preferences(user_id, sms_contact_id) SELECT tenant_user, id FROM user_contacts WHERE user_id = tenant_user;
  INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day, deposit_agreed_paise)
  SELECT o_kav, id, '+919000000011', m1, 2200000, 1, 0 FROM units WHERE property_id = p_kav RETURNING id INTO t;
  INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, created_by) VALUES (t, 'Arjun Menon', '+919000000011', u_kav);
  INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (t, 0);
  INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, '+919000000011') RETURNING id INTO inv;
  PERFORM rg_accept_invitation(inv, tenant_user);
  PERFORM rg_generate_monthly_invoice(t, m1);
  PERFORM rg_record_payment(t, 'gateway', 2200000, m1 + 1, 'seed-gw-1', tenant_user, 'sandbox', 'seed_rent_order_1', true);
  PERFORM rg_confirm_gateway_payment('seed_rent_order_1', 'seed_rent_pay_1', 2200000);
  INSERT INTO payout_accounts(owner_account_id, provider, display_masked, status, created_by)
  VALUES (o_kav, 'sandbox', 'DEMO UPI ka•••@okbank', 'verified', u_kav), (o_gopi, 'sandbox', 'DEMO HDFC ••••4321', 'verified', u_gopi);
END $$;

SELECT 'demo seed loaded: ' || (SELECT count(*) FROM tenancies) || ' tenancies, ' ||
       (SELECT count(*) FROM payments) || ' payments, ' || (SELECT count(*) FROM ledger_entries) || ' ledger entries' AS result;

-- the demo properties count as verified
UPDATE properties SET verification_status = 'verified', reviewed_at = now(), review_note = 'demo data' WHERE verification_status = 'submitted';
