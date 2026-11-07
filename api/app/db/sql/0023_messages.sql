-- Messages from an owner to a renter: spoken or typed in one language, translated into the renter's, sent to the renter's bell and,
-- when chosen, by SMS or WhatsApp. Every message is kept as it was said and as it was sent.
CREATE TABLE owner_messages (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id        uuid NOT NULL REFERENCES tenancies(id),
    sent_by           uuid NOT NULL REFERENCES users(id),
    original_text     text NOT NULL CHECK (char_length(original_text) BETWEEN 1 AND 600),
    original_lang     text NOT NULL CHECK (original_lang IN ('en','ta','hi','te','kn','ml','mr','bn')),
    sent_text         text NOT NULL CHECK (char_length(sent_text) BETWEEN 1 AND 600),
    sent_lang         text NOT NULL CHECK (sent_lang IN ('en','ta','hi','te','kn','ml','mr','bn')),
    input_method      text NOT NULL DEFAULT 'typed' CHECK (input_method IN ('typed','voice')),
    channels          text[] NOT NULL DEFAULT '{bell}',
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_owner_messages_tenancy ON owner_messages(tenancy_id, created_at DESC);
ALTER TABLE owner_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON owner_messages FOR ALL TO pmr_app
  USING (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()))
  WITH CHECK (owner_account_id = ANY (rg_ctx_owners()) OR tenancy_id = ANY (rg_ctx_tenancies()));

-- translation is an AI feature like the others: it counts against the plan's allowance
ALTER TABLE ai_usage_events DROP CONSTRAINT IF EXISTS ai_usage_events_feature_check;
ALTER TABLE ai_usage_events ADD CONSTRAINT ai_usage_events_feature_check CHECK (feature IN ('ask','reminder_draft','voice_ask','translate'));
UPDATE plan_ai_entitlements SET features = array_append(features, 'translate') WHERE ai_enabled AND NOT ('translate' = ANY(features));
