-- The owner's usual way of receiving rent, saved once in the profile. A tenant whose own pay_method is NULL follows it;
-- a tenant with a pay_method of their own is an exception the owner chose for that tenant.
ALTER TABLE owner_accounts
  ADD COLUMN default_pay_method text CHECK (default_pay_method IS NULL OR default_pay_method IN ('upi','online','cash'));
