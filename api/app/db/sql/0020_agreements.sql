-- Agreements. A rental's agreement can be extended while it runs, or replaced by a new one after it lapsed. Each period is its own row,
-- and old rows are never changed or removed: the history stays in the database.
ALTER TABLE tenancies ADD COLUMN IF NOT EXISTS increment_percent numeric(5,2);
ALTER TABLE tenancies ADD CONSTRAINT tenancies_increment_check CHECK (increment_percent IS NULL OR increment_percent BETWEEN 0 AND 100);

CREATE TABLE tenancy_agreements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id    uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id          uuid NOT NULL REFERENCES tenancies(id),
    seq                 integer NOT NULL CHECK (seq >= 1),
    kind                text NOT NULL CHECK (kind IN ('original','extension','new')),
    start_date          date NOT NULL,
    end_date            date,
    monthly_rent_paise  bigint NOT NULL CHECK (monthly_rent_paise >= 0),      -- the rent this agreement starts with
    increment_percent   numeric(5,2),                                          -- the yearly increase that was applied to get there
    note                text CHECK (note IS NULL OR char_length(note) <= 250),
    created_by          uuid REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenancy_id, seq),
    CHECK (end_date IS NULL OR end_date > start_date OR kind = 'original')
);
CREATE INDEX ix_agreements_owner ON tenancy_agreements(owner_account_id);

ALTER TABLE tenancy_agreements ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON tenancy_agreements FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()))
  WITH CHECK (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()));

-- history is kept: an agreement row can be added, never edited or deleted
CREATE FUNCTION rg_agreements_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_RECORD: agreement history cannot be changed or removed' USING ERRCODE = 'P0001'; END $$;
CREATE TRIGGER trg_agreements_keep BEFORE UPDATE OR DELETE ON tenancy_agreements FOR EACH ROW EXECUTE FUNCTION rg_agreements_keep();

-- every rental that exists already gets its first agreement row
INSERT INTO tenancy_agreements(owner_account_id, tenancy_id, seq, kind, start_date, end_date, monthly_rent_paise)
SELECT owner_account_id, id, 1, 'original', start_date, end_date, monthly_rent_paise FROM tenancies;
