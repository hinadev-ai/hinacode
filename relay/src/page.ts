const linkScript = `
const code = new URLSearchParams(location.search).get("code")
const $ = (id) => document.getElementById(id)
const say = (id, text) => { $(id).textContent = text }
const reveal = (id, visible) => { $(id).hidden = !visible }

const GRANTS = {
  machine: [
    "Get its own private tunnel through the relay",
    "Show up on the phones and browsers signed in to this account",
    "Let those devices open its threads and run its agents",
  ],
  device: [
    "See the machines linked to this account",
    "Open their threads and run their agents",
    "Link, hide and remove machines",
    "Stay signed in until you sign it out",
  ],
}

async function api(method, path) {
  const token = await Clerk.session.getToken()
  const response = await fetch(path, { method, headers: { Authorization: "Bearer " + token } })
  const answer = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(answer && answer.error ? answer.error : "The relay answered HTTP " + response.status + ".")
  return answer
}

function show({ title, detail = "", peer = null, state = "idle", request = false }) {
  say("title", title)
  say("detail", detail)
  reveal("detail", detail !== "")
  reveal("peer", peer !== null)
  if (peer) say("peer-initial", Array.from(peer.trim())[0] ?? "?")
  $("card").dataset.state = state
  $("card").removeAttribute("aria-busy")
  reveal("request", request)
}

function showRequest(link) {
  const device = link.kind === "device"
  show({
    title: link.name + (device ? " wants to sign in to your HinaCode account" : " wants to link to your HinaCode account"),
    peer: link.name,
    state: "pending",
    request: true,
  })
  $("grants").replaceChildren(
    ...GRANTS[link.kind].map((grant) => {
      const item = $("grant").content.firstElementChild.cloneNode(true)
      item.append(grant)
      return item
    }),
  )
  const path = "/v1/links/" + encodeURIComponent(code)
  const decide = async (button, pendingLabel, method, done) => {
    const label = button.textContent
    $("approve").disabled = $("deny").disabled = true
    reveal("request-error", false)
    button.textContent = pendingLabel
    try {
      await api(method, path)
      done()
    } catch (error) {
      say("request-error", error.message)
      reveal("request-error", true)
    } finally {
      button.textContent = label
      $("approve").disabled = $("deny").disabled = false
    }
  }
  $("approve").onclick = () =>
    decide($("approve"), "Approving…", "POST", () =>
      show({
        title: device ? link.name + " is signed in" : link.name + " is linked",
        detail: "You can close this tab. HinaCode connects on its own.",
        peer: link.name,
        state: "linked",
      }),
    )
  $("deny").onclick = () =>
    decide($("deny"), "Denying…", "DELETE", () =>
      show({
        title: device ? link.name + " was not signed in" : link.name + " was not linked",
        detail: "You can close this tab.",
        peer: link.name,
        state: "denied",
      }),
    )
}

async function loadRequest() {
  if (!code) {
    return show({ title: "Nothing to approve", detail: "Start linking in HinaCode, and it opens this page for you." })
  }
  try {
    showRequest(await api("GET", "/v1/links/" + encodeURIComponent(code)))
  } catch (error) {
    show({ title: "This request can't be approved", detail: error.message })
  }
}

async function signOutDevices() {
  if (!confirm("Sign out every desktop and phone on this account?")) return
  $("sign-out-devices").disabled = true
  try {
    await api("DELETE", "/v1/devices")
    say("devices-status", "Every device is signed out.")
  } catch (error) {
    say("devices-status", error.message)
  } finally {
    $("sign-out-devices").disabled = false
  }
}

function showAccount() {
  say("email", Clerk.user?.primaryEmailAddress?.emailAddress ?? "your account")
  reveal("account", true)
  $("sign-out-devices").onclick = signOutDevices
  $("switch-account").onclick = async () => {
    await Clerk.signOut()
    location.reload()
  }
}

window.addEventListener("load", async () => {
  await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } })
  if (Clerk.isSignedIn) {
    showAccount()
    return loadRequest()
  }
  show({ title: "Sign in to HinaCode" })
  mountSignIn()
})
`

const style = `
:root {
  color-scheme: light dark;
  --paper: oklch(0.975 0.007 106.521);
  --surface: oklch(0.99 0.004 106.5);
  --ink: oklch(0.32 0.026 195.945);
  --muted: oklch(0.48 0.022 196);
  --border: oklch(0.905 0.012 106.5);
  --coral: oklch(0.56 0.16 34.263);
  --teal: oklch(0.527 0.085 193.827);
  --danger: oklch(0.52 0.19 18);
  --ring: oklch(0.24 0.04 194);
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
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
    --danger: oklch(0.78 0.13 8);
    --ring: oklch(0.91 0.07 194);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; min-height: 100dvh; display: grid; grid-template-rows: 1fr auto; justify-items: center; padding: 64px 16px 32px; gap: 32px; }
main { width: 100%; max-width: 460px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 48px 32px 32px; box-shadow: 0 1px 2px oklch(0 0 0 / 0.04), 0 8px 24px oklch(0 0 0 / 0.06); text-align: center; }
.card[aria-busy="true"] > :not(.mark) { visibility: hidden; }
.mark { display: flex; align-items: center; justify-content: center; margin-bottom: 32px; }
.tile { width: 56px; height: 56px; border-radius: 14px; display: grid; place-items: center; flex: none; }
.tile svg { width: 100%; height: 100%; }
.brand-tile { border-radius: 12px; box-shadow: 0 0 0 1px var(--border); }
.peer { display: contents; }
.peer-tile { background: var(--ink); color: var(--paper); font-size: 1.5rem; font-weight: 600; text-transform: uppercase; }
.wire { width: 56px; height: 2px; margin: 0 8px; position: relative; background-image: linear-gradient(to right, var(--muted) 50%, transparent 0); background-size: 8px 2px; }
.wire::after { content: ""; position: absolute; inset: 0; background: var(--teal); transform: scaleX(0); transform-origin: left; transition: transform 400ms var(--ease-out); }
.wire::before, .wire i { content: ""; position: absolute; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); transition: background-color 200ms var(--ease-out); }
.wire::before { left: -4px; }
.wire i { right: -4px; }
[data-state="linked"] .wire::after { transform: scaleX(1); }
[data-state="linked"] .wire::before, [data-state="linked"] .wire i { background: var(--teal); }
[data-state="linked"] .wire i { transition-delay: 350ms; }
[data-state="denied"] .wire { opacity: 0.4; }
h1 { font-size: 1.375rem; font-weight: 600; line-height: 1.3; margin: 0; text-wrap: balance; overflow-wrap: anywhere; }
.detail { margin: 12px 0 0; color: var(--muted); text-wrap: pretty; overflow-wrap: anywhere; }
.request { margin-top: 32px; text-align: start; }
.lead { margin: 0 0 12px; color: var(--muted); font-size: 0.875rem; }
.grants { list-style: none; margin: 0; padding: 4px 0; border-block: 1px solid var(--border); }
.grants li { display: flex; gap: 12px; align-items: flex-start; padding: 8px 0; }
.grants svg { width: 20px; height: 20px; flex: none; margin-top: 2px; color: var(--coral); }
.error { margin: 16px 0 0; color: var(--danger); font-size: 0.875rem; overflow-wrap: anywhere; }
.actions { display: grid; gap: 8px; margin-top: 24px; }
button { font: inherit; cursor: pointer; border-radius: 10px; border: 0; transition: background-color 150ms var(--ease-out), color 150ms var(--ease-out); }
button:focus-visible { outline: 2px solid color-mix(in oklab, var(--ring) 50%, transparent); outline-offset: 2px; }
button:disabled { cursor: default; }
.primary { padding: 12px 16px; background: var(--ink); color: var(--paper); font-weight: 600; }
.primary:hover:not(:disabled) { background: color-mix(in oklab, var(--ink) 88%, var(--paper)); }
.ghost { padding: 10px 16px; background: transparent; color: var(--ink); }
.ghost:hover:not(:disabled) { background: color-mix(in oklab, var(--ink) 6%, transparent); }
button:disabled { color: var(--muted); }
.primary:disabled { background: color-mix(in oklab, var(--ink) 20%, var(--surface)); }
footer { text-align: center; color: var(--muted); font-size: 0.875rem; display: grid; gap: 4px; justify-items: center; }
footer p { margin: 0; overflow-wrap: anywhere; }
footer strong { color: var(--ink); font-weight: 500; }
.links { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }
.link { padding: 4px 2px; background: none; color: var(--ink); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in oklab, var(--ink) 35%, transparent); border-radius: 4px; }
.link:hover:not(:disabled) { text-decoration-color: currentColor; }
#sign-in { margin-top: 32px; text-align: start; }
@media (width < 480px) {
  body { padding-top: 24px; }
  .card { padding: 32px 20px 20px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0ms !important; transition-delay: 0ms !important; }
}
`

const mark = `<svg viewBox="0 0 256 256" aria-hidden="true"><rect width="256" height="256" rx="56" fill="#F7F7F2"/><g transform="translate(36 36) scale(0.71875)"><path fill="#233737" d="M38 90A32 32 0 0 1 70 58A32 32 0 0 1 97.13 73.04A5 5 0 0 1 95.68 79.84A58 58 0 0 0 99.46 178.49A5 5 0 0 1 102 182.85L102 194A32 32 0 0 1 70 226A32 32 0 0 1 38 194ZM218 166A32 32 0 0 1 186 198A32 32 0 0 1 158.87 182.96A5 5 0 0 1 160.32 176.16A58 58 0 0 0 156.54 77.51A5 5 0 0 1 154 73.15L154 62A32 32 0 0 1 186 30A32 32 0 0 1 218 62Z"/><circle fill="#E56B4F" cx="128" cy="128" r="46"/></g></svg>`

const check = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`

const signInScript = `
const $ = (id) => document.getElementById(id)

async function returnToApp() {
  $("detail").textContent = "Returning to HinaCode."
  $("detail").hidden = false
  const query = new URLSearchParams(location.search)
  try {
    const response = await fetch("/v1/sign-in-codes", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await Clerk.session.getToken()), "Content-Type": "application/json" },
      body: JSON.stringify({
        redirectUri: query.get("redirect_uri"),
        codeChallenge: query.get("code_challenge"),
        name: query.get("name"),
      }),
    })
    const answer = await response.json().catch(() => null)
    if (!response.ok) throw new Error(answer && answer.error ? answer.error : "The relay answered HTTP " + response.status + ".")
    location.replace(answer.redirectUrl)
  } catch (error) {
    $("title").textContent = "Couldn't return to HinaCode"
    $("detail").textContent = error.message
  }
}

window.addEventListener("load", async () => {
  await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } })
  $("card").removeAttribute("aria-busy")
  if (Clerk.isSignedIn) return returnToApp()
  mountSignIn()
})
`

const mountSignInScript = `
const SIGN_IN_COLORS = matchMedia("(prefers-color-scheme: dark)").matches
  ? { primary: "#F7F7F2", onPrimary: "#233737", background: "#233737", text: "#F7F7F2", muted: "#BDBDB4", input: "#1B2E2E", border: "#34494A" }
  : { primary: "#233737", onPrimary: "#F7F7F2", background: "#FCFCFA", text: "#233737", muted: "#4F6262", input: "#FFFFFF", border: "#E2E3DC" }

function mountSignIn() {
  const colors = SIGN_IN_COLORS
  const target = document.getElementById("sign-in")
  target.hidden = false
  Clerk.mountSignIn(target, {
    forceRedirectUrl: location.href,
    signUpForceRedirectUrl: location.href,
    appearance: {
      variables: {
        colorPrimary: colors.primary,
        colorPrimaryForeground: colors.onPrimary,
        colorBackground: colors.background,
        colorForeground: colors.text,
        colorMutedForeground: colors.muted,
        colorInput: colors.input,
        colorInputForeground: colors.text,
        colorNeutral: colors.text,
        colorBorder: colors.border,
        fontFamily: "inherit",
        borderRadius: "10px",
      },
      elements: {
        rootBox: { width: "100%" },
        cardBox: { width: "100%", maxWidth: "none", boxShadow: "none", border: "none", borderRadius: "0", background: "transparent" },
        card: { boxShadow: "none", border: "none", background: "transparent", padding: "0" },
        header: { display: "none" },
        footer: { background: "transparent" },
        socialButtonsBlockButton: { height: "44px", boxShadow: "none", border: "1px solid " + colors.border, background: colors.input },
        socialButtonsBlockButtonText: { color: colors.text, fontWeight: "500", fontSize: "0.9375rem" },
      },
    },
  })
}
`

const clerkFrontendHost = (publishableKey: string) => atob(publishableKey.split("_")[2] ?? "").replace(/\$$/, "")

interface ClerkPage {
  publishableKey: string
  script: string
}

const clerkScripts = ({ publishableKey, script }: ClerkPage) => `
<script defer crossorigin="anonymous" src="https://${clerkFrontendHost(publishableKey)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${publishableKey}" src="https://${clerkFrontendHost(publishableKey)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script>${mountSignInScript}${script}</script>`

const shell = (page: { title: string; main: string; footer?: string; clerk?: ClerkPage }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${page.title}</title>
<style>${style}</style>
</head>
<body>
<main>
${page.main}
</main>
${page.footer ?? ""}${page.clerk ? clerkScripts(page.clerk) : ""}
</body>
</html>
`

const brandTile = `<span class="tile brand-tile">${mark}</span>`

export const linkPage = (publishableKey: string) =>
  shell({
    title: "Link a machine to HinaCode",
    main: `<article id="card" class="card" aria-busy="true" data-state="idle">
<div class="mark">
<span id="peer" class="peer" hidden><span id="peer-initial" class="tile peer-tile"></span><span class="wire"><i></i></span></span>
${brandTile}
</div>
<h1 id="title" aria-live="polite">Loading</h1>
<p id="detail" class="detail" hidden></p>
<div id="sign-in" hidden></div>
<section id="request" class="request" hidden>
<p class="lead">Approving lets it:</p>
<ul id="grants" class="grants"></ul>
<p id="request-error" class="error" role="alert" hidden></p>
<div class="actions">
<button id="approve" class="primary">Approve</button>
<button id="deny" class="ghost">Deny</button>
</div>
</section>
</article>
<template id="grant"><li>${check}</li></template>`,
    footer: `<footer id="account" hidden>
<p>Signed in as <strong id="email"></strong></p>
<div class="links">
<button id="switch-account" class="link">Switch account</button>
<button id="sign-out-devices" class="link">Sign out all devices</button>
</div>
<p id="devices-status" role="status"></p>
</footer>`,
    clerk: { publishableKey, script: linkScript },
  })

export const signInPage = (publishableKey: string) =>
  shell({
    title: "Sign in to HinaCode",
    main: `<article id="card" class="card" aria-busy="true">
<div class="mark">${brandTile}</div>
<h1 id="title">Sign in to HinaCode</h1>
<p id="detail" class="detail" role="status" hidden></p>
<div id="sign-in" hidden></div>
</article>`,
    clerk: { publishableKey, script: signInScript },
  })

export const signedInPage = () =>
  shell({
    title: "You're signed in",
    main: `<article class="card" data-state="linked">
<div class="mark">${brandTile}</div>
<h1>You're signed in</h1>
<p class="detail">Return to HinaCode. You can close this tab.</p>
</article>`,
  })
