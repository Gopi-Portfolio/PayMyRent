# Build process: backend and mobile app, separately

The backend (`api/`) and the app (`mobile/`) are built, tested and released on their own. A change in one does not rebuild the other.
They meet only over HTTPS: the app calls the address set in `EXPO_PUBLIC_API_URL`.

| | Backend | Mobile app |
|---|---|---|
| Folder | `api/` (+ `jobs/`) | `mobile/` |
| Output | Docker image `paymyrent-api` | iPhone `.ipa` and Android `.aab` |
| Goes to | Your Oracle server | Apple App Store and Google Play |
| Local script | `scripts/build-backend.sh` | `scripts/build-mobile.sh` |
| Automatic (GitHub) | `.github/workflows/backend.yml` | `.github/workflows/mobile.yml` |
| Release | pull the image on the server and restart | `eas build`, then `eas submit`, then store review |

## Backend
```bash
scripts/build-backend.sh --test-only        # tests only (a temporary database starts and is removed)
scripts/build-backend.sh                    # tests, then an image for this machine
scripts/build-backend.sh --arm64 --push     # image for the Oracle ARM server, pushed to the registry
                                            #   (IMAGE=ghcr.io/<you>/paymyrent-api  docker login ghcr.io  first)
```
On the server (`scripts/deploy-backend.sh`), set `API_IMAGE`, pull and restart. Database changes (migrations) run by themselves when the API starts.
`docker-compose.prod.yml` reads the image from `API_IMAGE`.
On GitHub, every change under `api/` runs the tests; on `main` it also builds and pushes `ghcr.io/<owner>/paymyrent-api` for ARM and x86.

## Mobile app
```bash
scripts/build-mobile.sh check               # type check, language check, tests
EXPO_PUBLIC_API_URL=https://api.yourdomain scripts/build-mobile.sh ios        # production iPhone build
EXPO_PUBLIC_API_URL=https://api.yourdomain scripts/build-mobile.sh android    # production Android build
scripts/build-mobile.sh all --submit        # build both and send to the stores
```
Before the first build: `npx eas login`, add `mobile/GoogleService-Info.plist` and `mobile/google-services.json`, and replace the app icon and splash with the new logo.
On GitHub, every change under `mobile/` runs the checks; pushing a tag such as `mobile-v1.0.0` also builds both apps with EAS
(add the `EXPO_TOKEN` secret and the `EXPO_PUBLIC_API_URL` variable in the repository settings).

## Rules that keep the two apart
- The app holds no secrets. Only `EXPO_PUBLIC_*` values go into it, and those are public.
- Keep the backend working with older app versions: people update the app at different times.
- `.env` files, Firebase files and keys stay out of git.
