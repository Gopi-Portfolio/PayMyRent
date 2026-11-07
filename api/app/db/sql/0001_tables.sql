-- PayMyRent schema v1 — SQL is the source of truth for tables, constraints and
-- financial invariants. All money is BIGINT paise. All timestamps are timestamptz;
-- business dates (billing months, due dates) are computed in Asia/Kolkata.

-- ───────────────────────────── identity ─────────────────────────────
CREATE TABLE users (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    firebase_uid           text UNIQUE,                       -- external identity; never used as FK
    full_name              text CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 2 AND 400),
    address                text CHECK (address IS NULL OR char_length(address) <= 1000),
    preferred_language     text NOT NULL DEFAULT 'en'
                           CHECK (preferred_language IN ('en','ta','hi','te','kn','ml','mr','bn')),
    status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','closed')),
    sessions_valid_after   timestamptz NOT NULL DEFAULT to_timestamp(0), -- tokens issued earlier are rejected
    profile_completed_at   timestamptz,
    version                integer NOT NULL DEFAULT 1,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
    user_id    uuid NOT NULL REFERENCES users(id),
    role       text NOT NULL CHECK (role IN ('owner','tenant')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role)
);

CREATE TABLE user_contacts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id),
    kind        text NOT NULL CHECK (kind IN ('mobile','email')),
    value       text NOT NULL,                                 -- mobile: E.164 +91XXXXXXXXXX; email: lower-cased
    is_primary  boolean NOT NULL DEFAULT false,
    verified_at timestamptz,
    removed_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (kind <> 'mobile' OR value ~ '^\+91[6-9][0-9]{9}$'),
    CHECK (kind <> 'email'  OR (char_length(value) <= 254 AND value LIKE '%_@_%'))
);
-- A verified mobile belongs to exactly one account.
CREATE UNIQUE INDEX ux_contacts_verified_mobile ON user_contacts(value)
    WHERE kind = 'mobile' AND verified_at IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX ux_contacts_one_primary ON user_contacts(user_id, kind)
    WHERE is_primary AND removed_at IS NULL;
CREATE UNIQUE INDEX ux_contacts_user_value ON user_contacts(user_id, kind, value) WHERE removed_at IS NULL;

CREATE TABLE notification_preferences (
    user_id               uuid PRIMARY KEY REFERENCES users(id),
    sms_contact_id        uuid REFERENCES user_contacts(id),
    whatsapp_contact_id   uuid REFERENCES user_contacts(id),
    email_contact_id      uuid REFERENCES user_contacts(id),
    sms_enabled           boolean NOT NULL DEFAULT true,
    whatsapp_enabled      boolean NOT NULL DEFAULT false,   -- WhatsApp needs explicit opt-in
    email_enabled         boolean NOT NULL DEFAULT true,
    push_enabled          boolean NOT NULL DEFAULT true,
    quiet_start           time NOT NULL DEFAULT '21:00',
    quiet_end             time NOT NULL DEFAULT '08:00',
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_records (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id),
    channel    text NOT NULL CHECK (channel IN ('sms','whatsapp','email','push','ai_processing')),
    granted    boolean NOT NULL,
    source     text NOT NULL,                                -- e.g. 'profile_settings', 'onboarding'
    notice_version text NOT NULL DEFAULT 'v1',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_consent_user_channel ON consent_records(user_id, channel, created_at DESC);

-- OTP challenges for: local dev login simulator, secondary-mobile verification, email verification.
-- Production primary login OTP is handled by Firebase; we never store raw codes.
CREATE TABLE otp_challenges (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target       text NOT NULL,
    purpose      text NOT NULL CHECK (purpose IN ('dev_login','verify_mobile','verify_email','change_primary_old','change_primary_new')),
    user_id      uuid REFERENCES users(id),
    code_hash    text NOT NULL,
    attempts     integer NOT NULL DEFAULT 0,
    expires_at   timestamptz NOT NULL,
    consumed_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_otp_target_recent ON otp_challenges(target, created_at DESC);

CREATE TABLE mobile_change_requests (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users(id),
    old_phone        text NOT NULL,
    new_phone        text NOT NULL CHECK (new_phone ~ '^\+91[6-9][0-9]{9}$'),
    method           text NOT NULL CHECK (method IN ('old_and_new_otp','manual_review')),
    old_verified_at  timestamptz,
    new_verified_at  timestamptz,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rejected','expired','under_review')),
    reviewer_note    text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz
);

-- ───────────────────────────── owners ─────────────────────────────
CREATE TABLE owner_accounts (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    primary_user_id  uuid NOT NULL UNIQUE REFERENCES users(id),
    display_name     text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE owner_memberships (
    owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
    user_id          uuid NOT NULL REFERENCES users(id),
    role             text NOT NULL CHECK (role IN ('owner','co_owner','manager')),
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    granted_by       uuid REFERENCES users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_account_id, user_id)
);

-- ───────────────────────────── subscriptions ─────────────────────────────
CREATE TABLE subscription_plans (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code           text NOT NULL CHECK (code IN ('starter','growth','business')),
    version        integer NOT NULL,
    label          text NOT NULL,
    price_paise    bigint NOT NULL CHECK (price_paise > 0),
    currency       text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    billing_period text NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly')),
    max_units      integer NOT NULL CHECK (max_units > 0),
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    sort_order     integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (code, version)
);
CREATE UNIQUE INDEX ux_plan_one_active_version ON subscription_plans(code) WHERE status = 'active';

CREATE TABLE plan_ai_entitlements (
    plan_id                     uuid PRIMARY KEY REFERENCES subscription_plans(id),
    ai_enabled                  boolean NOT NULL,
    features                    text[] NOT NULL DEFAULT '{}',   -- 'ask','reminder_draft','voice_ask'
    model_allowlist             text[] NOT NULL DEFAULT '{}',
    monthly_token_allowance     integer NOT NULL CHECK (monthly_token_allowance >= 0),
    per_request_max_tokens      integer NOT NULL CHECK (per_request_max_tokens >= 0),
    per_request_max_output      integer NOT NULL DEFAULT 400,
    voice_seconds_allowance     integer NOT NULL DEFAULT 0,
    max_concurrent_requests     integer NOT NULL DEFAULT 2,
    requests_per_minute         integer NOT NULL DEFAULT 6,
    monthly_cost_ceiling_paise  bigint NOT NULL DEFAULT 0
);

CREATE TABLE owner_subscriptions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id    uuid NOT NULL REFERENCES owner_accounts(id),
    plan_id             uuid NOT NULL REFERENCES subscription_plans(id),
    plan_code           text NOT NULL,                 -- snapshot
    price_paise         bigint NOT NULL,               -- snapshot
    max_units           integer NOT NULL,              -- snapshot
    status              text NOT NULL CHECK (status IN ('scheduled','active','grace','expired','superseded','completed')),
    period_start        timestamptz NOT NULL,
    period_end          timestamptz NOT NULL,
    grace_until         timestamptz NOT NULL,
    renewal_mode        text NOT NULL DEFAULT 'manual' CHECK (renewal_mode IN ('manual','auto_mandate')),
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    scheduled_plan_id   uuid REFERENCES subscription_plans(id),   -- downgrade at next renewal
    is_demo             boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end > period_start AND grace_until >= period_end)
);
CREATE UNIQUE INDEX ux_owner_one_current_sub ON owner_subscriptions(owner_account_id)
    WHERE status IN ('active','grace');
CREATE UNIQUE INDEX ux_owner_one_scheduled_sub ON owner_subscriptions(owner_account_id)
    WHERE status = 'scheduled';

CREATE TABLE subscription_orders (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id   uuid NOT NULL REFERENCES owner_accounts(id),
    plan_id            uuid NOT NULL REFERENCES subscription_plans(id),
    purpose            text NOT NULL CHECK (purpose IN ('new','renewal','upgrade')),
    amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
    provider           text NOT NULL,
    provider_order_id  text UNIQUE,
    idempotency_key    text NOT NULL,
    status             text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','expired')),
    checkout           jsonb NOT NULL DEFAULT '{}',     -- non-secret data the app needs to reopen checkout
    is_demo            boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    paid_at            timestamptz,
    UNIQUE (owner_account_id, idempotency_key)
);
-- At most one open order per owner+plan+purpose: retries reuse it instead of double-charging.
CREATE UNIQUE INDEX ux_sub_order_open ON subscription_orders(owner_account_id, plan_id, purpose) WHERE status = 'created';

CREATE TABLE subscription_payments (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id             uuid NOT NULL UNIQUE REFERENCES subscription_orders(id),
    provider_payment_id  text NOT NULL UNIQUE,
    amount_paise         bigint NOT NULL,
    verified_via         text NOT NULL CHECK (verified_via IN ('webhook','status_check','demo')),
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_invoices (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    order_id          uuid NOT NULL UNIQUE REFERENCES subscription_orders(id),
    subscription_id   uuid NOT NULL REFERENCES owner_subscriptions(id),
    number            text NOT NULL UNIQUE,
    amount_paise      bigint NOT NULL,
    issued_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_events (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    subscription_id   uuid REFERENCES owner_subscriptions(id),
    type              text NOT NULL,
    data              jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- Webhooks for BOTH purposes land here but are keyed by purpose; dedupe per provider+purpose+event.
CREATE TABLE webhook_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider         text NOT NULL,
    purpose          text NOT NULL CHECK (purpose IN ('subscription','rent')),
    event_id         text NOT NULL,
    signature_valid  boolean NOT NULL,
    payload          jsonb NOT NULL,
    result           text,
    received_at      timestamptz NOT NULL DEFAULT now(),
    processed_at     timestamptz,
    UNIQUE (provider, purpose, event_id)
);

-- ───────────────────────────── AI metering ─────────────────────────────
CREATE TABLE ai_usage_balances (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id         uuid NOT NULL REFERENCES owner_accounts(id),
    subscription_id          uuid NOT NULL REFERENCES owner_subscriptions(id),
    period_start             timestamptz NOT NULL,
    period_end               timestamptz NOT NULL,
    token_allowance          integer NOT NULL CHECK (token_allowance >= 0),
    tokens_reserved          integer NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
    tokens_consumed          integer NOT NULL DEFAULT 0 CHECK (tokens_consumed >= 0),
    cost_ceiling_paise       bigint NOT NULL DEFAULT 0,
    cost_reserved_paise      bigint NOT NULL DEFAULT 0 CHECK (cost_reserved_paise >= 0),
    cost_consumed_paise      bigint NOT NULL DEFAULT 0 CHECK (cost_consumed_paise >= 0),
    voice_seconds_allowance  integer NOT NULL DEFAULT 0,
    voice_seconds_reserved   integer NOT NULL DEFAULT 0 CHECK (voice_seconds_reserved >= 0),
    voice_seconds_consumed   integer NOT NULL DEFAULT 0 CHECK (voice_seconds_consumed >= 0),
    in_flight                integer NOT NULL DEFAULT 0 CHECK (in_flight >= 0),
    version                  integer NOT NULL DEFAULT 1,
    UNIQUE (subscription_id)
);

CREATE TABLE ai_usage_events (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id   uuid NOT NULL REFERENCES owner_accounts(id),
    balance_id         uuid NOT NULL REFERENCES ai_usage_balances(id),
    request_id         text NOT NULL,
    user_id            uuid NOT NULL REFERENCES users(id),
    feature            text NOT NULL CHECK (feature IN ('ask','reminder_draft','voice_ask')),
    provider           text NOT NULL,
    model              text NOT NULL,
    reserved_tokens    integer NOT NULL,
    reserved_cost_paise bigint NOT NULL,
    reserved_voice_seconds integer NOT NULL DEFAULT 0,
    input_tokens       integer,
    output_tokens      integer,
    cached_tokens      integer,
    reasoning_tokens   integer,
    billable_tokens    integer,
    voice_seconds      integer,
    final_cost_paise   bigint,
    status             text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','completed','failed','released')),
    usage_source       text CHECK (usage_source IN ('provider','assumed_full_reservation','none')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    UNIQUE (owner_account_id, request_id)
);

-- ───────────────────────────── property / units ─────────────────────────────
CREATE TABLE properties (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    name              text,
    address           text NOT NULL CHECK (char_length(address) BETWEEN 5 AND 1000),
    city              text,
    state             text,
    pincode           text CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
    kind              text NOT NULL DEFAULT 'commercial' CHECK (kind IN ('commercial','residential','mixed')),
    archived_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_properties_owner ON properties(owner_account_id);

CREATE TABLE units (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    property_id       uuid NOT NULL REFERENCES properties(id),
    identifier        text NOT NULL CHECK (identifier ~ '^[A-Za-z0-9][A-Za-z0-9/ -]{0,19}$'),
    kind              text NOT NULL DEFAULT 'shop' CHECK (kind IN ('shop','office','house','flat','other')),
    status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    tax_config        jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_unit_identifier ON units(property_id, lower(identifier));
CREATE INDEX ix_units_owner_status ON units(owner_account_id, status);

CREATE TABLE unit_status_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id      uuid NOT NULL REFERENCES units(id),
    from_status  text,
    to_status    text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── tenancies ─────────────────────────────
CREATE TABLE tenancies (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id     uuid NOT NULL REFERENCES owner_accounts(id),
    unit_id              uuid NOT NULL REFERENCES units(id),
    tenant_user_id       uuid REFERENCES users(id),       -- set only after the tenant accepts
    invited_phone        text NOT NULL CHECK (invited_phone ~ '^\+91[6-9][0-9]{9}$'),
    status               text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','rejected','cancelled','ended')),
    start_date           date NOT NULL,
    end_date             date,
    monthly_rent_paise   bigint NOT NULL CHECK (monthly_rent_paise >= 0),
    due_day              smallint NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    grace_days           smallint NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 60),
    deposit_agreed_paise bigint NOT NULL DEFAULT 0 CHECK (deposit_agreed_paise >= 0),
    ended_at             timestamptz,
    ended_by             uuid REFERENCES users(id),
    version              integer NOT NULL DEFAULT 1,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CHECK (end_date IS NULL OR end_date > start_date),
    CHECK (status <> 'active' OR tenant_user_id IS NOT NULL)
);
-- No overlapping live tenancies on the same unit (shared occupancy is not modelled in v1).
CREATE UNIQUE INDEX ux_unit_one_live_tenancy ON tenancies(unit_id) WHERE status IN ('invited','active');
CREATE INDEX ix_tenancies_tenant ON tenancies(tenant_user_id) WHERE tenant_user_id IS NOT NULL;
CREATE INDEX ix_tenancies_owner ON tenancies(owner_account_id, status);
CREATE INDEX ix_tenancies_invited_phone ON tenancies(invited_phone) WHERE status = 'invited';

CREATE TABLE tenancy_invitations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id   uuid NOT NULL REFERENCES tenancies(id),
    phone        text NOT NULL,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
    responded_by uuid REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz
);
CREATE UNIQUE INDEX ux_invite_one_pending ON tenancy_invitations(tenancy_id) WHERE status = 'pending';

-- Owner-specific view of the tenant's contact details (does not touch the tenant's global profile).
CREATE TABLE tenancy_contact_snapshots (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id  uuid NOT NULL REFERENCES tenancies(id),
    name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 400),
    phone       text NOT NULL,
    alt_phone   text,
    email       text,
    address     text,
    created_by  uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_contact_snap_tenancy ON tenancy_contact_snapshots(tenancy_id, created_at DESC);

CREATE TABLE contact_change_proposals (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id   uuid NOT NULL REFERENCES tenancies(id),
    proposed_by  uuid NOT NULL REFERENCES users(id),
    field        text NOT NULL CHECK (field IN ('secondary_mobile','primary_mobile','email')),
    new_value    text NOT NULL,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz
);

CREATE TABLE rent_revisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id          uuid NOT NULL REFERENCES tenancies(id),
    effective_month     date NOT NULL CHECK (extract(day FROM effective_month) = 1),
    monthly_rent_paise  bigint NOT NULL CHECK (monthly_rent_paise >= 0),
    created_by          uuid REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenancy_id, effective_month)
);

CREATE TABLE rent_free_periods (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id  uuid NOT NULL REFERENCES tenancies(id),
    from_month  date NOT NULL,
    to_month    date NOT NULL,
    CHECK (to_month >= from_month)
);

CREATE TABLE recurring_charge_config (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id            uuid NOT NULL REFERENCES tenancies(id),
    category              text NOT NULL CHECK (category IN ('electricity','water','maintenance','misc')),
    enabled               boolean NOT NULL DEFAULT true,
    default_amount_paise  bigint CHECK (default_amount_paise IS NULL OR default_amount_paise >= 0),
    carry_forward         boolean NOT NULL DEFAULT false,   -- only meaningful for maintenance
    tenant_can_submit     boolean NOT NULL DEFAULT true,
    UNIQUE (tenancy_id, category)
);

-- ───────────────────────────── billing & ledger ─────────────────────────────
CREATE TABLE monthly_invoices (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id        uuid NOT NULL REFERENCES tenancies(id),
    period_month      date NOT NULL CHECK (extract(day FROM period_month) = 1),
    number            text NOT NULL UNIQUE,
    due_date          date NOT NULL,
    status            text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenancy_id, period_month)
);

CREATE TABLE invoice_lines (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id            uuid NOT NULL REFERENCES monthly_invoices(id),
    category              text NOT NULL CHECK (category IN ('rent','electricity','water','maintenance','misc','opening_balance','other','tax')),
    kind                  text NOT NULL DEFAULT 'charge' CHECK (kind IN ('charge','adjustment','credit_note')),
    description           text,
    amount_paise          bigint NOT NULL,
    source                text NOT NULL CHECK (source IN ('system','owner','tenant_submission','import')),
    charge_submission_id  uuid UNIQUE,
    adjusts_line_id       uuid REFERENCES invoice_lines(id),
    reason                text,
    created_by            uuid REFERENCES users(id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'credit_note' AND amount_paise < 0) OR (kind <> 'credit_note' AND amount_paise > 0)),
    CHECK (kind = 'charge' OR reason IS NOT NULL)
);
CREATE INDEX ix_lines_invoice ON invoice_lines(invoice_id);
-- System-generated rent is created once per invoice.
CREATE UNIQUE INDEX ux_line_system_rent ON invoice_lines(invoice_id, category) WHERE source = 'system' AND kind = 'charge';

CREATE TABLE charge_submissions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id       uuid NOT NULL REFERENCES tenancies(id),
    period_month     date NOT NULL CHECK (extract(day FROM period_month) = 1),
    category         text NOT NULL CHECK (category IN ('electricity','water','maintenance','misc')),
    reading_previous numeric(12,2),
    reading_current  numeric(12,2),
    amount_paise     bigint NOT NULL CHECK (amount_paise > 0),
    submitted_by     uuid NOT NULL REFERENCES users(id),
    submitter_role   text NOT NULL CHECK (submitter_role IN ('owner','tenant')),
    status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','withdrawn')),
    attachment_id    uuid,
    reviewed_by      uuid REFERENCES users(id),
    reviewed_at      timestamptz,
    review_reason    text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (reading_current IS NULL OR reading_previous IS NULL OR reading_current >= reading_previous)
);
CREATE INDEX ix_submissions_tenancy ON charge_submissions(tenancy_id, period_month);

CREATE TABLE payments (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id     uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id           uuid NOT NULL REFERENCES tenancies(id),
    method               text NOT NULL CHECK (method IN ('cash','gateway','manual_transfer','deposit')),
    verification         text NOT NULL CHECK (verification IN ('owner_recorded','gateway_verified','owner_confirmed','deposit_adjustment','pending')),
    status               text NOT NULL CHECK (status IN ('pending','confirmed','failed','reversed')),
    amount_paise         bigint NOT NULL CHECK (amount_paise > 0),
    paid_on              date NOT NULL,
    idempotency_key      text NOT NULL,
    recorded_by          uuid REFERENCES users(id),
    provider             text,
    provider_order_id    text UNIQUE,
    provider_payment_id  text UNIQUE,
    tenant_ack           text CHECK (tenant_ack IN ('acknowledged','disputed')),
    checkout             jsonb NOT NULL DEFAULT '{}',
    reversed_reason      text,
    is_demo              boolean NOT NULL DEFAULT false,
    created_at           timestamptz NOT NULL DEFAULT now(),
    confirmed_at         timestamptz,
    UNIQUE (tenancy_id, idempotency_key)
);
CREATE INDEX ix_payments_tenancy ON payments(tenancy_id, status);

CREATE TABLE payment_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id  uuid NOT NULL REFERENCES payments(id),
    type        text NOT NULL,
    data        jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deposits (
    tenancy_id     uuid PRIMARY KEY REFERENCES tenancies(id),
    agreed_paise   bigint NOT NULL DEFAULT 0 CHECK (agreed_paise >= 0),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deposit_transactions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id          uuid NOT NULL REFERENCES deposits(tenancy_id),
    type                text NOT NULL CHECK (type IN ('received','applied_to_dues','refund')),
    amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
    reason              text,
    payment_id          uuid REFERENCES payments(id),   -- for applied_to_dues
    idempotency_key     text NOT NULL,
    created_by          uuid NOT NULL REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenancy_id, idempotency_key),
    CHECK (type = 'received' OR reason IS NOT NULL)
);

-- Allocation of a payment (or a credit note) to a positive invoice line. Insert-only;
-- a reversal inserts negative rows.
CREATE TABLE payment_allocations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenancy_id       uuid NOT NULL REFERENCES tenancies(id),
    payment_id       uuid REFERENCES payments(id),
    credit_line_id   uuid REFERENCES invoice_lines(id),
    invoice_line_id  uuid NOT NULL REFERENCES invoice_lines(id),
    amount_paise     bigint NOT NULL CHECK (amount_paise <> 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK ((payment_id IS NULL) <> (credit_line_id IS NULL))
);
CREATE INDEX ix_alloc_line ON payment_allocations(invoice_line_id);
CREATE INDEX ix_alloc_payment ON payment_allocations(payment_id);

-- Double-entry-style, append-only ledger. Two sub-ledgers per tenancy:
--   tenant_receivable : +charges  −payments  (+reversals)
--   deposit_held      : +received −applied −refunded
CREATE TABLE ledger_entries (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id        uuid NOT NULL REFERENCES tenancies(id),
    account           text NOT NULL CHECK (account IN ('tenant_receivable','deposit_held')),
    entry_type        text NOT NULL CHECK (entry_type IN ('charge','adjustment','credit_note','payment','payment_reversal','deposit_received','deposit_applied','deposit_refund')),
    amount_paise      bigint NOT NULL CHECK (amount_paise <> 0),
    invoice_line_id   uuid REFERENCES invoice_lines(id),
    payment_id        uuid REFERENCES payments(id),
    deposit_txn_id    uuid REFERENCES deposit_transactions(id),
    effective_date    date NOT NULL,
    created_by        uuid REFERENCES users(id),
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ledger_tenancy ON ledger_entries(tenancy_id, account);
CREATE UNIQUE INDEX ux_ledger_line_once ON ledger_entries(invoice_line_id) WHERE invoice_line_id IS NOT NULL;
CREATE UNIQUE INDEX ux_ledger_payment_once ON ledger_entries(payment_id, entry_type) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX ux_ledger_deposit_once ON ledger_entries(deposit_txn_id, account) WHERE deposit_txn_id IS NOT NULL;

CREATE TABLE receipts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id        uuid NOT NULL REFERENCES tenancies(id),
    payment_id        uuid UNIQUE REFERENCES payments(id),
    deposit_txn_id    uuid UNIQUE REFERENCES deposit_transactions(id),
    number            text NOT NULL UNIQUE,
    tenant_name       text,                 -- snapshot at issue time; later profile edits don't rewrite receipts
    unit_label        text,
    amount_paise      bigint NOT NULL,
    issued_at         timestamptz NOT NULL DEFAULT now(),
    CHECK ((payment_id IS NULL) <> (deposit_txn_id IS NULL))
);

CREATE TABLE number_counters (
    kind   text NOT NULL,
    year   integer NOT NULL,
    next   bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (kind, year)
);

-- ───────────────────────────── notes, disputes ─────────────────────────────
CREATE TABLE notes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id        uuid NOT NULL REFERENCES tenancies(id),
    target_type       text NOT NULL CHECK (target_type IN ('tenancy','invoice','invoice_line','payment','deposit_txn','dispute','charge_submission')),
    target_id         uuid NOT NULL,
    author_user_id    uuid NOT NULL REFERENCES users(id),
    author_role       text NOT NULL CHECK (author_role IN ('owner','tenant')),
    body              text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000), -- 250 graphemes enforced in API
    input_method      text NOT NULL DEFAULT 'typed' CHECK (input_method IN ('typed','voice')),
    visibility        text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','owner_private')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    edited_at         timestamptz,
    CHECK (visibility = 'shared' OR author_role = 'owner')
);
CREATE INDEX ix_notes_target ON notes(target_type, target_id);

CREATE TABLE note_revisions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id     uuid NOT NULL REFERENCES notes(id),
    body        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE disputes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id uuid NOT NULL REFERENCES owner_accounts(id),
    tenancy_id    uuid NOT NULL REFERENCES tenancies(id),
    target_type   text NOT NULL CHECK (target_type IN ('payment','invoice_line','deposit_txn','charge_submission')),
    target_id     uuid NOT NULL,
    raised_by     uuid NOT NULL REFERENCES users(id),
    reason        text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
    resolution    text,
    resolved_by   uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz
);

-- ───────────────────────────── notifications ─────────────────────────────
CREATE TABLE reminder_rules (
    owner_account_id  uuid PRIMARY KEY REFERENCES owner_accounts(id),
    offsets_days      integer[] NOT NULL DEFAULT '{-5,-1,0,3}',  -- negative = before due date
    channels          text[] NOT NULL DEFAULT '{push,sms}',
    enabled           boolean NOT NULL DEFAULT true
);

CREATE TABLE notification_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users(id),
    owner_account_id    uuid REFERENCES owner_accounts(id),
    channel             text NOT NULL CHECK (channel IN ('push','sms','whatsapp','email')),
    template            text NOT NULL,
    language            text NOT NULL,
    dedupe_key          text NOT NULL UNIQUE,
    destination_masked  text,
    status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','skipped')),
    skip_reason         text,
    provider            text,
    provider_message_id text,
    attempts            integer NOT NULL DEFAULT 0,
    payload             jsonb NOT NULL DEFAULT '{}',
    approved_by         uuid REFERENCES users(id),   -- required for AI-drafted reminders
    created_at          timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz
);
CREATE INDEX ix_notif_status ON notification_events(status, created_at);

-- ───────────────────────────── files, imports ─────────────────────────────
CREATE TABLE file_attachments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid REFERENCES owner_accounts(id),
    uploaded_by       uuid NOT NULL REFERENCES users(id),
    storage_key       text NOT NULL UNIQUE,
    content_type      text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
    size_bytes        integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    sha256            text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_jobs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id  uuid NOT NULL REFERENCES owner_accounts(id),
    created_by        uuid NOT NULL REFERENCES users(id),
    file_sha256       text NOT NULL,
    status            text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','committed','failed')),
    total_rows        integer NOT NULL DEFAULT 0,
    valid_rows        integer NOT NULL DEFAULT 0,
    new_units         integer NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    committed_at      timestamptz
);

CREATE TABLE import_rows (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      uuid NOT NULL REFERENCES import_jobs(id),
    row_number  integer NOT NULL,
    data        jsonb NOT NULL,
    errors      jsonb NOT NULL DEFAULT '[]',
    warnings    jsonb NOT NULL DEFAULT '[]',
    status      text NOT NULL CHECK (status IN ('valid','invalid','imported','skipped')),
    tenancy_id  uuid REFERENCES tenancies(id),
    UNIQUE (job_id, row_number)
);

-- ───────────────────────────── audit, payouts, recon, jobs ─────────────────────────────
CREATE TABLE audit_events (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id     uuid REFERENCES users(id),
    owner_account_id  uuid REFERENCES owner_accounts(id),
    action            text NOT NULL,
    entity_type       text NOT NULL,
    entity_id         uuid,
    before            jsonb,
    after             jsonb,
    request_id        text,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX ix_audit_owner ON audit_events(owner_account_id, created_at DESC);

CREATE TABLE payout_accounts (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id      uuid NOT NULL REFERENCES owner_accounts(id),
    provider              text NOT NULL,
    provider_account_ref  text,                -- e.g. PSP linked/sub-merchant account id; never raw bank data
    display_masked        text NOT NULL,       -- e.g. 'HDFC ••••1234' / 'name@upi' masked
    status                text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','pending_psp','verified','disabled')),
    created_by            uuid NOT NULL REFERENCES users(id),
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_payout_one_active ON payout_accounts(owner_account_id) WHERE status IN ('pending_psp','verified');

CREATE TABLE reconciliation_records (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_key               text NOT NULL,
    provider              text NOT NULL,
    purpose               text NOT NULL CHECK (purpose IN ('subscription','rent')),
    provider_payment_id   text NOT NULL,
    our_amount_paise      bigint,
    provider_amount_paise bigint,
    status                text NOT NULL CHECK (status IN ('matched','amount_mismatch','missing_locally','missing_at_provider')),
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_key, provider, provider_payment_id)
);

CREATE TABLE job_runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name     text NOT NULL,
    run_key      text NOT NULL,        -- e.g. '2026-11-01' — makes a scheduled run idempotent
    status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
    detail       jsonb NOT NULL DEFAULT '{}',
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    UNIQUE (job_name, run_key)
);
