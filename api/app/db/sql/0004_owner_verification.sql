-- Owner details required before an owner can add properties or tenants.
-- Status is 'submitted' until a reviewer marks it 'verified'. A document reference is never treated as proof
-- of title on its own; payouts are gated separately (see docs/DECISIONS.md D-03).
CREATE TABLE owner_verifications (
    owner_account_id   uuid PRIMARY KEY REFERENCES owner_accounts(id),
    legal_name         text NOT NULL CHECK (char_length(legal_name) BETWEEN 2 AND 400),
    pan                text NOT NULL CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
    address            text NOT NULL CHECK (char_length(address) BETWEEN 5 AND 1000),
    proof_type         text NOT NULL CHECK (proof_type IN ('property_tax','electricity_bill','sale_deed','rent_agreement','gst','other')),
    proof_ref          text NOT NULL CHECK (char_length(proof_ref) BETWEEN 3 AND 80),
    declared_at        timestamptz NOT NULL DEFAULT now(),
    status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected')),
    reviewed_at        timestamptz,
    review_note        text,
    updated_at         timestamptz NOT NULL DEFAULT now()
);
-- The same PAN cannot back two different owner accounts.
CREATE UNIQUE INDEX ux_owner_verification_pan ON owner_verifications(pan) WHERE status IN ('submitted','verified');
