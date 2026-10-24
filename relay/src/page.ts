const script = `
const code = new URLSearchParams(location.search).get("code")
const $ = (id) => document.getElementById(id)

const show = (id, visible) => { $(id).hidden = !visible }
const say = (id, text) => { $(id).textContent = text }

const TOKEN_KEY = "hinacode-relay-owner-token"

async function api(method, path) {
  const token = localStorage.getItem(TOKEN_KEY)
  const response = await fetch(path, { method, headers: { Authorization: "Bearer " + token } })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (response.status === 401) localStorage.removeItem(TOKEN_KEY)
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

async function rotateToken() {
  if (!confirm("Replace the owner token? The current one stops working everywhere, including other browsers.")) return
  $("rotate").disabled = true
  try {
    const { token } = await api("POST", "/v1/owner/token")
    localStorage.setItem(TOKEN_KEY, token)
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
  show("machines", true)
  show("owner-token", true)
  $("rotate").onclick = rotateToken
  $("copy-token").onclick = () => navigator.clipboard.writeText($("new-token").value)
  show("sign-out", true)
  $("sign-out").onclick = (event) => {
    event.preventDefault()
    localStorage.removeItem(TOKEN_KEY)
    location.reload()
  }
  renderLink()
  renderHosts()
}

if (localStorage.getItem(TOKEN_KEY)) {
  start()
} else {
  say("link-title", "Enter the owner token")
  say("link-status", "This relay serves one account. Paste its OWNER_TOKEN.")
  show("sign-in", true)
  $("sign-in").onsubmit = (event) => {
    event.preventDefault()
    localStorage.setItem(TOKEN_KEY, $("token").value.trim())
    show("sign-in", false)
    start()
  }
}
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
button:disabled { opacity: 0.5; cursor: default; }
.row { display: flex; gap: 8px; margin: 8px 0; }
.row input { flex: 1; min-width: 0; font-family: ui-monospace, monospace; }
#rotate { margin-top: 8px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
li div { display: grid; min-width: 0; }
li span { font-size: 0.875rem; color: color-mix(in srgb, currentColor 60%, transparent); overflow-wrap: anywhere; }
a { color: inherit; font-size: 0.875rem; }
`

/** The link page. Everything it shows comes from the API and goes into the DOM through `textContent`. */
export const linkPage = `<!doctype html>
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
<form id="sign-in" hidden><input id="token" type="password" autocomplete="current-password" required> <button>Continue</button></form>
<section id="machines" hidden>
<h2>Your machines</h2>
<p id="hosts-status"></p>
<ul id="hosts"></ul>
</section>
<section id="owner-token" hidden>
<h2>Owner token</h2>
<p id="token-status">Replace it if it may have leaked.</p>
<div id="new-token-field" class="row" hidden><input id="new-token" readonly aria-label="New owner token"> <button id="copy-token" class="secondary">Copy</button></div>
<button id="rotate" class="secondary">Rotate owner token</button>
</section>
<a id="sign-out" href="#" hidden>Forget the token</a>
</main>
<script>${script}</script>
</body>
</html>
`
