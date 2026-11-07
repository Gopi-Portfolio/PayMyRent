# Security, privacy and tenancy isolation

## Threat model (summary)

| Asset | Main threats | Controls |
|---|---|---|
| Owners' and tenants' financial records | IDOR/BOLA across owners; tenants reading owner data; "Both" role confusion | Every owner query is filtered by `owner_account_id` taken from `owner_memberships`, never from client input. Tenant queries are filtered by `tenant_user_id` **and** an accepted status. A foreign ID returns 404. DB triggers stop cross-owner unit or tenancy links (`SCOPE_VIOLATION`). The role switch only changes the UI. |
| Ledger integrity | Tampering, double posting, replayed webhooks, races | Append-only triggers. Unique "post once" indexes. Row locks in `rg_*` functions. Idempotency keys. Webhook dedupe. Clients can never set a paid status. Tested with parallel sessions (`tests/sql/test_concurrency.sh`). |
| Accounts | SIM-swap or OTP abuse; takeover through a secondary number; owner hijacking a tenant | Firebase Phone Auth plus App Check (production). Dev OTPs are rate-limited per number and stored only as keyed hashes bound to the target, with 5-minute expiry and 5 attempts. A number verified on one account cannot start another. The primary-mobile change needs step-up on the old number **and** proof of the new one, keeps the same UUID, revokes all sessions and alerts the old number. Recovery without the old phone goes to manual review and never reveals whether an account exists. Owners can only *propose* contact changes. |
| Money flows | Rent sent to the platform's merchant account; subscription and rent mixed up | Separate provider configurations, secrets, webhook endpoints, order tables and functions. Rent checkout requires a verified owner payout account outside demo mode (D-03). |
| Payout details | Redirecting an owner's money | Step-up OTP within 5 minutes. The owner role only (not managers). A security notification on every change. Raw bank/UPI data stays with the PSP and only a masked label is stored. |
| Uploaded spreadsheets and files | Formula/CSV injection, macros, XXE, zip bombs, malware | Only `.xlsx`. Macro and external-link packages rejected. Size and uncompressed-size limits. `data_only=False` so formula cells are found and rejected. Dangerous leading characters rejected. `defusedxml`. Content-type magic-byte sniffing. Private S3 with KMS. 5-minute presigned downloads. CSV exports neutralise `= + - @`. |
| AI | Prompt injection, cross-owner leakage, runaway cost | No write tools. The owner id comes from the server scope, never from the model. Tool output is passed as JSON data and the system prompt says to treat it as data. Phone numbers are never sent and tenant names are reduced to first names. Hard token, cost, voice and concurrency limits sit in SQL, with no silent overage and no automatic fallback to a larger model. The provider key stays server-side. AI can be switched off with `RG_AI_ENABLED=false`. |
| Infrastructure | Public database, leaked keys | DB `publicly_accessible=false` with TLS required. S3 public access is blocked and a TLS-only policy is in place. GitHub deploys use OIDC (no stored AWS keys). Secrets live in SSM SecureString. The app IAM user is least-privilege and rotated every 90 days (removed once on ECS). CloudTrail is on. MFA is required for all human IAM users and the root account. |

## Checklist (status)

- [x] Backend verifies a token on every protected request. Sessions can be revoked (`users.sessions_valid_after`).
- [x] Startup refuses unsafe production configuration: dev auth, dev secrets, sandbox PSP or the mock AI provider.
- [x] Rate limits: OTP (per number, DB-backed), checkout, AI, recovery. The per-process limiter is fine for one instance; see the scaling note.
- [x] HSTS, nosniff, frame-deny, no-store and request IDs on every response. OpenAPI docs are disabled in production.
- [x] Logs redact Indian mobile numbers and emails (`RedactingFilter`). Receipts and logs show masked contacts.
- [x] Card numbers and UPI PINs are never handled. Hosted checkout only.
- [x] Audit events for profile, contact, role, tenancy, charge, payment, deposit, dispute, payout and import actions.
- [x] Dependency audit (pip-audit, npm audit) and a secret scan (gitleaks) in CI.
- [ ] **PostgreSQL row-level security** as defence in depth. Not enabled in v1 because the API uses one database role. The plan is to give the API a non-owner role, `SET LOCAL app.owner_ids` per request, and add RLS policies on tenant-scoped tables (tracked in DECISIONS D-11).
- [ ] Firebase App Check and the Play Integrity / App Attest setup (production project).
- [ ] Push token registration and the FCM adapter.
- [ ] Retention purge job (OTPs older than 30 days, notification payloads older than 180 days).
- [ ] External penetration test before launch.

## Privacy (DPDP Act 2023 — requires legal review)

- **Purpose limitation.** Contact data is used only for login, rent communication and security alerts. Marketing is not built and would need separate consent.
- **Consent.** `consent_records` stores an append-only history per channel and notice version. WhatsApp needs explicit opt-in. Tenants control their own channels; owners can't change them.
- **Data principal rights.** Profile view and edit exist today; an export endpoint and account closure (deactivate, keep financial records, redact optional PII) are documented in DATA_MODEL.md and need a short admin implementation.
- **Processors.** Firebase (auth), PSP, SMS/WhatsApp provider, AWS (SES, S3, Bedrock in ap-south-1). Data processing agreements and cross-border review are needed for each before launch.
- **Breach response.** See the incident response steps below. CERT-In reporting obligations apply (6 hours for notifiable incidents) and must be confirmed by counsel.

## Incident response (short form)

1. Contain: disable the affected integration (`RG_AI_ENABLED=false`, rotate the PSP webhook secret, revoke sessions by bumping `sessions_valid_after`).
2. Preserve: CloudTrail, `audit_events`, `webhook_events`, container logs.
3. Assess scope with the audit queries in AWS_DEPLOYMENT.md.
4. Notify: CERT-In, the Data Protection Board and affected users as counsel advises; the PSP if payment data is involved.
5. Post-mortem and add a regression test.


## Production hardening (added)
- Owner PAN is stored AES-256-GCM encrypted (`pan_enc`) with a keyed lookup hash (`pan_hash`) for the one-PAN-per-owner rule; only a masked form is ever returned. Back up `RG_PAN_ENCRYPTION_KEY`: without it stored PANs cannot be read.
- Rate limits are PostgreSQL-backed (`rate_limit_hits`), so they are shared by all API instances and survive restarts.
- File links are signed with their own `RG_FILE_SIGNING_SECRET`.
- Request bodies over `RG_MAX_BODY_BYTES` (8 MB) get 413 before they are buffered. Host header allow-list via `RG_ALLOWED_HOSTS`.
- With `RG_APP_ENV=production` the API refuses to start unless: dev auth is off; every secret is real (24+ chars); webhook secrets are set; sandbox providers are off; `RG_PUBLIC_BASE_URL` is https; hosts/CORS are explicit; the database password is not the default.
- `docker-compose.prod.yml`: database port not published, API bound to localhost behind a TLS proxy, read-only filesystem, all capabilities dropped, memory limits.
- Mobile: sign-out wipes the query cache, role and profile preferences; release builds refuse a non-https API address; cache lives 10 minutes, not 24 hours.

## Privacy rights and known accepted risks
- `GET /api/v1/me/export` (download my data) and `POST /api/v1/me/close-account` (type DELETE): removes name, address, contacts, PAN, signs out all devices and frees the mobile number. Bills, payments, receipts and ledger entries are immutable and kept for accounting; they stay linked to an anonymous "Closed account". Blocked while the person has an active or invited rental.
- In-app privacy notice (menu and Profile), available in all 8 languages.
- Dependency scans: `pip-audit` clean. `npm audit --omit=dev` still lists build-time Expo CLI packages (not shipped in the app) and Firebase firestore/grpc packages pulled in by the Firebase SDK (the app imports only Auth, so they are not bundled). Re-run both scans before every release.
- Not implemented: PostgreSQL row-level security (isolation relies on the owner-scope checks in code, covered by tests), certificate pinning, jailbreak/root detection, CAPTCHA.

## Who can see whose data (added 2026-11-06)

**Renter privacy.** A renter's screens get: their own unit and its address, rent, bills, payments, deposit, the notes shared with them,
and the owner's display name plus the "verified" badge. Nothing else about the owner (no phone, no internal ids, no PAN or legal
address) and nothing about the owner's other units, properties or renters. An invitation shown before acceptance carries only the
owner's name, the unit number and the badge. Enforced in the API (`/tenant/rentals`, `/tenant/invitations`) and tested in
`tests/integration/test_isolation.py`.

**Owner numbers (co-owners).** An owner account has at most `RG_MAX_OWNER_NUMBERS` people (default 2: the subscriber + one more),
identified by mobile number, declared at checkout (`owner_mobiles`) or later (`PUT /owner/owner-numbers`, main owner only). Only a
person who signs in with a declared, OTP-verified number is attached as a co-owner; removing the number revokes access at once. There
is no other way to become an owner of an account. There is no way to become an owner of an account
other than this list.

**Properties: one registered owner, one subscription each (added 2026-11-06).** A property is identified by its normalised address
(case, punctuation, rd/road, "No." ... and pincode ignored) and by its ownership proof number (property tax / sale deed / electricity
connection / lease deed). Both are unique across ALL owners, enforced by database unique indexes; a second owner is told the property
is already registered, never by whom (`rg_property_conflict` answers yes/no across owners). Proof numbers that look like placeholders
(000000, 123456, AAAAAA) are rejected, the declaration is required, and the pre-check endpoint is rate-limited so it cannot be used to
probe addresses. A property is `submitted` until a reviewer verifies it (`/admin/review/property/{id}`, admin token, system
connection); renters can only be added to a verified property, and the signed-in database role cannot verify, reject or rewrite a
verified property's address or proof even directly. A near-duplicate address (same pincode, 80% of words equal) is allowed but flagged
for the reviewer. Each owner account holds ONE property with its own plan: another property is added as a new account of the same
person (same phone, owner details copied), needs its own plan and payment, and is validated before any money is asked.
Accounts that already held several properties before this rule are grandfathered (`legacy_multi_property`).
Limits: verification is by document number plus a human reviewer, not an automated registry lookup, and no document upload yet.
The demo switch `RG_DEMO_AUTO_VERIFY_PROPERTIES` lets a developer skip the reviewer locally; it is stored in a table the app role cannot
write and the provisioning step refuses it in production.

**Row-level security (database).** The API's signed-in requests connect as the limited role `pmr_app`, and each request tells the
database who is asking (`app.user_id`, `app.owner_ids`, `app.phones`, `app.tenancy_ids`, transaction-local). Policies on the core
tables (properties, units, tenancies, invoices and lines, payments, ledger, receipts, deposits, notes, disputes, contact snapshots,
invitations, charge config, ...) return or change only rows of the person's own owner account or of tenancies they rent, so a query
that forgets its WHERE clause cannot leak another owner's data. Views run with the caller's rights (`security_invoker`). Migrations,
scheduled jobs, webhooks and admin review use the table-owner connection, which row-level security does not restrict.
Set the role's password at deploy time (`RG_APP_DB_PASSWORD`, run by `python -m app.db.provision`); production refuses to start
without `RG_APP_DATABASE_URL`. Tested directly against the database in `tests/integration/test_rls.py`. Measured on 70,000 shops:
no measurable difference (dashboard 33.6 ms vs 32.0 ms, other screens within noise).

Accepted limits: (1) the context settings are ordinary session settings, so a SQL-injection hole could still set them. Parameterised
queries everywhere are the first defence; (2) tables outside the list above (subscriptions, notifications, AI usage, imports, audit)
are protected by application checks only; (3) AI, KYC and subscription code that opens its own system transaction is not restricted by
row-level security; (4) a wrong phone number on an invitation shows the owner's name and unit number to whoever holds that number.

## One-time code on every verification step
Identity check, owner details, property submission, payout account and a second-owner number each need a fresh 6-digit code sent to the
mobile number attached to the signed-in account (`POST /me/action-otp/request`; the destination is never taken from the request). The code
is bound to that number and to that one step, is single-use, expires after 5 minutes, and wrong tries are limited (10 per 10 minutes, counted
outside the request so a failed attempt cannot be rolled back). Without a valid code the step is refused with `otp_required`.
