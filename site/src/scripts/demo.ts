import { isTouch, reduceMotion } from "./platform"

const keyFor = (event: KeyboardEvent) => {
  if (event.key === "Meta" || event.key === "Control") return "mod"
  if (event.key === "Shift") return "shift"
  return event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.key
}
const keycaps = (key: string) => document.querySelectorAll(`[data-keys] kbd[data-key="${CSS.escape(key)}"]`)
addEventListener("keydown", (event) => keycaps(keyFor(event)).forEach((key) => key.classList.add("down")))
addEventListener("keyup", (event) => {
  keycaps(keyFor(event)).forEach((key) => key.classList.remove("down"))
  if (event.key === "Meta") {
    document.querySelectorAll("[data-keys] kbd.down").forEach((key) => key.classList.remove("down"))
  }
})
addEventListener("blur", () =>
  document.querySelectorAll("[data-keys] kbd.down").forEach((key) => key.classList.remove("down")),
)

function element(selector: string, root: ParentNode = document): HTMLElement {
  const node = root.querySelector(selector)
  if (!(node instanceof HTMLElement)) throw new Error(`Missing demo element: ${selector}`)
  return node
}

const transcript = element("[data-transcript]")
const row = element('[data-thread="main"]')
const chip = element("[data-chip]")
const hint = element("[data-hint]")
const prSlot = element("[data-pr-slot]")
const initial = { transcript: transcript.innerHTML, pr: prSlot.innerHTML }
const labels = { working: "Working", needs: "Needs you", done: "Done" }
let phase: "idle" | "playing" | "approval" | "resolving" | "done" = "idle"
let run = 0

const wait = (ms: number) => new Promise<void>((complete) => setTimeout(complete, reduceMotion ? 0 : ms))
function setState(state: keyof typeof labels) {
  row.dataset.state = state
  element(".status", row).setAttribute("aria-label", labels[state])
  chip.dataset.state = state
  element("[data-chip-label]", chip).textContent = labels[state]
}
const setHint = (markup: string) => (hint.innerHTML = markup)

function trim() {
  while (transcript.scrollHeight > transcript.clientHeight + 4 && transcript.children.length > 3) {
    transcript.firstElementChild?.remove()
  }
}
function append(node: HTMLElement) {
  node.classList.add("step", "on")
  transcript.append(node)
  trim()
}
function html(markup: string): HTMLElement {
  const template = document.createElement("template")
  template.innerHTML = markup.trim()
  const node = template.content.firstElementChild
  if (!(node instanceof HTMLElement)) throw new Error("Invalid demo markup")
  return node
}
const agentSays = (text: string) =>
  Object.assign(document.createElement("div"), { className: "msg-agent", textContent: text })

async function play() {
  const id = ++run
  const alive = () => id === run
  const steps = [...transcript.querySelectorAll<HTMLElement>(".step")]
  const stream = element("[data-stream]", transcript)
  const text = stream.textContent.trim()
  phase = "playing"
  setState("working")
  setHint("<span>The agent is working. You could be doing something else.</span>")
  await wait(900)
  stream.textContent = ""
  stream.classList.add("on")
  for (const word of text.split(" ")) {
    if (!alive()) return
    stream.textContent += (stream.textContent ? " " : "") + word
    await wait(38)
  }
  for (const step of steps.slice(1)) {
    await wait(step.matches("[data-approval]") ? 800 : 600)
    if (!alive()) return
    append(step)
  }
  setState("needs")
  phase = "approval"
  setHint(
    isTouch
      ? "<span>Now it needs you. Tap Allow or Deny.</span>"
      : "<span>Now it needs you.</span><kbd>A</kbd><span>allows,</span><kbd>D</kbd><span>denies.</span>",
  )
}

async function resolve(allowed: boolean) {
  if (phase !== "approval") return
  const id = run
  phase = "resolving"
  const approval = element("[data-approval]", transcript)
  approval.classList.add("resolved")
  element("[data-approval-title]", approval).textContent = allowed ? "Allowed by you" : "Denied by you"
  element(".approval-head", approval).dataset.state = "done"
  setState("working")
  setHint("<span>Back to work.</span>")
  await wait(500)
  if (id !== run) return
  if (allowed) {
    append(
      html(
        '<div class="tool"><span class="glyph" aria-hidden="true">$</span>git push -u origin feat/address-validation <span class="ok">done</span></div>',
      ),
    )
    await wait(700)
    if (id !== run) return
    append(
      html(
        '<div class="tool"><span class="glyph" aria-hidden="true">⇡</span>link_pull_request <span class="path">#128</span></div>',
      ),
    )
    prSlot.innerHTML = `
      <div class="pr step on">
        <div class="pr-title"><span>#128</span>Tighten address validation</div>
        <div class="pr-meta"><span class="pr-state">Open</span><span class="ok">4/4 checks</span><span>Ready for review</span></div>
      </div>`
    await wait(800)
    if (id !== run) return
    append(agentSays("Opened #128 and the checks pass. It's ready for your review."))
  } else {
    append(agentSays("Understood. The branch stays local, and the tests are green whenever you want to push."))
  }
  setState("done")
  phase = "done"
  setHint('<span>Done. That is the whole loop.</span><button class="replay" type="button" data-replay>Replay</button>')
}

function replay() {
  run++
  transcript.innerHTML = initial.transcript
  prSlot.innerHTML = initial.pr
  void play()
}

function steer(text: string) {
  const note = html('<div class="msg-user"><small>Steer</small></div>')
  note.append(text)
  append(note)
  setTimeout(
    () => append(agentSays("Noted. I'll fold that into the next step without starting over.")),
    reduceMotion ? 0 : 600,
  )
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return
  if (event.target.closest("[data-allow]")) void resolve(true)
  if (event.target.closest("[data-deny]")) void resolve(false)
  if (event.target.closest("[data-replay]")) replay()
})

addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
  if (event.target instanceof Element && event.target.closest("input, textarea, summary, button")) return
  if (event.key.toLowerCase() === "a") void resolve(true)
  if (event.key.toLowerCase() === "d") void resolve(false)
})

element("[data-composer]").addEventListener("submit", (event) => {
  event.preventDefault()
  const input = element("input", element("[data-composer]"))
  if (!(input instanceof HTMLInputElement)) return
  const text = input.value.trim()
  if (!text) return
  input.value = ""
  steer(text)
})

new IntersectionObserver(
  (entries, observer) => {
    if (!entries.some((entry) => entry.isIntersecting)) return
    observer.disconnect()
    void play()
  },
  { threshold: 0.35 },
).observe(element("#demo"))
