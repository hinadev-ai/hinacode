import { isTouch, reduceMotion } from "./platform"

function element(selector: string, root: ParentNode = document): HTMLElement {
  const node = root.querySelector(selector)
  if (!(node instanceof HTMLElement)) throw new Error(`Missing board element: ${selector}`)
  return node
}
function label(node: HTMLElement, name: string): string {
  const value = node.getAttribute(`data-label-${name}`)
  if (value === null) throw new Error(`Missing board label: ${name}`)
  return value
}
function template(name: string): DocumentFragment {
  const node = element(`[data-board-template="${name}"]`)
  if (!(node instanceof HTMLTemplateElement)) throw new Error(`Invalid board template: ${name}`)
  const copy = node.content.cloneNode(true)
  if (!(copy instanceof DocumentFragment)) throw new Error(`Invalid board content: ${name}`)
  return copy
}

const page = element("[data-page]")
const lines = element("[data-lines]", page)
const hint = element("[data-hint]")
const row = element('tr[data-node="03"]')
const needsCount = element("[data-needs-count] b")
const initial = { lines: lines.innerHTML, hint: hint.innerHTML, row: element("[data-state-label]", row).textContent }
let phase: "needs" | "resolving" | "done" = "needs"
let run = 0

const wait = (ms: number) => new Promise<void>((complete) => setTimeout(complete, reduceMotion ? 0 : ms))

function setState(state: "needs" | "working" | "done") {
  page.dataset.state = state
  row.dataset.state = state
  needsCount.textContent = state === "needs" ? "1" : "0"
  element("[data-state-label]", row).textContent = state === "needs" ? initial.row : label(page, state)
}

function print(fragment: DocumentFragment) {
  for (const line of fragment.children) line.classList.add("printed")
  lines.append(fragment)
}

async function resolve(allowed: boolean) {
  if (phase !== "needs") return
  const id = run
  phase = "resolving"
  const title = element("[data-request-title]", lines)
  title.textContent = label(title, allowed ? "allowed" : "denied")
  element("[data-actions]", lines).remove()
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
  phase = "needs"
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
