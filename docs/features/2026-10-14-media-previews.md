# Media previews

Status: Shipped
Date: 2026-10-14

## Problem

kkcode is built for private repositories, and their pull request descriptions show nothing but links. GitHub serves `user-attachments` only to a signed-in account, and the renderer has no GitHub session, so every screenshot and before and after video in a PR body was a bare URL. The file explorer had the same gap. Opening an image, a video or an HTML report an agent produced said "This is a binary file" or showed raw markup.

## User flow

1. Open a thread's Pull requests view. Images in the description render inline, and a bare attachment link on its own line plays as a video, as on GitHub.
2. Open an image, SVG, video, audio or HTML file from the Files view. It renders in the file pane.
3. For SVG and HTML, Source switches to the editor and Preview switches back. Edits on disk reload the preview.

## Design

Main serves both kinds of content over two privileged schemes, so no rpc method carries bytes or the token.

- `kkcode-github-asset://asset/<uuid>` takes only an attachment id. Main runs `gh auth token`, asks `github.com/user-attachments/assets/<uuid>` for its redirect, and fetches the short-lived signed URL without the token, passing the Range header so video seeks. `Markdown.tsx` rewrites attachment image URLs to it, and embeds a paragraph that is only a bare attachment link.
- `kkcode-file://root/<encoded root>/<path>` resolves through `Files.resolve`, the same known-root and inside-root check as `fs.read`. The root is one path segment, so an HTML file's relative links resolve to siblings, and a link that climbs out names an unknown root.
- Every `kkcode-file` response carries `Content-Security-Policy: sandbox allow-scripts`. HTML runs its scripts in an opaque origin, without popups, top navigation, storage, cookies, `window.kkcode` or the parent DOM, however it is embedded. `will-frame-navigate` lets a subframe load `kkcode-file` and nothing else, and keeps the top frame on the app.
- Both schemes are registered on the default session only, so in-app browser pages, which run in `persist:browser`, cannot reach them.

## Out of scope

- Other remote images in markdown stay blocked by the renderer CSP, which keeps agent output from loading tracking pixels.
- Raw HTML in markdown, such as `<img>` tags and comments, is not rendered.
- An HTML preview cannot `fetch` its sibling files, since the scheme does not opt into the Fetch API.

## Verification

`security.test.ts` covers the URL parsers and the navigation rule. In the real app, a linked private PR shows its images and plays and seeks its videos. The Files view previews PNG, SVG, MP4, MP3 and an HTML page whose probes confirm the sandbox. Requests that climb out of a root or name an unknown root are refused.
