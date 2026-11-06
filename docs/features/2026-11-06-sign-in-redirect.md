# Sign in by redirecting back to the app

Status: Building
Date: 2026-11-06

## Problem

Signing in on the desktop or the phone opened `relay.hinacode.app/link`, asked the person to sign in there, then asked them to approve `Sign in to HinaCode on <name>?`, while the app polled `/v1/links/claim` every five seconds. The approval click is the device authorization flow's defence against a phished link, and it is the part people notice. The app also only learns about the approval on its next poll.

## User flow

1. The person clicks **Sign in** in the desktop account menu or Settings, or taps it on the phone.
2. The browser opens on the relay's sign-in page. With a session already in that browser, it returns at once. Otherwise they sign in with Google or GitHub.
3. The browser hands the person back to HinaCode, which is signed in.

On the phone the browser is the system auth sheet, which closes itself on the redirect. On the desktop the loopback listener redirects the tab to the relay's `/signed-in` page, which says to return to HinaCode, and HinaCode comes to the front.

## Design

OAuth authorization code with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), with the relay as the authorization server and Clerk behind it. The redirect delivers the code to the device that started the sign-in, so a link sent to someone else delivers its code to their device, where no sign-in is waiting. That replaces the approval click.

- **Desktop** redirects to a loopback listener, `http://127.0.0.1:<port>/callback`, opened for one sign-in ([RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3)). A `hinacode://` scheme would need registering with the OS, does not work in dev on Linux, and two instances on one machine would race for it.
- **Phone** redirects to `hinacode://signed-in` through `expo-web-browser`'s `openAuthSessionAsync`, which uses `ASWebAuthenticationSession` on iOS and Custom Tabs on Android.

```
app                               browser                          relay
 │ verifier = 32 random bytes
 │ open /sign-in?redirect_uri&code_challenge&name ─▶ Clerk sign-in if needed
 │                                   │ POST /v1/sign-in-codes (Clerk session) ─▶ store code
 │                                   │ ◀─ { redirectUrl: redirect_uri?code=… }
 │ ◀── redirect_uri?code=… ──────────┘
 │ POST /v1/sign-in-codes/exchange { code, codeVerifier } ─────────────────────▶ device row
 │ ◀── { credential } ─────────────────────────────────────────────────────────┘
```

### Data shape

```sql
-- relay/migrations/0005_sign_in_code.sql
CREATE TABLE sign_in_code (
  code_hash TEXT PRIMARY KEY,     -- sha256 hex of the code in the redirect
  code_challenge TEXT NOT NULL,   -- base64url sha256 of the verifier only the app holds
  user_id TEXT NOT NULL,          -- the Clerk user who signed in
  name TEXT NOT NULL,             -- the device name, kept on the device row
  expires_at INTEGER NOT NULL     -- 2 minutes after the redirect
);
```

| Method and path                   | Caller             | Does                                                                                       |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `GET /sign-in`                    | browser            | The page. Signs in with Clerk, then posts the code request and follows `redirectUrl`       |
| `POST /v1/sign-in-codes`          | page, Clerk bearer | `{ redirectUri, codeChallenge, name }` → `{ redirectUrl }`. A device credential is refused |
| `POST /v1/sign-in-codes/exchange` | app                | `{ code, codeVerifier }` → `{ credential }` once. A wrong verifier spends the code         |
| `GET /signed-in`                  | browser            | Says to return to HinaCode. The desktop's loopback listener redirects the tab here         |

- `redirectUri` is `http://127.0.0.1:<port>/<path>` or `hinacode://<path>`, with no query or fragment. Anything else is refused, because the code is only safe on the device that holds the verifier.
- `codeChallenge` is S256: base64url of SHA-256 of the verifier, 43 characters.
- The exchange deletes the row before it checks the verifier, so a code is spent on its first use either way.
- The old `POST /v1/sign-ins` and the approval on `/link` stay for released apps and the web app. `hinacode serve` keeps linking machines through `/link`, because a headless machine has no browser to redirect to.

### Avatar

`GET /v1/account` also returns `imageUrl`, the Clerk avatar, or null when the account has only Clerk's generated one. The desktop downloads it in the main process and hands the renderer a `data:` URL in `RelayAccountStatus.avatar`, because the renderer's CSP allows no remote images. It downloads again only when the URL changes, and refuses anything that is not an https image under 256 KB. The web app and the phone load the URL directly. The account menu and the phone's Relay settings show it, and fall back to the initial or the name.

## Out of scope

- Sending the person straight to Google or GitHub, skipping Clerk's chooser. One click, and the chooser also offers email.
- Moving the web app to the redirect. It can redirect to its own origin later.
- Registering `hinacode://` on the desktop.

## Verification

- `relay/test/app.test.ts`: a code needs a Clerk session, refuses other redirect targets, exchanges once, refuses a wrong verifier and an expired code.
- `src/main/services/RelayAccount.integration.test.ts`: signing in against a stand-in relay follows the redirect to the loopback listener and stores the credential.
- `apps/mobile/src/lib/relay-account.test.ts`: the callback URL parses into a code, and the exchange stores the account.
- By hand: an isolated HinaCode signs in against `wrangler dev` and a Clerk development instance.
