-- PayMyRent financial invariants, implemented in the database so that every caller
-- (API, jobs, imports, admin scripts) gets the same guarantees under concurrency.
-- Error convention: RAISE EXCEPTION '<CODE>: detail' USING ERRCODE = 'P0001';
-- the API maps <CODE> to a localized 4xx response.

-- ───────────────────────────── helpers ─────────────────────────────
CREATE FUNCTION rg_today() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

CREATE FUNCTION rg_month_last_day(p_month date) RETURNS date LANGUAGE sql IMMUTABLE AS
$$ SELECT (date_trunc('month', p_month) + interval '1 month - 1 day')::date $$;

-- Due day 29–31 in a shorter month falls on that month's last day.
CREATE FUNCTION rg_due_date(p_month date, p_due_day int) RETURNS date LANGUAGE sql IMMUTABLE AS
$$ SELECT (date_trunc('month', p_month)::date
           + (LEAST(p_due_day, extract(day FROM rg_month_last_day(p_month))::int) - 1)) $$;

CREATE FUNCTION rg_next_number(p_kind text, p_prefix text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE y int := extract(year FROM rg_today()); n bigint;
BEGIN
  INSERT INTO number_counters(kind, year, next) VALUES (p_kind, y, 2)
  ON CONFLICT (kind, year) DO UPDATE SET next = number_counters.next + 1
  RETURNING next - 1 INTO n;
  RETURN p_prefix || '-' || y || '-' || lpad(n::text, 6, '0');
END $$;

CREATE FUNCTION rg_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: % is append-only; post a reversal/adjustment instead', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_entries','payment_allocations','audit_events','subscription_events',
                           'deposit_transactions','invoice_lines','receipts','subscription_payments',
                           'note_revisions','consent_records','unit_status_events'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_immutable BEFORE UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION rg_forbid_mutation()', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_no_truncate BEFORE TRUNCATE ON %I
                    FOR EACH STATEMENT EXECUTE FUNCTION rg_forbid_mutation()', t, t);
  END LOOP;
END $$;

CREATE FUNCTION rg_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION rg_touch_updated_at();
CREATE TRIGGER trg_units_touch BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION rg_touch_updated_at();
CREATE TRIGGER trg_tenancies_touch BEFORE UPDATE ON tenancies FOR EACH ROW EXECUTE FUNCTION rg_touch_updated_at();
CREATE TRIGGER trg_properties_touch BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION rg_touch_updated_at();

-- Max two mobiles and two emails per user.
CREATE FUNCTION rg_limit_contacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.removed_at IS NULL AND (
       SELECT count(*) FROM user_contacts
        WHERE user_id = NEW.user_id AND kind = NEW.kind AND removed_at IS NULL AND id <> NEW.id) >= 2 THEN
    RAISE EXCEPTION 'CONTACT_LIMIT: at most two % contacts', NEW.kind USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contacts_limit BEFORE INSERT OR UPDATE ON user_contacts
  FOR EACH ROW EXECUTE FUNCTION rg_limit_contacts();

-- ───────────────────────────── subscription state ─────────────────────────────
-- Lazily advance one owner's subscription rows to the right state. Called by
-- every gate (capacity, AI, charges) and by the lifecycle job.
CREATE FUNCTION rg_refresh_subscription(p_owner uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE cur owner_subscriptions; sched owner_subscriptions;
BEGIN
  SELECT * INTO cur FROM owner_subscriptions
   WHERE owner_account_id = p_owner AND status IN ('active','grace') FOR UPDATE;
  SELECT * INTO sched FROM owner_subscriptions
   WHERE owner_account_id = p_owner AND status = 'scheduled' FOR UPDATE;

  IF cur.id IS NOT NULL AND cur.period_end <= now() THEN
    IF sched.id IS NOT NULL AND sched.period_start <= now() THEN
      UPDATE owner_subscriptions SET status = 'completed', updated_at = now() WHERE id = cur.id;
      UPDATE owner_subscriptions SET status = 'active', updated_at = now() WHERE id = sched.id;
      INSERT INTO subscription_events(owner_account_id, subscription_id, type)
        VALUES (p_owner, sched.id, 'renewal_started');
    ELSIF cur.cancel_at_period_end OR cur.grace_until <= now() THEN
      UPDATE owner_subscriptions SET status = 'expired', updated_at = now() WHERE id = cur.id;
      INSERT INTO subscription_events(owner_account_id, subscription_id, type) VALUES (p_owner, cur.id, 'expired');
    ELSIF cur.status = 'active' THEN
      UPDATE owner_subscriptions SET status = 'grace', updated_at = now() WHERE id = cur.id;
      INSERT INTO subscription_events(owner_account_id, subscription_id, type) VALUES (p_owner, cur.id, 'grace_started');
    END IF;
  END IF;
END $$;

-- 'active' (full access) | 'grace' (existing units work, no new units) | 'read_only' | 'none'
CREATE FUNCTION rg_owner_write_state(p_owner uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  PERFORM rg_refresh_subscription(p_owner);
  SELECT status INTO s FROM owner_subscriptions
   WHERE owner_account_id = p_owner AND status IN ('active','grace');
  IF s IS NOT NULL THEN RETURN s; END IF;
  IF EXISTS (SELECT 1 FROM owner_subscriptions WHERE owner_account_id = p_owner) THEN RETURN 'read_only'; END IF;
  RETURN 'none';
END $$;

CREATE FUNCTION rg_require_owner_writable(p_owner uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s text := rg_owner_write_state(p_owner);
BEGIN
  IF s NOT IN ('active','grace') THEN
    RAISE EXCEPTION 'SUBSCRIPTION_REQUIRED: owner account is %', s USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ───────────────────────────── unit capacity ─────────────────────────────
CREATE FUNCTION rg_enforce_unit_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max int; v_count int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM properties WHERE id = NEW.property_id AND owner_account_id = NEW.owner_account_id) THEN
    RAISE EXCEPTION 'SCOPE_VIOLATION: property does not belong to owner' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'archived' THEN
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM tenancies WHERE unit_id = NEW.id AND status IN ('invited','active')) THEN
      RAISE EXCEPTION 'UNIT_HAS_LIVE_TENANCY: end the tenancy before archiving' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN RETURN NEW; END IF;

  -- Serialise all capacity decisions for this owner.
  PERFORM 1 FROM owner_accounts WHERE id = NEW.owner_account_id FOR UPDATE;
  PERFORM rg_refresh_subscription(NEW.owner_account_id);
  SELECT max_units INTO v_max FROM owner_subscriptions
   WHERE owner_account_id = NEW.owner_account_id AND status = 'active' AND period_end > now();
  IF v_max IS NULL THEN
    RAISE EXCEPTION 'SUBSCRIPTION_REQUIRED: an active paid plan is needed to add or reactivate units' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_count FROM units
   WHERE owner_account_id = NEW.owner_account_id AND status = 'active' AND id <> NEW.id;
  IF v_count + 1 > v_max THEN
    RAISE EXCEPTION 'UNIT_CAPACITY_EXCEEDED: plan allows % active units', v_max USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_units_capacity BEFORE INSERT OR UPDATE OF status, owner_account_id, property_id ON units
  FOR EACH ROW EXECUTE FUNCTION rg_enforce_unit_capacity();

CREATE FUNCTION rg_log_unit_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO unit_status_events(unit_id, from_status, to_status)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_units_status_log AFTER INSERT OR UPDATE OF status ON units
  FOR EACH ROW EXECUTE FUNCTION rg_log_unit_status();

CREATE FUNCTION rg_check_tenancy_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM units WHERE id = NEW.unit_id AND owner_account_id = NEW.owner_account_id AND status = 'active') THEN
    RAISE EXCEPTION 'SCOPE_VIOLATION: unit is not an active unit of this owner' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tenancy_scope BEFORE INSERT ON tenancies FOR EACH ROW EXECUTE FUNCTION rg_check_tenancy_scope();

-- ───────────────────────────── ledger core ─────────────────────────────
CREATE FUNCTION rg_lock_tenancy(p_tenancy uuid) RETURNS tenancies LANGUAGE plpgsql AS $$
DECLARE t tenancies;
BEGIN
  SELECT * INTO t FROM tenancies WHERE id = p_tenancy FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: tenancy' USING ERRCODE = 'P0001'; END IF;
  RETURN t;
END $$;

CREATE VIEW v_line_open AS
SELECT l.id AS line_id, i.tenancy_id, i.period_month, l.category, l.kind, l.created_at, l.amount_paise,
       l.amount_paise - COALESCE((SELECT sum(a.amount_paise) FROM payment_allocations a WHERE a.invoice_line_id = l.id), 0) AS open_paise
FROM invoice_lines l JOIN monthly_invoices i ON i.id = l.invoice_id
WHERE i.status = 'issued' AND l.amount_paise > 0;

CREATE VIEW v_payment_remaining AS
SELECT p.id AS payment_id, p.tenancy_id, p.paid_on, p.created_at,
       p.amount_paise - COALESCE((SELECT sum(a.amount_paise) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS remaining_paise
FROM payments p WHERE p.status = 'confirmed';

CREATE VIEW v_credit_remaining AS
SELECT l.id AS credit_line_id, i.tenancy_id, l.created_at,
       -l.amount_paise - COALESCE((SELECT sum(a.amount_paise) FROM payment_allocations a WHERE a.credit_line_id = l.id), 0) AS remaining_paise
FROM invoice_lines l JOIN monthly_invoices i ON i.id = l.invoice_id
WHERE i.status = 'issued' AND l.amount_paise < 0;

CREATE FUNCTION rg_category_priority(c text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE c WHEN 'opening_balance' THEN 0 WHEN 'rent' THEN 1 WHEN 'maintenance' THEN 2
                WHEN 'electricity' THEN 3 WHEN 'water' THEN 4 WHEN 'tax' THEN 5 ELSE 6 END $$;

-- Allocate every unapplied credit/payment to the oldest open charge (default policy:
-- oldest month first, then rent → maintenance → utilities → misc). Deterministic and
-- idempotent; caller must hold the tenancy lock.
CREATE FUNCTION rg_reallocate(p_tenancy uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE src record; tgt record; amt bigint; n int := 0;
BEGIN
  LOOP
    SELECT * INTO src FROM (
      SELECT 'credit' AS kind, credit_line_id AS id, remaining_paise, created_at::date AS d, created_at
        FROM v_credit_remaining WHERE tenancy_id = p_tenancy AND remaining_paise > 0
      UNION ALL
      SELECT 'payment', payment_id, remaining_paise, paid_on, created_at
        FROM v_payment_remaining WHERE tenancy_id = p_tenancy AND remaining_paise > 0
    ) s ORDER BY (kind = 'payment'), d, created_at, id LIMIT 1;
    EXIT WHEN NOT FOUND;

    SELECT * INTO tgt FROM v_line_open WHERE tenancy_id = p_tenancy AND open_paise > 0
     ORDER BY period_month, rg_category_priority(category), created_at, line_id LIMIT 1;
    EXIT WHEN NOT FOUND;

    amt := LEAST(src.remaining_paise, tgt.open_paise);
    INSERT INTO payment_allocations(tenancy_id, payment_id, credit_line_id, invoice_line_id, amount_paise)
    VALUES (p_tenancy,
            CASE WHEN src.kind = 'payment' THEN src.id END,
            CASE WHEN src.kind = 'credit'  THEN src.id END,
            tgt.line_id, amt);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE FUNCTION rg_ensure_invoice(p_tenancy uuid, p_month date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t tenancies; inv uuid;
BEGIN
  SELECT * INTO t FROM tenancies WHERE id = p_tenancy;
  IF extract(day FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'VALIDATION: period_month must be the first day of a month' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO inv FROM monthly_invoices WHERE tenancy_id = p_tenancy AND period_month = p_month;
  IF inv IS NULL THEN
    INSERT INTO monthly_invoices(owner_account_id, tenancy_id, period_month, number, due_date)
    VALUES (t.owner_account_id, p_tenancy, p_month, rg_next_number('invoice', 'INV'), rg_due_date(p_month, t.due_day))
    RETURNING id INTO inv;
  END IF;
  RETURN inv;
END $$;

CREATE FUNCTION rg_post_line(p_invoice uuid, p_category text, p_kind text, p_amount bigint, p_description text,
                             p_source text, p_submission uuid, p_adjusts uuid, p_reason text, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE inv monthly_invoices; line uuid;
BEGIN
  SELECT * INTO inv FROM monthly_invoices WHERE id = p_invoice;
  IF inv.status <> 'issued' THEN RAISE EXCEPTION 'INVOICE_VOID' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO invoice_lines(invoice_id, category, kind, description, amount_paise, source,
                            charge_submission_id, adjusts_line_id, reason, created_by)
  VALUES (p_invoice, p_category, p_kind, p_description, p_amount, p_source, p_submission, p_adjusts, p_reason, p_actor)
  RETURNING id INTO line;
  INSERT INTO ledger_entries(owner_account_id, tenancy_id, account, entry_type, amount_paise, invoice_line_id, effective_date, created_by)
  VALUES (inv.owner_account_id, inv.tenancy_id, 'tenant_receivable', p_kind, p_amount, line, rg_today(), p_actor);
  RETURN line;
END $$;

-- Monthly invoice with prorated rent for partial first/last months, rent revisions,
-- rent-free months and carried-forward maintenance. Utilities are never guessed.
CREATE FUNCTION rg_generate_monthly_invoice(p_tenancy uuid, p_month date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t tenancies; inv uuid; base bigint; dim int; d_from date; d_to date; days int; amt bigint; cfg record;
BEGIN
  t := rg_lock_tenancy(p_tenancy);
  IF t.status <> 'active' THEN RETURN NULL; END IF;
  IF rg_owner_write_state(t.owner_account_id) NOT IN ('active','grace') THEN RETURN NULL; END IF;
  IF p_month < date_trunc('month', t.start_date)::date THEN RETURN NULL; END IF;
  IF t.end_date IS NOT NULL AND p_month > t.end_date THEN RETURN NULL; END IF;

  inv := rg_ensure_invoice(p_tenancy, p_month);

  IF NOT EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = inv AND category = 'rent' AND source = 'system') THEN
    SELECT COALESCE((SELECT monthly_rent_paise FROM rent_revisions
                      WHERE tenancy_id = p_tenancy AND effective_month <= p_month
                      ORDER BY effective_month DESC LIMIT 1), t.monthly_rent_paise) INTO base;
    IF EXISTS (SELECT 1 FROM rent_free_periods WHERE tenancy_id = p_tenancy AND p_month BETWEEN from_month AND to_month) THEN
      base := 0;
    END IF;
    dim    := extract(day FROM rg_month_last_day(p_month))::int;
    d_from := GREATEST(t.start_date, p_month);
    d_to   := LEAST(COALESCE(t.end_date, rg_month_last_day(p_month)), rg_month_last_day(p_month));
    days   := d_to - d_from + 1;
    amt    := round(base::numeric * days / dim)::bigint;    -- half away from zero, paise
    IF amt > 0 THEN
      PERFORM rg_post_line(inv, 'rent', 'charge', amt,
              CASE WHEN days < dim THEN format('Rent (%s of %s days)', days, dim) ELSE 'Rent' END,
              'system', NULL, NULL, NULL, NULL);
    END IF;
  END IF;

  FOR cfg IN SELECT * FROM recurring_charge_config
              WHERE tenancy_id = p_tenancy AND enabled AND carry_forward AND category = 'maintenance'
                AND COALESCE(default_amount_paise, 0) > 0 LOOP
    IF NOT EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = inv AND category = 'maintenance' AND source = 'system') THEN
      PERFORM rg_post_line(inv, 'maintenance', 'charge', cfg.default_amount_paise, 'Maintenance', 'system', NULL, NULL, NULL, NULL);
    END IF;
  END LOOP;

  PERFORM rg_reallocate(p_tenancy);
  RETURN inv;
END $$;

-- Owner-entered charge (electricity/water/maintenance/misc/other/opening_balance).
CREATE FUNCTION rg_add_charge(p_tenancy uuid, p_month date, p_category text, p_amount bigint,
                              p_description text, p_actor uuid, p_source text DEFAULT 'owner')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t tenancies; inv uuid; line uuid;
BEGIN
  t := rg_lock_tenancy(p_tenancy);
  -- 'invited' allowed so opening arrears can be recorded at onboarding; the tenant sees them on acceptance.
  IF t.status NOT IN ('invited','active','ended') THEN RAISE EXCEPTION 'TENANCY_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  PERFORM rg_require_owner_writable(t.owner_account_id);
  IF p_amount <= 0 THEN RAISE EXCEPTION 'VALIDATION: amount must be positive' USING ERRCODE = 'P0001'; END IF;
  inv := rg_ensure_invoice(p_tenancy, p_month);
  line := rg_post_line(inv, p_category, 'charge', p_amount, p_description, p_source, NULL, NULL, NULL, p_actor);
  PERFORM rg_reallocate(p_tenancy);
  RETURN line;
END $$;

-- Changing an issued line never rewrites it: the delta becomes an adjustment (+) or credit note (−).
CREATE FUNCTION rg_adjust_line(p_line uuid, p_new_total bigint, p_reason text, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE l invoice_lines; inv monthly_invoices; cur_total bigint; delta bigint; t tenancies; newline uuid;
BEGIN
  SELECT * INTO l FROM invoice_lines WHERE id = p_line;
  IF NOT FOUND OR l.kind <> 'charge' THEN RAISE EXCEPTION 'NOT_FOUND: charge line' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO inv FROM monthly_invoices WHERE id = l.invoice_id;
  t := rg_lock_tenancy(inv.tenancy_id);
  PERFORM rg_require_owner_writable(t.owner_account_id);
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'VALIDATION: reason required' USING ERRCODE = 'P0001'; END IF;
  IF p_new_total < 0 THEN RAISE EXCEPTION 'VALIDATION: amount cannot be negative' USING ERRCODE = 'P0001'; END IF;
  SELECT l.amount_paise + COALESCE(sum(amount_paise), 0) INTO cur_total FROM invoice_lines WHERE adjusts_line_id = p_line;
  delta := p_new_total - cur_total;
  IF delta = 0 THEN RETURN NULL; END IF;
  newline := rg_post_line(inv.id, l.category, CASE WHEN delta > 0 THEN 'adjustment' ELSE 'credit_note' END,
                          delta, 'Adjustment', 'owner', NULL, p_line, p_reason, p_actor);
  PERFORM rg_reallocate(inv.tenancy_id);
  RETURN newline;
END $$;

CREATE FUNCTION rg_issue_receipt(p_payment uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p payments; rid uuid; tname text; ulabel text;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment;
  SELECT id INTO rid FROM receipts WHERE payment_id = p_payment;
  IF rid IS NOT NULL THEN RETURN rid; END IF;
  SELECT name INTO tname FROM tenancy_contact_snapshots WHERE tenancy_id = p.tenancy_id ORDER BY created_at DESC LIMIT 1;
  SELECT COALESCE(pr.name || ' · ', '') || u.identifier INTO ulabel
    FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN properties pr ON pr.id = u.property_id WHERE t.id = p.tenancy_id;
  INSERT INTO receipts(owner_account_id, tenancy_id, payment_id, number, tenant_name, unit_label, amount_paise)
  VALUES (p.owner_account_id, p.tenancy_id, p.id, rg_next_number('receipt', 'RCT'), tname, ulabel, p.amount_paise)
  RETURNING id INTO rid;
  RETURN rid;
END $$;

CREATE FUNCTION rg__apply_confirmed_payment(p_payment uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p payments;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment;
  INSERT INTO ledger_entries(owner_account_id, tenancy_id, account, entry_type, amount_paise, payment_id, effective_date, created_by)
  VALUES (p.owner_account_id, p.tenancy_id, 'tenant_receivable', 'payment', -p.amount_paise, p.id, p.paid_on, p.recorded_by);
  INSERT INTO payment_events(payment_id, type, data) VALUES (p.id, 'confirmed', jsonb_build_object('verification', p.verification));
  PERFORM rg_issue_receipt(p.id);
  PERFORM rg_reallocate(p.tenancy_id);
END $$;

-- Cash (owner_recorded), manual transfer (pending → owner_confirmed) and gateway checkout
-- (pending → gateway_verified) all start here. Idempotent per (tenancy, idempotency_key).
CREATE FUNCTION rg_record_payment(p_tenancy uuid, p_method text, p_amount bigint, p_paid_on date,
                                  p_idem text, p_actor uuid, p_provider text DEFAULT NULL,
                                  p_provider_order text DEFAULT NULL, p_is_demo boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t tenancies; existing payments; pid uuid; v_status text; v_ver text;
BEGIN
  t := rg_lock_tenancy(p_tenancy);
  SELECT * INTO existing FROM payments WHERE tenancy_id = p_tenancy AND idempotency_key = p_idem;
  IF FOUND THEN
    IF existing.amount_paise <> p_amount OR existing.method <> p_method THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: different payment already uses this key' USING ERRCODE = 'P0001';
    END IF;
    RETURN existing.id;
  END IF;
  IF t.status NOT IN ('active','ended') THEN RAISE EXCEPTION 'TENANCY_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'VALIDATION: amount must be positive' USING ERRCODE = 'P0001'; END IF;
  IF p_paid_on > rg_today() THEN RAISE EXCEPTION 'VALIDATION: payment date cannot be in the future' USING ERRCODE = 'P0001'; END IF;

  CASE p_method
    WHEN 'cash'            THEN v_status := 'confirmed'; v_ver := 'owner_recorded';
    WHEN 'manual_transfer' THEN v_status := 'pending';   v_ver := 'pending';
    WHEN 'gateway'         THEN v_status := 'pending';   v_ver := 'pending';
    ELSE RAISE EXCEPTION 'VALIDATION: unsupported method %', p_method USING ERRCODE = 'P0001';
  END CASE;

  INSERT INTO payments(owner_account_id, tenancy_id, method, verification, status, amount_paise, paid_on,
                       idempotency_key, recorded_by, provider, provider_order_id, is_demo, confirmed_at)
  VALUES (t.owner_account_id, p_tenancy, p_method, v_ver, v_status, p_amount, p_paid_on, p_idem, p_actor,
          p_provider, p_provider_order, p_is_demo, CASE WHEN v_status = 'confirmed' THEN now() END)
  RETURNING id INTO pid;
  INSERT INTO payment_events(payment_id, type, data) VALUES (pid, 'created', jsonb_build_object('method', p_method));
  IF v_status = 'confirmed' THEN PERFORM rg__apply_confirmed_payment(pid); END IF;
  RETURN pid;
END $$;

-- Called ONLY after the API has verified the webhook signature (or an authoritative
-- server-to-server status check). Exactly-once: replays return 'already_confirmed'.
CREATE FUNCTION rg_confirm_gateway_payment(p_provider_order text, p_provider_payment text, p_amount bigint)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_tenancy uuid; p payments;
BEGIN
  SELECT tenancy_id INTO v_tenancy FROM payments WHERE provider_order_id = p_provider_order;
  IF v_tenancy IS NULL THEN RETURN 'unknown_order'; END IF;
  PERFORM rg_lock_tenancy(v_tenancy);
  SELECT * INTO p FROM payments WHERE provider_order_id = p_provider_order FOR UPDATE;
  IF p.method <> 'gateway' THEN RETURN 'not_gateway'; END IF;
  IF p.status = 'confirmed' THEN
    RETURN CASE WHEN p.provider_payment_id = p_provider_payment THEN 'already_confirmed' ELSE 'conflict_second_capture' END;
  END IF;
  IF p.status NOT IN ('pending','failed') THEN RETURN 'not_confirmable'; END IF;
  IF p_amount <> p.amount_paise THEN
    INSERT INTO payment_events(payment_id, type, data)
    VALUES (p.id, 'amount_mismatch', jsonb_build_object('expected', p.amount_paise, 'got', p_amount));
    RETURN 'amount_mismatch';
  END IF;
  UPDATE payments SET status = 'confirmed', verification = 'gateway_verified',
                      provider_payment_id = p_provider_payment, confirmed_at = now()
   WHERE id = p.id;
  PERFORM rg__apply_confirmed_payment(p.id);
  RETURN 'confirmed';
END $$;

CREATE FUNCTION rg_fail_gateway_payment(p_provider_order text, p_reason text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE p payments;
BEGIN
  SELECT * INTO p FROM payments WHERE provider_order_id = p_provider_order FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown_order'; END IF;
  IF p.status <> 'pending' THEN RETURN 'ignored_' || p.status; END IF;
  UPDATE payments SET status = 'failed' WHERE id = p.id;
  INSERT INTO payment_events(payment_id, type, data) VALUES (p.id, 'failed', jsonb_build_object('reason', p_reason));
  RETURN 'failed';
END $$;

CREATE FUNCTION rg_owner_confirm_transfer(p_payment uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p payments;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment;
  PERFORM rg_lock_tenancy(p.tenancy_id);
  SELECT * INTO p FROM payments WHERE id = p_payment FOR UPDATE;
  IF p.method <> 'manual_transfer' OR p.status <> 'pending' THEN
    RAISE EXCEPTION 'INVALID_STATE: only pending manual transfers can be confirmed' USING ERRCODE = 'P0001';
  END IF;
  UPDATE payments SET status = 'confirmed', verification = 'owner_confirmed', confirmed_at = now() WHERE id = p.id;
  INSERT INTO payment_events(payment_id, type, data) VALUES (p.id, 'owner_confirmed', jsonb_build_object('by', p_actor));
  PERFORM rg__apply_confirmed_payment(p.id);
END $$;

-- Audited correction: the payment row is marked reversed, the ledger gets an opposite
-- entry, and allocations are released with negative rows. Nothing is deleted.
CREATE FUNCTION rg_reverse_payment(p_payment uuid, p_actor uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p payments; a record;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: payment' USING ERRCODE = 'P0001'; END IF;
  PERFORM rg_lock_tenancy(p.tenancy_id);
  SELECT * INTO p FROM payments WHERE id = p_payment FOR UPDATE;
  IF p.status <> 'confirmed' THEN RAISE EXCEPTION 'INVALID_STATE: only confirmed payments can be reversed' USING ERRCODE = 'P0001'; END IF;
  IF p.method = 'deposit' THEN RAISE EXCEPTION 'INVALID_STATE: reverse deposit applications with a deposit transaction' USING ERRCODE = 'P0001'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'VALIDATION: reason required' USING ERRCODE = 'P0001'; END IF;
  UPDATE payments SET status = 'reversed', reversed_reason = p_reason WHERE id = p.id;
  INSERT INTO ledger_entries(owner_account_id, tenancy_id, account, entry_type, amount_paise, payment_id, effective_date, created_by)
  VALUES (p.owner_account_id, p.tenancy_id, 'tenant_receivable', 'payment_reversal', p.amount_paise, p.id, rg_today(), p_actor);
  FOR a IN SELECT invoice_line_id, sum(amount_paise) AS amt FROM payment_allocations
            WHERE payment_id = p.id GROUP BY invoice_line_id HAVING sum(amount_paise) <> 0 LOOP
    INSERT INTO payment_allocations(tenancy_id, payment_id, invoice_line_id, amount_paise)
    VALUES (p.tenancy_id, p.id, a.invoice_line_id, -a.amt);
  END LOOP;
  INSERT INTO payment_events(payment_id, type, data) VALUES (p.id, 'reversed', jsonb_build_object('by', p_actor, 'reason', p_reason));
  PERFORM rg_reallocate(p.tenancy_id);
END $$;

-- ───────────────────────────── deposits ─────────────────────────────
CREATE FUNCTION rg_deposit_held(p_tenancy uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(amount_paise), 0)::bigint FROM ledger_entries WHERE tenancy_id = p_tenancy AND account = 'deposit_held' $$;

CREATE FUNCTION rg_deposit_txn(p_tenancy uuid, p_type text, p_amount bigint, p_reason text, p_idem text, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t tenancies; did uuid; held bigint; pid uuid;
BEGIN
  t := rg_lock_tenancy(p_tenancy);
  INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (p_tenancy, t.deposit_agreed_paise) ON CONFLICT DO NOTHING;
  SELECT id INTO did FROM deposit_transactions WHERE tenancy_id = p_tenancy AND idempotency_key = p_idem;
  IF did IS NOT NULL THEN RETURN did; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'VALIDATION: amount must be positive' USING ERRCODE = 'P0001'; END IF;
  held := rg_deposit_held(p_tenancy);
  IF p_type IN ('applied_to_dues','refund') AND p_amount > held THEN
    RAISE EXCEPTION 'DEPOSIT_INSUFFICIENT: only % paise held', held USING ERRCODE = 'P0001';
  END IF;

  IF p_type = 'applied_to_dues' THEN
    INSERT INTO payments(owner_account_id, tenancy_id, method, verification, status, amount_paise, paid_on,
                         idempotency_key, recorded_by, confirmed_at)
    VALUES (t.owner_account_id, p_tenancy, 'deposit', 'deposit_adjustment', 'confirmed', p_amount, rg_today(),
            'deposit:' || p_idem, p_actor, now())
    RETURNING id INTO pid;
  END IF;

  INSERT INTO deposit_transactions(tenancy_id, type, amount_paise, reason, payment_id, idempotency_key, created_by)
  VALUES (p_tenancy, p_type, p_amount, p_reason, pid, p_idem, p_actor) RETURNING id INTO did;

  INSERT INTO ledger_entries(owner_account_id, tenancy_id, account, entry_type, amount_paise, deposit_txn_id, effective_date, created_by)
  VALUES (t.owner_account_id, p_tenancy, 'deposit_held',
          CASE p_type WHEN 'received' THEN 'deposit_received' WHEN 'applied_to_dues' THEN 'deposit_applied' ELSE 'deposit_refund' END,
          CASE WHEN p_type = 'received' THEN p_amount ELSE -p_amount END, did, rg_today(), p_actor);

  IF pid IS NOT NULL THEN PERFORM rg__apply_confirmed_payment(pid); END IF;
  IF p_type <> 'applied_to_dues' THEN
    INSERT INTO receipts(owner_account_id, tenancy_id, deposit_txn_id, number, amount_paise)
    VALUES (t.owner_account_id, p_tenancy, did, rg_next_number('receipt', 'RCT'), p_amount);
  END IF;
  RETURN did;
END $$;

-- ───────────────────────────── charge submissions ─────────────────────────────
CREATE FUNCTION rg_review_charge_submission(p_submission uuid, p_reviewer uuid, p_approve boolean, p_reason text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE s charge_submissions; inv uuid; line uuid;
BEGIN
  SELECT * INTO s FROM charge_submissions WHERE id = p_submission;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: submission' USING ERRCODE = 'P0001'; END IF;
  PERFORM rg_lock_tenancy(s.tenancy_id);
  SELECT * INTO s FROM charge_submissions WHERE id = p_submission FOR UPDATE;
  IF s.status <> 'proposed' THEN RAISE EXCEPTION 'INVALID_STATE: submission already %', s.status USING ERRCODE = 'P0001'; END IF;
  IF NOT p_approve THEN
    UPDATE charge_submissions SET status = 'rejected', reviewed_by = p_reviewer, reviewed_at = now(), review_reason = p_reason WHERE id = s.id;
    RETURN NULL;
  END IF;
  PERFORM rg_require_owner_writable((SELECT owner_account_id FROM tenancies WHERE id = s.tenancy_id));
  inv := rg_ensure_invoice(s.tenancy_id, s.period_month);
  line := rg_post_line(inv, s.category, 'charge', s.amount_paise, initcap(s.category) || ' (tenant submitted)',
                       'tenant_submission', s.id, NULL, NULL, p_reviewer);
  UPDATE charge_submissions SET status = 'approved', reviewed_by = p_reviewer, reviewed_at = now(), review_reason = p_reason WHERE id = s.id;
  PERFORM rg_reallocate(s.tenancy_id);
  RETURN line;
END $$;

-- ───────────────────────────── tenancy lifecycle ─────────────────────────────
CREATE FUNCTION rg_accept_invitation(p_invitation uuid, p_user uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE inv tenancy_invitations; t tenancies;
BEGIN
  SELECT * INTO inv FROM tenancy_invitations WHERE id = p_invitation FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'pending' THEN RAISE EXCEPTION 'NOT_FOUND: invitation' USING ERRCODE = 'P0001'; END IF;
  -- The accepting user must own the invited number as a verified contact.
  IF NOT EXISTS (SELECT 1 FROM user_contacts WHERE user_id = p_user AND kind = 'mobile' AND value = inv.phone
                   AND verified_at IS NOT NULL AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'NOT_FOUND: invitation' USING ERRCODE = 'P0001';   -- don't reveal existence
  END IF;
  t := rg_lock_tenancy(inv.tenancy_id);
  IF t.status <> 'invited' THEN RAISE EXCEPTION 'INVALID_STATE: tenancy is %', t.status USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM owner_accounts WHERE id = t.owner_account_id AND primary_user_id = p_user) THEN
    RAISE EXCEPTION 'VALIDATION: an owner cannot be the tenant of their own unit' USING ERRCODE = 'P0001';
  END IF;
  UPDATE tenancy_invitations SET status = 'accepted', responded_by = p_user, responded_at = now() WHERE id = inv.id;
  UPDATE tenancies SET status = 'active', tenant_user_id = p_user, version = version + 1 WHERE id = t.id;
  INSERT INTO user_roles(user_id, role) VALUES (p_user, 'tenant') ON CONFLICT DO NOTHING;
  RETURN t.id;
END $$;

CREATE FUNCTION rg_reject_invitation(p_invitation uuid, p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE inv tenancy_invitations;
BEGIN
  SELECT * INTO inv FROM tenancy_invitations WHERE id = p_invitation FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'pending' OR NOT EXISTS (
      SELECT 1 FROM user_contacts WHERE user_id = p_user AND kind = 'mobile' AND value = inv.phone
         AND verified_at IS NOT NULL AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'NOT_FOUND: invitation' USING ERRCODE = 'P0001';
  END IF;
  UPDATE tenancy_invitations SET status = 'rejected', responded_by = p_user, responded_at = now() WHERE id = inv.id;
  UPDATE tenancies SET status = 'rejected', version = version + 1 WHERE id = inv.tenancy_id AND status = 'invited';
END $$;

CREATE FUNCTION rg_end_tenancy(p_tenancy uuid, p_end_date date, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tenancies;
BEGIN
  t := rg_lock_tenancy(p_tenancy);
  IF t.status = 'invited' THEN
    UPDATE tenancies SET status = 'cancelled', ended_at = now(), ended_by = p_actor WHERE id = t.id;
    UPDATE tenancy_invitations SET status = 'cancelled' WHERE tenancy_id = t.id AND status = 'pending';
    RETURN;
  END IF;
  IF t.status <> 'active' THEN RAISE EXCEPTION 'INVALID_STATE: tenancy is %', t.status USING ERRCODE = 'P0001'; END IF;
  IF p_end_date <= t.start_date THEN RAISE EXCEPTION 'VALIDATION: end date must be after start date' USING ERRCODE = 'P0001'; END IF;
  UPDATE tenancies SET status = 'ended', end_date = p_end_date, ended_at = now(), ended_by = p_actor, version = version + 1 WHERE id = t.id;
END $$;

-- ───────────────────────────── subscription activation ─────────────────────────────
CREATE FUNCTION rg_ensure_ai_balance(p_sub uuid, p_carry_tokens int DEFAULT 0, p_carry_cost bigint DEFAULT 0, p_carry_voice int DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE s owner_subscriptions; e plan_ai_entitlements; bid uuid;
BEGIN
  SELECT * INTO s FROM owner_subscriptions WHERE id = p_sub;
  SELECT * INTO e FROM plan_ai_entitlements WHERE plan_id = s.plan_id;
  SELECT id INTO bid FROM ai_usage_balances WHERE subscription_id = p_sub;
  IF bid IS NOT NULL THEN RETURN bid; END IF;
  INSERT INTO ai_usage_balances(owner_account_id, subscription_id, period_start, period_end, token_allowance,
                                tokens_consumed, cost_ceiling_paise, cost_consumed_paise, voice_seconds_allowance, voice_seconds_consumed)
  VALUES (s.owner_account_id, s.id, s.period_start, s.period_end,
          CASE WHEN COALESCE(e.ai_enabled, false) THEN e.monthly_token_allowance ELSE 0 END,
          p_carry_tokens, COALESCE(e.monthly_cost_ceiling_paise, 0), p_carry_cost,
          COALESCE(e.voice_seconds_allowance, 0), p_carry_voice)
  ON CONFLICT (subscription_id) DO NOTHING
  RETURNING id INTO bid;
  IF bid IS NULL THEN SELECT id INTO bid FROM ai_usage_balances WHERE subscription_id = p_sub; END IF;
  RETURN bid;
END $$;

-- Exactly-once activation after a VERIFIED provider payment (never a client callback).
-- Policies (see DECISIONS.md): renewal before expiry is queued after the current period;
-- renewal in grace/after expiry starts now; upgrade starts a fresh full period now at the
-- full new price and carries this period's AI consumption forward (no quota reset by switching).
CREATE FUNCTION rg_activate_subscription(p_order uuid, p_provider_payment text, p_amount bigint,
                                         p_verified_via text, p_grace_days int DEFAULT 7)
RETURNS text LANGUAGE plpgsql SET timezone = 'Asia/Kolkata' AS $$
DECLARE o subscription_orders; pl subscription_plans; cur owner_subscriptions; sched owner_subscriptions;
        b ai_usage_balances; new_id uuid; v_start timestamptz; v_status text := 'active';
BEGIN
  SELECT * INTO o FROM subscription_orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown_order'; END IF;
  PERFORM 1 FROM owner_accounts WHERE id = o.owner_account_id FOR UPDATE;
  IF o.status = 'paid' THEN RETURN 'already_activated'; END IF;
  IF o.status <> 'created' THEN RETURN 'order_not_open'; END IF;
  IF p_amount <> o.amount_paise THEN
    INSERT INTO subscription_events(owner_account_id, type, data)
    VALUES (o.owner_account_id, 'amount_mismatch', jsonb_build_object('order', o.id, 'expected', o.amount_paise, 'got', p_amount));
    RETURN 'amount_mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription_payments WHERE provider_payment_id = p_provider_payment) THEN
    RETURN 'payment_already_used';
  END IF;

  INSERT INTO subscription_payments(order_id, provider_payment_id, amount_paise, verified_via)
  VALUES (o.id, p_provider_payment, p_amount, p_verified_via);
  UPDATE subscription_orders SET status = 'paid', paid_at = now() WHERE id = o.id;

  PERFORM rg_refresh_subscription(o.owner_account_id);
  SELECT * INTO pl FROM subscription_plans WHERE id = o.plan_id;
  SELECT * INTO cur FROM owner_subscriptions WHERE owner_account_id = o.owner_account_id AND status IN ('active','grace') FOR UPDATE;
  SELECT * INTO sched FROM owner_subscriptions WHERE owner_account_id = o.owner_account_id AND status = 'scheduled' FOR UPDATE;

  IF o.purpose = 'upgrade' AND cur.id IS NOT NULL THEN
    SELECT * INTO b FROM ai_usage_balances WHERE subscription_id = cur.id;
    UPDATE owner_subscriptions SET status = 'superseded', updated_at = now() WHERE id = cur.id;
    v_start := now();
  ELSIF sched.id IS NOT NULL THEN
    -- A renewal is already queued (checkout normally prevents this). Never lose a paid
    -- period: fold the extra month into the queued one and flag for review.
    INSERT INTO subscription_events(owner_account_id, type, data)
    VALUES (o.owner_account_id, 'needs_review_multiple_prepaid', jsonb_build_object('order', o.id));
    UPDATE owner_subscriptions SET period_end = period_end + interval '1 month',
           grace_until = period_end + interval '1 month' + make_interval(days => p_grace_days)
     WHERE id = sched.id;
    INSERT INTO subscription_invoices(owner_account_id, order_id, subscription_id, number, amount_paise)
    VALUES (o.owner_account_id, o.id, sched.id, rg_next_number('subscription_invoice', 'SUB'), o.amount_paise);
    RETURN 'activated';
  ELSIF cur.id IS NOT NULL AND cur.status = 'active' AND cur.period_end > now() THEN
    v_start := cur.period_end; v_status := 'scheduled';          -- early renewal queued
  ELSE
    IF cur.id IS NOT NULL THEN UPDATE owner_subscriptions SET status = 'completed', updated_at = now() WHERE id = cur.id; END IF;
    v_start := now();
  END IF;

  INSERT INTO owner_subscriptions(owner_account_id, plan_id, plan_code, price_paise, max_units, status,
                                  period_start, period_end, grace_until, is_demo)
  VALUES (o.owner_account_id, pl.id, pl.code, pl.price_paise, pl.max_units, v_status,
          v_start, v_start + interval '1 month', v_start + interval '1 month' + make_interval(days => p_grace_days), o.is_demo)
  RETURNING id INTO new_id;

  IF o.purpose = 'upgrade' AND sched.id IS NOT NULL THEN
    UPDATE owner_subscriptions SET period_start = v_start + interval '1 month',
           period_end = v_start + interval '2 month',
           grace_until = v_start + interval '2 month' + make_interval(days => p_grace_days)
     WHERE id = sched.id;
  END IF;

  IF v_status = 'active' THEN
    PERFORM rg_ensure_ai_balance(new_id,
            CASE WHEN b.id IS NOT NULL THEN b.tokens_consumed ELSE 0 END,
            CASE WHEN b.id IS NOT NULL THEN b.cost_consumed_paise ELSE 0 END,
            CASE WHEN b.id IS NOT NULL THEN b.voice_seconds_consumed ELSE 0 END);
  END IF;

  INSERT INTO subscription_invoices(owner_account_id, order_id, subscription_id, number, amount_paise)
  VALUES (o.owner_account_id, o.id, new_id, rg_next_number('subscription_invoice', 'SUB'), o.amount_paise);
  INSERT INTO subscription_events(owner_account_id, subscription_id, type, data)
  VALUES (o.owner_account_id, new_id, CASE WHEN v_status = 'scheduled' THEN 'renewal_scheduled' ELSE 'activated' END,
          jsonb_build_object('order', o.id, 'plan', pl.code, 'purpose', o.purpose, 'via', p_verified_via));
  INSERT INTO user_roles(user_id, role)
  SELECT primary_user_id, 'owner' FROM owner_accounts WHERE id = o.owner_account_id ON CONFLICT DO NOTHING;
  RETURN 'activated';
END $$;

-- ───────────────────────────── AI quota ─────────────────────────────
CREATE FUNCTION rg_ai_reserve(p_owner uuid, p_user uuid, p_request text, p_feature text, p_provider text,
                              p_model text, p_tokens int, p_cost bigint, p_voice_seconds int DEFAULT 0)
RETURNS TABLE(event_id uuid, outcome text) LANGUAGE plpgsql AS $$
DECLARE ev ai_usage_events; s owner_subscriptions; e plan_ai_entitlements; bid uuid; bal ai_usage_balances;
BEGIN
  SELECT * INTO ev FROM ai_usage_events WHERE owner_account_id = p_owner AND request_id = p_request;
  IF FOUND THEN event_id := ev.id; outcome := 'duplicate'; RETURN NEXT; RETURN; END IF;

  PERFORM rg_refresh_subscription(p_owner);
  SELECT * INTO s FROM owner_subscriptions WHERE owner_account_id = p_owner AND status = 'active' AND period_end > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_SUBSCRIPTION_INACTIVE' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM plan_ai_entitlements WHERE plan_id = s.plan_id;
  IF NOT FOUND OR NOT e.ai_enabled OR NOT (p_feature = ANY(e.features)) THEN
    RAISE EXCEPTION 'AI_FEATURE_NOT_IN_PLAN' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_model = ANY(e.model_allowlist)) THEN RAISE EXCEPTION 'AI_MODEL_NOT_ALLOWED' USING ERRCODE = 'P0001'; END IF;
  IF p_tokens <= 0 OR p_tokens > e.per_request_max_tokens THEN RAISE EXCEPTION 'AI_REQUEST_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;

  bid := rg_ensure_ai_balance(s.id);
  UPDATE ai_usage_balances
     SET tokens_reserved = tokens_reserved + p_tokens,
         cost_reserved_paise = cost_reserved_paise + p_cost,
         voice_seconds_reserved = voice_seconds_reserved + p_voice_seconds,
         in_flight = in_flight + 1, version = version + 1
   WHERE id = bid
     AND tokens_consumed + tokens_reserved + p_tokens <= token_allowance
     AND cost_consumed_paise + cost_reserved_paise + p_cost <= cost_ceiling_paise
     AND voice_seconds_consumed + voice_seconds_reserved + p_voice_seconds <= voice_seconds_allowance
     AND in_flight < e.max_concurrent_requests
  RETURNING * INTO bal;
  IF NOT FOUND THEN
    SELECT * INTO bal FROM ai_usage_balances WHERE id = bid;
    IF bal.tokens_consumed + bal.tokens_reserved + p_tokens > bal.token_allowance THEN
      RAISE EXCEPTION 'AI_QUOTA_EXHAUSTED' USING ERRCODE = 'P0001';
    ELSIF bal.cost_consumed_paise + bal.cost_reserved_paise + p_cost > bal.cost_ceiling_paise THEN
      RAISE EXCEPTION 'AI_COST_CEILING_REACHED' USING ERRCODE = 'P0001';
    ELSIF bal.voice_seconds_consumed + bal.voice_seconds_reserved + p_voice_seconds > bal.voice_seconds_allowance THEN
      RAISE EXCEPTION 'AI_VOICE_QUOTA_EXHAUSTED' USING ERRCODE = 'P0001';
    ELSE
      RAISE EXCEPTION 'AI_TOO_MANY_CONCURRENT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ai_usage_events(owner_account_id, balance_id, request_id, user_id, feature, provider, model,
                              reserved_tokens, reserved_cost_paise, reserved_voice_seconds)
  VALUES (p_owner, bid, p_request, p_user, p_feature, p_provider, p_model, p_tokens, p_cost, p_voice_seconds)
  RETURNING id INTO event_id;
  outcome := 'reserved'; RETURN NEXT;
END $$;

-- Accounting rule: billable = input + output + reasoning tokens as reported by the provider.
-- Cached input tokens are already inside the provider's input count and are billed at full
-- weight against the allowance (conservative). If the provider returns no usage after a call
-- was attempted, the full reservation is charged.
CREATE FUNCTION rg_ai_settle(p_event uuid, p_input int, p_output int, p_cached int, p_reasoning int,
                             p_cost bigint, p_voice_seconds int DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE ev ai_usage_events; billable int; cost bigint; voice int; src text;
BEGIN
  SELECT * INTO ev FROM ai_usage_events WHERE id = p_event FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF ev.status <> 'reserved' THEN RETURN 'already_settled'; END IF;
  IF p_input IS NULL AND p_output IS NULL THEN
    billable := ev.reserved_tokens; cost := ev.reserved_cost_paise; src := 'assumed_full_reservation';
  ELSE
    billable := COALESCE(p_input, 0) + COALESCE(p_output, 0) + COALESCE(p_reasoning, 0);
    cost := COALESCE(p_cost, ev.reserved_cost_paise); src := 'provider';
  END IF;
  voice := COALESCE(p_voice_seconds, ev.reserved_voice_seconds);
  UPDATE ai_usage_balances
     SET tokens_reserved = tokens_reserved - ev.reserved_tokens,
         tokens_consumed = tokens_consumed + billable,
         cost_reserved_paise = cost_reserved_paise - ev.reserved_cost_paise,
         cost_consumed_paise = cost_consumed_paise + cost,
         voice_seconds_reserved = voice_seconds_reserved - ev.reserved_voice_seconds,
         voice_seconds_consumed = voice_seconds_consumed + voice,
         in_flight = in_flight - 1, version = version + 1
   WHERE id = ev.balance_id;
  UPDATE ai_usage_events SET status = 'completed', input_tokens = p_input, output_tokens = p_output,
         cached_tokens = p_cached, reasoning_tokens = p_reasoning, billable_tokens = billable,
         voice_seconds = voice, final_cost_paise = cost, usage_source = src, completed_at = now()
   WHERE id = ev.id;
  RETURN 'settled';
END $$;

-- Release a reservation when the provider was never called (validation/timeout before send).
CREATE FUNCTION rg_ai_release(p_event uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE ev ai_usage_events;
BEGIN
  SELECT * INTO ev FROM ai_usage_events WHERE id = p_event FOR UPDATE;
  IF NOT FOUND OR ev.status <> 'reserved' THEN RETURN 'noop'; END IF;
  UPDATE ai_usage_balances
     SET tokens_reserved = tokens_reserved - ev.reserved_tokens,
         cost_reserved_paise = cost_reserved_paise - ev.reserved_cost_paise,
         voice_seconds_reserved = voice_seconds_reserved - ev.reserved_voice_seconds,
         in_flight = in_flight - 1, version = version + 1
   WHERE id = ev.balance_id;
  UPDATE ai_usage_events SET status = 'released', usage_source = 'none', billable_tokens = 0, final_cost_paise = 0,
         completed_at = now() WHERE id = ev.id;
  RETURN 'released';
END $$;

-- ───────────────────────────── read models ─────────────────────────────
CREATE VIEW v_tenancy_balance AS
SELECT t.id AS tenancy_id, t.owner_account_id, t.tenant_user_id,
       COALESCE((SELECT sum(amount_paise) FROM ledger_entries le WHERE le.tenancy_id = t.id AND le.account = 'tenant_receivable'), 0)::bigint AS balance_paise,
       COALESCE((SELECT sum(amount_paise) FROM ledger_entries le WHERE le.tenancy_id = t.id AND le.account = 'deposit_held'), 0)::bigint AS deposit_held_paise
FROM tenancies t;

CREATE VIEW v_invoice_status AS
SELECT i.id AS invoice_id, i.tenancy_id, i.owner_account_id, i.period_month, i.due_date, i.number,
       COALESCE(sum(l.amount_paise), 0)::bigint AS total_paise,
       COALESCE(sum(o.open_paise), 0)::bigint AS open_paise,
       CASE WHEN COALESCE(sum(o.open_paise), 0) = 0 THEN 'paid'
            WHEN COALESCE(sum(o.open_paise), 0) < COALESCE(sum(CASE WHEN l.amount_paise > 0 THEN l.amount_paise END), 0)
                 THEN CASE WHEN rg_today() > i.due_date THEN 'overdue_partial' ELSE 'partial' END
            WHEN rg_today() > i.due_date THEN 'overdue'
            ELSE 'unpaid' END AS status
FROM monthly_invoices i
LEFT JOIN invoice_lines l ON l.invoice_id = i.id
LEFT JOIN v_line_open o ON o.line_id = l.id
WHERE i.status = 'issued'
GROUP BY i.id;
