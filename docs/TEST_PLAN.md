# Test plan

## Test layers

| Layer | Location | Runs where | What it proves |
|---|---|---|---|
| Domain unit tests (79) | `api/tests/unit/test_domain.py` | anywhere (`make test-unit`) | Indian mobile normalisation, Unicode-aware names in 8 scripts, 250/251-grapheme notes (Tamil, Devanagari conjuncts, emoji), money parsing (no float/NaN/exponent/negative), Indian grouping, proration rounding, webhook HMAC over raw bytes, signed tokens, OTP hashing, notification destination/consent/quiet-hours, reminder schedule, Excel template/row errors/duplicates/formula injection/macros/capacity |
| DB invariant tests (16 scenarios) | `api/tests/sql/test_invariants.sql` | Postgres (`make test-sql`) | Plan catalogue, unpaid/Starter caps, archive evasion, exactly-once activation, grace/read-only, invitation gating, the ₹10,000/₹7,000/₹13,000 example, oldest-first allocation, reversal, append-only ledger, gateway exactly-once + mismatch, deposit ₹45,000 − ₹15,000 = ₹30,000 + exit refund, tenant submissions + adjustments, proration + due-day 31, AI quotas (Starter blocked, Growth 10k cap, duplicates, missing usage, cost ceiling, voice), upgrade carry-over, contact limits, scope violations |
| DB concurrency races (4) | `api/tests/sql/test_concurrency.sh` | Postgres | Two sessions racing for the 100th unit and two for the 101st (cap holds); 8 parallel duplicate webhooks (one ledger entry); 6 parallel activations of one order (one subscription); 10 parallel 9,000-token AI reservations against 50,000 (exactly 5 succeed) |
| SQL contract check | 285 SQL statements in the Python modules `PREPARE`d against the real schema | Postgres | Every query the API sends parses, references real columns and has inferable parameter types (this catches the psycopg "could not determine data type" class of bug) |
| API end-to-end (13) | `api/tests/integration/test_api_flows.py` | Postgres + FastAPI (`make test-api`, CI) | The HTTP layer: auth, scoping, webhooks, idempotency, flows below |
| Mobile | `mobile/scripts/format.test.ts`, `check-i18n.mjs`, `__tests__/*.test.tsx`, `e2e/*.yaml` (Maestro) | Node / jest-expo / device | Grapheme counter (with and without `Intl.Segmenter`, as on Hermes), INR formatting, all 8 locales complete, searchable select, owner cash flow and tenant invitation on a device |

## Required scenarios → coverage

| # | Scenario | Covered by |
|---|---|---|
| 1 | Pricing ₹1/1, ₹50/100, ₹100/250 → OTP → role → profile → locked primary; paid activation; tenant free; Both tenant view free | T01, T04 · API `test_public_plans_are_exact`, `test_owner_activation_only_via_verified_webhook`, `test_both_role_tenant_view_free_before_owner_payment` · Maestro owner flow |
| 2 | Owner creates shop + tenancy; tenant sees it only after OTP + accept | T06 · API `test_tenant_sees_nothing_until_accepting` · Maestro tenant flow |
| 3 | Excel with valid/invalid rows, preview, commit without duplicates | unit Excel tests · API `test_excel_import_preview_and_commit` |
| 4 | Tenant of two owners who also owns a unit; zero leakage | T16 · API `test_cross_owner_isolation` · seed (Ravi, Kavya) |
| 5 | Primary mobile change keeps UUID and all data | API `test_mobile_change_preserves_identity` |
| 6 | Owner proposes contact change; cannot hijack identity | API `test_owner_contact_proposal_needs_tenant` |
| 7 | Owner and tenant charges; approval before payable | T11 |
| 8 | ₹10,000 − ₹7,000 cash = ₹3,000 → ₹13,000; dispute | T07 · API `test_cash_partial_and_dispute` |
| 9 | Verified webhook updates ledger once; failed/pending don't | T09, C2 · API `test_rent_gateway_and_purpose_separation` |
| 10 | Deposit ₹45,000, adjust ₹15,000 → ₹30,000; final settlement | T10 · seed (Lakshmi/Ravi) |
| 11 | 250 Indian-script chars OK, 251 rejected; voice reviewed before save | unit note tests · API `test_note_limits` · `NoteInput` (manual save only) |
| 12 | Channel destinations = verified contacts only; consent; no duplicate reminders; none after full payment | unit `test_destinations_*`, `test_reminders_*` · `notification_events.dedupe_key` UNIQUE |
| 13 | Close one tenancy; other owners unaffected; history kept | T10 · API `test_close_one_tenancy_keeps_others` |
| 14 | IDOR/BOLA, Both confusion, malicious Excel, payment tampering, rate limits | T15, T16, unit Excel/signature tests, API isolation + webhook tests |
| 15 | AI: Starter off, Growth 10k, Business 50k, concurrency, caps, voice, resets, no cross-owner data | T13, T14, C4 · API `test_ai_plan_gating_and_usage` |
| 16 | All 8 locales load, no missing critical keys | `check-i18n.mjs` (104 keys × 8) |

## What has been run so far

These ran in the authoring environment against **PostgreSQL 16.x** with Python 3.13 and Node 22:

- ✅ 79/79 domain unit tests
- ✅ 16/16 DB invariant scenarios
- ✅ 4/4 concurrency races
- ✅ Demo seed loads, and all 10 seeded tenancies reconcile bill ↔ ledger
- ✅ 284/285 API SQL statements prepare against the schema. The 1 reported failure is the checker's own placeholder for a conditional `FOR UPDATE` f-string; it was confirmed valid by hand.
- ✅ Mobile helpers (with and without `Intl.Segmenter`), i18n completeness, TypeScript syntax of all 35 files, and a stub-typed `tsc` pass with no unresolved names or imports
- ✅ `ruff` pyflakes checks clean

**Not run yet.** The package registries (PyPI, npm) were unreachable in the authoring environment, so these need their first run on your machine or in CI:

- ⏳ API end-to-end tests (needs FastAPI, SQLAlchemy and psycopg installed): `make up && make test-api`
- ⏳ Full mobile `tsc --noEmit`, jest-expo tests, the Expo build, and the Maestro flows (needs `npm install`)
- ⏳ `terraform validate` (needs the Terraform CLI)

Expect a few small fixes on first run. That's normal for code whose HTTP and React Native layers haven't been executed yet. The financial core underneath them has been executed.

## Boundary checklist (validation)

Each field's rule is in `api/app/domain/validation.py` (`FIELD_RULES`, also served at `GET /api/v1/meta/validation`) and is tested at both edges: name 1/2/100/101 graphemes; mobile 9/10/11 digits, prefix 5 vs 6; email 254/255; profile address 250/251; property address 4/5; unit identifier 20/21 and bad characters; PIN 5/6/7 digits and leading 0; due day 0/1/31/32/non-integer; amounts 0/0.01/2 vs 3 decimals/exponent/negative/over ₹1 crore; notes 0/1/250/251; dates end ≤ start.
