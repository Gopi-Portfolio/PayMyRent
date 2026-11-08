-- How the owner wants to receive rent, chosen for EACH tenant.
--   upi    : the tenant pays the owner's UPI ID directly (Google Pay / any UPI app). Free. The owner confirms each payment.
--   online : the tenant pays through the app's checkout (a payment provider; it may charge a fee).
--   cash   : the tenant pays in cash or a bank transfer outside the app; the owner records it.
-- NULL means the owner has not chosen yet (older tenancies): the app asks them.
-- The UPI ID is the owner's own payee address for this tenant. Changing it is a step-up (OTP) action, and the tenant is told.
ALTER TABLE tenancies
  ADD COLUMN pay_method text CHECK (pay_method IN ('upi','online','cash')),
  ADD COLUMN pay_upi_id text CHECK (pay_upi_id IS NULL OR pay_upi_id ~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{2,32}$'),
  ADD CONSTRAINT tenancies_upi_needs_id CHECK (pay_method IS DISTINCT FROM 'upi' OR pay_upi_id IS NOT NULL);

-- The owner did not receive this transfer (or it does not match): the report is closed as failed. Nothing reaches the ledger.
CREATE FUNCTION rg_owner_reject_transfer(p_payment uuid, p_actor uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p payments;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: payment' USING ERRCODE = 'P0001'; END IF;
  PERFORM rg_lock_tenancy(p.tenancy_id);
  SELECT * INTO p FROM payments WHERE id = p_payment FOR UPDATE;
  IF p.method <> 'manual_transfer' OR p.status <> 'pending' THEN
    RAISE EXCEPTION 'INVALID_STATE: only pending manual transfers can be rejected' USING ERRCODE = 'P0001';
  END IF;
  UPDATE payments SET status = 'failed' WHERE id = p.id;
  INSERT INTO payment_events(payment_id, type, data) VALUES (p.id, 'owner_rejected', jsonb_build_object('by', p_actor, 'reason', p_reason));
END $$;
GRANT EXECUTE ON FUNCTION rg_owner_reject_transfer(uuid, uuid, text) TO pmr_app;
