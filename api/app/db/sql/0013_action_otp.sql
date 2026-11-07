-- One-time codes that approve a verification step (identity check, owner details, property, payout account, second-owner number).
-- The code goes only to the mobile number attached to the signed-in account, and is good for that one step only.
ALTER TABLE otp_challenges DROP CONSTRAINT IF EXISTS otp_challenges_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_purpose_check
  CHECK (purpose IN ('dev_login','verify_mobile','verify_email','change_primary_old','change_primary_new','verify_action'));
