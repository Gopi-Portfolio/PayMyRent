# Deploying the backend to the Oracle server

Backend only. The mobile app is built separately (`docs/BUILD.md`) and talks to the API over HTTPS.

```
Jenkins server (polls GitHub; push to main)
   └─ Jenkinsfile: tests ─▶ build ARM image ─▶ SSH to this server ─▶ scripts/deploy-backend.sh
Server (Oracle A1, Ubuntu)
   Caddy :80/:443 (HTTPS, auto certificate) ─▶ api :8000 (internal only) ─▶ db (internal only)
   backup container: a database dump every 24 h, kept 14 days
```

## 0. Decide first
- **Ubuntu 22.04 or 24.04.** 20.04 no longer gets free security updates. The VM can be recreated for free on the same shape; keep the same reserved public IP.
- **Reserve the public IP** (Networking → Reserved public IPs), so the address in DNS and the app never changes.
- **Address for the API.** With no domain yet, use `<ip-with-dashes>.sslip.io` (for `161.153.65.47` it is `161-153-65-47.sslip.io`). It resolves to the IP and Caddy can get a real certificate for it. For the App Store launch buy a domain and point an A record at the IP.

## 1. Oracle console: open the ports (the first of two firewalls)
Networking → your VCN (`paymyrent-vcn`) → Security List → **Add ingress rules**: source `0.0.0.0/0`, TCP, destination port **80**, and another for **443**.
Keep 22 (SSH) restricted to your own IP if you can. **Never open 5432 or 8000.**

## 2. Server: install Docker and open the second firewall
```bash
ssh -i <your-key.pem> ubuntu@161.153.65.47
curl -fsSLO https://raw.githubusercontent.com/Gopi-Portfolio/PayMyRent/main/scripts/server-setup.sh   # or copy the file with scp
bash server-setup.sh
exit    # log in again so the docker group applies
```

## 3. Server: get the code and the secrets in place
The server does not need GitHub access. For the first start send a snapshot from your PC (later the pipeline sends the deploy files itself):
```powershell
# on your PC, in the project folder
git archive --format=tar.gz -o $env:TEMP\pmr.tgz main
scp -i <key-file> "$env:TEMP\pmr.tgz" ubuntu@161.153.65.47:~/
```
```bash
# on the server
sudo mkdir -p /opt/paymyrent/app && sudo chown -R ubuntu:ubuntu /opt/paymyrent
tar -xzf ~/pmr.tgz -C /opt/paymyrent/app
cd /opt/paymyrent
cp app/deploy/paymyrent.env.example paymyrent.env
cp app/deploy/paymyrent-api.test.env.example paymyrent-api.env     # for a real launch use app/api/.env.production.example
chmod 600 paymyrent.env paymyrent-api.env
```
Fill both files **on the server** (nano). Generate every secret and password separately:
`python3 -c "import secrets;print(secrets.token_urlsafe(48))"`.

Rules the API enforces at startup (it refuses to start otherwise): all secrets at least 24 characters and not starting with `dev`; `RG_PUBLIC_BASE_URL` is `https://…`; `RG_ALLOWED_HOSTS` lists the host name; a real Firebase project id; payment providers not `sandbox`; passwords not the development defaults.
**Back up `RG_PAN_ENCRYPTION_KEY` somewhere safe** (a password manager). Losing it makes stored PANs unreadable.

## 4. Later updates: Jenkins
After the first start, updates are done by a separate Jenkins server: you push to `main`, Jenkins tests, builds the image and restarts this server (no registry login needed, the image is sent over SSH).
Set it up with **docs/JENKINS.md**. This server only needs the deploy key's public half in `~/.ssh/authorized_keys`.

## 5. First start and check
Start it by hand once (`docker compose --env-file ../paymyrent.env -f docker-compose.prod.yml up -d --build`). Then:
```bash
curl https://<API_DOMAIN>/api/v1/health      # {"status":"ok", ...}
ssh ubuntu@161.153.65.47 'cd /opt/paymyrent/app && docker compose --env-file ../paymyrent.env -f docker-compose.prod.yml ps'
```
The first start runs the database migrations and creates the limited `pmr_app` database role by itself.

## 7. Backups
`dbbackups` volume holds a dump every 24 h (14 kept). That is on the same disk, so also copy it off the server, for example weekly:
```bash
docker run --rm -v paymyrent_dbbackups:/b -v "$PWD":/out alpine tar czf /out/db-backups.tgz -C /b .
```
Restore: `docker compose … exec -T db pg_restore -U $DB_USER -d $DB_NAME --clean < paymyrent-YYYYMMDD-HHMM.dump`.
Receipts and statements are in the `apistorage` volume; back that up the same way.

## 8. The mobile app
- Build with `EXPO_PUBLIC_API_URL=https://<API_DOMAIN>` and `EXPO_PUBLIC_AUTH_MODE=firebase`.
- **Demo mode must never run on the internet.** The on-screen OTP `123456` only exists when the API runs as `local`/`test`; anyone could log in as anyone. A server your TestFlight testers reach needs `RG_APP_ENV=production` (or `staging`) with real Firebase phone sign-in. Keep demo accounts for local development with Expo Go.
- iOS needs `GoogleService-Info.plist` from your Firebase project in `mobile/` (git-ignored), and an Apple Developer account for TestFlight and the App Store.

## Still open before real users (docs/DECISIONS.md)
Payment provider with settlement to each owner's own account (D-03), DLT-registered SMS templates, SES/WhatsApp production access, Indian tax and DPDP legal review, native-speaker review of the translations, Firebase abuse limits.
