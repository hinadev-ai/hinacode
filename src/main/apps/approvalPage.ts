import { createHash } from "node:crypto"

const COPY = {
  waitingTitle: "Approve in HinaCode",
  waiting: "HinaCode is asking you to approve this app. This page continues once you do.",
  app: "App",
  returnsTo: "Sends you back to",
  warning: "A connected app can read your threads and start agents that run code on this machine.",
  notStartedTitle: "Start in HinaCode",
  notStarted: "Open HinaCode, go to Settings > Connections > Apps, choose Copy URL, then connect again.",
  brokenLinkTitle: "This link does not work",
  brokenLink: "The app that sent you here has not registered with this HinaCode, or its link is incomplete.",
}

const REFRESH_SECONDS = 2

const STYLE = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { margin: 0; display: grid; min-height: 100dvh; place-items: center; }
main { box-sizing: border-box; width: 100%; max-width: 26rem; padding: 1.5rem; }
h1 { margin: 0 0 1rem; font-size: 1.25rem; }
dl { margin: 0 0 1rem; display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; }
dt { opacity: 0.7; }
dd { margin: 0; overflow-wrap: anywhere; font-weight: 600; }
p { margin: 0 0 1rem; }
`

const HEADERS = {
  "content-security-policy": `default-src 'none'; style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'; base-uri 'none'; frame-ancestors 'none'`,
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

export const waitingPage = (input: { readonly appName: string; readonly redirectHost: string }) =>
  document(
    COPY.waitingTitle,
    markup`<h1>${COPY.waitingTitle}</h1>
<p>${COPY.waiting}</p>
<dl><dt>${COPY.app}</dt><dd>${input.appName}</dd><dt>${COPY.returnsTo}</dt><dd>${input.redirectHost}</dd></dl>
<p>${COPY.warning}</p>`,
    markup`<meta http-equiv="refresh" content="${String(REFRESH_SECONDS)}">`,
  )

export const notStartedPage = () =>
  document(COPY.notStartedTitle, markup`<h1>${COPY.notStartedTitle}</h1><p>${COPY.notStarted}</p>`)

export const brokenLinkPage = () =>
  document(COPY.brokenLinkTitle, markup`<h1>${COPY.brokenLinkTitle}</h1><p>${COPY.brokenLink}</p>`)
