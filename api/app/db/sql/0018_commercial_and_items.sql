-- A third kind of unit, "commercial": a whole place (10-20 shops, a building with many rooms, a factory).
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_kind_check;
ALTER TABLE units ADD CONSTRAINT units_kind_check CHECK (kind IN ('shop','office','house','flat','commercial','other'));

-- What the owner provides with the place, as the owner typed it (commas or new lines). Part of the agreement; shown to the renter.
ALTER TABLE tenancies ADD COLUMN IF NOT EXISTS items_provided text;
ALTER TABLE tenancies ADD CONSTRAINT tenancies_items_provided_check CHECK (items_provided IS NULL OR char_length(items_provided) <= 2000);
