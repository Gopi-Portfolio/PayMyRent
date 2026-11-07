-- A renter cannot close a rental on their own: they ask the owner of THAT place to let them vacate. Only that owner is told and only that
-- owner can approve. Approving ends the tenancy with the existing rg_end_tenancy (the place becomes vacant); the request is just the ask.
CREATE TABLE vacate_requests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id        uuid NOT NULL REFERENCES tenancies(id),
    requested_by      uuid NOT NULL REFERENCES users(id),
    move_out_date     date NOT NULL,
    reason            text CHECK (reason IS NULL OR char_length(reason) <= 250),
    status            text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined','cancelled')),
    owner_note        text CHECK (owner_note IS NULL OR char_length(owner_note) <= 250),
    decided_by        uuid REFERENCES users(id),
    decided_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_vacate_one_open ON vacate_requests(tenancy_id) WHERE status = 'requested';
CREATE INDEX ix_vacate_owner_open ON vacate_requests(owner_account_id) WHERE status = 'requested';

ALTER TABLE vacate_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON vacate_requests FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()))
  WITH CHECK (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()));
