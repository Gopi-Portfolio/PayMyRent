-- Monthly paid-message allowance per plan. SMS = 1 unit, WhatsApp = 2 units (it costs more); push is always free.
-- Email has its own, larger allowance. Security/OTP messages are never counted or blocked.
CREATE TABLE plan_message_limits (
    plan_id        uuid PRIMARY KEY REFERENCES subscription_plans(id),
    paid_units     integer NOT NULL CHECK (paid_units >= 0),
    email_messages integer NOT NULL CHECK (email_messages >= 0)
);
INSERT INTO plan_message_limits(plan_id, paid_units, email_messages)
SELECT id, CASE code WHEN 'starter' THEN 20 WHEN 'growth' THEN 150 ELSE 400 END,
           CASE code WHEN 'starter' THEN 50 WHEN 'growth' THEN 1000 ELSE 3000 END
FROM subscription_plans;
CREATE INDEX IF NOT EXISTS ix_notif_owner_month ON notification_events(owner_account_id, sent_at) WHERE status = 'sent';
