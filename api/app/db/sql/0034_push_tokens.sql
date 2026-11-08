-- Phone push tokens (Firebase Cloud Messaging). One row per device; a token belongs to ONE signed-in person at a time:
-- signing in on a phone moves that phone's token to the new person. A person sees and removes only their own tokens.
CREATE TABLE push_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id),
    token        text NOT NULL UNIQUE CHECK (length(token) BETWEEN 20 AND 4096),
    platform     text NOT NULL CHECK (platform IN ('ios','android')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    disabled_at  timestamptz                                  -- set when FCM says the token is no longer valid
);
CREATE INDEX ix_push_tokens_user ON push_tokens(user_id) WHERE disabled_at IS NULL;

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY rg_scope ON push_tokens FOR ALL TO pmr_app
  USING (user_id = rg_ctx_user()) WITH CHECK (user_id = rg_ctx_user());

-- Registering must be able to take a token that a previous person left on this phone, which a person's own RLS view cannot see.
CREATE FUNCTION rg_register_push_token(p_user uuid, p_token text, p_platform text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO push_tokens(user_id, token, platform) VALUES (p_user, p_token, p_platform)
  ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen_at = now(), disabled_at = NULL;
  -- at most 10 devices per person: the oldest go
  DELETE FROM push_tokens WHERE user_id = p_user AND id IN (
    SELECT id FROM push_tokens WHERE user_id = p_user ORDER BY last_seen_at DESC OFFSET 10);
END $$;
GRANT EXECUTE ON FUNCTION rg_register_push_token(uuid, text, text) TO pmr_app;
