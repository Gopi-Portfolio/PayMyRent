-- The Growth plan's paid-message allowance goes back to 150 a month. The migration that made Growth 50 units had also cut it to 50 by mistake.
UPDATE plan_message_limits SET paid_units = 150
 WHERE plan_id = (SELECT id FROM subscription_plans WHERE code = 'growth' AND status = 'active');
