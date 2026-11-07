-- DEMO DATA for Viji (+91 98840 38398), who is both an owner and a renter. Local/staging only; safe to run once (guarded).
--   As OWNER : tops her up to exactly 10 shops + 5 houses (renters +91 90000 00041..45 are the new ones).
--   As RENTER: she rents 3 shops + 8 houses from other owners (Gopi: 3 shops + 4 houses, Prashanth: 4 houses).
--   docker compose exec -T db psql -U paymyrent -d paymyrent -v ON_ERROR_STOP=1 < api/app/db/seed/demo_seed_viji.sql
DO $$
DECLARE
  m2 date := (date_trunc('month', rg_today()) - interval '2 month')::date;
  u_viji uuid; o_viji uuid; u_gopi uuid; o_gopi uuid; u_pra uuid; o_pra uuid;
  p_vs uuid; p_vh uuid; p uuid; tu uuid; t uuid; inv uuid; mo date; ph text; k int; i int; n_shop int; n_house int;
  own_kinds text[] := ARRAY['shop','shop','shop','house','house'];
  own_names text[] := ARRAY['Ismail Garments','Janaki Books','Kumar Cycles','Latha Residence','Mohan Residence'];
  -- what Viji rents: owner (1 Gopi, 2 Prashanth), kind, identifier, monthly rent
  r_owner int[]  := ARRAY[1,1,1,1,1,1,1, 2,2,2,2];
  r_kind text[]  := ARRAY['shop','shop','shop','house','house','house','house','house','house','house','house'];
  r_rent bigint[] := ARRAY[1400000,950000,1250000, 1800000,1500000,2100000,1700000, 1600000,1900000,1350000,2000000];
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE firebase_uid = 'dev:+919000000041') THEN RAISE NOTICE 'already loaded'; RETURN; END IF;
  SELECT id INTO u_viji FROM users WHERE firebase_uid = 'dev:+919884038398';
  SELECT id INTO o_viji FROM owner_accounts WHERE primary_user_id = u_viji;
  SELECT id INTO u_gopi FROM users WHERE firebase_uid = 'dev:+919000000001';
  SELECT id INTO o_gopi FROM owner_accounts WHERE primary_user_id = u_gopi;
  SELECT id INTO u_pra  FROM users WHERE firebase_uid = 'dev:+919940910444';
  SELECT id INTO o_pra  FROM owner_accounts WHERE primary_user_id = u_pra;
  IF u_viji IS NULL OR o_viji IS NULL OR o_gopi IS NULL OR o_pra IS NULL THEN RAISE EXCEPTION 'expected accounts are missing'; END IF;

  -- ───── Viji as OWNER: bring the counts to 10 shops + 5 houses ─────
  SELECT count(*) FILTER (WHERE kind = 'shop'), count(*) FILTER (WHERE kind = 'house') INTO n_shop, n_house FROM units WHERE owner_account_id = o_viji;
  SELECT id INTO p_vs FROM properties WHERE owner_account_id = o_viji AND kind = 'commercial' ORDER BY created_at LIMIT 1;
  SELECT id INTO p_vh FROM properties WHERE owner_account_id = o_viji AND kind = 'residential' ORDER BY created_at LIMIT 1;
  FOR k IN 1..5 LOOP
    CONTINUE WHEN (own_kinds[k] = 'shop' AND n_shop >= 10) OR (own_kinds[k] = 'house' AND n_house >= 5);
    p := CASE own_kinds[k] WHEN 'shop' THEN p_vs ELSE p_vh END;
    ph := '+9190000000' || (40 + k);
    INSERT INTO units(owner_account_id, property_id, identifier, kind) VALUES (o_viji, p, CASE own_kinds[k] WHEN 'shop' THEN 'E-' ELSE 'F-' END || lpad(k::text, 2, '0'), own_kinds[k]::text)
      RETURNING id INTO t;
    INSERT INTO users(firebase_uid, full_name, profile_completed_at) VALUES ('dev:' || ph, own_names[k], now()) RETURNING id INTO tu;
    INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at) VALUES (tu, 'mobile', ph, true, now());
    INSERT INTO notification_preferences(user_id, sms_contact_id) SELECT tu, id FROM user_contacts WHERE user_id = tu;
    INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day, deposit_agreed_paise)
    VALUES (o_viji, t, ph, m2, 900000 + k * 150000, 5, (900000 + k * 150000) * 2) RETURNING id INTO t;
    INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, created_by) VALUES (t, own_names[k], ph, u_viji);
    INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (t, (900000 + k * 150000) * 2);
    INSERT INTO recurring_charge_config(tenancy_id, category, enabled, default_amount_paise, carry_forward) VALUES
      (t, 'electricity', true, NULL, false), (t, 'water', true, NULL, false), (t, 'maintenance', true, 30000, true), (t, 'misc', true, NULL, false);
    INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, ph) RETURNING id INTO inv;
    PERFORM rg_accept_invitation(inv, tu);
    PERFORM rg_deposit_txn(t, 'received', (900000 + k * 150000) * 2, NULL, 'seed-v-dep-' || k, u_viji);
    FOR i IN 0..2 LOOP
      mo := (m2 + (i || ' month')::interval)::date;
      PERFORM rg_generate_monthly_invoice(t, mo);
      PERFORM rg_add_charge(t, mo, 'electricity', 30000 + k * 3000, 'EB bill', u_viji);
      IF k <> 3 AND NOT (k = 5 AND i = 2) THEN
        PERFORM rg_record_payment(t, 'cash', 900000 + k * 150000 + 30000 + 30000 + k * 3000, LEAST(mo + 4, rg_today()), 'seed-v-pay-' || k || '-' || i, u_viji);
      END IF;
    END LOOP;
  END LOOP;

  -- ───── Viji as RENTER: 3 shops + 8 houses from Gopi and Prashanth ─────
  SELECT id INTO p FROM properties WHERE owner_account_id = o_gopi AND kind = 'residential' LIMIT 1;
  IF p IS NULL THEN
    INSERT INTO properties(owner_account_id, name, address, city, state, pincode, kind)
    VALUES (o_gopi, 'Gopi Residences', '8 Anna Nagar, Madurai', 'Madurai', 'Tamil Nadu', '625020', 'residential') RETURNING id INTO p;
  END IF;
  p_vh := p;                                                  -- Gopi's residential property
  SELECT id INTO p_vs FROM properties WHERE owner_account_id = o_gopi AND kind = 'commercial' ORDER BY created_at LIMIT 1;
  SELECT id INTO p FROM properties WHERE owner_account_id = o_pra AND kind = 'residential' LIMIT 1;
  IF p IS NULL THEN
    INSERT INTO properties(owner_account_id, name, address, city, state, pincode, kind)
    VALUES (o_pra, 'Prashanth Residences', '3 Race Course Road, Coimbatore', 'Coimbatore', 'Tamil Nadu', '641018', 'residential') RETURNING id INTO p;
  END IF;
  FOR k IN 1..11 LOOP
    INSERT INTO units(owner_account_id, property_id, identifier, kind)
    VALUES (CASE r_owner[k] WHEN 1 THEN o_gopi ELSE o_pra END,
            CASE WHEN r_kind[k] = 'shop' THEN p_vs WHEN r_owner[k] = 1 THEN p_vh ELSE p END,
            'V-' || lpad(k::text, 2, '0'), r_kind[k]) RETURNING id INTO t;
    INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day, deposit_agreed_paise)
    VALUES (CASE r_owner[k] WHEN 1 THEN o_gopi ELSE o_pra END, t, '+919884038398', m2, r_rent[k], 5, r_rent[k] * 2) RETURNING id INTO t;
    INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, created_by)
    VALUES (t, 'Viji', '+919884038398', CASE r_owner[k] WHEN 1 THEN u_gopi ELSE u_pra END);
    INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (t, r_rent[k] * 2);
    INSERT INTO recurring_charge_config(tenancy_id, category, enabled, default_amount_paise, carry_forward) VALUES
      (t, 'electricity', true, NULL, false), (t, 'water', true, NULL, false), (t, 'maintenance', k % 2 = 0, 40000, k % 2 = 0), (t, 'misc', true, NULL, false);
    INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, '+919884038398') RETURNING id INTO inv;
    PERFORM rg_accept_invitation(inv, u_viji);
    PERFORM rg_deposit_txn(t, 'received', r_rent[k] * 2, NULL, 'seed-vr-dep-' || k, CASE r_owner[k] WHEN 1 THEN u_gopi ELSE u_pra END);
    FOR i IN 0..2 LOOP
      mo := (m2 + (i || ' month')::interval)::date;
      PERFORM rg_generate_monthly_invoice(t, mo);
      PERFORM rg_add_charge(t, mo, 'electricity', 40000 + k * 4000, 'EB bill', CASE r_owner[k] WHEN 1 THEN u_gopi ELSE u_pra END);
      -- she pays most on time; houses 3 and 8 are behind, shop 2 paid only part
      IF NOT (k IN (3, 8)) AND NOT (k = 2 AND i = 2) AND NOT (k = 6 AND i = 2) THEN
        PERFORM rg_record_payment(t, 'cash', r_rent[k] + 40000 + k * 4000 + CASE WHEN k % 2 = 0 THEN 40000 ELSE 0 END, LEAST(mo + 4, rg_today()),
                                  'seed-vr-pay-' || k || '-' || i, CASE r_owner[k] WHEN 1 THEN u_gopi ELSE u_pra END);
      END IF;
    END LOOP;
  END LOOP;
END $$;
SELECT 'owner: ' || (SELECT count(*) FILTER (WHERE kind='shop') FROM units x JOIN owner_accounts o ON o.id=x.owner_account_id JOIN users u ON u.id=o.primary_user_id WHERE u.firebase_uid='dev:+919884038398')
    || ' shops, ' || (SELECT count(*) FILTER (WHERE kind='house') FROM units x JOIN owner_accounts o ON o.id=x.owner_account_id JOIN users u ON u.id=o.primary_user_id WHERE u.firebase_uid='dev:+919884038398') || ' houses' AS owner_side,
       'renter: ' || (SELECT count(*) FILTER (WHERE x.kind='shop') FROM tenancies t JOIN units x ON x.id=t.unit_id WHERE t.invited_phone='+919884038398' AND t.tenant_user_id IS NOT NULL)
    || ' shops, ' || (SELECT count(*) FILTER (WHERE x.kind='house') FROM tenancies t JOIN units x ON x.id=t.unit_id WHERE t.invited_phone='+919884038398' AND t.tenant_user_id IS NOT NULL) || ' houses' AS renter_side;

-- the demo properties count as verified
UPDATE properties SET verification_status = 'verified', reviewed_at = now(), review_note = 'demo data' WHERE verification_status = 'submitted';
