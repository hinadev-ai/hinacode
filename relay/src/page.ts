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
  const device = link.kind === "device"
  say("link-title", device ? "Sign in to HinaCode on " + link.name + "?" : "Link " + link.name + " to your HinaCode account?")
  say("link-status", "Code " + code + ". Approve only a " + (device ? "device" : "machine") + " you recognise.")
  show("approve", true)
  $("approve").onclick = async () => {
    $("approve").disabled = true
    try {
      await api("POST", "/v1/links/" + encodeURIComponent(code))
      show("approve", false)
      say("link-title", device ? link.name + " is signed in." : link.name + " is linked.")
      say("link-status", "Return to HinaCode. It connects on its own.")
    } catch (error) {
      $("approve").disabled = false
      say("link-status", error.message)
    }
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

function start() {
  say("link-title", "Link a machine")
  show("devices", true)
  $("sign-out-devices").onclick = signOutDevices
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
button { font: inherit; }
button { padding: 8px 16px; border-radius: 8px; border: 0; background: #e8618c; color: white; cursor: pointer; }
button.secondary { background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 4px 12px; }
[hidden] { display: none !important; }
button:disabled { opacity: 0.5; cursor: default; }
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
<section id="devices" hidden>
<p id="devices-status" role="status"></p>
<button id="sign-out-devices" class="secondary">Sign out all devices</button>
</section>
<a id="sign-out" href="#" hidden>Sign out</a>
</main>
<script defer crossorigin="anonymous" src="https://${clerkFrontendHost(publishableKey)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${publishableKey}" src="https://${clerkFrontendHost(publishableKey)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script>${script}</script>
</body>
</html>
`
