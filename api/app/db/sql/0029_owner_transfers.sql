-- An owner who is leaving hands the whole owner account (places, renters, history) to another mobile number. The account keeps its
-- records; the new owner must pay for a plan before using it (its old subscription is ended), and gives their own owner details.
CREATE TABLE owner_transfers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
    from_user_id     uuid NOT NULL REFERENCES users(id),
    to_phone         text NOT NULL,
    to_user_id       uuid REFERENCES users(id),
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz
);
CREATE UNIQUE INDEX ux_owner_transfer_one_pending ON owner_transfers(owner_account_id) WHERE status = 'pending';
CREATE INDEX ix_owner_transfer_phone ON owner_transfers(to_phone) WHERE status = 'pending';
