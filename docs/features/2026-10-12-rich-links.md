# Rich links in messages

Status: Building
Date: 2026-10-12

## Problem

Agents and users paste links all the time: Linear issues, docs, preview deploys. In a message they show as raw URLs, and in user messages they are not even clickable. Telling a Linear link from a Vercel preview means reading the whole URL. Pull requests are worse: `#42` is plain text, and checking whether a referenced PR is merged or green means leaving hinacode.

## User flow

1. The user sends `look at https://linear.app/` or the agent writes a URL in its reply.
2. The message shows `[favicon] https://linear.app` as a link. A muted globe holds the icon's place until the favicon arrives, or for good when the site has none, so the text never shifts.
3. Clicking it, or focusing it with Tab and pressing Enter, opens the system browser.
4. A pull request URL shows as `[GitHub mark] owner/repo#42`, or `#42` in the thread's own repository. A bare `#42` in prose links to pull request 42 of the project's GitHub repository.
5. Hovering a pull request link for a moment, or tabbing to it, opens a card: `owner/repo #42`, the title, state, checks and review, `author · head → base`, and `+additions −deletions`. Moving away or pressing Escape closes it.

## Design

- **Main**: `services/Favicons.ts` exposes `favicon(url)`, returning a `data:image/...` URL or null and never failing. It only accepts `http:` and `https:` URLs and works per host: it GETs the origin's `/`, takes the first `<link rel="icon" | "shortcut icon" | "apple-touch-icon">`, and falls back to `/favicon.ico`. Requests use global `fetch` with no cookies or credentials.
- **Limits**: favicons come from sites nobody vetted, so every limit is a named constant at the top of `Favicons.ts`.
  - `REQUEST_TIMEOUT_MS` (5 s per GET) and `LOOKUP_TIMEOUT_MS` (8 s for a host's page, icon and redirects together) keep a site that answers slowly or never from holding a lookup, and a permit, forever.
  - `MAX_REDIRECTS` (3, each to http(s) only, followed by hand) stops redirect loops and keeps a redirect from reaching `file:` or another scheme.
  - `PAGE_LIMIT_BYTES` (512 KB, the rest of the page is ignored) and `ICON_LIMIT_BYTES` (100 KB, a larger icon is refused) bound memory. Reading stops as soon as a body passes its cap, so an endless body costs no more than a full one.
  - The icon is accepted by its bytes: PNG, ICO, GIF, JPEG and WebP by magic bytes, and SVG only when it is text whose root element is `<svg>`. The data URL's MIME comes from that sniffed type, never from the response header, so a site cannot pass HTML or script off as an image.
  - `MAX_CONCURRENT_LOOKUPS` (4) caps network use across the app, however many messages ask at once.
  - `CACHE_CAPACITY` (500 hosts, oldest evicted first) bounds memory over a long session. The cache and the in-flight dedupe are keyed by lowercased hostname with the port ignored, so http and https, every port and every path on a host share one lookup and one result, misses included.
  - The renderer asks for at most `FAVICONS_PER_MESSAGE` (20) distinct origins per message, in reading order (`faviconOrigins` in `lib/linkify.ts`, passed through the `FaviconOrigins` context). Later links still render as links with the globe and never call `links.favicon`, so one pasted list of links cannot start hundreds of lookups.
- **rpc**: `links.favicon({ url }) -> string | null`.
- **Renderer**: `faviconAtom(origin)` in `lib/rpc.ts`, kept alive. `WebLink` renders the 14 px icon before the link text and drops the trailing `/` of a bare URL. Markdown's `a` uses it for every http(s) href. User messages go through `lib/linkify.ts`, which splits text into text and URL segments and trims trailing punctuation the way GFM autolinks do.
- **Pull requests** (branch 2): `lib/pullRequestRefs.ts` holds the pure matcher. `parsePullRequestUrl` reads `https://github.com/<owner>/<repo>/pull/<n>` with any trailing path or fragment, and `linkPullRequestNumbers` finds a bare `#n` after the start, whitespace or `(` and not followed by a word character. `rpc github.repository({ projectId })` runs `git remote get-url origin` in the project root through `GitHub.repository` and parses it with `parseGitHubRepository`, null when there is no GitHub origin. `ThreadView` loads it with `repositoryAtom(projectId)` and provides it through the `ThreadRepository` context. Markdown adds `remarkPullRequests`, which rewrites mdast `text` nodes only, so inline code, code blocks and existing links stay as they are; user text uses `linkify(text, repository)`. Without a GitHub origin, `#n` stays text. `WebLink` hands pull request URLs to `PullRequestLink`, which shows `RiGithubFill` instead of fetching github.com's favicon and opens a Base UI preview card (`ui/hover-card.tsx`) on hover or focus. The card loads `github.pullRequest` only when it opens, through the existing `pullRequestStatusAtom`, and `PullRequest` now carries `author`, `headRefName`, `baseRefName`, `additions` and `deletions` from `gh pr view`.
- **Trust boundary**: favicons arrive as data URLs, so the renderer CSP (`img-src 'self' data: hinacode-attachment:`) stays as it is and the renderer never contacts a site. Main only ever GETs an origin root and an icon, never the linked path or query, so a secret in a URL never leaves the app. A site does learn that the user's machine looked at it, the same as any browser preview. For a single-user local app showing links the user or their own agent wrote, that is acceptable, and it is less than clicking the link would reveal.

## Out of scope

- Previews for anything but GitHub pull requests. A favicon is enough to tell other sites apart at a glance.
- Issues, commits and `owner/repo#n` typed as text. Only pull request URLs and bare `#n` are recognized.
- Persisting favicons across restarts. A lookup costs two small requests per host per session.
- Links in tool output and diffs, which render as code.

## Verification

- `services/Favicons.integration.test.ts` runs a real HTTP server on 127.0.0.1: link-tag icon, relative href, `/favicon.ico` fallback, sniffed types and SVG roots, oversized and endless icons, redirect limits and schemes, the 8 s deadline, non-http URLs, and one lookup per host.
- `lib/linkify.test.ts` covers URL boundaries, trailing punctuation and the 20-site budget per message.
- `services/GitHub.integration.test.ts` reads origins from real temp repos; `lib/pullRequestRefs.test.ts` and `lib/remarkPullRequests.test.ts` cover the reference boundaries and that code and links are left alone.
- With `verify-hinacode`, in a project cloned from GitHub, send `#1 and https://github.com/hinadev-ai/hinacode/pull/1`, hover each link and tab to it, and screenshot the card while loading, loaded, and with `gh` signed out.
- With `verify-hinacode`, send `https://linear.app/ and https://github.com` in a thread and screenshot the message, with the network on and off.
