# Data model

Source of truth: `api/app/db/sql/0001_tables.sql` (tables and constraints) and `0002_functions.sql` (invariants). All keys are UUIDs. All relationships use the internal `users.id`, never a phone number or Firebase UID.

## Entity map

```
users ─┬─ user_roles (owner|tenant intent)
       ├─ user_contacts (≤2 mobile, ≤2 email; verified flag; one primary per kind)
       ├─ notification_preferences (sms/whatsapp/email destination = a verified contact) ─ consent_records (append-only)
       ├─ mobile_change_requests
       └─ owner_accounts (1 per owning user) ─┬─ owner_memberships (owner | co_owner | manager)
                                              ├─ owner_subscriptions (one period per row) ─ ai_usage_balances ─ ai_usage_events
                                              ├─ subscription_orders ─ subscription_payments ─ subscription_invoices
                                              ├─ properties ─ units ─ unit_status_events
                                              └─ tenancies (unit × tenant user, status) ─┬─ tenancy_invitations
                                                                                         ├─ tenancy_contact_snapshots (owner's view of tenant)
                                                                                         ├─ recurring_charge_config · rent_revisions · rent_free_periods
                                                                                         ├─ monthly_invoices ─ invoice_lines
                                                                                         ├─ charge_submissions (tenant proposals)
                                                                                         ├─ payments ─ payment_events · payment_allocations · receipts
                                                                                         ├─ deposits ─ deposit_transactions
                                                                                         ├─ ledger_entries (append-only)
                                                                                         └─ notes ─ note_revisions · disputes
plans: subscription_plans (versioned) ─ plan_ai_entitlements
ops: webhook_events · notification_events · import_jobs ─ import_rows · file_attachments · audit_events · payout_accounts
     reconciliation_records · job_runs · number_counters · otp_challenges
```

## Invariants and where they are enforced

| Rule | Mechanism |
|---|---|
| A verified mobile belongs to exactly one account | `ux_contacts_verified_mobile` partial unique index |
| ≤2 mobiles, ≤2 emails per user | `trg_contacts_limit` |
| One live tenancy per unit (no overlapping occupancy) | `ux_unit_one_live_tenancy` (status invited/active) |
| A tenant can be linked to many owners; owners are isolated | `tenancies(tenant_user_id)`; no global tenant id on `users`; every query scoped by `owner_account_id` or `tenant_user_id` |
| Unit belongs to its owner's property; tenancy belongs to the unit's owner | `rg_enforce_unit_capacity`, `rg_check_tenancy_scope` triggers |
| Active units ≤ plan capacity, also under concurrency, imports and reactivation | `trg_units_capacity` locks `owner_accounts` row, then counts |
| One invoice per tenancy per month; system rent once per invoice | `UNIQUE (tenancy_id, period_month)`, `ux_line_system_rent` |
| Ledger, allocations, invoice lines, receipts, deposits, audit, consents are append-only | `rg_forbid_mutation` triggers (UPDATE/DELETE/TRUNCATE) |
| Each invoice line / payment / deposit posts to the ledger once | `ux_ledger_line_once`, `ux_ledger_payment_once`, `ux_ledger_deposit_once` |
| Gateway payment confirmed once; one provider payment id per payment | `rg_confirm_gateway_payment` row lock + `payments.provider_payment_id UNIQUE` |
| Subscription activated once per order; provider payment id never reused | `rg_activate_subscription` (order `FOR UPDATE`, status gate) + `subscription_payments` unique keys |
| One current subscription, at most one queued renewal | `ux_owner_one_current_sub`, `ux_owner_one_scheduled_sub` |
| Webhook processed once per (provider, purpose, event) | `webhook_events UNIQUE` |
| Notification sent once per dedupe key | `notification_events.dedupe_key UNIQUE` |
| AI tokens/cost/voice never over-reserved | `rg_ai_reserve` single conditional `UPDATE … WHERE consumed+reserved+n ≤ allowance` |
| Scheduled job runs once per run key | `job_runs UNIQUE (job_name, run_key)` |

## Ledger

Two sub-ledgers per tenancy in `ledger_entries.account`:

- `tenant_receivable`: charges, adjustments and credit notes (positive or negative), payments (negative) and reversals (positive). **Balance due = sum.**
- `deposit_held`: received (+), applied to dues (−), refunded (−). It never mixes with rent income. Applying a deposit to dues creates a `payments` row (method `deposit`) so the allocation looks the same as any other payment.

The presentation views `v_line_open`, `v_payment_remaining`, `v_credit_remaining`, `v_invoice_status` and `v_tenancy_balance` are derived and never stored. The bill endpoint rejects any response where *arrears + this month + later months − unapplied credit ≠ ledger balance*.

**Allocation policy (default).** Payments and credit notes are applied to the oldest month first, then rent → maintenance → electricity → water → tax → other. Existing allocations are never moved. A reversal releases its own allocations through negative rows, and any remaining money is then reallocated. Configurable per-charge allocation is a documented extension point (`rg_category_priority`).

**Corrections.** Changing an issued charge adds an `adjustment` (+) or `credit_note` (−) line that points to the original. Reversing a payment marks it `reversed` and posts an opposite entry. Nothing financial is ever updated or deleted.

## Statuses

- Tenancy: `invited → active → ended`, plus `rejected` and `cancelled`.
- Payment: `pending → confirmed | failed`, and `confirmed → reversed`. The `verification` field is one of `owner_recorded`, `gateway_verified`, `owner_confirmed` (manual transfer), `deposit_adjustment` or `pending`.
- Subscription: `scheduled → active → grace → expired`, plus `superseded` (upgrade) and `completed` (period ended and a renewal took over).
- Invoice view: `unpaid | partial | paid | overdue | overdue_partial`.
- Charge submission: `proposed → approved | rejected | withdrawn`.

## Retention

Financial records (ledger, invoices, payments, receipts, deposits, audit) are kept for at least 8 years, a working assumption that legal review must confirm. Closing an account deactivates the login, keeps the financial history, and redacts optional profile fields. OTP challenges are purged after 30 days, and notification payloads after 180 days (this is a planned job; see SECURITY.md).
