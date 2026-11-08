-- When the owner moves a rental's end date, the rent already billed is brought in line with it:
-- months after the new end date are credited back, the last month is pro-rated, and an extended rental is billed on the next call.
-- Nothing is deleted or rewritten: the change is an adjustment (more rent) or a credit note (less rent) on the same invoice, with a reason.

-- the rent a month should carry for this tenancy as it stands now (same rule as rg_generate_monthly_invoice)
CREATE FUNCTION rg_expected_rent(p_tenancy uuid, p_month date) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE t tenancies; base bigint; dim int; d_from date; d_to date; days int;
BEGIN
  SELECT * INTO t FROM tenancies WHERE id = p_tenancy;
  SELECT COALESCE((SELECT monthly_rent_paise FROM rent_revisions
                    WHERE tenancy_id = p_tenancy AND effective_month <= p_month
                    ORDER BY effective_month DESC LIMIT 1), t.monthly_rent_paise) INTO base;
  IF EXISTS (SELECT 1 FROM rent_free_periods WHERE tenancy_id = p_tenancy AND p_month BETWEEN from_month AND to_month) THEN
    RETURN 0;
  END IF;
  dim    := extract(day FROM rg_month_last_day(p_month))::int;
  d_from := GREATEST(t.start_date, p_month);
  d_to   := LEAST(COALESCE(t.end_date, rg_month_last_day(p_month)), rg_month_last_day(p_month));
  days   := GREATEST(d_to - d_from + 1, 0);
  RETURN round(base::numeric * days / dim)::bigint;
END $$;

CREATE FUNCTION rg_resync_rent(p_tenancy uuid, p_actor uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE t tenancies; inv record; expected bigint; current_net bigint; delta bigint; rent_line uuid; dim int; days int; n int := 0;
BEGIN
  t := rg_lock_tenancy(p_tenancy);
  IF t.status <> 'active' THEN RETURN 0; END IF;
  FOR inv IN SELECT i.id, i.period_month FROM monthly_invoices i
              WHERE i.tenancy_id = p_tenancy AND i.status = 'issued'
                AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.category = 'rent' AND l.source = 'system' AND l.kind = 'charge')
              ORDER BY i.period_month LOOP
    expected := rg_expected_rent(p_tenancy, inv.period_month);
    SELECT COALESCE(sum(amount_paise), 0) INTO current_net FROM invoice_lines
     WHERE invoice_id = inv.id AND category = 'rent' AND source = 'system';
    delta := expected - current_net;
    CONTINUE WHEN delta = 0;
    SELECT id INTO rent_line FROM invoice_lines
     WHERE invoice_id = inv.id AND category = 'rent' AND source = 'system' AND kind = 'charge';
    dim  := extract(day FROM rg_month_last_day(inv.period_month))::int;
    days := LEAST(GREATEST((LEAST(COALESCE(t.end_date, rg_month_last_day(inv.period_month)), rg_month_last_day(inv.period_month))
                            - GREATEST(t.start_date, inv.period_month) + 1), 0), dim);
    PERFORM rg_post_line(inv.id, 'rent', CASE WHEN delta > 0 THEN 'adjustment' ELSE 'credit_note' END, delta,
            CASE WHEN expected = 0 THEN 'Rent removed: rental ends before this month'
                 ELSE format('Rent adjusted for new end date (%s of %s days)', days, dim) END,
            'system', NULL, rent_line, 'End date changed', p_actor);
    n := n + 1;
  END LOOP;
  PERFORM rg_reallocate(p_tenancy);
  RETURN n;
END $$;
