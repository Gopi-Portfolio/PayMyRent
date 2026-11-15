-- Photos for the automatic owner check (docs/DECISIONS.md D-21, amended): the owner's PAN card, live selfie and the first and last page
-- of the property deed. Each photo is encrypted (AES-GCM, key from RG_PAN_ENCRYPTION_KEY) before it reaches this table, so a copy of the
-- database alone does not show them. One row per kind per owner account; a new upload replaces the old one.
CREATE TABLE owner_documents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
    kind             text NOT NULL CHECK (kind IN ('pan', 'aadhaar', 'selfie', 'deed_first', 'deed_last')),
    mime             text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
    content_enc      bytea NOT NULL,
    sha256           text NOT NULL,                       -- of the original photo: the same photo cannot back two owner accounts
    text_enc         bytea,                               -- the text read from the photo (encrypted), kept so a property can be matched to the deed later
    uploaded_by      uuid REFERENCES users(id),
    uploaded_phone   text,                                -- the signed-in mobile at upload time
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_account_id, kind)
);
CREATE INDEX ix_owner_documents_sha ON owner_documents(sha256);

ALTER TABLE owner_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON owner_documents FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners())) WITH CHECK (owner_account_id = ANY (rg_ctx_owners()));

-- Automatic property verification. The server has already matched the deed text against the property's address; this function only
-- enforces what the database can check itself: the switch is on, the owner passed the automatic document check, and both deed pages exist.
-- Like rg_demo_verify_property it is the only way the signed-in role can verify a property, and it does nothing unless the flag is on.
INSERT INTO system_flags(key, value) VALUES ('doc_auto_verify', 'off') ON CONFLICT (key) DO NOTHING;
CREATE FUNCTION rg_doc_verify_property(p_property uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce((SELECT value FROM system_flags WHERE key = 'doc_auto_verify'), 'off') <> 'on' THEN RETURN false; END IF;
  UPDATE properties p SET verification_status = 'verified', reviewed_at = now(), review_note = 'automatic document check'
   WHERE p.id = p_property AND p.verification_status = 'submitted' AND p.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM owner_verifications v WHERE v.owner_account_id = p.owner_account_id AND v.status = 'verified'
                   AND v.review_note = 'automatic document check')
     AND (SELECT count(*) FROM owner_documents d WHERE d.owner_account_id = p.owner_account_id AND d.kind IN ('deed_first', 'deed_last')) = 2;
  RETURN FOUND;
END $$;
GRANT EXECUTE ON FUNCTION rg_doc_verify_property(uuid) TO pmr_app;
