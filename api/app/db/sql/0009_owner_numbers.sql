-- Owner numbers: the mobile numbers an owner declares (when buying the plan, or later) as the people who may act as owners of
-- the same account. Only a person who signs in with one of these numbers (OTP-verified) is attached as a co-owner; anyone else
-- stays a separate owner with their own, private properties.
CREATE TABLE owner_allowed_numbers (
    owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
    phone            text NOT NULL CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
    added_by         uuid REFERENCES users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    removed_at       timestamptz,
    PRIMARY KEY (owner_account_id, phone)
);
CREATE INDEX ix_owner_allowed_phone ON owner_allowed_numbers(phone) WHERE removed_at IS NULL;
