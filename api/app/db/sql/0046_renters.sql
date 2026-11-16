-- A renter the owner has recorded before allotting a place: contact details plus a photo ID (encrypted, owner-only).
CREATE TABLE renters (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
    name             text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 400),
    phone            text NOT NULL,
    email            text,
    address          text,
    id_type          text NOT NULL CHECK (id_type IN ('aadhaar', 'pan', 'voter', 'driving', 'passport')),
    id_mime          text NOT NULL CHECK (id_mime IN ('image/jpeg', 'image/png')),
    id_enc           bytea NOT NULL,
    id_sha256        text NOT NULL,
    keep_copy_ok     boolean NOT NULL CHECK (keep_copy_ok),     -- the owner ticked that they may keep a copy
    tenancy_id       uuid REFERENCES tenancies(id),             -- set when the renter is allotted a place
    created_by       uuid NOT NULL REFERENCES users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_account_id, phone)
);
ALTER TABLE renters ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON renters FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners())) WITH CHECK (owner_account_id = ANY (rg_ctx_owners()));
