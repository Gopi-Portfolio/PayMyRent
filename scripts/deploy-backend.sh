#!/usr/bin/env bash
# Run on the SERVER (Oracle VM) to update the backend to a new image. Does not touch the mobile app.
#   API_IMAGE=ghcr.io/<you>/paymyrent-api:20261107-1200 API_ENV_FILE=/secure/paymyrent-api.env DB_USER=... DB_PASSWORD=... APP_DB_PASSWORD=... PROXY_IP=127.0.0.1 \
#     scripts/deploy-backend.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${API_IMAGE:?set API_IMAGE (the image to run)}"
docker compose -f docker-compose.prod.yml pull api || true
docker compose -f docker-compose.prod.yml up -d --no-build
echo "Waiting for the API to be healthy..."
for i in $(seq 1 30); do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose -f docker-compose.prod.yml ps -q api)" 2>/dev/null || echo starting)
  [ "$s" = healthy ] && { echo "Healthy. Migrations ran at start."; exit 0; }
  sleep 4
done
echo "The API did not become healthy; see: docker compose -f docker-compose.prod.yml logs api"; exit 1
