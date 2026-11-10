import { createHash } from "node:crypto"

const COPY = {
  title: "Connect an app to HinaCode",
  app: "App",
  returnsTo: "Sends you back to",
  warning:
    "A connected app can read your threads and start agents that run code on this machine. Approve only an app you are adding yourself.",
  code: "Approval code from HinaCode, Settings > Connections > Apps",
  approve: "Approve",
  deny: "Deny",
  wrongCode: "That code is not right. Check it and try again.",
  noCode: "No approval code is live. Make a new one in HinaCode, then enter it here.",
  brokenLinkTitle: "This link does not work",
  brokenLink: "The app that sent you here has not registered with this HinaCode, or its link is incomplete.",
}

const STYLE = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { margin: 0; display: grid; min-height: 100dvh; place-items: center; }
main { box-sizing: border-box; width: 100%; max-width: 26rem; padding: 1.5rem; }
h1 { margin: 0 0 1rem; font-size: 1.25rem; }
dl { margin: 0 0 1rem; display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; }
dt { opacity: 0.7; }
dd { margin: 0; overflow-wrap: anywhere; font-weight: 600; }
label { display: block; margin: 1rem 0 0.25rem; }
input { box-sizing: border-box; width: 100%; padding: 0.5rem; font: 1.25rem ui-monospace, monospace; letter-spacing: 0.15em; text-transform: uppercase; }
.error { margin: 0.5rem 0 0; color: #c62828; }
.actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
button { flex: 1; padding: 0.5rem; font: inherit; }
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

const document = (title: string, body: Markup) => ({
  headers: HEADERS,
  html: markup`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${new Markup(STYLE)}</style>
</head>
<body><main>${body}</main></body>
</html>`.html,
})

export const approvalPage = (input: {
  readonly appName: string
  readonly redirectHost: string
  readonly action: string
  readonly fields: Readonly<Record<string, string | undefined>>
  readonly problem?: "wrongCode" | "noCode"
}) =>
  document(
    COPY.title,
    markup`<h1>${COPY.title}</h1>
<dl><dt>${COPY.app}</dt><dd>${input.appName}</dd><dt>${COPY.returnsTo}</dt><dd>${input.redirectHost}</dd></dl>
<p>${COPY.warning}</p>
<form method="post" action="${input.action}">
${Object.entries(input.fields).flatMap(([name, value]) =>
  value === undefined ? [] : [markup`<input type="hidden" name="${name}" value="${value}">`],
)}
<label for="approval_code">${COPY.code}</label>
<input id="approval_code" name="approval_code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" autofocus>
${input.problem === undefined ? NOTHING : markup`<p class="error" role="alert">${COPY[input.problem]}</p>`}
<div class="actions">
<button name="decision" value="approve">${COPY.approve}</button>
<button name="decision" value="deny">${COPY.deny}</button>
</div>
</form>`,
  )

export const brokenLinkPage = () =>
  document(COPY.brokenLinkTitle, markup`<h1>${COPY.brokenLinkTitle}</h1><p>${COPY.brokenLink}</p>`)
