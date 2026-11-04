const script = `
const code = new URLSearchParams(location.search).get("code")
const $ = (id) => document.getElementById(id)

const show = (id, visible) => { $(id).hidden = !visible }
const say = (id, text) => { $(id).textContent = text }

async function api(method, path) {
  const token = await Clerk.session.getToken()
  const response = await fetch(path, { method, headers: { Authorization: "Bearer " + token } })
  const answer = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(answer && answer.error ? answer.error : "The relay answered HTTP " + response.status + ".")
  return answer
}

async function renderLink() {
  if (!code) return say("link-status", "Open this page from HinaCode to link a machine.")
  let link
  try {
    link = await api("GET", "/v1/links/" + encodeURIComponent(code))
  } catch (error) {
    return say("link-status", error.message)
  }
  say("link-title", "Link " + link.name + " to your HinaCode account?")
  say("link-status", "Code " + code + ". Approve only a machine you recognise.")
  show("approve", true)
  $("approve").onclick = async () => {
    $("approve").disabled = true
    try {
      await api("POST", "/v1/links/" + encodeURIComponent(code))
      show("approve", false)
      say("link-title", link.name + " is linked.")
      say("link-status", "Return to HinaCode. It connects on its own.")
    } catch (error) {
      $("approve").disabled = false
      say("link-status", error.message)
    }
  }
}

async function rotateToken() {
  if (!confirm("Create a new owner token? Any earlier one stops working on every device.")) return
  $("rotate").disabled = true
  try {
    const { token } = await api("POST", "/v1/account/token")
    $("new-token").value = token
    show("new-token-field", true)
    say("token-status", "This is the new owner token. Save it now; this page will not show it again.")
  } catch (error) {
    say("token-status", error.message)
  } finally {
    $("rotate").disabled = false
  }
}

function start() {
  say("link-title", "Link a machine")
  show("owner-token", true)
  $("rotate").onclick = rotateToken
  $("copy-token").onclick = () => navigator.clipboard.writeText($("new-token").value)
  show("sign-out", true)
  $("sign-out").onclick = async (event) => {
    event.preventDefault()
    await Clerk.signOut()
    location.reload()
  }
  renderLink()
}

window.addEventListener("load", async () => {
  await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } })
  if (Clerk.isSignedIn) return start()
  say("link-title", "Sign in to link a machine")
  show("link-status", false)
  Clerk.mountSignIn($("sign-in"), {
    forceRedirectUrl: location.href,
    signUpForceRedirectUrl: location.href,
  })
})
`

const style = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { margin: 0; display: grid; place-items: start center; padding: 48px 16px; }
main { width: 100%; max-width: 440px; display: grid; gap: 24px; }
h1 { font-size: 1.375rem; margin: 0; text-wrap: balance; }
h2 { font-size: 1rem; margin: 0 0 8px; }
p { margin: 0; color: color-mix(in srgb, currentColor 70%, transparent); }
input, button { font: inherit; }
input { padding: 7px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
button { padding: 8px 16px; border-radius: 8px; border: 0; background: #e8618c; color: white; cursor: pointer; }
button.secondary { background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 4px 12px; }
[hidden] { display: none !important; }
button:disabled { opacity: 0.5; cursor: default; }
.row { display: flex; gap: 8px; margin: 8px 0; }
.row input { flex: 1; min-width: 0; font-family: ui-monospace, monospace; }
#rotate { margin-top: 8px; }
a { color: inherit; font-size: 0.875rem; }
`

const clerkFrontendHost = (publishableKey: string) => atob(publishableKey.split("_")[2] ?? "").replace(/\$$/, "")

export const linkPage = (publishableKey: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Link a machine to HinaCode</title>
<style>${style}</style>
</head>
<body>
<main>
<section>
<h1 id="link-title">Link a machine</h1>
<p id="link-status">Loading.</p>
</section>
<button id="approve" hidden>Approve</button>
<div id="sign-in"></div>
<section id="owner-token" hidden>
<h2>Owner token</h2>
<p id="token-status">HinaCode on your desktop and phone signs in with this.</p>
<div id="new-token-field" class="row" hidden><input id="new-token" readonly aria-label="New owner token"> <button id="copy-token" class="secondary">Copy</button></div>
<button id="rotate" class="secondary">New owner token</button>
</section>
<a id="sign-out" href="#" hidden>Sign out</a>
</main>
<script defer crossorigin="anonymous" src="https://${clerkFrontendHost(publishableKey)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${publishableKey}" src="https://${clerkFrontendHost(publishableKey)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script>${script}</script>
</body>
</html>
`
