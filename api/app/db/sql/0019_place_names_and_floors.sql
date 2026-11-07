-- A commercial place is described, not numbered: "10-50 hostel", "2 shops, 5 houses", "Factory shed". It may be longer and use a few more characters.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_identifier_check;
ALTER TABLE units ADD CONSTRAINT units_identifier_check CHECK (
  (kind IN ('commercial','other') AND identifier ~ '^[A-Za-z0-9][A-Za-z0-9/ ,.&#+()''-]{0,79}$')
  OR identifier ~ '^[A-Za-z0-9][A-Za-z0-9/ -]{0,19}$');

-- The floor of the building: 0 = ground, 1 = 1st ... 10 = 10th. Optional.
ALTER TABLE units ADD COLUMN IF NOT EXISTS floor smallint;
ALTER TABLE units ADD CONSTRAINT units_floor_check CHECK (floor IS NULL OR floor BETWEEN 0 AND 10);
