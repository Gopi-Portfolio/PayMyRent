-- Launch price and regular price. Only the launch price (price_paise) is ever charged; the regular price is what the plan usually costs and is shown
-- crossed out next to it. The saving percentage is worked out by the server from the two prices, never stored or typed.
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS regular_price_paise bigint;
ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_regular_price_check CHECK (regular_price_paise IS NULL OR regular_price_paise > price_paise);
UPDATE subscription_plans SET regular_price_paise = 6500,    max_properties = 5   WHERE code = 'growth'   AND status = 'active';     -- ₹65, 5 properties
UPDATE subscription_plans SET regular_price_paise = 15000,   max_properties = 10  WHERE code = 'business' AND status = 'active';     -- ₹150, 10 properties
UPDATE subscription_plans SET regular_price_paise = 200000                        WHERE code = 'max'      AND status = 'active';     -- ₹2,000, 100 properties
