import { isTouch, reduceMotion } from "./platform"

type State = "working" | "needs" | "done"

function element(selector: string, root: ParentNode = document): HTMLElement {
  const node = root.querySelector(selector)
  if (!(node instanceof HTMLElement)) throw new Error(`Missing rail element: ${selector}`)
  return node
}
function label(node: HTMLElement, name: string): string {
  const value = node.getAttribute(`data-label-${name}`)
  if (value === null) throw new Error(`Missing rail label: ${name}`)
  return value
}
function template(name: string): DocumentFragment {
  const node = element(`[data-rail-template="${name}"]`)
  if (!(node instanceof HTMLTemplateElement)) throw new Error(`Invalid rail template: ${name}`)
  const copy = node.content.cloneNode(true)
  if (!(copy instanceof DocumentFragment)) throw new Error(`Invalid rail content: ${name}`)
  return copy
}

const rail = element(".rail")
const ticket = element("[data-live]", rail)
const lines = element("[data-lines]", ticket)
const hint = element("[data-hint]", ticket)
const initial = { lines: lines.innerHTML, hint: hint.innerHTML }
let phase: "approval" | "resolving" | "done" = "approval"
let run = 0

const wait = (ms: number) => new Promise<void>((complete) => setTimeout(complete, reduceMotion ? 0 : ms))

function setState(state: State) {
  ticket.dataset.state = state
  element("[data-stamp-label]", ticket).textContent = label(rail, state)
}

function print(fragment: DocumentFragment) {
  for (const line of fragment.children) line.classList.add("printed")
  lines.append(fragment)
}

async function resolve(allowed: boolean) {
  if (phase !== "approval") return
  const id = run
  phase = "resolving"
  const approval = element("[data-approval]", lines)
  const title = element("[data-approval-title]", approval)
  title.textContent = label(title, allowed ? "allowed" : "denied")
  approval.dataset.resolved = allowed ? "allowed" : "denied"
  element(".approval-actions", approval).remove()
  setState("working")
  hint.replaceChildren(template("hint-resolving"))
  await wait(700)
  if (id !== run) return
  print(template(allowed ? "allowed" : "denied"))
  await wait(500)
  if (id !== run) return
  setState("done")
  phase = "done"
  hint.replaceChildren(template("hint-done"))
}

function replay() {
  run++
  lines.innerHTML = initial.lines
  hint.innerHTML = initial.hint
  if (isTouch) hint.replaceChildren(template("hint-touch"))
  setState("needs")
  phase = "approval"
  element("[data-allow]", lines).focus({ preventScroll: true })
}

if (isTouch) hint.replaceChildren(template("hint-touch"))

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return
  if (event.target.closest("[data-allow]")) void resolve(true)
  if (event.target.closest("[data-deny]")) void resolve(false)
  if (event.target.closest("[data-replay]")) replay()
})

addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
  if (event.target instanceof Element && event.target.closest("input, textarea, summary, button, a")) return
  if (event.key.toLowerCase() === "a") void resolve(true)
  if (event.key.toLowerCase() === "d") void resolve(false)
})
