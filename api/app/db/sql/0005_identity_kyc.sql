-- Provider-based identity verification (government ID + liveness selfie + name match).
-- PayMyRent stores ONLY the outcome and a provider reference — never ID numbers (e.g. Aadhaar), ID images or selfies.
CREATE TABLE identity_verifications (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid NOT NULL REFERENCES users(id),
    status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','verified','failed','manual_review','rejected','withdrawn')),
    provider             text NOT NULL,
    provider_session_id  text UNIQUE,
    method               text,                           -- e.g. 'digilocker', 'aadhaar_otp', 'document_ocr'
    liveness_passed      boolean,
    face_matched         boolean,
    name_matched         boolean,
    consent_version      text NOT NULL,
    consented_at         timestamptz NOT NULL DEFAULT now(),
    expires_at           timestamptz,
    reviewed_at          timestamptz,
    review_note          text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_identity_one_open     ON identity_verifications(user_id) WHERE status IN ('pending','manual_review');
CREATE UNIQUE INDEX ux_identity_one_verified ON identity_verifications(user_id) WHERE status = 'verified';
CREATE INDEX ix_identity_user ON identity_verifications(user_id, created_at DESC);
