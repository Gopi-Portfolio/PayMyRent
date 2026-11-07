# Architecture

## Shape

```
 Android / iOS (one Expo app)                      AWS ap-south-1
 ┌────────────────────────────┐   HTTPS   ┌──────────────────────────────────────────┐
 │ Owner │ Tenant │ Both (switch)│ ───────▶ │ Lightsail container service (FastAPI)    │
 │ Firebase Phone Auth (+91)   │           │  ├─ identity · profile · contacts         │
 │ on-device speech-to-text    │           │  ├─ subscriptions (platform money)        │
 └────────────────────────────┘           │  ├─ onboarding · imports                  │
          ▲ hosted checkout (PSP)          │  ├─ billing · payments (owner money)      │
          │                                │  ├─ notes · disputes · notify (outbox)    │
 ┌────────┴────────┐  signed webhooks      │  ├─ ai (read-only tools, metered)         │
 │ Razorpay/Cashfree│ ───────────────────▶ │  └─ jobs (EventBridge → /jobs/{name})     │
 └─────────────────┘                       │            │ SQL + rg_* functions          │
                                           │  Lightsail PostgreSQL 16 (private, TLS)  │
                                           │  S3 (private, KMS) · SES · Bedrock       │
                                           └──────────────────────────────────────────┘
```

**Modular monolith.** One deployable with one module per business area (`api/app/modules/*`). Modules talk through plain function calls and the database. There's no Kafka, Redis, Kubernetes or microservices. Background work is in-process code triggered by durable EventBridge schedules, not a scheduler living inside the API process.

## Where the rules live

| Layer | Holds | Why |
|---|---|---|
| `api/app/db/sql/0002_functions.sql` | Ledger posting, allocation, payment confirmation, deposit maths, invoice generation, subscription activation and lifecycle, unit capacity, AI quota reservation and settlement | These invariants must survive concurrency, retries and any future caller (jobs, imports, admin scripts). Row locks plus a single code path give exactly-once behaviour, and they're tested against a real PostgreSQL. |
| `api/app/domain/*` | Field validation (Unicode-aware), money parsing and formatting, Excel safety, signatures, notification rules | Pure Python with no I/O, so it unit-tests quickly. The mobile app mirrors validation for instant feedback. |
| `api/app/modules/*` | HTTP contracts, authorization scope, orchestration, provider calls | Thin layer. It never computes balances itself and only formats paise that SQL returned. |
| `api/app/providers/*` | Payment, messaging, AI and storage adapters behind small interfaces | Sandbox, console and mock adapters let the whole app run locally without pretending anything real happened. |

## Key flows

**Owner activation.** The app calls `POST /subscription/checkout` and the server creates the order at the server-side price. The app opens the provider's hosted checkout. The provider sends a signed webhook to `/webhooks/payments/subscription`, which is stored once per event id and passed to `rg_activate_subscription`. That function locks the order and the owner, checks the amount, records the payment and creates the subscription period. Meanwhile the app polls `POST /subscription/orders/{id}/refresh`, which does a server-to-server status check. If the user retries checkout, the open order is reused after a status check, so there's never a second charge.

**Cash.** Owner picks the tenant, enters the amount and confirms. The server calls `rg_record_payment('cash')`, which posts a ledger credit, allocates oldest dues first, issues a receipt (labelled *owner-recorded*) and queues a notification to the tenant. The tenant can acknowledge it or raise a dispute. Corrections go through `rg_reverse_payment`, which posts an opposite entry. Nothing is deleted.

**Online rent.** The tenant chooses an amount. The server creates a pending payment and a provider order using the rent merchant configuration, never the subscription one. A verified webhook triggers `rg_confirm_gateway_payment`. It confirms exactly once: replays return `already_confirmed`, and an amount mismatch is recorded but not applied. The reconciliation job catches payments whose webhook never arrived.

**Monthly bill.** The `generate_invoices` job calls `rg_generate_monthly_invoice`. It creates one invoice per tenancy per month (enforced by a unique constraint), prorates rent for partial months, applies rent revisions and rent-free months, and carries forward maintenance. Utility charges come either from owner entry or from approved tenant submissions; they are never guessed.

**AI.** The owner's question goes through the scope check, then `rg_ai_reserve` (plan, feature, model, per-request cap, monthly tokens, cost ceiling, voice seconds and concurrency, all in one conditional UPDATE). The provider then runs with read-only, owner-scoped tools, and `rg_ai_settle` records actual usage (or the full reservation if usage is missing). Figures shown in the app come from the tool results (`facts`), not from model text. Reminder drafts need an explicit `/reminder-send` from the owner before anything goes out.

## Time and money

- All money is `BIGINT` paise. Python uses `Decimal` only for parsing input; TypeScript uses integers. There is no float arithmetic on money anywhere.
- Business dates (billing month, due dates, "today") are in Asia/Kolkata (`rg_today()`). Timestamps are stored as `timestamptz` in UTC.
- A due day of 29–31 falls on the last day of shorter months (`rg_due_date`).
- Proration is `round(rent × occupied_days ÷ days_in_month)`, rounding half away from zero to the paisa.

## Scaling path

You can stay on one Lightsail container service and Lightsail PostgreSQL until roughly tens of thousands of tenancies. The next step is ECS Fargate (task roles, so no IAM user keys) plus RDS PostgreSQL Multi-AZ with RDS Proxy, CloudWatch Logs via awslogs, and a Postgres-backed rate limiter (or ElastiCache once there's more than one instance). The schema, the functions and the job model don't change. See AWS_DEPLOYMENT.md.
