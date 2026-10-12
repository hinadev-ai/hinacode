# Rich links in messages

Status: Building
Date: 2026-10-12

## Problem

Agents and users paste links all the time: Linear issues, docs, preview deploys. In a message they show as raw URLs, and in user messages they are not even clickable. Telling a Linear link from a Vercel preview means reading the whole URL.

## User flow

1. The user sends `look at https://linear.app/` or the agent writes a URL in its reply.
2. The message shows `[favicon] https://linear.app` as a link. A muted globe holds the icon's place until the favicon arrives, or for good when the site has none, so the text never shifts.
3. Clicking it, or focusing it with Tab and pressing Enter, opens the system browser.

## Design

- **Main**: `services/Favicons.ts` exposes `favicon(url)`, returning a `data:image/...` URL or null and never failing. It only accepts `http:` and `https:` URLs and works per origin: it GETs the origin's `/` (5 s timeout, first 512 KB), takes the first `<link rel="icon" | "shortcut icon" | "apple-touch-icon">`, and falls back to `/favicon.ico`. The icon must be an `image/*` response (or `application/octet-stream` for an `.ico`) under 100 KB. Requests use global `fetch` with no cookies or credentials, and a redirect off http(s) gives null. Results, nulls included, are cached per origin for the app's lifetime, and concurrent lookups for one origin share one request.
- **rpc**: `links.favicon({ url }) -> string | null`.
- **Renderer**: `faviconAtom(origin)` in `lib/rpc.ts`, kept alive. `WebLink` renders the 14 px icon before the link text and drops the trailing `/` of a bare URL. Markdown's `a` uses it for every http(s) href. User messages go through `lib/linkify.ts`, which splits text into text and URL segments and trims trailing punctuation the way GFM autolinks do.
- **Trust boundary**: favicons arrive as data URLs, so the renderer CSP (`img-src 'self' data: kkcode-attachment:`) stays as it is and the renderer never contacts a site. Main only ever GETs an origin root and an icon, never the linked path or query, so a secret in a URL never leaves the app. A site does learn that the user's machine looked at it, the same as any browser preview. For a single-user local app showing links the user or their own agent wrote, that is acceptable, and it is less than clicking the link would reveal.

## Out of scope

- Link previews with titles or images. A favicon is enough to tell sites apart at a glance.
- Persisting favicons across restarts. A lookup costs two small requests per origin per session.
- Links in tool output and diffs, which render as code.

## Verification

- `services/Favicons.integration.test.ts` runs a real HTTP server on 127.0.0.1: link-tag icon, relative href, `/favicon.ico` fallback, non-image and oversized icons, non-http URLs, and one request per origin.
- `lib/linkify.test.ts` covers URL boundaries and trailing punctuation.
- With `verify-kkcode`, send `https://linear.app/ and https://github.com` in a thread and screenshot the message, with the network on and off.
