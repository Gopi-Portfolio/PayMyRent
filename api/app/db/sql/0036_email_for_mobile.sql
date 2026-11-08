-- Every email belongs to one of the person's own mobile numbers (one email per number). Existing emails go to the login number
-- (a second one to the person's other number when there is one).
ALTER TABLE user_contacts ADD COLUMN for_mobile_id uuid REFERENCES user_contacts(id);

WITH ranked AS (
  SELECT e.id, e.user_id, row_number() OVER (PARTITION BY e.user_id ORDER BY e.created_at) AS n FROM user_contacts e
   WHERE e.kind = 'email' AND e.removed_at IS NULL)
UPDATE user_contacts e SET for_mobile_id = COALESCE(
    CASE WHEN r.n = 2 THEN (SELECT m.id FROM user_contacts m WHERE m.user_id = e.user_id AND m.kind = 'mobile' AND m.removed_at IS NULL AND NOT m.is_primary ORDER BY m.created_at LIMIT 1) END,
    (SELECT m.id FROM user_contacts m WHERE m.user_id = e.user_id AND m.kind = 'mobile' AND m.removed_at IS NULL AND m.is_primary LIMIT 1))
  FROM ranked r WHERE r.id = e.id;
