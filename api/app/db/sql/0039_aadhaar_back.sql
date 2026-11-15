-- The owner can use an Aadhaar card instead of a PAN card; its BACK page carries the address, which is read and saved to the profile.
ALTER TABLE owner_documents DROP CONSTRAINT owner_documents_kind_check;
ALTER TABLE owner_documents ADD CONSTRAINT owner_documents_kind_check CHECK (kind IN ('pan', 'aadhaar', 'aadhaar_back', 'selfie', 'deed_first', 'deed_last'));
