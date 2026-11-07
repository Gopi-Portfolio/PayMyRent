-- The new version of the ₹1 plan carries the same monthly message allowance as the old one (a plan version without a row would mean zero messages).
INSERT INTO plan_message_limits(plan_id, paid_units, email_messages)
SELECT n.id, l.paid_units, l.email_messages
FROM subscription_plans n JOIN subscription_plans o ON o.code = n.code AND o.version = 1 JOIN plan_message_limits l ON l.plan_id = o.id
WHERE n.code = 'starter' AND n.version = 2
ON CONFLICT DO NOTHING;
