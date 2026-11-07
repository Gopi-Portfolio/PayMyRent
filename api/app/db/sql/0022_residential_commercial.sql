-- Two kinds of place only: residential and commercial. A shop is a commercial place; a house or flat is residential.
-- Both have a floor, a door / shop / room number (or a description), rooms and so on.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_kind_check;
UPDATE units SET kind = CASE WHEN kind IN ('house','flat','residential') THEN 'residential' ELSE 'commercial' END;
ALTER TABLE units ADD CONSTRAINT units_kind_check CHECK (kind IN ('residential','commercial'));
ALTER TABLE units ALTER COLUMN kind SET DEFAULT 'commercial';

-- the number / name of a place is free-form for both kinds ("12", "4B", "Flat 3", "S-01", "10-50 hostel", "2 shops, 5 houses")
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_identifier_check;
ALTER TABLE units ADD CONSTRAINT units_identifier_check CHECK (identifier ~ '^[A-Za-z0-9][A-Za-z0-9/ ,.&#+()''-]{0,79}$');
