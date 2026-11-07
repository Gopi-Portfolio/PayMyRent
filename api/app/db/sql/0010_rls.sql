-- Row-level security: a second line of defence BELOW the application code.
-- The API connects as the limited role pmr_app and tells the database, per request, who is asking
-- (app.user_id / app.owner_ids / app.phones, transaction-local). The database then only returns or changes rows that belong to
-- that person's owner account(s), or to the tenancies they rent. A query that forgets its WHERE clause can no longer leak another
-- owner's data. System work (migrations, scheduled jobs, webhooks, admin review) runs as the table owner, which RLS does not restrict.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmr_app') THEN
    CREATE ROLE pmr_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;   -- LOGIN + password are set at deploy time
  END IF;
END $$;

-- (re-runnable: the policies and helper functions are replaced if they already exist)
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE policyname = 'rg_scope' LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS rg_my_properties();
DROP FUNCTION IF EXISTS rg_my_units();
DROP FUNCTION IF EXISTS rg_my_tenancies();

-- who is asking (set by the API at the start of each request; empty = nobody = sees nothing)
CREATE OR REPLACE FUNCTION rg_ctx_user() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION rg_ctx_owners() RETURNS uuid[] LANGUAGE sql STABLE
  AS $$ SELECT coalesce(string_to_array(nullif(current_setting('app.owner_ids', true), ''), ',')::uuid[], '{}'::uuid[]) $$;
CREATE OR REPLACE FUNCTION rg_ctx_phones() RETURNS text[] LANGUAGE sql STABLE
  AS $$ SELECT coalesce(string_to_array(nullif(current_setting('app.phones', true), ''), ','), '{}'::text[]) $$;

-- the tenancies this person rents (computed ONCE per request by the API, so every rule below is a plain, index-friendly array test)
CREATE OR REPLACE FUNCTION rg_ctx_tenancies() RETURNS uuid[] LANGUAGE sql STABLE
  AS $$ SELECT coalesce(string_to_array(nullif(current_setting('app.tenancy_ids', true), ''), ',')::uuid[], '{}'::uuid[]) $$;

-- the tenancies this person rents, or has been invited to and not yet answered (phone match only while the invitation is still open:
-- a recycled number never reaches an old, accepted tenancy). SECURITY DEFINER so it reads tenancies directly, via their indexes.
CREATE FUNCTION rg_my_tenancies() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenancies WHERE tenant_user_id = rg_ctx_user()
  UNION ALL
  SELECT id FROM tenancies WHERE status = 'invited' AND tenant_user_id IS NULL AND invited_phone = ANY (rg_ctx_phones()) $$;
CREATE FUNCTION rg_my_units() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT unit_id FROM tenancies WHERE id = ANY (rg_ctx_tenancies()) $$;
CREATE FUNCTION rg_my_properties() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT property_id FROM units WHERE id IN (SELECT rg_my_units()) $$;

-- the limited role may use the data, but only through the policies below
GRANT USAGE ON SCHEMA public TO pmr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pmr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pmr_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pmr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pmr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pmr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO pmr_app;

-- views must run with the caller's rights, otherwise they would see everything
ALTER VIEW v_credit_remaining SET (security_invoker = true);
ALTER VIEW v_invoice_status SET (security_invoker = true);
ALTER VIEW v_line_open SET (security_invoker = true);
ALTER VIEW v_payment_remaining SET (security_invoker = true);
ALTER VIEW v_tenancy_balance SET (security_invoker = true);

-- tenancies: the owner's account(s), or the renter / invited person
ALTER TABLE tenancies ENABLE ROW LEVEL SECURITY;
-- three branches, each answered by an index: the owner's account, the renter, an open invitation to this phone
CREATE POLICY rg_scope ON tenancies FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners()) OR tenant_user_id = rg_ctx_user()
         OR (status = 'invited' AND tenant_user_id IS NULL AND invited_phone = ANY (rg_ctx_phones())))
  WITH CHECK (owner_account_id = ANY (rg_ctx_owners()) OR tenant_user_id = rg_ctx_user()
         OR (status = 'invited' AND tenant_user_id IS NULL AND invited_phone = ANY (rg_ctx_phones())));

-- units / properties: the owner's, plus only the unit (and its property) a renter actually rents
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON units FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners()) OR id IN (SELECT rg_my_units()))
  WITH CHECK (owner_account_id = ANY (rg_ctx_owners()));
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON properties FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners()) OR id IN (SELECT rg_my_properties()))
  WITH CHECK (owner_account_id = ANY (rg_ctx_owners()));

-- rows that carry both an owner and a tenancy
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['monthly_invoices', 'payments', 'ledger_entries', 'receipts', 'notes', 'disputes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY rg_scope ON %I FOR ALL TO pmr_app
        USING (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()))
        WITH CHECK (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()))$p$, t);
  END LOOP;
  -- rows that hang off a tenancy: visible exactly when the tenancy is
  FOREACH t IN ARRAY ARRAY['charge_submissions', 'contact_change_proposals', 'deposit_transactions', 'deposits', 'payment_allocations',
                           'recurring_charge_config', 'rent_free_periods', 'rent_revisions', 'tenancy_contact_snapshots', 'tenancy_invitations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY rg_scope ON %I FOR ALL TO pmr_app
        USING (tenancy_id IN (SELECT id FROM tenancies)) WITH CHECK (tenancy_id IN (SELECT id FROM tenancies))$p$, t);
  END LOOP;
END $$;

-- invoice lines hang off an invoice
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON invoice_lines FOR ALL TO pmr_app
  USING (invoice_id IN (SELECT id FROM monthly_invoices)) WITH CHECK (invoice_id IN (SELECT id FROM monthly_invoices));
