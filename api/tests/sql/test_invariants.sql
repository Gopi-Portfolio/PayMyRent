-- Database invariant tests. Run: make test-sql  (needs a migrated, empty database)
-- Each test runs inside a transaction that is rolled back.
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_sql text, p_code text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(p_code IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'expected % but got: %', p_code, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected error % but statement succeeded: %', p_code, p_sql;
END $$;

-- fixture: a user with verified primary mobile
CREATE OR REPLACE FUNCTION pg_temp.mk_user(p_phone text, p_name text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE u uuid;
BEGIN
  INSERT INTO users(full_name, profile_completed_at) VALUES (p_name, now()) RETURNING id INTO u;
  INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at) VALUES (u, 'mobile', p_phone, true, now());
  RETURN u;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.mk_owner(p_phone text, p_plan text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE u uuid; o uuid; ord uuid; r text;
BEGIN
  u := pg_temp.mk_user(p_phone, 'Owner ' || p_phone);
  INSERT INTO owner_accounts(primary_user_id, display_name) VALUES (u, 'Owner') RETURNING id INTO o;
  INSERT INTO owner_memberships(owner_account_id, user_id, role) VALUES (o, u, 'owner');
  IF p_plan IS NOT NULL THEN
    INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key)
    SELECT o, id, 'new', price_paise, 'sandbox', 'order_' || o, 'k1' FROM subscription_plans WHERE code = p_plan AND status = 'active'
    RETURNING id INTO ord;
    r := rg_activate_subscription(ord, 'pay_' || o, (SELECT amount_paise FROM subscription_orders WHERE id = ord), 'webhook');
    ASSERT r = 'activated', r;
  END IF;
  RETURN o;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.mk_tenancy(p_owner uuid, p_tenant uuid, p_phone text, p_rent bigint, p_start date, p_ident text DEFAULT 'S1')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE pr uuid; un uuid; t uuid; inv uuid;
BEGIN
  SELECT id INTO pr FROM properties WHERE owner_account_id = p_owner LIMIT 1;
  IF pr IS NULL THEN
    INSERT INTO properties(owner_account_id, name, address) VALUES (p_owner, 'Main Bazaar', '12 Market Road, Madurai') RETURNING id INTO pr;
  END IF;
  INSERT INTO units(owner_account_id, property_id, identifier) VALUES (p_owner, pr, p_ident) RETURNING id INTO un;
  INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day)
  VALUES (p_owner, un, p_phone, p_start, p_rent, 5) RETURNING id INTO t;
  INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, created_by)
  VALUES (t, 'Tenant', p_phone, (SELECT primary_user_id FROM owner_accounts WHERE id = p_owner));
  INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, p_phone) RETURNING id INTO inv;
  IF p_tenant IS NOT NULL THEN PERFORM rg_accept_invitation(inv, p_tenant); END IF;
  RETURN t;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.bal(t uuid) RETURNS bigint LANGUAGE sql AS
$$ SELECT balance_paise FROM v_tenancy_balance WHERE tenancy_id = t $$;

\echo '-- T01 plan catalogue is exactly ₹1/1, ₹50/100, ₹100/250 with 0/10k/50k AI tokens'
BEGIN;
DO $$ BEGIN
  ASSERT (SELECT string_agg(code || ':' || price_paise || ':' || max_units || ':' || e.monthly_token_allowance, ',' ORDER BY sort_order)
            FROM subscription_plans p JOIN plan_ai_entitlements e ON e.plan_id = p.id WHERE status = 'active')
       = 'starter:100:1:0,growth:5000:100:10000,business:10000:250:50000';
END $$;
ROLLBACK;

\echo '-- T02 unpaid owner cannot create units; starter allows exactly one'
BEGIN;
DO $$ DECLARE o uuid; o2 uuid; pr uuid; pr2 uuid; BEGIN
  o := pg_temp.mk_owner('+919800000001', NULL);
  INSERT INTO properties(owner_account_id, address) VALUES (o, '1 Temple Street') RETURNING id INTO pr;
  PERFORM pg_temp.expect_error(format('INSERT INTO units(owner_account_id, property_id, identifier) VALUES (%L,%L,%L)', o, pr, 'A1'), 'SUBSCRIPTION_REQUIRED');
  o2 := pg_temp.mk_owner('+919800000002', 'starter');
  INSERT INTO properties(owner_account_id, address) VALUES (o2, '2 Temple Street') RETURNING id INTO pr2;
  INSERT INTO units(owner_account_id, property_id, identifier) VALUES (o2, pr2, 'A1');
  PERFORM pg_temp.expect_error(format('INSERT INTO units(owner_account_id, property_id, identifier) VALUES (%L,%L,%L)', o2, pr2, 'A2'), 'UNIT_CAPACITY_EXCEEDED');
END $$;
ROLLBACK;

\echo '-- T03 archive/reactivate cannot evade the cap; archived units free capacity'
BEGIN;
DO $$ DECLARE o uuid; pr uuid; u1 uuid; u2 uuid; BEGIN
  o := pg_temp.mk_owner('+919800000003', 'starter');
  INSERT INTO properties(owner_account_id, address) VALUES (o, '3 Temple Street') RETURNING id INTO pr;
  INSERT INTO units(owner_account_id, property_id, identifier) VALUES (o, pr, 'A1') RETURNING id INTO u1;
  UPDATE units SET status = 'archived' WHERE id = u1;
  INSERT INTO units(owner_account_id, property_id, identifier) VALUES (o, pr, 'A2') RETURNING id INTO u2;
  PERFORM pg_temp.expect_error(format('UPDATE units SET status = %L WHERE id = %L', 'active', u1), 'UNIT_CAPACITY_EXCEEDED');
  ASSERT (SELECT count(*) FROM unit_status_events WHERE unit_id = u1) = 2;
END $$;
ROLLBACK;

\echo '-- T04 subscription activates exactly once; replay / reused payment / wrong amount do not activate'
BEGIN;
DO $$ DECLARE o uuid; ord uuid; ord2 uuid; BEGIN
  o := pg_temp.mk_owner('+919800000004', NULL);
  INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key)
  SELECT o, id, 'new', price_paise, 'sandbox', 'ord_x', 'k' FROM subscription_plans WHERE code = 'growth' RETURNING id INTO ord;
  ASSERT rg_activate_subscription(ord, 'pay_1', 4999, 'webhook') = 'amount_mismatch';
  ASSERT (SELECT count(*) FROM owner_subscriptions WHERE owner_account_id = o) = 0;
  ASSERT rg_activate_subscription(ord, 'pay_1', 5000, 'webhook') = 'activated';
  ASSERT rg_activate_subscription(ord, 'pay_1', 5000, 'webhook') = 'already_activated';
  ASSERT (SELECT count(*) FROM owner_subscriptions WHERE owner_account_id = o) = 1;
  ASSERT (SELECT count(*) FROM subscription_invoices WHERE owner_account_id = o) = 1;
  -- a second order cannot be paid with the same provider payment id
  INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key)
  SELECT o, id, 'renewal', price_paise, 'sandbox', 'ord_y', 'k2' FROM subscription_plans WHERE code = 'growth' RETURNING id INTO ord2;
  ASSERT rg_activate_subscription(ord2, 'pay_1', 5000, 'webhook') = 'payment_already_used';
  ASSERT (SELECT owner_account_id FROM owner_subscriptions WHERE status = 'active' AND owner_account_id = o) = o;
  ASSERT EXISTS (SELECT 1 FROM user_roles ur JOIN owner_accounts oa ON oa.primary_user_id = ur.user_id WHERE oa.id = o AND ur.role = 'owner');
END $$;
ROLLBACK;

\echo '-- T05 early renewal queues; grace blocks new units; expiry is read-only and keeps history'
BEGIN;
DO $$ DECLARE o uuid; ord uuid; pr uuid; t uuid; cur uuid; BEGIN
  o := pg_temp.mk_owner('+919800000005', 'growth');
  t := pg_temp.mk_tenancy(o, pg_temp.mk_user('+919811111105', 'Tenant5'), '+919811111105', 1000000, date_trunc('month', rg_today())::date);
  INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key)
  SELECT o, id, 'renewal', price_paise, 'sandbox', 'ord_r5', 'r' FROM subscription_plans WHERE code = 'growth' RETURNING id INTO ord;
  ASSERT rg_activate_subscription(ord, 'pay_r5', 5000, 'webhook') = 'activated';
  ASSERT (SELECT status FROM owner_subscriptions WHERE owner_account_id = o ORDER BY period_start DESC LIMIT 1) = 'scheduled';
  -- simulate time passing: cancel queued renewal for this test, push current period into the past
  DELETE FROM subscription_invoices WHERE order_id = ord;
  UPDATE owner_subscriptions SET status = 'expired' WHERE owner_account_id = o AND status = 'scheduled';
  SELECT id INTO cur FROM owner_subscriptions WHERE owner_account_id = o AND status = 'active';
  UPDATE owner_subscriptions SET period_start = now() - interval '35 days', period_end = now() - interval '2 days',
         grace_until = now() + interval '5 days' WHERE id = cur;
  ASSERT rg_owner_write_state(o) = 'grace';
  SELECT property_id INTO pr FROM units WHERE owner_account_id = o LIMIT 1;
  PERFORM pg_temp.expect_error(format('INSERT INTO units(owner_account_id, property_id, identifier) VALUES (%L,%L,%L)', o, pr, 'G2'), 'SUBSCRIPTION_REQUIRED');
  UPDATE owner_subscriptions SET grace_until = now() - interval '1 second' WHERE id = cur;
  ASSERT rg_owner_write_state(o) = 'read_only';
  PERFORM pg_temp.expect_error(format('SELECT rg_add_charge(%L, %L, %L, 500, %L, NULL)', t, date_trunc('month', rg_today())::date, 'misc', 'x'), 'SUBSCRIPTION_REQUIRED');
  ASSERT (SELECT count(*) FROM units WHERE owner_account_id = o) = 1;   -- nothing deleted
END $$;
ROLLBACK;

\echo '-- T06 tenant sees nothing until accepting; only the verified number can accept'
BEGIN;
DO $$ DECLARE o uuid; tenant uuid; stranger uuid; t uuid; inv uuid; BEGIN
  o := pg_temp.mk_owner('+919800000006', 'growth');
  tenant := pg_temp.mk_user('+919811111106', 'Kavya');
  stranger := pg_temp.mk_user('+919822222206', 'Someone');
  t := pg_temp.mk_tenancy(o, NULL, '+919811111106', 1000000, date_trunc('month', rg_today())::date);
  ASSERT (SELECT tenant_user_id FROM tenancies WHERE id = t) IS NULL;
  SELECT id INTO inv FROM tenancy_invitations WHERE tenancy_id = t;
  PERFORM pg_temp.expect_error(format('SELECT rg_accept_invitation(%L, %L)', inv, stranger), 'NOT_FOUND');
  PERFORM rg_accept_invitation(inv, tenant);
  ASSERT (SELECT status FROM tenancies WHERE id = t) = 'active';
  ASSERT (SELECT tenant_user_id FROM tenancies WHERE id = t) = tenant;
END $$;
ROLLBACK;

\echo '-- T07 ₹10,000 rent, ₹7,000 cash → ₹3,000; next month → ₹13,000; oldest-first allocation'
BEGIN;
DO $$ DECLARE o uuid; tn uuid; t uuid; m1 date := date_trunc('month', rg_today() - 40)::date; m2 date; p uuid; BEGIN
  m2 := (m1 + interval '1 month')::date;
  o := pg_temp.mk_owner('+919800000007', 'growth');
  tn := pg_temp.mk_user('+919811111107', 'Ravi');
  t := pg_temp.mk_tenancy(o, tn, '+919811111107', 1000000, m1);
  PERFORM rg_generate_monthly_invoice(t, m1);
  PERFORM rg_generate_monthly_invoice(t, m1);    -- idempotent
  ASSERT pg_temp.bal(t) = 1000000, pg_temp.bal(t)::text;
  p := rg_record_payment(t, 'cash', 700000, rg_today(), 'cash-1', NULL);
  ASSERT p = rg_record_payment(t, 'cash', 700000, rg_today(), 'cash-1', NULL);   -- idempotent retry
  ASSERT pg_temp.bal(t) = 300000;
  ASSERT (SELECT verification FROM payments WHERE id = p) = 'owner_recorded';
  ASSERT EXISTS (SELECT 1 FROM receipts WHERE payment_id = p);
  PERFORM rg_generate_monthly_invoice(t, m2);
  ASSERT pg_temp.bal(t) = 1300000;
  ASSERT (SELECT open_paise FROM v_invoice_status WHERE tenancy_id = t AND period_month = m1) = 300000;
  ASSERT (SELECT open_paise FROM v_invoice_status WHERE tenancy_id = t AND period_month = m2) = 1000000;
  -- a ₹5,000 payment clears the older ₹3,000 first
  PERFORM rg_record_payment(t, 'cash', 500000, rg_today(), 'cash-2', NULL);
  ASSERT (SELECT open_paise FROM v_invoice_status WHERE tenancy_id = t AND period_month = m1) = 0;
  ASSERT (SELECT open_paise FROM v_invoice_status WHERE tenancy_id = t AND period_month = m2) = 800000;
  PERFORM pg_temp.expect_error(format('SELECT rg_record_payment(%L, %L, 1, rg_today(), %L, NULL)', t, 'cash', 'cash-1'), 'IDEMPOTENCY_KEY_REUSED');
  PERFORM pg_temp.expect_error(format('SELECT rg_record_payment(%L, %L, 0, rg_today(), %L, NULL)', t, 'cash', 'zero'), 'VALIDATION');
  -- tenant disputes the cash entry; the ledger is untouched until the owner reverses it
  INSERT INTO disputes(owner_account_id, tenancy_id, target_type, target_id, raised_by, reason) VALUES (o, t, 'payment', p, tn, 'I paid 7500');
  UPDATE payments SET tenant_ack = 'disputed' WHERE id = p;
  ASSERT pg_temp.bal(t) = 800000;
  PERFORM rg_reverse_payment(p, NULL, 'entered wrong amount');
  ASSERT pg_temp.bal(t) = 1500000;
  ASSERT (SELECT open_paise FROM v_invoice_status WHERE tenancy_id = t AND period_month = m1) = 700000; -- released ₹7,000 reopens m1; existing allocations are never moved
END $$;
ROLLBACK;

\echo '-- T08 ledger and allocations are append-only'
BEGIN;
DO $$ DECLARE o uuid; tn uuid; t uuid; BEGIN
  o := pg_temp.mk_owner('+919800000008', 'growth');
  tn := pg_temp.mk_user('+919811111108', 'Asha');
  t := pg_temp.mk_tenancy(o, tn, '+919811111108', 500000, date_trunc('month', rg_today())::date);
  PERFORM rg_generate_monthly_invoice(t, date_trunc('month', rg_today())::date);
  PERFORM pg_temp.expect_error('UPDATE ledger_entries SET amount_paise = 1', 'IMMUTABLE_RECORD');
  PERFORM pg_temp.expect_error('DELETE FROM ledger_entries', 'IMMUTABLE_RECORD');
  PERFORM pg_temp.expect_error('UPDATE invoice_lines SET amount_paise = 1', 'IMMUTABLE_RECORD');
  PERFORM pg_temp.expect_error('TRUNCATE ledger_entries CASCADE', 'IMMUTABLE_RECORD');
END $$;
ROLLBACK;

\echo '-- T09 gateway payment confirms exactly once; pending/failed/mismatch do not touch the ledger'
BEGIN;
DO $$ DECLARE o uuid; tn uuid; t uuid; p uuid; BEGIN
  o := pg_temp.mk_owner('+919800000009', 'growth');
  tn := pg_temp.mk_user('+919811111109', 'Imran');
  t := pg_temp.mk_tenancy(o, tn, '+919811111109', 1000000, date_trunc('month', rg_today())::date);
  PERFORM rg_generate_monthly_invoice(t, date_trunc('month', rg_today())::date);
  p := rg_record_payment(t, 'gateway', 400000, rg_today(), 'chk-1', tn, 'sandbox', 'gw_order_9');
  ASSERT pg_temp.bal(t) = 1000000;                                  -- pending: no effect
  ASSERT rg_confirm_gateway_payment('gw_order_9', 'gw_pay_9', 399999) = 'amount_mismatch';
  ASSERT pg_temp.bal(t) = 1000000;
  ASSERT rg_confirm_gateway_payment('gw_order_9', 'gw_pay_9', 400000) = 'confirmed';
  ASSERT rg_confirm_gateway_payment('gw_order_9', 'gw_pay_9', 400000) = 'already_confirmed';
  ASSERT rg_confirm_gateway_payment('gw_order_9', 'gw_pay_other', 400000) = 'conflict_second_capture';
  ASSERT pg_temp.bal(t) = 600000;
  ASSERT (SELECT count(*) FROM ledger_entries WHERE payment_id = p) = 1;
  ASSERT rg_fail_gateway_payment('gw_order_9', 'late failure event') = 'ignored_confirmed';
  ASSERT rg_confirm_gateway_payment('unknown', 'x', 1) = 'unknown_order';
END $$;
ROLLBACK;

\echo '-- T10 deposit ₹45,000 − ₹15,000 applied = ₹30,000; refund cannot exceed held'
BEGIN;
DO $$ DECLARE o uuid; tn uuid; t uuid; ou uuid; BEGIN
  o := pg_temp.mk_owner('+919800000010', 'growth');
  ou := (SELECT primary_user_id FROM owner_accounts WHERE id = o);
  tn := pg_temp.mk_user('+919811111110', 'Meena');
  t := pg_temp.mk_tenancy(o, tn, '+919811111110', 2000000, date_trunc('month', rg_today())::date);
  PERFORM rg_generate_monthly_invoice(t, date_trunc('month', rg_today())::date);
  PERFORM rg_deposit_txn(t, 'received', 4500000, NULL, 'd1', ou);
  PERFORM rg_deposit_txn(t, 'received', 4500000, NULL, 'd1', ou);  -- idempotent
  ASSERT rg_deposit_held(t) = 4500000;
  PERFORM rg_deposit_txn(t, 'applied_to_dues', 1500000, 'tenant request: adjust against rent', 'd2', ou);
  ASSERT rg_deposit_held(t) = 3000000;
  ASSERT pg_temp.bal(t) = 500000;                                    -- 20,000 rent − 15,000
  PERFORM pg_temp.expect_error(format('SELECT rg_deposit_txn(%L, %L, 3000001, %L, %L, %L)', t, 'refund', 'exit', 'd3', ou), 'DEPOSIT_INSUFFICIENT');
  PERFORM rg_end_tenancy(t, rg_today() + 1, ou);
  PERFORM rg_deposit_txn(t, 'applied_to_dues', 500000, 'final settlement', 'd4', ou);
  PERFORM rg_deposit_txn(t, 'refund', 2500000, 'exit refund', 'd5', ou);
  ASSERT rg_deposit_held(t) = 0 AND pg_temp.bal(t) = 0;
  ASSERT (SELECT status FROM tenancies WHERE id = t) = 'ended';
END $$;
ROLLBACK;

\echo '-- T11 tenant-submitted utilities do nothing until approved; edits create adjustments'
BEGIN;
DO $$ DECLARE o uuid; tn uuid; t uuid; s uuid; line uuid; m date := date_trunc('month', rg_today())::date; ou uuid; BEGIN
  o := pg_temp.mk_owner('+919800000011', 'growth');
  ou := (SELECT primary_user_id FROM owner_accounts WHERE id = o);
  tn := pg_temp.mk_user('+919811111111', 'Suresh');
  t := pg_temp.mk_tenancy(o, tn, '+919811111111', 1000000, m);
  PERFORM rg_generate_monthly_invoice(t, m);
  INSERT INTO charge_submissions(tenancy_id, period_month, category, reading_previous, reading_current, amount_paise, submitted_by, submitter_role)
  VALUES (t, m, 'electricity', 1200, 1320, 96000, tn, 'tenant') RETURNING id INTO s;
  ASSERT pg_temp.bal(t) = 1000000;
  line := rg_review_charge_submission(s, ou, true, NULL);
  ASSERT pg_temp.bal(t) = 1096000;
  PERFORM pg_temp.expect_error(format('SELECT rg_review_charge_submission(%L, %L, true, NULL)', s, ou), 'INVALID_STATE');
  PERFORM rg_adjust_line(line, 90000, 'meter misread', ou);
  ASSERT pg_temp.bal(t) = 1090000;
  ASSERT (SELECT count(*) FROM invoice_lines WHERE adjusts_line_id = line AND kind = 'credit_note') = 1;
  PERFORM rg_adjust_line(line, 95000, 'corrected again', ou);
  ASSERT pg_temp.bal(t) = 1095000;
END $$;
ROLLBACK;

\echo '-- T12 prorated first month and due-day 31 in February'
BEGIN;
DO $$ DECLARE o uuid; tn uuid; t uuid; BEGIN
  ASSERT rg_due_date('2026-02-01', 31) = '2026-02-28';
  ASSERT rg_due_date('2028-02-01', 30) = '2028-02-29';
  ASSERT rg_due_date('2026-04-01', 31) = '2026-04-30';
  o := pg_temp.mk_owner('+919800000012', 'growth');
  tn := pg_temp.mk_user('+919811111112', 'Lakshmi');
  t := pg_temp.mk_tenancy(o, tn, '+919811111112', 3000000, '2026-09-21');  -- 10 of 30 days
  PERFORM rg_generate_monthly_invoice(t, '2026-09-01');
  ASSERT pg_temp.bal(t) = 1000000, pg_temp.bal(t)::text;
END $$;
ROLLBACK;

\echo '-- T13 AI: starter blocked, growth 10k cap, duplicate request not double-counted, ceiling enforced'
BEGIN;
DO $$ DECLARE s uuid; g uuid; gu uuid; r record; r2 record; BEGIN
  s := pg_temp.mk_owner('+919800000013', 'starter');
  PERFORM pg_temp.expect_error(format('SELECT * FROM rg_ai_reserve(%L, %L, %L, %L, %L, %L, 100, 1)',
          s, (SELECT primary_user_id FROM owner_accounts WHERE id = s), 'r1', 'ask', 'mock', 'mock-small'), 'AI_FEATURE_NOT_IN_PLAN');
  g := pg_temp.mk_owner('+919800000014', 'growth');
  gu := (SELECT primary_user_id FROM owner_accounts WHERE id = g);
  SELECT * INTO r FROM rg_ai_reserve(g, gu, 'q1', 'ask', 'mock', 'mock-small', 2500, 100);
  ASSERT r.outcome = 'reserved';
  SELECT * INTO r2 FROM rg_ai_reserve(g, gu, 'q1', 'ask', 'mock', 'mock-small', 2500, 100);
  ASSERT r2.outcome = 'duplicate' AND r2.event_id = r.event_id;
  ASSERT (SELECT tokens_reserved FROM ai_usage_balances WHERE owner_account_id = g) = 2500;
  ASSERT rg_ai_settle(r.event_id, 1800, 250, 0, 0, 80) = 'settled';
  ASSERT rg_ai_settle(r.event_id, 1800, 250, 0, 0, 80) = 'already_settled';
  ASSERT (SELECT tokens_consumed || '/' || tokens_reserved FROM ai_usage_balances WHERE owner_account_id = g) = '2050/0';
  PERFORM pg_temp.expect_error(format('SELECT * FROM rg_ai_reserve(%L,%L,%L,%L,%L,%L, 3501, 1)', g, gu, 'big', 'ask', 'mock', 'mock-small'), 'AI_REQUEST_TOO_LARGE');
  PERFORM pg_temp.expect_error(format('SELECT * FROM rg_ai_reserve(%L,%L,%L,%L,%L,%L, 100, 1)', g, gu, 'm', 'ask', 'mock', 'gpt-huge'), 'AI_MODEL_NOT_ALLOWED');
  -- consume up to the cap: 2050 + 3×2500 = 9550; next 2500 would exceed 10,000
  FOR i IN 1..3 LOOP
    SELECT * INTO r FROM rg_ai_reserve(g, gu, 'fill' || i, 'ask', 'mock', 'mock-small', 2500, 10);
    PERFORM rg_ai_settle(r.event_id, NULL, NULL, NULL, NULL, NULL);   -- missing usage → full reservation charged
  END LOOP;
  PERFORM pg_temp.expect_error(format('SELECT * FROM rg_ai_reserve(%L,%L,%L,%L,%L,%L, 2500, 1)', g, gu, 'over', 'ask', 'mock', 'mock-small'), 'AI_QUOTA_EXHAUSTED');
  SELECT * INTO r FROM rg_ai_reserve(g, gu, 'small', 'ask', 'mock', 'mock-small', 400, 1);
  ASSERT rg_ai_release(r.event_id) = 'released';
  ASSERT (SELECT tokens_reserved FROM ai_usage_balances WHERE owner_account_id = g) = 0;
  -- cost ceiling (₹15) binds even with tokens left
  UPDATE ai_usage_balances SET tokens_consumed = 0 WHERE owner_account_id = g;
  PERFORM pg_temp.expect_error(format('SELECT * FROM rg_ai_reserve(%L,%L,%L,%L,%L,%L, 100, 1500)', g, gu, 'pricey', 'ask', 'mock', 'mock-small'), 'AI_COST_CEILING_REACHED');
  -- voice seconds are metered separately (growth: 120 s)
  PERFORM pg_temp.expect_error(format('SELECT * FROM rg_ai_reserve(%L,%L,%L,%L,%L,%L, 100, 1, 121)', g, gu, 'v', 'voice_ask', 'mock', 'mock-small'), 'AI_VOICE_QUOTA_EXHAUSTED');
END $$;
ROLLBACK;

\echo '-- T14 upgrade carries AI consumption forward (no reset by plan switching) and raises capacity'
BEGIN;
DO $$ DECLARE g uuid; gu uuid; r record; ord uuid; BEGIN
  g := pg_temp.mk_owner('+919800000015', 'growth');
  gu := (SELECT primary_user_id FROM owner_accounts WHERE id = g);
  SELECT * INTO r FROM rg_ai_reserve(g, gu, 'u1', 'ask', 'mock', 'mock-small', 2000, 10);
  PERFORM rg_ai_settle(r.event_id, 1500, 400, 0, 0, 10);
  INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key)
  SELECT g, id, 'upgrade', price_paise, 'sandbox', 'up_1', 'up' FROM subscription_plans WHERE code = 'business' RETURNING id INTO ord;
  ASSERT rg_activate_subscription(ord, 'pay_up_1', 10000, 'webhook') = 'activated';
  ASSERT (SELECT plan_code || ':' || max_units FROM owner_subscriptions WHERE owner_account_id = g AND status = 'active') = 'business:250';
  ASSERT (SELECT token_allowance || ':' || tokens_consumed FROM ai_usage_balances b
            JOIN owner_subscriptions s ON s.id = b.subscription_id WHERE s.owner_account_id = g AND s.status = 'active') = '50000:1900';
END $$;
ROLLBACK;

\echo '-- T15 contacts: max two mobiles; a verified number belongs to one account; one live tenancy per unit'
BEGIN;
DO $$ DECLARE u uuid; v uuid; o uuid; t uuid; BEGIN
  u := pg_temp.mk_user('+919833333301', 'Gopi');
  INSERT INTO user_contacts(user_id, kind, value, verified_at) VALUES (u, 'mobile', '+919833333302', now());
  PERFORM pg_temp.expect_error(format('INSERT INTO user_contacts(user_id, kind, value) VALUES (%L, %L, %L)', u, 'mobile', '+919833333303'), 'CONTACT_LIMIT');
  v := pg_temp.mk_user('+919833333304', 'Other');
  PERFORM pg_temp.expect_error(format('INSERT INTO user_contacts(user_id, kind, value, verified_at) VALUES (%L, %L, %L, now())', v, 'mobile', '+919833333301'), 'ux_contacts_verified_mobile');
  PERFORM pg_temp.expect_error(format('INSERT INTO user_contacts(user_id, kind, value) VALUES (%L, %L, %L)', v, 'mobile', '+915833333301'), 'check');
  o := pg_temp.mk_owner('+919800000016', 'growth');
  t := pg_temp.mk_tenancy(o, NULL, '+919811111116', 100, date_trunc('month', rg_today())::date);
  PERFORM pg_temp.expect_error(format('INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day) SELECT owner_account_id, unit_id, %L, start_date, 1, 1 FROM tenancies WHERE id = %L', '+919811111117', t), 'ux_unit_one_live_tenancy');
END $$;
ROLLBACK;

\echo '-- T16 one owner cannot attach a tenancy to another owner''s unit'
BEGIN;
DO $$ DECLARE a uuid; b uuid; ta uuid; BEGIN
  a := pg_temp.mk_owner('+919800000017', 'growth');
  b := pg_temp.mk_owner('+919800000018', 'growth');
  ta := pg_temp.mk_tenancy(a, NULL, '+919811111118', 100, date_trunc('month', rg_today())::date);
  PERFORM rg_end_tenancy(ta, NULL, NULL);
  PERFORM pg_temp.expect_error(format('INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day) SELECT %L, unit_id, %L, start_date, 1, 1 FROM tenancies WHERE id = %L', b, '+919811111119', ta), 'SCOPE_VIOLATION');
END $$;
ROLLBACK;

\echo 'ALL SQL INVARIANT TESTS PASSED'
