# Scheduled jobs

| Job | Schedule (IST) | Run key | What it does |
|---|---|---|---|
| `generate_invoices` | daily 00:30 | date | Creates this month's invoice (prorated rent, carried-forward maintenance) for every active tenancy whose owner is active/grace. Unique `(tenancy, month)` makes reruns no-ops. |
| `send_reminders` | daily 09:30 | date | Queues reminders at the owner's offsets (default −5, −1, 0, +3 days). Never for fully paid invoices or ended tenancies; continues for partial balances. |
| `dispatch_notifications` | every 15 min | 15-min bucket | Sends the outbox: verified destination + consent + quiet hours; each `dedupe_key` sends at most once. |
| `subscription_lifecycle` | hourly | hour | Moves subscriptions active → grace → expired, starts queued renewals, warns 3 days before expiry. |
| `reconcile_payments` | every 15 min | 15-min bucket | Status-checks gateway orders whose webhook never arrived, confirms/fails them, writes reconciliation records. |

Production trigger: **EventBridge Scheduler** → API destination `POST /api/v1/jobs/{name}?run_key=…` with an `X-Job-Token` (HMAC, minted by the small Lambda in `infra/terraform/scheduler.tf`). Schedules have retries + a DLQ, and `job_runs` (UNIQUE job_name+run_key) makes duplicate deliveries harmless. A failed run can be retried with the same key; a succeeded run cannot run twice. `GET /api/v1/health` reports the last success per job and CloudWatch alarms on staleness.
