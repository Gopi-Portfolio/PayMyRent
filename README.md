# RentMeezy — rent billing & collection for Indian shop and house owners

One mobile app (Owner / Tenant / Both), one FastAPI backend, one PostgreSQL database.
Built for owners with roughly 5–250 shops or houses, and for tenants who just want to see and pay their dues.

```
api/      FastAPI modular monolith · SQL-first schema · PL/pgSQL ledger & quota invariants · tests
mobile/   React Native + Expo + TypeScript (Expo Router, Paper, TanStack Query, RHF/Zod, i18n ×8)
jobs/     scheduled job runner + schedule table (EventBridge in production)
infra/    Terraform (AWS ap-south-1: Lightsail containers + Lightsail Postgres + S3 + SES + EventBridge)
docs/     ARCHITECTURE · DATA_MODEL · API · SECURITY · AWS_DEPLOYMENT · TEST_PLAN · DECISIONS
```

## Run it locally (about 5 minutes)

Prerequisites: Docker Desktop, Node 20+, and the Expo Go app on your phone (or an Android emulator).

```bash
make up          # Postgres 16 + API on :8000 (migrations run on start)
open http://localhost:8000/docs
```

Then run the app:

```bash
cd mobile
cp .env.example .env    # set EXPO_PUBLIC_API_URL to your computer's LAN IP, e.g. http://192.168.1.10:8000
npm install && npx expo install --fix    # aligns native module versions with the Expo SDK
npx expo start                           # scan the QR code with Expo Go
```

If your phone uses the API over the LAN, start it with `LAN_IP=192.168.1.10 make up` so the demo checkout links point to your computer.

### Signing in locally (local dev OTP simulator; the code is always `123456` and is shown on screen)

There is no sample data: the database starts empty. Any 10-digit number starting with 6–9 creates a new account, so make your own owner and renter and add properties, units and renters through the app.

**Everything local is a demo.** OTPs aren't sent, the sandbox checkout moves no money, and SMS, WhatsApp and email go to the API log. Each of these is clearly labelled in the app (a yellow DEMO bar) and on receipts.

## Tests

```bash
make test-unit   # 79 pure-Python tests: validation (Indian scripts, 250-grapheme notes), money, Excel safety, signatures, reminders
make test-sql    # 16 database invariant scenarios + 4 real concurrency races (needs `make up`)
make test-api    # FastAPI + Postgres end-to-end scenarios (needs `make up` and `pip install -r api/requirements-dev.txt`)
cd mobile && node scripts/check-i18n.mjs && npx tsx scripts/format.test.ts
```

See `docs/TEST_PLAN.md` for the scenario matrix, including which tests have already been run and which still need running in your environment.

## Run the scheduled jobs by hand

```bash
make jobs        # generate invoices → queue reminders → dispatch notifications
docker compose exec api python -m app.cli reconcile_payments
```

## Before production: decisions only you can make

These block a real launch. Each is described in `docs/DECISIONS.md`.

1. **Payment provider and owner settlement (D-03).** You need to confirm with Razorpay, Cashfree or another provider that rent can settle directly into each owner's own account (Route, linked accounts or sub-merchants), plus the KYC flow for that. Until then, online rent is disabled outside demo mode. RentMeezy never holds rent in the platform's own merchant account.
2. **₹1 Starter economics.** Check the provider's minimum charge, the fee on a ₹1 transaction, GST on the subscription, and the refund flow.
3. **SMS (DLT), WhatsApp (BSP + templates) and SES production access.** The templates in `api/app/i18n/templates.py` must be registered word for word.
4. **Indian tax and legal review.** This covers GST/TDS on commercial rent, DPDP Act notices and consent, data retention, and the terms of service.
5. **Native-speaker review of the seven non-English languages.** They are first drafts.
6. **Firebase project.** Set up Phone Auth for India, App Check, and abuse limits, and sign off on the account-recovery procedure.
