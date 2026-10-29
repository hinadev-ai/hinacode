# Universal links: one link opens the phone on a machine or a thread

Status: Building
Date: 2026-10-28

## Problem

`hinacode://connect?...` opens the app, but nothing reads the link: the connect screen ignores it, and a paired phone cannot reach that screen at all. A custom scheme also does nothing when the phone's camera scans it without the app installed, and a notification tap has its own routing path apart from links. There is no way to send someone "open this thread on your phone".

## User flow

1. The desktop's pairing QR code is `https://relay.hinacode.app/connect#host=...&port=...&token=...`. The system camera opens HinaCode on the add-machine form, filled in. The developer taps Connect. Without the app, the link opens a page in the browser that says to install HinaCode.
2. `https://relay.hinacode.app/t/<environmentId>/<threadId>` opens that thread on a phone paired with that machine, and the thread list on a phone that is not.
3. A push or a local notification opens the thread through the same link.

## Design

### The link contract

`src/shared/links.ts` is the one place that writes and reads links, for the desktop's QR code, the daemon's printed URL, the phone's scanner and paste field, incoming universal links and notification taps.

```ts
export const LINK_ORIGIN = "https://relay.hinacode.app"

export type AppLink =
  | { readonly type: "connect"; readonly target: PairingTarget }
  | { readonly type: "thread"; readonly environmentId: string; readonly threadId: string }

connectLink(target: PairingTarget): string  // LINK_ORIGIN/connect#relay=..&host=..&port=..&token=..
threadLink(environmentId: string, threadId: string): string // LINK_ORIGIN/t/<environmentId>/<threadId>
parseAppLink(text: string): AppLink | null  // also reads the older hinacode://connect?... links
```

The pairing token sits in the fragment. Browsers and the OS never send a fragment to the server, so it never reaches the relay's logs or Cloudflare's. The thread link's ids are not secrets: they only work on a phone already paired with that machine. `parsePairingUrl` keeps accepting `hinacode://connect?...` and also accepts the https form, so the desktop's paste field and old QR codes keep working.

### Phone

`apps/mobile/src/app/+native-intent.tsx` is expo-router's hook for every incoming URL. It calls `routeForLink(url)` in `apps/mobile/src/lib/links.ts`:

- `connect` goes to `/connect?pairing=...` while nothing is paired, and to `/server/new?pairing=...` otherwise. The pairing form starts filled in. It never connects without a tap, so a link from a stranger cannot quietly pair the phone with their machine.
- `thread` goes to `/thread/<threadId>`. A machine this phone has not paired goes to `/` instead.
- Anything else goes to `/`.

A notification tap builds `threadLink(environmentId, threadId)` from its data and calls the same `routeForLink`, so links and notifications share one path.

### Relay

The relay owns `relay.hinacode.app`, so it serves the association files and the fallback page:

| Path                                              | Serves                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /.well-known/apple-app-site-association`     | `applinks` for `APPLE_APP_ID`, components `/t/*` and `/connect`. 404 if unset.   |
| `GET /.well-known/assetlinks.json`                | `handle_all_urls` for `ANDROID_PACKAGE` and `ANDROID_CERT_SHA256`. 404 if unset. |
| `GET /connect`, `GET /t/:environmentId/:threadId` | A static page: open this on a phone with HinaCode installed.                     |

### Config the developer fills in

| Value                 | Where                         | What it is                                                                                                                                                           |
| --------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_APP_ID`        | `relay/wrangler.jsonc` `vars` | `<Team ID>.com.hinadev.hinacode`. The Team ID is on developer.apple.com > Membership.                                                                                |
| `ANDROID_CERT_SHA256` | `relay/wrangler.jsonc` `vars` | The release signing certificate's SHA-256, colon-separated, comma between several. Play Console > App integrity, or `keytool -list -v -keystore <release.keystore>`. |
| `ANDROID_PACKAGE`     | `relay/wrangler.jsonc` `vars` | `com.hinadev.hinacode`, the `android.package` in `apps/mobile/app.json`.                                                                                             |

`app.json` gets `ios.bundleIdentifier` `com.hinadev.hinacode`, `ios.associatedDomains` `applinks:relay.hinacode.app`, and an `android.intentFilters` entry with `autoVerify` for `https://relay.hinacode.app` paths `/connect` and `/t/`.

## Out of scope

- A desktop "Open on phone" button. The contract is ready for it, but no UI asks for it yet.
- Links to a project, a file or a pull request.
- A relay other than `relay.hinacode.app`. The associated domain is baked into the app.

## Verification

- `src/shared/links.test.ts`: both link shapes round-trip, the token stays in the fragment, old `hinacode://` links still parse, and malformed ones do not.
- `relay/test/app.test.ts`: both association files have the exact shape the platforms expect, and answer 404 while their config is unset.
- On the Android emulator, a release build with the domain approved by `pm set-app-links`: `adb shell am start -a android.intent.action.VIEW -d <link>` opens the add-machine form filled in, and a thread link opens the thread. Domain verification itself needs the deployed relay and the real certificate.
- iOS needs a signed build with the associated domains entitlement, so it is not verified here.
