-- A place is identified by building + floor + number. The same number can exist on different floors ("Room 1" on the 1st and on the 2nd floor),
-- never twice on the same floor ("no floor given" counts as its own floor). Spelling and spacing are ignored: "S-01", "s 01" and "S01" are one number.
DROP INDEX IF EXISTS ux_unit_identity;
DROP INDEX IF EXISTS ux_unit_identifier;
CREATE UNIQUE INDEX ux_unit_place ON units(property_id, COALESCE(floor, -1), regexp_replace(lower(identifier), '[^a-z0-9]', '', 'g'));
