# Offline capture and sync

The app keeps working with no network for plain data entry. What the person types is saved on the phone first and sent, by itself, when the
connection is back. This page says how it works, what it does and does not cover, and how it is tested.

## What works offline

| Offline (saved, sent later) | Needs the internet |
|---|---|
| Opening the app as the person signed in last time (the profile is kept on the phone) | Signing in, one-time codes |
| Viewing the screens visited in the last day (a saved copy of what the server sent) | Payments of every kind (recording cash, paying rent, plans), anything that moves money |
| **Add renter** (also for a unit that was itself added offline) | Add property (it is confirmed with a code), owner details, photo ID check |
| **Add unit**, **edit renter details**, **add a charge** | Scanning a photo (ID card, agreement), uploads, Excel import |
| **Notes** (owner and renter), the **profile**, the renter's **message to the owner** | The AI features, translated messages, downloading reports |

Screens that cannot work offline say so at the top (`NeedsInternet`), and the renter's Pay slider switches off.

## How it works

1. **Connection state** (`src/lib/network.ts`): one answer for the whole app, from the phone's own report (NetInfo) and from what happens to requests.
   react-query is told too, so saved screens stay on screen without error banners and refresh by themselves when the connection returns.
   A request that cannot reach the server flips the app to "offline"; a quiet probe every 20 seconds (and the phone's own report) flips it back.
2. **Saved screens** (`src/lib/queryClient.ts`): the react-query cache is written to the phone and kept for a day.
3. **The outbox** (`src/lib/outbox.ts`): a queue of entries on the phone. An entry is written to the phone *before* anything else happens. They are sent
   oldest first, one at a time, each with its own `Idempotency-Key`.
   * no connection -> the entry keeps waiting, nothing is lost;
   * the server says no (a rule was broken, 4xx) -> the entry is marked "needs attention" with the server's reason; the others still go;
   * sign-in expired (401) -> sending stops, everything is kept, the person is asked to sign in again;
   * server busy or unwell (5xx, 429) -> waits with growing pauses (30 s, 1 min, 2 min ... 15 min);
   * an entry that points at something another waiting entry creates (`local-<id>`) is sent after it with the real id filled in;
   * editing the same thing twice offline sends only the last edit (`coalesceKey`);
   * an entry older than 30 days is not sent (the server remembers a key for 35 days); at most 200 entries wait.
4. **`submitOrQueue`** (`src/lib/offline.ts`): what the forms call. Online it sends at once, exactly as before. If the request fails because the server
   could not be reached or did not answer, the entry is saved with the *same* key (the first try may have worked, and the server then does it once).
5. **Safe retries on the server** (`api/app/core/idempotency.py`, table `request_idempotency`): the first time a key is seen the work is done and its
   reply is kept; every repeat of the same key returns that reply and does nothing. Copies arriving together are done one after the other. The same key
   for a *different* request is refused (`IDEMPOTENCY_KEY_REUSED`). Applied to add renter, add unit, edit renter, add charge, notes, profile, renter message.
6. **What the person sees**: a bar under the top bar (offline / sending / needs attention / sign in again), a *Saved Changes* screen (`/sync`) with
   Try Again and Discard, a short "saved on this phone" message, and screens that already show the result (a renter just added makes the unit show as
   rented, "waiting to send", so it cannot be given to a second renter).

## Privacy

Everything kept for offline use (the saved screens, the profile, the waiting entries) is removed on sign-out, and when a *different* person signs in
on the same phone it is removed first. A write that is still in flight at sign-out is waited for, so it cannot bring the old data back.
The data is held in the app's private storage (the operating system's own protection; it is not separately encrypted).
Scanning a photo for a renter's name and mobile (`POST /owner/renter-scan`) reads the photo in memory: the photo and its text are not stored, and no ID
number is returned. Answers about other people (the ID-verified check) are never written to the phone.

## Adding another form

Replace the `api(...)` call with `submitOrQueue({ kind, label, path, method, body, ownerAccount })`, give the server endpoint an `Idempotency-Key` header
parameter wrapped in `idempotent(...)`, add a label text in all languages and, if the form can leave something on screen that should change at once, an
`optimistic` function (see `src/lib/optimistic.ts`). Do not queue anything gated by a one-time code, a payment, a scan or an upload.

## Tests

* `__tests__/outbox.test.ts` the engine, against a fake server that remembers keys and loses replies (26 tests);
* `__tests__/offline-submit.test.ts`, `offline-support.test.tsx`, `offline-ui.test.tsx`, `offline-forms.test.tsx`, `auth-offline.test.tsx`: the glue,
  connection state, banner, Saved Changes screen, Add renter / Add unit with no network, opening the app offline, sign-out;
* `api/tests/integration/test_idempotency.py`: the server side, including six copies at once;
* `mobile/e2e-live/offline-live.test.ts`: the real engine against a real backend (12 scenarios: lost reply, app killed mid-send, two copies at once,
  connection dropping mid-batch, a refusal, expired sign-in, renter side, a batch of 25). `npm run test:offline-live` with `OFFLINE_E2E_URL` set;
  run by `.github/workflows/offline-e2e.yml`.
