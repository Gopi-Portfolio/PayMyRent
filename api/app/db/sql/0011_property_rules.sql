-- Property rules, enforced IN THE DATABASE (so no code path can bypass them):
--  1. A property can be registered by ONE owner only: its normalised address (+ pincode) is unique across every owner, and so is the
--     ownership proof reference (property-tax / sale-deed / electricity number ...).
--  2. Each property has its own subscription: an owner account holds ONE property. Another property needs another account
--     (same person, same phone) with its own plan and payment. (Accounts that already held several properties are grandfathered.)
--  3. Renters can only be added to a VERIFIED property. Only the system (admin review) can verify; the application role cannot.

-- the same normalisation for everyone: case, punctuation, common abbreviations (rd/road, st/street ...), door-no words, pincode digits
CREATE OR REPLACE FUNCTION rg_address_key(p_address text, p_pincode text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text := lower(coalesce(p_address, ''));
BEGIN
  v := replace(v, '&', ' and ');
  v := regexp_replace(v, '[^[:alnum:]]+', ' ', 'g');
  v := regexp_replace(v, '\m(rd)\M', 'road', 'g');
  v := regexp_replace(v, '\m(st)\M', 'street', 'g');
  v := regexp_replace(v, '\m(ave|av)\M', 'avenue', 'g');
  v := regexp_replace(v, '\m(nr)\M', 'near', 'g');
  v := regexp_replace(v, '\m(opp)\M', 'opposite', 'g');
  v := regexp_replace(v, '\m(apt)\M', 'apartment', 'g');
  v := regexp_replace(v, '\m(bldg)\M', 'building', 'g');
  v := regexp_replace(v, '\m(flr)\M', 'floor', 'g');
  v := regexp_replace(v, '\m(no|dno|door|plot)\M', ' ', 'g');
  IF p_pincode IS NOT NULL THEN v := regexp_replace(v, '\m' || p_pincode || '\M', ' ', 'g'); END IF;
  v := trim(regexp_replace(v, '\s+', ' ', 'g'));
  RETURN v || '|' || coalesce(p_pincode, '');
END $$;

CREATE OR REPLACE FUNCTION rg_ref_key(p_ref text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(upper(regexp_replace(coalesce(p_ref, ''), '[^[:alnum:]]', '', 'g')), '') $$;

-- an owner account can be one of several held by the same person
ALTER TABLE owner_accounts DROP CONSTRAINT IF EXISTS owner_accounts_primary_user_id_key;
CREATE INDEX IF NOT EXISTS ix_owner_accounts_primary ON owner_accounts(primary_user_id);
ALTER TABLE owner_accounts ADD COLUMN IF NOT EXISTS legacy_multi_property boolean NOT NULL DEFAULT false;

ALTER TABLE properties
  ADD COLUMN address_key          text,
  ADD COLUMN verification_status  text NOT NULL DEFAULT 'submitted' CHECK (verification_status IN ('submitted', 'verified', 'rejected')),
  ADD COLUMN proof_type           text CHECK (proof_type IS NULL OR proof_type IN ('property_tax', 'sale_deed', 'electricity_bill', 'lease_deed')),
  ADD COLUMN proof_ref            text CHECK (proof_ref IS NULL OR char_length(proof_ref) BETWEEN 4 AND 40),
  ADD COLUMN proof_ref_key        text,
  ADD COLUMN declared_at          timestamptz,
  ADD COLUMN reviewed_at          timestamptz,
  ADD COLUMN review_note          text,
  ADD COLUMN review_flags         jsonb NOT NULL DEFAULT '{}';

-- properties that exist today are grandfathered as verified; a duplicate address among them is kept but flagged
UPDATE properties SET address_key = rg_address_key(address, pincode), verification_status = 'verified',
       reviewed_at = now(), review_note = 'grandfathered before property verification';
WITH d AS (SELECT id, row_number() OVER (PARTITION BY address_key ORDER BY created_at, id) AS rn FROM properties WHERE archived_at IS NULL)
UPDATE properties p SET address_key = p.address_key || '#legacy-' || left(p.id::text, 8), review_flags = p.review_flags || '{"duplicate_legacy": true}'
  FROM d WHERE d.id = p.id AND d.rn > 1;
UPDATE properties SET address_key = address_key || '#archived-' || left(id::text, 8) WHERE archived_at IS NOT NULL;
UPDATE owner_accounts o SET legacy_multi_property = true
 WHERE (SELECT count(*) FROM properties p WHERE p.owner_account_id = o.id AND p.archived_at IS NULL) > 1;
ALTER TABLE properties ALTER COLUMN address_key SET NOT NULL;

-- 1. one owner per property: address and proof are unique across ALL owners (rejected claims free the address again)
CREATE UNIQUE INDEX ux_property_address_key ON properties(address_key) WHERE archived_at IS NULL AND verification_status <> 'rejected';
CREATE UNIQUE INDEX ux_property_proof ON properties(proof_type, proof_ref_key)
  WHERE proof_ref_key IS NOT NULL AND archived_at IS NULL AND verification_status <> 'rejected';
CREATE INDEX ix_properties_pincode ON properties(pincode) WHERE archived_at IS NULL;

-- yes/no answers across ALL owners (the application role cannot see other owners' rows, and must not learn who owns what)
CREATE FUNCTION rg_near_duplicates(p_address text, p_pincode text) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (SELECT string_to_array(split_part(rg_address_key(p_address, p_pincode), '|', 1), ' ') AS t)
  SELECT count(*)::int FROM properties p, me
   WHERE p.pincode = p_pincode AND p.archived_at IS NULL AND p.verification_status <> 'rejected'
     AND p.address_key <> rg_address_key(p_address, p_pincode) AND position('#' in p.address_key) = 0
     AND (SELECT count(*) FROM (SELECT unnest(string_to_array(split_part(p.address_key, '|', 1), ' ')) INTERSECT SELECT unnest(me.t)) i)::float
         / greatest((SELECT count(DISTINCT x) FROM unnest(string_to_array(split_part(p.address_key, '|', 1), ' ') || me.t) x), 1) >= 0.8 $$;

CREATE FUNCTION rg_property_conflict(p_address text, p_pincode text, p_proof_type text, p_proof_ref text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM properties WHERE address_key = rg_address_key(p_address, p_pincode) AND archived_at IS NULL AND verification_status <> 'rejected') THEN 'address'
    WHEN rg_ref_key(p_proof_ref) IS NOT NULL AND EXISTS (SELECT 1 FROM properties WHERE proof_type = p_proof_type AND proof_ref_key = rg_ref_key(p_proof_ref)
                                                          AND archived_at IS NULL AND verification_status <> 'rejected') THEN 'proof'
  END $$;
GRANT EXECUTE ON FUNCTION rg_near_duplicates(text, text), rg_property_conflict(text, text, text, text) TO pmr_app;

CREATE FUNCTION rg_properties_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- keys are always derived here, never trusted from a caller
  IF TG_OP = 'INSERT' OR NEW.address IS DISTINCT FROM OLD.address OR NEW.pincode IS DISTINCT FROM OLD.pincode THEN
    NEW.address_key := rg_address_key(NEW.address, NEW.pincode);
    IF TG_OP = 'UPDATE' AND position('#' in OLD.address_key) > 0 THEN NEW.address_key := OLD.address_key; END IF;
  END IF;
  NEW.proof_ref_key := rg_ref_key(NEW.proof_ref);

  IF TG_OP = 'INSERT' THEN
    NEW.review_flags := jsonb_build_object('near_duplicates', rg_near_duplicates(NEW.address, NEW.pincode));   -- for the reviewer
    -- 2. one property per owner account (each needs its own subscription)
    IF current_user = 'pmr_app' AND NOT (SELECT legacy_multi_property FROM owner_accounts WHERE id = NEW.owner_account_id)
       AND EXISTS (SELECT 1 FROM properties WHERE owner_account_id = NEW.owner_account_id AND archived_at IS NULL AND verification_status <> 'rejected') THEN
      RAISE EXCEPTION 'PROPERTY_NEEDS_SUBSCRIPTION: each property needs its own subscription; add it as a new property' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 3. only the system (admin review) can verify or reject; the signed-in application role cannot, and cannot rewrite a verified property
  IF current_user = 'pmr_app' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.verification_status := 'submitted'; NEW.reviewed_at := NULL; NEW.review_note := NULL;
    ELSE
      IF NEW.verification_status IS DISTINCT FROM OLD.verification_status OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
         OR NEW.review_note IS DISTINCT FROM OLD.review_note THEN
        RAISE EXCEPTION 'FORBIDDEN: only a reviewer can change the verification status' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.verification_status = 'verified' AND (NEW.address, NEW.pincode, NEW.proof_type, NEW.proof_ref, NEW.owner_account_id)
                                         IS DISTINCT FROM (OLD.address, OLD.pincode, OLD.proof_type, OLD.proof_ref, OLD.owner_account_id) THEN
        RAISE EXCEPTION 'IMMUTABLE_RECORD: a verified property''s address and ownership proof cannot be changed' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_properties_guard BEFORE INSERT OR UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION rg_properties_guard();

-- renters can only be added to a verified property
CREATE FUNCTION rg_require_verified_property() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- (signed-in requests only; the system connection is used by migrations and demo seeds)
  IF current_user = 'pmr_app' AND NOT EXISTS (SELECT 1 FROM units u JOIN properties p ON p.id = u.property_id
                  WHERE u.id = NEW.unit_id AND p.verification_status = 'verified' AND p.archived_at IS NULL) THEN
    RAISE EXCEPTION 'PROPERTY_NOT_VERIFIED: the property must be verified before renters can be added' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tenancy_property_verified BEFORE INSERT ON tenancies FOR EACH ROW EXECUTE FUNCTION rg_require_verified_property();

-- the same person can hold several owner accounts (one per subscribed property): the reviewed owner details are copied to the new
-- account instead of being submitted again; the PAN stays unique across DIFFERENT people only
ALTER TABLE owner_verifications ADD COLUMN copied_from_account uuid REFERENCES owner_accounts(id);
DROP INDEX IF EXISTS ux_owner_verification_pan_hash;
CREATE UNIQUE INDEX ux_owner_verification_pan_hash ON owner_verifications(pan_hash)
  WHERE status IN ('submitted', 'verified') AND copied_from_account IS NULL;

-- Local demo only: lets a developer verify a property without a reviewer. The flag lives in a table the application role cannot write,
-- is set at deploy time (python -m app.db.provision) and is refused in production, so the signed-in app can never verify by itself.
CREATE TABLE system_flags (key text PRIMARY KEY, value text NOT NULL);
REVOKE ALL ON system_flags FROM PUBLIC, pmr_app;      -- (default privileges would otherwise let the app role write it)
GRANT SELECT ON system_flags TO pmr_app;
INSERT INTO system_flags(key, value) VALUES ('demo_auto_verify_properties', 'off');
CREATE FUNCTION rg_demo_verify_property(p_property uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce((SELECT value FROM system_flags WHERE key = 'demo_auto_verify_properties'), 'off') <> 'on' THEN RETURN false; END IF;
  UPDATE properties SET verification_status = 'verified', reviewed_at = now(), review_note = 'demo auto-verification (local only)'
   WHERE id = p_property AND verification_status = 'submitted';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION rg_demo_verify_property(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rg_demo_verify_property(uuid) TO pmr_app;
