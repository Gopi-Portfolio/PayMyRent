-- The bell: everything newer than this moment is "unread" for the person.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_seen_at timestamptz;
