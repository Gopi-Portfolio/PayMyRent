-- Safe retries for data-entry requests. The app can capture entries with no network and send them later; a request may then arrive twice
-- (the first reply was lost on a weak connection, or the phone retried). Each such request carries a key; the first time the key is seen the
-- work is done and its reply is kept here, and every repeat of the same key gets that same reply without doing the work again.
CREATE TABLE IF NOT EXISTS request_idempotency (
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          text        NOT NULL,
  request_hash text        NOT NULL,           -- what was asked (method, path, body): the same key with a different request is refused
  response     jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS ix_request_idempotency_created ON request_idempotency(created_at);

ALTER TABLE request_idempotency ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rg_scope ON request_idempotency;
CREATE POLICY rg_scope ON request_idempotency FOR ALL TO pmr_app
  USING (user_id = rg_ctx_user()) WITH CHECK (user_id = rg_ctx_user());
GRANT SELECT, INSERT, DELETE ON request_idempotency TO pmr_app;
