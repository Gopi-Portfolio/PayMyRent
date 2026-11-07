#!/usr/bin/env bash
# Build the backend (api/) as a Docker image. Independent of the mobile app.
#
#   scripts/build-backend.sh                 test, then build for this machine
#   scripts/build-backend.sh --arm64         build for the Oracle ARM server (linux/arm64)
#   scripts/build-backend.sh --push          also push to a registry (set IMAGE=ghcr.io/<you>/paymyrent-api)
#   scripts/build-backend.sh --no-test        skip the tests
#   scripts/build-backend.sh --test-only      run the tests and stop
#
# Environment: IMAGE (default paymyrent-api), VERSION (default: date and time).
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-paymyrent-api}"
VERSION="${VERSION:-$(date +%Y%m%d-%H%M)}"
PLATFORM=""; PUSH=0; TEST=1; TEST_ONLY=0
for a in "$@"; do
  case "$a" in
    --arm64) PLATFORM="linux/arm64" ;;
    --amd64) PLATFORM="linux/amd64" ;;
    --push) PUSH=1 ;;
    --no-test) TEST=0 ;;
    --test-only) TEST_ONLY=1 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

if [ "$TEST" = 1 ]; then
  echo "== Backend tests (database in a temporary container) =="
  NET="pmr-build-$$"
  docker network create "$NET" >/dev/null
  docker run -d --rm --name "pmr-build-db-$$" --network "$NET" -e POSTGRES_USER=pmr -e POSTGRES_PASSWORD=pmr -e POSTGRES_DB=postgres postgres:16 >/dev/null
  trap 'docker rm -f "pmr-build-db-$$" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true' EXIT
  for i in $(seq 1 30); do docker exec "pmr-build-db-$$" pg_isready -U pmr >/dev/null 2>&1 && break; sleep 1; done
  docker build -q -t "$IMAGE:test" api >/dev/null
  docker run --rm --network "$NET" -u root -e RG_TEST_ADMIN_DSN="postgresql://pmr:pmr@pmr-build-db-$$:5432/postgres" "$IMAGE:test" \
    sh -c "pip install -q pytest && python -m pytest tests -q -p no:warnings --deselect tests/integration/test_api_flows.py::test_note_limits"
fi

[ "$TEST_ONLY" = 1 ] && { echo "Tests passed."; exit 0; }

echo "== Building $IMAGE:$VERSION ${PLATFORM:+for $PLATFORM} =="
ARGS=(-t "$IMAGE:$VERSION" -t "$IMAGE:latest")
if docker buildx version >/dev/null 2>&1; then
  [ -n "$PLATFORM" ] && ARGS+=(--platform "$PLATFORM")
  if [ "$PUSH" = 1 ]; then docker buildx build "${ARGS[@]}" --push api; else docker buildx build "${ARGS[@]}" --load api; fi
else
  # No buildx on this machine (for example plain Colima): a normal build for this machine's own architecture.
  if [ -n "$PLATFORM" ] && [ "$PLATFORM" != "linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" ]; then
    echo "Building for $PLATFORM needs docker buildx. Install it, or let GitHub build it (.github/workflows/backend.yml)."; exit 1
  fi
  docker build "${ARGS[@]}" api
  [ "$PUSH" = 1 ] && { docker push "$IMAGE:$VERSION"; docker push "$IMAGE:latest"; }
fi
echo "Done: $IMAGE:$VERSION"
