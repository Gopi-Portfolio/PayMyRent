-- The bell is per role: someone who is both an owner and a renter has two separate lists and two separate "last looked" times.
-- notifications_seen_at (0016) is the renter's; this is the owner's.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_seen_owner_at timestamptz;
