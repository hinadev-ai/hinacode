const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** The Clerk Frontend API host a publishable key names: `pk_test_<base64 of "<host>$">`. */
export const frontendApiHost = (publishableKey: string): string | null => {
  const encoded = publishableKey.split("_")[2]
  if (!encoded) return null
  try {
    const decoded = atob(encoded)
    return /^[a-z0-9.-]+\$$/i.test(decoded) ? decoded.slice(0, -1) : null
  } catch {
    return null
  }
}

const script = `
const code = new URLSearchParams(location.search).get("code")
const $ = (id) => document.getElementById(id)

const show = (id, visible) => { $(id).hidden = !visible }
const say = (id, text) => { $(id).textContent = text }

async function api(method, path) {
  const token = await Clerk.session.getToken()
  const response = await fetch(path, { method, headers: { Authorization: "Bearer " + token } })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(body && body.error ? body.error : "The relay answered HTTP " + response.status + ".")
  return body
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
      renderHosts()
    } catch (error) {
      $("approve").disabled = false
      say("link-status", error.message)
    }
  }
}

async function renderHosts() {
  const list = $("hosts")
  let hosts
  try {
    hosts = (await api("GET", "/v1/hosts")).hosts
  } catch (error) {
    return say("hosts-status", error.message)
  }
  list.replaceChildren()
  say("hosts-status", hosts.length === 0 ? "No machines are linked yet." : "")
  for (const host of hosts) {
    const item = document.createElement("li")
    const label = document.createElement("div")
    const name = document.createElement("strong")
    name.textContent = host.name
    const hostname = document.createElement("span")
    hostname.textContent = host.hostname
    label.append(name, hostname)
    const remove = document.createElement("button")
    remove.textContent = "Remove"
    remove.className = "secondary"
    remove.onclick = async () => {
      remove.disabled = true
      try {
        await api("DELETE", "/v1/hosts/" + encodeURIComponent(host.id))
        renderHosts()
      } catch (error) {
        remove.disabled = false
        say("hosts-status", error.message)
      }
    }
    item.append(label, remove)
    list.append(item)
  }
}

addEventListener("load", async () => {
  try {
    await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } })
  } catch {
    return say("link-status", "Cannot load sign-in. Reload the page.")
  }
  if (!Clerk.user) {
    say("link-title", "Sign in to link this machine")
    say("link-status", "")
    show("sign-in", true)
    Clerk.mountSignIn($("sign-in"), { forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href })
    return
  }
  say("link-title", "Link a machine")
  show("machines", true)
  show("sign-out", true)
  $("sign-out").onclick = (event) => {
    event.preventDefault()
    Clerk.signOut({ redirectUrl: location.href })
  }
  renderLink()
  renderHosts()
})
`

const style = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { margin: 0; display: grid; place-items: start center; padding: 48px 16px; }
main { width: 100%; max-width: 440px; display: grid; gap: 24px; }
h1 { font-size: 1.375rem; margin: 0; text-wrap: balance; }
h2 { font-size: 1rem; margin: 0 0 8px; }
p { margin: 0; color: color-mix(in srgb, currentColor 70%, transparent); }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 0; background: #e8618c; color: white; cursor: pointer; }
button.secondary { background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 4px 12px; }
button:disabled { opacity: 0.5; cursor: default; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
li div { display: grid; min-width: 0; }
li span { font-size: 0.875rem; color: color-mix(in srgb, currentColor 60%, transparent); overflow-wrap: anywhere; }
a { color: inherit; font-size: 0.875rem; }
`

/** The link page. Everything it shows comes from the API and goes into the DOM through `textContent`. */
export const linkPage = (publishableKey: string, frontendApi: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Link a machine to HinaCode</title>
<style>${style}</style>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeAttribute(publishableKey)}" src="https://${escapeAttribute(frontendApi)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer crossorigin="anonymous" src="https://${escapeAttribute(frontendApi)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
</head>
<body>
<main>
<section>
<h1 id="link-title">Link a machine</h1>
<p id="link-status">Loading.</p>
</section>
<button id="approve" hidden>Approve</button>
<div id="sign-in" hidden></div>
<section id="machines" hidden>
<h2>Your machines</h2>
<p id="hosts-status"></p>
<ul id="hosts"></ul>
</section>
<a id="sign-out" href="#" hidden>Sign out</a>
</main>
<script>${script}</script>
</body>
</html>
`
