-- MORE DEMO DATA — additive, local/staging only. Run AFTER demo_seed.sql; safe to run once (guarded).
--   docker compose exec -T db psql -U paymyrent -d paymyrent -v ON_ERROR_STOP=1 < api/app/db/seed/demo_seed_more.sql
-- Adds: this month's part-payments and extra charges for Gopi's shops, a mix of payment methods, notes from
-- both owner and renter, Ravi's rent at Lakshmi's, Arjun's second online payment, and owner-private notes.
DO $$
DECLARE
  m0 date := date_trunc('month', rg_today())::date;
  m1 date := (date_trunc('month', rg_today()) - interval '1 month')::date;
  u_gopi uuid; u_lak uuid; u_kav uuid; u_ravi uuid; u_arjun uuid;
  o_gopi uuid; o_lak uuid; o_kav uuid;
  t uuid; r record; i int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM notes WHERE body = 'seed-more-guard') THEN
    RAISE NOTICE 'extra demo data already loaded'; RETURN;
  END IF;
  SELECT id INTO u_gopi  FROM users WHERE firebase_uid = 'dev:+919000000001';
  SELECT id INTO u_ravi  FROM users WHERE firebase_uid = 'dev:+919000000002';
  SELECT id INTO u_lak   FROM users WHERE firebase_uid = 'dev:+919000000003';
  SELECT id INTO u_kav   FROM users WHERE firebase_uid = 'dev:+919000000004';
  SELECT id INTO u_arjun FROM users WHERE firebase_uid = 'dev:+919000000011';
  SELECT id INTO o_gopi  FROM owner_accounts WHERE primary_user_id = u_gopi;
  SELECT id INTO o_lak   FROM owner_accounts WHERE primary_user_id = u_lak;
  SELECT id INTO o_kav   FROM owner_accounts WHERE primary_user_id = u_kav;

  -- Gopi's accepted shops (S-01 .. S-07): this month's extras, bank transfers, notes from both sides
  FOR r IN SELECT t.id, t.monthly_rent_paise AS rent FROM tenancies t JOIN units u ON u.id = t.unit_id
           WHERE t.owner_account_id = o_gopi AND t.status = 'active' ORDER BY u.identifier LOOP
    i := i + 1;
    PERFORM rg_add_charge(r.id, m0, 'misc', 25000 + i * 5000, 'Signboard light repair', u_gopi);
    IF i >= 4 THEN
      PERFORM rg_add_charge(r.id, m0, 'electricity', 50000 + i * 6000, 'EB bill this month', u_gopi);
      PERFORM rg_record_payment(r.id, 'manual_transfer', r.rent / 2, m0 + 2, 'seed-more-xfer-' || i, u_gopi);
    END IF;
    INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body)
    VALUES (o_gopi, r.id, 'tenancy', r.id, u_gopi, 'owner', 'Shop inspected; shutter and wiring are fine.');
    INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body, visibility)
    VALUES (o_gopi, r.id, 'tenancy', r.id, u_gopi, 'owner', 'Reliable tenant. Renewal talk in 3 months.', 'owner_private');
  END LOOP;

  -- Ravi at Lakshmi's G-1: month 1 paid by cash, a water charge, and a note from the renter
  SELECT id INTO t FROM tenancies WHERE owner_account_id = o_lak AND invited_phone = '+919000000002';
  IF t IS NOT NULL THEN
    PERFORM rg_record_payment(t, 'cash', 1800000, m1 + 9, 'seed-more-lak-1', u_lak);
    PERFORM rg_add_charge(t, m0, 'water', 18000, 'Water bill', u_lak);
    INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body)
    VALUES (o_lak, t, 'tenancy', t, u_ravi, 'tenant', 'Please send the rent receipt for last month.'),
           (o_lak, t, 'tenancy', t, u_lak, 'owner', 'Receipt sent on WhatsApp.');
  END IF;

  -- Arjun at Kavya's house: this month's bill, an extra charge, a second online payment
  SELECT id INTO t FROM tenancies WHERE owner_account_id = o_kav AND invited_phone = '+919000000011';
  IF t IS NOT NULL THEN
    PERFORM rg_generate_monthly_invoice(t, m0);
    PERFORM rg_add_charge(t, m0, 'misc', 30000, 'Garden maintenance', u_kav);
    PERFORM rg_record_payment(t, 'gateway', 1500000, m0 + 1, 'seed-more-gw-2', u_arjun, 'sandbox', 'seed_rent_order_2', true);
    PERFORM rg_confirm_gateway_payment('seed_rent_order_2', 'seed_rent_pay_2', 1500000);
    INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body)
    VALUES (o_kav, t, 'tenancy', t, u_arjun, 'tenant', 'Paid ₹15,000 online; the balance comes on the 10th.');
  END IF;

  -- marker so a second run does nothing (an owner-private note, so no money totals change)
  INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body, visibility)
  SELECT o_gopi, id, 'tenancy', id, u_gopi, 'owner', 'seed-more-guard', 'owner_private' FROM tenancies WHERE owner_account_id = o_gopi LIMIT 1;
END $$;
SELECT (SELECT count(*) FROM payments) payments, (SELECT count(*) FROM notes) notes, (SELECT count(*) FROM ledger_entries) ledger_entries;

-- the demo properties count as verified
UPDATE properties SET verification_status = 'verified', reviewed_at = now(), review_note = 'demo data' WHERE verification_status = 'submitted';
