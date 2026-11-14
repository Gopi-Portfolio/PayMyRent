// Links that open the app but are not screens.
// Phone sign-in on iOS opens a reCAPTCHA page; when it is done it comes back to the app through a link such as
// app-1-<id>-ios-<hash>://firebaseauth/link?... . That link is for the Firebase SDK, which handles it itself. Without this file Expo Router
// also tries to open it as a screen and shows "Unmatched Route". Returning null means "do nothing, stay on the current screen".
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    if (/firebaseauth|deep_link_id|recaptcha|^app-\d+-/i.test(path)) return null;
    if (!initial && /^([a-z][\w.+-]*:)?\/*$/i.test(path)) return null;      // an empty link ("paymyrent:///") while the app is already open
  } catch {
    // fall through to the normal behaviour
  }
  return path;
}
