-- One flat/shop/house = one unit, however it is spelled: "S-01", "s 01" and "S01" are the same unit,
-- so a second tenant cannot be put on the same address under a different spelling.
CREATE UNIQUE INDEX IF NOT EXISTS ux_unit_identity ON units(property_id, regexp_replace(lower(identifier), '[^a-z0-9]', '', 'g'));
