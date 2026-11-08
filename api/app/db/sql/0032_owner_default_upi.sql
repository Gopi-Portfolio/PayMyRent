-- The owner's UPI ID is saved once on the owner account (profile) and used for every tenant who is set to UPI.
-- A tenant's own pay_upi_id (0031) is now only an override: NULL means "use the owner's UPI ID".
ALTER TABLE owner_accounts
  ADD COLUMN default_upi_id text CHECK (default_upi_id IS NULL OR default_upi_id ~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{2,32}$');
ALTER TABLE tenancies DROP CONSTRAINT tenancies_upi_needs_id;
