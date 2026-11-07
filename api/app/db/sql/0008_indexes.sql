-- Indexes found missing by the 70,000-shop load test (owner dashboard scanned every bill; every request scanned owner_memberships).
CREATE INDEX IF NOT EXISTS ix_membership_user ON owner_memberships(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_invoices_owner_due ON monthly_invoices(owner_account_id, due_date);
CREATE INDEX IF NOT EXISTS ix_payments_owner_paid ON payments(owner_account_id, paid_on) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS ix_units_owner ON units(owner_account_id);
CREATE INDEX IF NOT EXISTS ix_notes_tenancy ON notes(tenancy_id, created_at);
