-- Rent relief: a renter who cannot pay the full month asks the owner; the owner agrees an amount to pay now and the rest moves to next month.
-- Nothing is edited. The month gets a credit note for the deferred part (applied to that month's own open lines) and next month's bill
-- gets a matching "carried over" charge, so the total owed never changes and both sides read the same bill.
CREATE TABLE rent_relief (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id    uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id          uuid NOT NULL REFERENCES tenancies(id),
    period_month        date NOT NULL CHECK (extract(day FROM period_month) = 1),
    initiated_by        text NOT NULL CHECK (initiated_by IN ('renter','owner')),
    status              text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined','cancelled')),
    requested_pay_paise bigint CHECK (requested_pay_paise >= 0),      -- what the renter says they can pay now
    reason              text CHECK (reason IS NULL OR char_length(reason) <= 250),
    billed_paise        bigint,                                        -- the month's full bill when it was decided
    open_paise          bigint,                                        -- what was still unpaid for that month at that moment
    agreed_pay_paise    bigint CHECK (agreed_pay_paise >= 0),          -- what the owner agreed must be paid now
    deferred_paise      bigint CHECK (deferred_paise > 0),             -- what moves to next month
    owner_note          text CHECK (owner_note IS NULL OR char_length(owner_note) <= 250),
    credit_line_id      uuid REFERENCES invoice_lines(id),
    carry_line_id       uuid REFERENCES invoice_lines(id),
    requested_by        uuid REFERENCES users(id),
    decided_by          uuid REFERENCES users(id),
    decided_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_relief_one_open     ON rent_relief(tenancy_id, period_month) WHERE status = 'requested';
CREATE UNIQUE INDEX ux_relief_one_approved ON rent_relief(tenancy_id, period_month) WHERE status = 'approved';
CREATE INDEX ix_relief_owner_open ON rent_relief(owner_account_id) WHERE status = 'requested';

ALTER TABLE rent_relief ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON rent_relief FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()))
  WITH CHECK (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()));

-- Approve a request at an agreed "pay now" amount. The caller holds no lock; this takes the tenancy lock.
CREATE FUNCTION rg_apply_rent_relief(p_relief uuid, p_agreed bigint, p_note text, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r rent_relief; t tenancies; inv uuid; ninv uuid; nxt date; total bigint; open_ bigint; d bigint; cl uuid; carry uuid; ln record; take bigint; left_ bigint;
BEGIN
  SELECT * INTO r FROM rent_relief WHERE id = p_relief FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: rent relief request' USING ERRCODE = 'P0001'; END IF;
  t := rg_lock_tenancy(r.tenancy_id);
  IF r.status <> 'requested' THEN RAISE EXCEPTION 'INVALID_STATE: this request has already been decided' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'active' THEN RAISE EXCEPTION 'TENANCY_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  PERFORM rg_require_owner_writable(t.owner_account_id);
  IF p_agreed IS NULL OR p_agreed < 0 THEN RAISE EXCEPTION 'VALIDATION: the agreed amount cannot be negative' USING ERRCODE = 'P0001'; END IF;

  SELECT invoice_id, total_paise, open_paise INTO inv, total, open_ FROM v_invoice_status WHERE tenancy_id = r.tenancy_id AND period_month = r.period_month;
  IF inv IS NULL THEN RAISE EXCEPTION 'VALIDATION: there is no bill for that month yet' USING ERRCODE = 'P0001'; END IF;
  IF open_ <= 0 THEN RAISE EXCEPTION 'VALIDATION: nothing is unpaid for that month' USING ERRCODE = 'P0001'; END IF;
  IF p_agreed >= open_ THEN RAISE EXCEPTION 'VALIDATION: the agreed amount must be less than what is unpaid; otherwise nothing moves to next month' USING ERRCODE = 'P0001'; END IF;
  d := open_ - p_agreed;

  nxt := (r.period_month + interval '1 month')::date;
  IF t.end_date IS NOT NULL AND nxt > t.end_date THEN
    RAISE EXCEPTION 'VALIDATION: this is the last month of the tenancy, so the balance cannot move to a next month' USING ERRCODE = 'P0001';
  END IF;

  -- this month: a credit note for the deferred part, applied to this month's own open lines (not to an older month)
  cl := rg_post_line(inv, 'rent', 'credit_note', -d, 'Moved to next month (agreed with the owner)', 'owner', NULL, NULL,
                     COALESCE(NULLIF(trim(p_note), ''), 'Rent relief agreed'), p_actor);
  left_ := d;
  FOR ln IN SELECT line_id, open_paise FROM v_line_open WHERE tenancy_id = r.tenancy_id AND period_month = r.period_month AND open_paise > 0
            ORDER BY rg_category_priority(category), created_at, line_id LOOP
    EXIT WHEN left_ <= 0;
    take := LEAST(ln.open_paise, left_);
    INSERT INTO payment_allocations(tenancy_id, credit_line_id, invoice_line_id, amount_paise) VALUES (r.tenancy_id, cl, ln.line_id, take);
    left_ := left_ - take;
  END LOOP;

  -- next month: the same amount, carried over
  ninv := rg_ensure_invoice(r.tenancy_id, nxt);
  carry := rg_post_line(ninv, 'other', 'charge', d, 'Carried over from ' || to_char(r.period_month, 'Mon YYYY'), 'owner', NULL, NULL, NULL, p_actor);
  PERFORM rg_reallocate(r.tenancy_id);

  UPDATE rent_relief SET status = 'approved', billed_paise = total, open_paise = open_, agreed_pay_paise = p_agreed, deferred_paise = d,
         owner_note = NULLIF(trim(p_note), ''), credit_line_id = cl, carry_line_id = carry, decided_by = p_actor, decided_at = now()
   WHERE id = p_relief;
END $$;

-- "Pay now": what is due this month or earlier. Charges already placed on a future month (e.g. a carried-over balance) are owed but not yet payable.
CREATE OR REPLACE VIEW v_tenancy_balance AS
SELECT t.id AS tenancy_id, t.owner_account_id, t.tenant_user_id,
       COALESCE((SELECT sum(amount_paise) FROM ledger_entries le WHERE le.tenancy_id = t.id AND le.account = 'tenant_receivable'), 0)::bigint AS balance_paise,
       COALESCE((SELECT sum(amount_paise) FROM ledger_entries le WHERE le.tenancy_id = t.id AND le.account = 'deposit_held'), 0)::bigint AS deposit_held_paise,
       GREATEST(
         COALESCE((SELECT sum(amount_paise) FROM ledger_entries le WHERE le.tenancy_id = t.id AND le.account = 'tenant_receivable'), 0)
         - COALESCE((SELECT sum(v.open_paise) FROM v_invoice_status v WHERE v.tenancy_id = t.id AND v.period_month > date_trunc('month', rg_today())::date), 0),
         0)::bigint AS payable_now_paise
FROM tenancies t;
ALTER VIEW v_tenancy_balance SET (security_invoker = true);
