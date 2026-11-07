-- Who the second owner is to the primary owner. Required whenever a second owner number is entered.
ALTER TABLE owner_allowed_numbers ADD COLUMN relationship text;
UPDATE owner_allowed_numbers SET relationship = 'family' WHERE relationship IS NULL;
ALTER TABLE owner_allowed_numbers ALTER COLUMN relationship SET NOT NULL;
ALTER TABLE owner_allowed_numbers ADD CONSTRAINT owner_allowed_relationship_check
  CHECK (relationship IN ('brother', 'sister', 'parent', 'son', 'daughter', 'friend', 'family'));
