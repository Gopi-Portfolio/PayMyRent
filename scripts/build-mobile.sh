#!/usr/bin/env bash
# Build the mobile app (mobile/) for the App Store and Google Play. Independent of the backend.
#
#   scripts/build-mobile.sh check            type check, language check and tests only (no build)
#   scripts/build-mobile.sh ios              check, then a production iPhone build with EAS
#   scripts/build-mobile.sh android          check, then a production Android build with EAS
#   scripts/build-mobile.sh all              both
#   add --submit to send the finished build to the store after it is built
#
# Needs: an Expo account (`npx eas login`), and EXPO_PUBLIC_API_URL set to your https API address.
set -euo pipefail
cd "$(dirname "$0")/../mobile"

MODE="${1:-check}"; shift || true
SUBMIT=0; for a in "$@"; do [ "$a" = "--submit" ] && SUBMIT=1; done

echo "== Checks =="
npx tsc --noEmit
node scripts/check-i18n.mjs
DEBUG_PRINT_LIMIT=0 npx jest --forceExit
[ "$MODE" = "check" ] && { echo "Checks passed."; exit 0; }

: "${EXPO_PUBLIC_API_URL:?set EXPO_PUBLIC_API_URL to the https:// address of your API}"
case "$EXPO_PUBLIC_API_URL" in https://*) ;; *) echo "EXPO_PUBLIC_API_URL must start with https://"; exit 1 ;; esac
for f in GoogleService-Info.plist google-services.json; do
  [ -f "$f" ] || echo "Warning: mobile/$f is missing (Firebase sign-in will not work in the build)"
done

case "$MODE" in ios|android|all) PLATFORM="$MODE" ;; *) echo "unknown mode: $MODE"; exit 2 ;; esac
EXTRA=(); [ "$SUBMIT" = 1 ] && EXTRA+=(--auto-submit)
echo "== EAS build: $PLATFORM =="
npx eas build --platform "$PLATFORM" --profile production --non-interactive "${EXTRA[@]}"
