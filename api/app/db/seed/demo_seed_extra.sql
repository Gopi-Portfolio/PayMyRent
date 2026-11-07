-- EXTRA DEMO DATA — local/staging only. Run AFTER demo_seed.sql (and demo_seed_more.sql). Safe to run once (guarded).
--   docker compose exec -T db psql -U paymyrent -d paymyrent -v ON_ERROR_STOP=1 < api/app/db/seed/demo_seed_extra.sql
-- Adds to Gopi (Growth plan): 6 more shops S-09..S-14 with renters +91 90000 00012..17 and SIX months of history
-- (paid on time, partial, late, unpaid), plus open and resolved disputes, so the lists, reports and dispute screens have content.
DO $$
DECLARE
  m0 date := date_trunc('month', rg_today())::date;
  m5 date := (date_trunc('month', rg_today()) - interval '5 month')::date;
  u_gopi uuid; o_gopi uuid; p_mdu uuid; tu uuid; t uuid; inv uuid; pay uuid; line uuid; mo date; k int;
  names text[] := ARRAY['Saravanan Electricals','Fathima Boutique','Dinesh Pharmacy','Lakshmi Tiffin Centre','Vikram Cycles','Annapoorani Sweets'];
  rents bigint[] := ARRAY[1300000, 800000, 1600000, 650000, 750000, 1000000];
BEGIN
  IF EXISTS (SELECT 1 FROM units WHERE identifier = 'S-14') THEN RAISE NOTICE 'extra demo data already loaded'; RETURN; END IF;
  SELECT id INTO u_gopi FROM users WHERE firebase_uid = 'dev:+919000000001';
  SELECT id INTO o_gopi FROM owner_accounts WHERE primary_user_id = u_gopi;
  SELECT id INTO p_mdu FROM properties WHERE owner_account_id = o_gopi ORDER BY created_at LIMIT 1;

  FOR k IN 1..6 LOOP
    INSERT INTO units(owner_account_id, property_id, identifier) VALUES (o_gopi, p_mdu, 'S-' || lpad((8 + k)::text, 2, '0'));
    INSERT INTO users(firebase_uid, full_name, profile_completed_at)
    VALUES ('dev:+9190000000' || (11 + k), names[k], now()) RETURNING id INTO tu;
    INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at) VALUES (tu, 'mobile', '+9190000000' || (11 + k), true, now());
    INSERT INTO notification_preferences(user_id, sms_contact_id) SELECT tu, id FROM user_contacts WHERE user_id = tu;
    INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day, deposit_agreed_paise)
    SELECT o_gopi, id, '+9190000000' || (11 + k), m5, rents[k], CASE WHEN k % 2 = 0 THEN 10 ELSE 5 END, rents[k] * 2
      FROM units WHERE property_id = p_mdu AND identifier = 'S-' || lpad((8 + k)::text, 2, '0') RETURNING id INTO t;
    INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, created_by) VALUES (t, names[k], '+9190000000' || (11 + k), u_gopi);
    INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (t, rents[k] * 2);
    INSERT INTO recurring_charge_config(tenancy_id, category, enabled, default_amount_paise, carry_forward) VALUES
      (t, 'electricity', true, NULL, false), (t, 'water', true, NULL, false), (t, 'maintenance', true, 40000, true), (t, 'misc', true, NULL, false);
    INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, '+9190000000' || (11 + k)) RETURNING id INTO inv;
    PERFORM rg_accept_invitation(inv, tu);
    PERFORM rg_deposit_txn(t, 'received', rents[k] * 2, NULL, 'seed-x-dep-' || k, u_gopi);

    FOR i IN 0..5 LOOP
      mo := (m5 + (i || ' month')::interval)::date;
      PERFORM rg_generate_monthly_invoice(t, mo);
      PERFORM rg_add_charge(t, mo, 'electricity', 40000 + (k * 3000) + (i * 1500), 'EB bill', u_gopi);
      -- k=1,2: always on time · k=3: pays half the rent only · k=4: stopped paying 2 months ago · k=5: always a few days late · k=6: pays everything but the last month
      IF k IN (1, 2) OR (k = 4 AND i <= 3) OR (k = 6 AND i <= 4) THEN
        PERFORM rg_record_payment(t, 'cash', rents[k] + 40000 + (k * 3000) + (i * 1500) + 40000, LEAST(mo + 4, rg_today()), 'seed-x-pay-' || k || '-' || i, u_gopi);
      ELSIF k = 3 THEN
        PERFORM rg_record_payment(t, 'manual_transfer', rents[k] / 2, LEAST(mo + 6, rg_today()), 'seed-x-pay-' || k || '-' || i, u_gopi);
      ELSIF k = 5 AND i <= 4 THEN
        PERFORM rg_record_payment(t, 'cash', rents[k] + 40000 + (k * 3000) + (i * 1500) + 40000, LEAST(mo + 14, rg_today()), 'seed-x-pay-' || k || '-' || i, u_gopi);
      END IF;
    END LOOP;

    -- Disputes: k=1 an OPEN dispute on a payment, k=2 a RESOLVED one, k=3 an OPEN one on an invoice line
    IF k IN (1, 2) THEN
      SELECT id INTO pay FROM payments WHERE tenancy_id = t ORDER BY paid_on LIMIT 1;
      INSERT INTO disputes(owner_account_id, tenancy_id, target_type, target_id, raised_by, reason, status, resolution, resolved_by, resolved_at)
      VALUES (o_gopi, t, 'payment', pay, tu,
              CASE k WHEN 1 THEN 'I paid ₹500 more in cash than the receipt shows.' ELSE 'Receipt date is wrong.' END,
              CASE k WHEN 1 THEN 'open' ELSE 'resolved' END,
              CASE k WHEN 1 THEN NULL ELSE 'Date corrected after checking the cash book.' END,
              CASE k WHEN 1 THEN NULL ELSE u_gopi END,
              CASE k WHEN 1 THEN NULL ELSE now() END);
    ELSIF k = 3 THEN
      SELECT l.id INTO line FROM invoice_lines l JOIN monthly_invoices mi ON mi.id = l.invoice_id
       WHERE mi.tenancy_id = t AND l.category = 'electricity' ORDER BY mi.period_month DESC LIMIT 1;
      INSERT INTO disputes(owner_account_id, tenancy_id, target_type, target_id, raised_by, reason)
      VALUES (o_gopi, t, 'invoice_line', line, tu, 'The electricity reading is higher than my meter shows.');
    END IF;
  END LOOP;
END $$;
SELECT (SELECT count(*) FROM units) units, (SELECT count(*) FROM tenancies) tenancies, (SELECT count(*) FROM monthly_invoices) invoices,
       (SELECT count(*) FROM payments) payments, (SELECT count(*) FROM disputes) disputes;

-- the demo properties count as verified
UPDATE properties SET verification_status = 'verified', reviewed_at = now(), review_note = 'demo data' WHERE verification_status = 'submitted';
