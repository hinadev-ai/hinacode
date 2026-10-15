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
function label(node: HTMLElement, name: string): string {
  const value = node.getAttribute(`data-label-${name}`)
  if (value === null) throw new Error(`Missing demo label: ${name}`)
  return value
}
const labels = { working: label(chip, "working"), needs: label(chip, "needs"), done: label(chip, "done") }
let phase: "idle" | "playing" | "approval" | "resolving" | "done" = "idle"
let run = 0

const wait = (ms: number) => new Promise<void>((complete) => setTimeout(complete, reduceMotion ? 0 : ms))
function setState(state: keyof typeof labels) {
  row.dataset.state = state
  element(".status", row).setAttribute("aria-label", labels[state])
  chip.dataset.state = state
  element("[data-chip-label]", chip).textContent = labels[state]
}
function template(name: string): DocumentFragment {
  const node = element(`[data-demo-template="${name}"]`)
  if (!(node instanceof HTMLTemplateElement)) throw new Error(`Invalid demo template: ${name}`)
  const copy = node.content.cloneNode(true)
  if (!(copy instanceof DocumentFragment)) throw new Error(`Invalid demo content: ${name}`)
  return copy
}
const setHint = (name: string) => hint.replaceChildren(template(`hint-${name}`))

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
function templateElement(name: string): HTMLElement {
  const node = template(name).firstElementChild
  if (!(node instanceof HTMLElement)) throw new Error("Invalid demo markup")
  return node
}

async function play() {
  const id = ++run
  const alive = () => id === run
  const steps = [...transcript.querySelectorAll<HTMLElement>(".step")]
  const stream = element("[data-stream]", transcript)
  const text = stream.textContent.trim()
  phase = "playing"
  setState("working")
  setHint("working")
  await wait(900)
  stream.textContent = ""
  stream.classList.add("on")
  const words = new Intl.Segmenter(document.documentElement.lang, { granularity: "word" }).segment(text)
  for (const word of words) {
    if (!alive()) return
    stream.textContent += word.segment
    if (word.isWordLike) await wait(38)
  }
  for (const step of steps.slice(1)) {
    await wait(step.matches("[data-approval]") ? 800 : 600)
    if (!alive()) return
    append(step)
  }
  setState("needs")
  phase = "approval"
  setHint(isTouch ? "needs-touch" : "needs-keyboard")
}

async function resolve(allowed: boolean) {
  if (phase !== "approval") return
  const id = run
  phase = "resolving"
  const approval = element("[data-approval]", transcript)
  approval.classList.add("resolved")
  const approvalTitle = element("[data-approval-title]", approval)
  approvalTitle.textContent = label(approvalTitle, allowed ? "allowed" : "denied")
  element(".approval-head", approval).dataset.state = "done"
  setState("working")
  setHint("resolving")
  await wait(500)
  if (id !== run) return
  if (allowed) {
    append(templateElement("push"))
    await wait(700)
    if (id !== run) return
    append(templateElement("link-pr"))
    prSlot.replaceChildren(template("pr"))
    await wait(800)
    if (id !== run) return
    append(templateElement("allowed-response"))
  } else {
    append(templateElement("denied-response"))
  }
  setState("done")
  phase = "done"
  setHint("done")
}

function replay() {
  run++
  transcript.innerHTML = initial.transcript
  prSlot.innerHTML = initial.pr
  void play()
}

function steer(text: string) {
  const note = templateElement("steer")
  note.append(text)
  append(note)
  setTimeout(() => append(templateElement("steered-response")), reduceMotion ? 0 : 600)
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
