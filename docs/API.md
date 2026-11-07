# PayMyRent API (v1)

Interactive OpenAPI: `http://localhost:8000/docs` (disabled in production). All paths are under `/api/v1`.

## Conventions

- **Auth:** `Authorization: Bearer <Firebase ID token>` (production) or a dev-simulator token (local only). Call `POST /auth/session` once after OTP sign-in.
- **Owner scope:** owner endpoints act on the caller's own owner account; a delegated manager may pass `X-Owner-Account`, which is checked against `owner_memberships`. IDs in paths are always re-checked against that scope — a foreign ID returns **404**, never 403, so existence is not leaked.
- **Money:** integer **paise** in responses (`*_paise`), with a pre-formatted `*_display` where useful. Requests accept rupee strings (`"7000"`, `"7,000.50"`) — never floats, exponents or negatives.
- **Idempotency:** every money-moving POST takes `idempotency_key` (8–80 chars). Retrying with the same key returns the original result; reusing a key for a different amount is `409 IDEMPOTENCY_KEY_REUSED`.
- **Concurrency:** profile and tenancy-terms edits carry `version`; a stale version is `409 STALE_VERSION`.
- **Errors:** `{"error": {"code", "message", "details"|"fields"}}`. `code` is stable and translated by the app. Common: `VALIDATION` 422, `NOT_FOUND` 404, `SUBSCRIPTION_REQUIRED` 402, `UNIT_CAPACITY_EXCEEDED` 409, `AI_QUOTA_EXHAUSTED` 429, `RATE_LIMITED` 429.
- **Never client-settable:** paid/confirmed status, prices, plan capacity, AI allowance, verification labels.

## Webhooks

Two **separate** endpoints, secrets and order tables: `POST /webhooks/payments/subscription` (owner → platform) and `POST /webhooks/payments/rent` (tenant → owner). Signature: hex HMAC-SHA256 of the raw body (`X-Razorpay-Signature`). Each event is stored once per `(provider, purpose, event_id)`; replays return `duplicate_event`. A rent order id sent to the subscription endpoint resolves to `unknown_order` and changes nothing.

## Endpoints

### Identity, profile, contacts

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/dev/otp/request` | demo env only | LOCAL DEMO ONLY |
| POST | `/dev/otp/verify` | demo env only |  |
| POST | `/auth/session` | verified token | Called after OTP sign-in |
| GET | `/me` | signed-in user |  |
| POST | `/me/roles` | signed-in user | Role *intent* |
| PUT | `/me/profile` | signed-in user |  |
| POST | `/me/contacts` | signed-in user |  |
| POST | `/me/contacts/{contact_id}/verify` | signed-in user |  |
| DELETE | `/me/contacts/{contact_id}` | signed-in user |  |
| PUT | `/me/notification-preferences` | signed-in user |  |
| POST | `/me/mobile-change/start` | signed-in user | Step 1 — prove possession of the CURRENT number: the token must have been minted by a fresh OTP sign-in on the current primary number within |
| POST | `/me/mobile-change/complete` | verified token | Step 2 — the client has linked the new number to the SAME Firebase user (updatePhoneNumber with an OTP credential), so the fresh token carri |
| POST | `/me/mobile-change/recovery` | verified token | Old phone lost: the person signs in with the NEW number and files a request naming the old number |

### Pricing & owner subscription

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/plans` | signed-in user | Public — no login |
| GET | `/subscription` | owner member |  |
| POST | `/subscription/checkout` | owner member |  |
| POST | `/subscription/renew` | owner member |  |
| POST | `/subscription/change-plan` | owner member |  |
| POST | `/subscription/cancel` | owner member |  |
| POST | `/subscription/orders/{order_id}/refresh` | owner member | Pending screen 'check again': authoritative server-to-server status check. |
| GET | `/subscription/payments` | owner member |  |
| GET | `/subscription/receipts` | owner member |  |
| POST | `/webhooks/payments/subscription` | PSP signature |  |
| GET | `/sandbox/pay/{purpose}/{order_id}` | demo env only |  |
| POST | `/sandbox/pay/{purpose}/{order_id}` | demo env only |  |

### Properties, units, tenancies, invitations, Excel import

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/owner/properties` | owner member |  |
| POST | `/owner/properties` | owner member |  |
| GET | `/owner/units` | owner member |  |
| POST | `/owner/units` | owner member |  |
| POST | `/owner/units/{unit_id}/{action}` | owner member |  |
| POST | `/owner/tenancies` | owner member |  |
| GET | `/owner/tenancies` | owner member |  |
| GET | `/owner/tenancies/{tenancy_id}` | owner member |  |
| PATCH | `/owner/tenancies/{tenancy_id}` | owner member |  |
| PUT | `/owner/tenancies/{tenancy_id}/charge-config` | owner member |  |
| PUT | `/owner/tenancies/{tenancy_id}/contact` | owner member | Owner's own record of the tenant for THIS tenancy |
| POST | `/owner/tenancies/{tenancy_id}/contact-proposals` | owner member |  |
| POST | `/owner/tenancies/{tenancy_id}/end` | owner member |  |
| GET | `/tenant/invitations` | signed-in user | Only enough to recognise the invitation — no rent, balances or address until accepted. |
| POST | `/tenant/invitations/{invitation_id}/{decision}` | signed-in user |  |
| GET | `/tenant/rentals` | signed-in user |  |
| GET | `/tenant/contact-proposals` | signed-in user |  |
| POST | `/tenant/contact-proposals/{proposal_id}/{decision}` | signed-in user | Accepting never applies the change silently: secondary mobile/email are added UNVERIFIED and the tenant verifies them by OTP; a primary-numb |
| GET | `/owner/imports/template` | owner member |  |
| POST | `/owner/imports` | owner member |  |
| POST | `/owner/imports/{job_id}/commit` | owner member |  |
| GET | `/owner/imports/{job_id}` | owner member |  |

### Bills, charges, submissions, reports

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/tenancies/{tenancy_id}/bill` | signed-in user |  |
| GET | `/tenancies/{tenancy_id}/history` | signed-in user |  |
| POST | `/owner/tenancies/{tenancy_id}/charges` | owner member |  |
| GET | `/owner/tenancies/{tenancy_id}/charge-suggestions` | owner member | Last month's utility amounts as *editable suggestions* — never billed automatically. |
| POST | `/owner/invoice-lines/{line_id}/adjust` | owner member |  |
| POST | `/owner/tenancies/{tenancy_id}/invoices` | owner member |  |
| POST | `/tenancies/{tenancy_id}/charge-submissions` | signed-in user |  |
| GET | `/owner/charge-submissions` | owner member |  |
| POST | `/owner/charge-submissions/{submission_id}/review` | owner member |  |
| GET | `/owner/dashboard` | owner member |  |
| GET | `/owner/reports/collections.csv` | owner member | Export works in every subscription state, including read-only after lapse. |
| GET | `/tenancies/{tenancy_id}/statement` | signed-in user | Printable statement in the viewer's language |

### Payments, receipts, deposits, payout

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/owner/tenancies/{tenancy_id}/payments/cash` | owner member | Select tenant → amount → confirm |
| POST | `/owner/payments/{payment_id}/reverse` | owner member |  |
| POST | `/owner/payments/{payment_id}/confirm-transfer` | owner member |  |
| POST | `/tenant/tenancies/{tenancy_id}/payments/manual-transfer` | signed-in user | A UPI/bank transfer made outside the app |
| POST | `/tenant/tenancies/{tenancy_id}/payments/checkout` | signed-in user |  |
| POST | `/tenant/payments/{payment_id}/refresh` | signed-in user | 'Check status' on the pending screen: server-to-server status check, never the client's word. |
| POST | `/webhooks/payments/rent` | PSP signature |  |
| POST | `/tenant/payments/{payment_id}/ack` | signed-in user |  |
| GET | `/payments/{payment_id}` | signed-in user |  |
| GET | `/receipts/{receipt_id}` | signed-in user |  |
| POST | `/owner/tenancies/{tenancy_id}/deposit` | owner member |  |
| GET | `/tenancies/{tenancy_id}/deposit` | signed-in user |  |
| POST | `/owner/payout-account` | owner member | Sensitive: requires a fresh OTP sign-in (step-up) and notifies the owner on every change |

### Notes, disputes, attachments

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/tenancies/{tenancy_id}/notes` | signed-in user |  |
| GET | `/tenancies/{tenancy_id}/notes` | signed-in user |  |
| PATCH | `/notes/{note_id}` | signed-in user |  |
| POST | `/tenancies/{tenancy_id}/disputes` | signed-in user |  |
| GET | `/tenancies/{tenancy_id}/disputes` | signed-in user |  |
| POST | `/owner/disputes/{dispute_id}/resolve` | owner member | Resolving records the outcome only |
| POST | `/attachments` | signed-in user |  |
| GET | `/owner/disputes` | owner member |  |

### Owner AI

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/owner/ai/ask` | owner member |  |
| POST | `/owner/ai/reminder-draft` | owner member | AI drafts wording only |
| POST | `/owner/ai/reminder-send` | owner member | Explicit owner approval |
| GET | `/owner/ai/usage` | owner member |  |

### Jobs, health, metadata

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/jobs/{name}` | job key | Called by an EventBridge rule → API destination (connection auth sends X-Job-Key), or by an operator with a short-lived signed X-Job-Token |
| GET | `/health` | public |  |
| GET | `/meta/validation` | public |  |
