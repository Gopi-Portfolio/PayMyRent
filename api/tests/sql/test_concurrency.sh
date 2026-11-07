#!/usr/bin/env bash
# Concurrency tests against a real PostgreSQL: parallel psql sessions race for the same
# resource and we assert the invariant held. Requires PG* env vars; uses a scratch DB.
set -euo pipefail
DB=${TEST_DB:-rg_conc}
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
for f in "$HERE"/app/db/sql/0*.sql; do psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"; done
q() { psql -v ON_ERROR_STOP=1 -qtA -d "$DB" -c "$1"; }
fail() { echo "FAIL: $*"; exit 1; }

# ── fixture: growth owner (100 units) with 99 active units, an issued invoice, a pending gateway payment
q "
DO \$\$ DECLARE u uuid; o uuid; ord uuid; pr uuid; tu uuid; t uuid; inv uuid; un uuid; BEGIN
  INSERT INTO users(id, full_name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Owner A') RETURNING id INTO u;
  INSERT INTO owner_accounts(id, primary_user_id, display_name) VALUES ('00000000-0000-0000-0000-0000000000b1', u, 'A') RETURNING id INTO o;
  INSERT INTO subscription_orders(id, owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key)
  SELECT '00000000-0000-0000-0000-0000000000c1', o, id, 'new', price_paise, 'sandbox', 'sub_ord_1', 'k' FROM subscription_plans WHERE code = 'growth' RETURNING id INTO ord;
  PERFORM rg_activate_subscription(ord, 'sub_pay_1', 5000, 'webhook');
  INSERT INTO properties(owner_account_id, address) VALUES (o, '1 Big Bazaar Street') RETURNING id INTO pr;
  FOR i IN 1..99 LOOP INSERT INTO units(owner_account_id, property_id, identifier) VALUES (o, pr, 'U' || i); END LOOP;
  -- an unused second order for the activation race
  INSERT INTO subscription_orders(id, owner_account_id, plan_id, purpose, amount_paise, provider, provider_order_id, idempotency_key)
  SELECT '00000000-0000-0000-0000-0000000000c2', o, id, 'upgrade', price_paise, 'sandbox', 'sub_ord_2', 'k2' FROM subscription_plans WHERE code = 'business';
  -- tenancy with pending gateway payment
  INSERT INTO users(full_name) VALUES ('Tenant T') RETURNING id INTO tu;
  INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at) VALUES (tu, 'mobile', '+919811100001', true, now());
  SELECT id INTO un FROM units WHERE owner_account_id = o AND identifier = 'U1';
  INSERT INTO tenancies(id, owner_account_id, unit_id, invited_phone, start_date, monthly_rent_paise, due_day)
  VALUES ('00000000-0000-0000-0000-0000000000d1', o, un, '+919811100001', date_trunc('month', rg_today())::date, 1000000, 5) RETURNING id INTO t;
  INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (t, '+919811100001') RETURNING id INTO inv;
  PERFORM rg_accept_invitation(inv, tu);
  PERFORM rg_generate_monthly_invoice(t, date_trunc('month', rg_today())::date);
  PERFORM rg_record_payment(t, 'gateway', 250000, rg_today(), 'chk', tu, 'sandbox', 'gw_race');
  UPDATE plan_ai_entitlements SET max_concurrent_requests = 10 WHERE plan_id = (SELECT id FROM subscription_plans WHERE code='growth');
END \$\$;"

echo "-- C1 two sessions race for the 100th unit, then two race for the 101st"
for i in 1 2; do
  psql -qtA -d "$DB" -c "BEGIN; INSERT INTO units(owner_account_id, property_id, identifier)
     SELECT owner_account_id, id, 'RACE$i' FROM properties LIMIT 1; SELECT pg_sleep(0.5); COMMIT;" >/dev/null 2>&1 &
done; wait
[ "$(q "SELECT count(*) FROM units WHERE status='active'")" = "100" ] || fail "expected exactly 100 active units"
for i in 3 4; do
  psql -qtA -d "$DB" -c "INSERT INTO units(owner_account_id, property_id, identifier) SELECT owner_account_id, id, 'RACE$i' FROM properties LIMIT 1;" >/dev/null 2>&1 &
done; wait
[ "$(q "SELECT count(*) FROM units WHERE status='active'")" = "100" ] || fail "cap exceeded"
echo "   ok: cap of 100 held under concurrency"

echo "-- C2 eight duplicate webhook deliveries for one gateway payment"
for i in $(seq 1 8); do
  psql -qtA -d "$DB" -c "SELECT rg_confirm_gateway_payment('gw_race', 'gw_pay_race', 250000);" >>"/tmp/rg_c2_$$" 2>&1 &
done; wait
[ "$(grep -c '^confirmed$' /tmp/rg_c2_$$)" = "1" ] || { cat /tmp/rg_c2_$$; fail "expected exactly one 'confirmed'"; }
[ "$(q "SELECT count(*) FROM ledger_entries WHERE entry_type='payment'")" = "1" ] || fail "duplicate ledger entries"
[ "$(q "SELECT balance_paise FROM v_tenancy_balance WHERE tenancy_id='00000000-0000-0000-0000-0000000000d1'")" = "750000" ] || fail "balance wrong"
rm -f /tmp/rg_c2_$$
echo "   ok: ledger updated exactly once"

echo "-- C3 six concurrent activations of the same subscription order"
for i in $(seq 1 6); do
  psql -qtA -d "$DB" -c "SELECT rg_activate_subscription('00000000-0000-0000-0000-0000000000c2', 'sub_pay_2', 10000, 'webhook');" >>"/tmp/rg_c3_$$" 2>&1 &
done; wait
[ "$(grep -c '^activated$' /tmp/rg_c3_$$)" = "1" ] || { cat /tmp/rg_c3_$$; fail "expected exactly one activation"; }
[ "$(q "SELECT count(*) FROM owner_subscriptions WHERE status IN ('active','grace')")" = "1" ] || fail "more than one current subscription"
rm -f /tmp/rg_c3_$$
echo "   ok: one activation"

echo "-- C4 ten concurrent 9,000-token AI reservations against a 50,000 allowance (business)"
q "UPDATE plan_ai_entitlements SET max_concurrent_requests = 20, per_request_max_tokens = 9000 WHERE plan_id = (SELECT id FROM subscription_plans WHERE code='business');"
for i in $(seq 1 10); do
  psql -qtA -d "$DB" -c "SELECT outcome FROM rg_ai_reserve('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'cr$i', 'ask', 'mock', 'mock-small', 9000, 1);" >>"/tmp/rg_c4_$$" 2>&1 &
done; wait
[ "$(grep -c '^reserved$' /tmp/rg_c4_$$)" = "5" ] || { cat /tmp/rg_c4_$$; fail "expected exactly 5 reservations"; }
[ "$(q "SELECT tokens_reserved FROM ai_usage_balances b JOIN owner_subscriptions s ON s.id=b.subscription_id WHERE s.status='active'")" = "45000" ] || fail "reserved tokens wrong"
rm -f /tmp/rg_c4_$$
echo "   ok: quota never over-reserved"

psql -q -d postgres -c "DROP DATABASE $DB"
echo "ALL CONCURRENCY TESTS PASSED"
