# Two independent builds. See docs/BUILD.md.
.PHONY: backend-test backend-image backend-image-arm64 mobile-check mobile-ios mobile-android
backend-test:         ; scripts/build-backend.sh --test-only
backend-image:        ; scripts/build-backend.sh
backend-image-arm64:  ; scripts/build-backend.sh --arm64
mobile-check:         ; scripts/build-mobile.sh check
mobile-ios:           ; scripts/build-mobile.sh ios
mobile-android:       ; scripts/build-mobile.sh android
