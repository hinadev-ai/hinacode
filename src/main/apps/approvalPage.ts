import { createHash } from "node:crypto"
import { APP_ICONS, HERMES_PNG } from "./appIcons.ts"

const COPY = {
  wantsToConnect: (app: string) => `${app} wants to connect to HinaCode`,
  returnsTo: (host: string) => `Sends you back to ${host}`,
  lead: "Approving lets it:",
  grants: [
    "Read your projects and threads",
    "Start agents that run code on this machine",
    "Send messages to threads and stop them",
    "Stay connected until you remove it in HinaCode",
  ],
  signInToApprove: "Sign in to approve",
  orInApp: "Or approve it in HinaCode, under Settings > Connections > Apps.",
  approve: "Approve",
  deny: "Deny",
  signedInAs: "Signed in as",
  yourAccount: "your HinaCode account",
  signInFailedTitle: "Sign-in did not finish",
  notStartedTitle: "Start in HinaCode",
  notStarted: "Open HinaCode, go to Settings > Connections > Apps, choose Copy URL, then connect again.",
  brokenLinkTitle: "This link does not work",
  brokenLink: "The app that sent you here has not registered with this HinaCode, or its link is incomplete.",
}

const REFRESH_SECONDS = 2

const STYLE = `
:root {
  color-scheme: light dark;
  --paper: oklch(0.975 0.007 106.521);
  --surface: oklch(0.99 0.004 106.5);
  --ink: oklch(0.32 0.026 195.945);
  --muted: oklch(0.48 0.022 196);
  --border: oklch(0.905 0.012 106.5);
  --coral: oklch(0.56 0.16 34.263);
  --teal: oklch(0.527 0.085 193.827);
  font-family: "DM Sans", system-ui, sans-serif;
  line-height: 1.5;
  background: var(--paper);
  color: var(--ink);
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: oklch(0.285 0.024 196);
    --surface: oklch(0.32 0.026 195.945);
    --ink: oklch(0.975 0.007 106.521);
    --muted: oklch(0.78 0.014 106.5);
    --border: oklch(0.385 0.028 196);
    --coral: oklch(0.669 0.158 34.263);
    --teal: oklch(0.7 0.09 193.8);
  }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; justify-items: center; align-content: start; padding: 64px 16px 32px; }
main { width: 100%; max-width: 460px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 48px 32px 32px; box-shadow: 0 1px 2px oklch(0 0 0 / 0.04), 0 8px 24px oklch(0 0 0 / 0.06); text-align: center; }
.mark { display: flex; align-items: center; justify-content: center; margin-bottom: 32px; }
.tile { width: 56px; height: 56px; border-radius: 14px; display: grid; place-items: center; flex: none; overflow: hidden; }
.tile svg { width: 100%; height: 100%; }
.brand { border-radius: 12px; box-shadow: 0 0 0 1px var(--border); }
.letter { background: var(--ink); color: var(--paper); font-size: 1.5rem; font-weight: 600; text-transform: uppercase; }
.glyph svg { width: 30px; height: 30px; }
.grok, .chatgpt { background: #000; color: #fff; }
.claude { background: #d97757; color: #fff; }
.hermes { background: #fff url("data:image/png;base64,${HERMES_PNG}") center / cover; }
.wire { width: 56px; height: 2px; margin: 0 8px; position: relative; background-image: linear-gradient(to right, var(--muted) 50%, transparent 0); background-size: 8px 2px; }
.wire::before, .wire::after { content: ""; position: absolute; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.wire::before { left: -4px; }
.wire::after { right: -4px; }
h1 { font-size: 1.375rem; font-weight: 600; line-height: 1.3; margin: 0; text-wrap: balance; overflow-wrap: anywhere; }
.detail { margin: 12px 0 0; color: var(--muted); text-wrap: pretty; overflow-wrap: anywhere; }
.request { margin-top: 32px; text-align: start; }
.lead { margin: 0 0 12px; color: var(--muted); font-size: 0.875rem; }
.grants { list-style: none; margin: 0; padding: 4px 0; border-block: 1px solid var(--border); }
.grants li { display: flex; gap: 12px; align-items: flex-start; padding: 8px 0; }
.grants svg { width: 20px; height: 20px; flex: none; margin-top: 2px; color: var(--coral); }
.actions { display: grid; gap: 8px; margin: 24px 0 0; }
.primary, .ghost { display: block; font: inherit; text-align: center; text-decoration: none; cursor: pointer; border: 0; border-radius: 10px; transition: background-color 150ms ease-out; }
.primary { padding: 12px 16px; background: var(--ink); color: var(--paper); font-weight: 600; }
.primary:hover { background: color-mix(in oklab, var(--ink) 88%, var(--paper)); }
.ghost { padding: 10px 16px; background: transparent; color: var(--ink); }
.ghost:hover { background: color-mix(in oklab, var(--ink) 6%, transparent); }
.primary:focus-visible, .ghost:focus-visible { outline: 2px solid color-mix(in oklab, var(--teal) 60%, transparent); outline-offset: 2px; }
.hint { margin: 12px 0 0; color: var(--muted); font-size: 0.875rem; text-align: center; text-wrap: pretty; }
footer { margin-top: 24px; text-align: center; color: var(--muted); font-size: 0.875rem; overflow-wrap: anywhere; }
footer strong { color: var(--ink); font-weight: 500; }
@media (width < 480px) {
  body { padding-top: 24px; }
  .card { padding: 32px 20px 20px; }
}
@media (prefers-reduced-motion: reduce) {
  .primary, .ghost { transition: none; }
}
`

const HEADERS = {
  "content-security-policy": `default-src 'none'; style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'; img-src data:; base-uri 'none'; frame-ancestors 'none'`,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
}

class Markup {
  readonly html: string
  constructor(html: string) {
    this.html = html
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

const markup = (strings: TemplateStringsArray, ...values: ReadonlyArray<string | Markup | ReadonlyArray<Markup>>) =>
  new Markup(
    strings.reduce((html, part, index) => {
      const value = values[index - 1]!
      const rendered =
        typeof value === "string"
          ? escapeHtml(value)
          : value instanceof Markup
            ? value.html
            : value.map((item) => item.html).join("")
      return html + rendered + part
    }),
  )

const NOTHING = new Markup("")

const HINACODE_MARK = new Markup(
  `<svg viewBox="0 0 256 256" aria-hidden="true"><rect width="256" height="256" rx="56" fill="#F7F7F2"/><g transform="translate(36 36) scale(0.71875)"><path fill="#233737" d="M38 90A32 32 0 0 1 70 58A32 32 0 0 1 97.13 73.04A5 5 0 0 1 95.68 79.84A58 58 0 0 0 99.46 178.49A5 5 0 0 1 102 182.85L102 194A32 32 0 0 1 70 226A32 32 0 0 1 38 194ZM218 166A32 32 0 0 1 186 198A32 32 0 0 1 158.87 182.96A5 5 0 0 1 160.32 176.16A58 58 0 0 0 156.54 77.51A5 5 0 0 1 154 73.15L154 62A32 32 0 0 1 186 30A32 32 0 0 1 218 62Z"/><circle fill="#E56B4F" cx="128" cy="128" r="46"/></g></svg>`,
)

const CHECK = new Markup(
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
)

const brandTile = markup`<span class="tile brand">${HINACODE_MARK}</span>`

const appTile = (appName: string, redirectHost: string) => {
  const icon = APP_ICONS.find(({ matches }) => matches.test(appName) || matches.test(redirectHost))
  if (icon === undefined)
    return markup`<span class="tile letter" aria-hidden="true">${Array.from(appName.trim())[0] ?? "?"}</span>`
  if (icon.paths === undefined) return new Markup(`<span class="tile ${icon.id}" aria-hidden="true"></span>`)
  return new Markup(
    `<span class="tile glyph ${icon.id}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor">${icon.paths
      .map((path) => `<path d="${path}"/>`)
      .join("")}</svg></span>`,
  )
}

const document = (title: string, body: Markup, head = NOTHING) => ({
  headers: HEADERS,
  html: markup`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${head}
<style>${new Markup(STYLE)}</style>
</head>
<body><main>${body}</main></body>
</html>`.html,
})

export type Approver =
  | { readonly signedIn: false; readonly signInPath: string }
  | { readonly signedIn: true; readonly email: string | null; readonly answerPath: string; readonly request: string }

const actions = (approver: Approver) =>
  approver.signedIn
    ? markup`<form class="actions" method="post" action="${approver.answerPath}">
<input type="hidden" name="request" value="${approver.request}">
<button class="primary" name="decision" value="approve">${COPY.approve}</button>
<button class="ghost" name="decision" value="deny">${COPY.deny}</button>
</form>`
    : markup`<div class="actions"><a class="primary" href="${approver.signInPath}">${COPY.signInToApprove}</a></div>
<p class="hint">${COPY.orInApp}</p>`

export const waitingPage = (input: {
  readonly appName: string
  readonly redirectHost: string
  readonly approver: Approver
}) =>
  document(
    COPY.wantsToConnect(input.appName),
    markup`<article class="card">
<div class="mark">${appTile(input.appName, input.redirectHost)}<span class="wire"></span>${brandTile}</div>
<h1>${COPY.wantsToConnect(input.appName)}</h1>
<p class="detail">${COPY.returnsTo(input.redirectHost)}</p>
<section class="request">
<p class="lead">${COPY.lead}</p>
<ul class="grants">${COPY.grants.map((grant) => markup`<li>${CHECK}${grant}</li>`)}</ul>
${actions(input.approver)}
</section>
</article>
${input.approver.signedIn ? markup`<footer>${COPY.signedInAs} <strong>${input.approver.email ?? COPY.yourAccount}</strong></footer>` : NOTHING}`,
    input.approver.signedIn ? NOTHING : markup`<meta http-equiv="refresh" content="${String(REFRESH_SECONDS)}">`,
  )

const notice = (title: string, detail: string) =>
  document(
    title,
    markup`<article class="card"><div class="mark">${brandTile}</div><h1>${title}</h1><p class="detail">${detail}</p></article>`,
  )

export const notStartedPage = () => notice(COPY.notStartedTitle, COPY.notStarted)

export const brokenLinkPage = () => notice(COPY.brokenLinkTitle, COPY.brokenLink)

export const signInFailedPage = (reason: string) => notice(COPY.signInFailedTitle, reason)
