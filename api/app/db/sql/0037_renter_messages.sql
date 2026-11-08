-- A renter writing to the owner of their rental (typed or spoken). The owner sees it in the bell and answers from there.
CREATE TABLE renter_messages (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id        uuid NOT NULL REFERENCES tenancies(id),
    sent_by           uuid NOT NULL REFERENCES users(id),
    text              text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 600),
    lang              text NOT NULL CHECK (lang IN ('en','ta','hi','te','kn','ml','mr','bn')),
    input_method      text NOT NULL DEFAULT 'typed' CHECK (input_method IN ('typed','voice')),
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_renter_messages_tenancy ON renter_messages(tenancy_id, created_at DESC);
ALTER TABLE renter_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON renter_messages FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()))
  WITH CHECK (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()));
GRANT SELECT, INSERT ON renter_messages TO pmr_app;
