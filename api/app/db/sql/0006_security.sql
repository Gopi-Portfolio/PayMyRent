-- Security hardening: owner PAN stored encrypted (+ keyed lookup hash), shared rate-limit counters.
ALTER TABLE owner_verifications ADD COLUMN pan_enc text, ADD COLUMN pan_hash text, ADD COLUMN pan_masked text;
DROP INDEX IF EXISTS ux_owner_verification_pan;
ALTER TABLE owner_verifications DROP CONSTRAINT IF EXISTS owner_verifications_pan_check;
ALTER TABLE owner_verifications ALTER COLUMN pan DROP NOT NULL;
CREATE UNIQUE INDEX ux_owner_verification_pan_hash ON owner_verifications(pan_hash) WHERE status IN ('submitted','verified');

-- Works across several API servers (the old limiter was per-process memory).
CREATE TABLE rate_limit_hits (
    key     text        NOT NULL,
    hit_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_rate_limit_hits ON rate_limit_hits(key, hit_at);
