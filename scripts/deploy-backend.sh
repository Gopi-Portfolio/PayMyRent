#!/usr/bin/env bash
# Run on the SERVER (Oracle VM) to update the backend to a new image. Does not touch the mobile app.
#   API_IMAGE=ghcr.io/<owner>/paymyrent-api:<tag> scripts/deploy-backend.sh
#
# Secrets are read from a file that lives ONLY on the server (never in git):
#   DEPLOY_ENV_FILE (default /opt/paymyrent/paymyrent.env) with DB_USER, DB_PASSWORD, APP_DB_PASSWORD, API_DOMAIN, API_ENV_FILE
# See docs/ORACLE_DEPLOYMENT.md.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${API_IMAGE:?set API_IMAGE (the image to run)}"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-/opt/paymyrent/paymyrent.env}"
[ -f "$DEPLOY_ENV_FILE" ] || { echo "Missing $DEPLOY_ENV_FILE (see docs/ORACLE_DEPLOYMENT.md)"; exit 1; }
export API_IMAGE
DC=(docker compose --env-file "$DEPLOY_ENV_FILE" -f docker-compose.prod.yml)

"${DC[@]}" pull api caddy db backup
"${DC[@]}" up -d --no-build --remove-orphans
echo "Waiting for the API to be healthy..."
for i in $(seq 1 30); do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$("${DC[@]}" ps -q api)" 2>/dev/null || echo starting)
  [ "$s" = healthy ] && { echo "Healthy. Migrations ran at start."; docker image prune -f >/dev/null; exit 0; }
  sleep 4
done
echo "The API did not become healthy; see: docker compose -f docker-compose.prod.yml logs api"; exit 1
