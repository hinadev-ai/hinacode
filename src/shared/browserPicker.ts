/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import type { PickedElement } from "./domain.ts"

/**
 * Runs inside the browsed page through `executeJavaScript`, so it must not reference anything outside its own
 * body. Highlights the element under the pointer and resolves with a `PagePick` on click or Enter, or null on
 * Escape or `window.__hinacodePicker.cancel()`. Arrow keys walk to the parent, first child and siblings.
 */
/* oxlint-disable unicorn/consistent-function-scoping -- the page gets this function's source alone, so helpers stay inside */
function pickElement(): Promise<unknown> {
  // The limits of `PickedElement`, which rejects the whole pick when one field is longer.
  const MAX_URL = 2048
  const MAX_SELECTOR = 1000
  const MAX_HTML = 4000
  const MAX_TEXT = 500
  const MAX_COMPONENT = 200
  const scope = window as unknown as { __hinacodePicker?: { cancel: () => void } }
  scope.__hinacodePicker?.cancel()

  return new Promise((resolve) => {
    const host = document.createElement("div")
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none"
    const root = host.attachShadow({ mode: "closed" })
    root.innerHTML = `<style>
      div { position: fixed; display: none; pointer-events: none; box-sizing: border-box }
      .box { border: 2px solid #7c3aed; background: rgb(124 58 237 / 0.12); border-radius: 2px }
      .label {
        max-width: 60vw; overflow: hidden; padding: 2px 6px; border-radius: 4px; background: #7c3aed; color: #fff;
        font: 500 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; text-overflow: ellipsis;
      }
    </style><div class="box"></div><div class="label"></div>`
    const box = root.querySelector<HTMLElement>(".box")!
    const label = root.querySelector<HTMLElement>(".label")!
    const cursor = document.createElement("style")
    cursor.textContent = "* { cursor: crosshair !important }"
    document.documentElement.append(host, cursor)

    let current: Element | null = null

    const name = (element: Element) =>
      element.localName +
      [...element.classList]
        .slice(0, 2)
        .map((value) => `.${value}`)
        .join("")

    const show = (element: Element | null) => {
      current = element
      if (!element) return
      const rect = element.getBoundingClientRect()
      Object.assign(box.style, {
        display: "block",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      })
      label.textContent = `${name(element)}  ${Math.round(rect.width)}×${Math.round(rect.height)}`
      const above = rect.top >= 20
      Object.assign(label.style, {
        display: "block",
        left: `${Math.max(0, rect.left)}px`,
        top: above ? `${rect.top - 20}px` : `${Math.min(rect.bottom + 4, innerHeight - 20)}px`,
      })
    }

    const segment = (element: Element) => {
      if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
        return `#${CSS.escape(element.id)}`
      }
      const classes = [...element.classList].slice(0, 2).map((value) => `.${CSS.escape(value)}`)
      const base = `${element.localName}${classes.join("")}`
      const siblings = [...(element.parentElement?.children ?? [])]
      if (siblings.filter((other) => other.matches(base)).length <= 1) return base
      const sameTag = siblings.filter((other) => other.localName === element.localName)
      return `${base}:nth-of-type(${sameTag.indexOf(element) + 1})`
    }

    /** The shortest ancestor path that matches only this element. */
    const selector = (element: Element) => {
      const parts: Array<string> = []
      for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
        parts.unshift(segment(node))
        if (parts[0]!.startsWith("#") || document.querySelectorAll(parts.join(" > ")).length === 1) break
      }
      return parts.join(" > ")
    }

    /**
     * React hangs its fiber on each DOM node; walking up names the components the element sits in. Production
     * builds have the fiber too but minified names, so only development builds, which carry `_debugOwner`, count.
     */
    const components = (element: Element) => {
      const key = Object.keys(element).find((property) => property.startsWith("__reactFiber$"))
      type Fiber = { type: unknown; return: Fiber | null }
      type Named = { displayName?: string; name?: string; render?: Named; type?: Named }
      const start = key ? (element as unknown as Record<string, Fiber>)[key] : undefined
      if (!start || !("_debugOwner" in start)) return []
      const names: Array<string> = []
      for (let fiber: Fiber | null = start; fiber && names.length < 5; fiber = fiber.return) {
        const type = fiber.type as Named | string | null
        if (type === null || typeof type === "string") continue
        const found = type.displayName ?? type.name ?? type.render?.displayName ?? type.render?.name ?? type.type?.name
        if (found && names.at(-1) !== found) names.push(found)
      }
      return names
    }

    const describe = (element: Element) => {
      const rect = element.getBoundingClientRect()
      const left = Math.max(0, rect.left)
      const top = Math.max(0, rect.top)
      const text = element instanceof HTMLElement ? element.innerText : (element.textContent ?? "")
      return {
        element: {
          url: location.href.slice(0, MAX_URL),
          selector: selector(element).slice(0, MAX_SELECTOR),
          html: element.outerHTML.slice(0, MAX_HTML),
          text: text.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT),
          components: components(element).map((component) => component.slice(0, MAX_COMPONENT)),
        },
        rect: {
          x: left,
          y: top,
          width: Math.max(0, Math.min(rect.right, innerWidth) - left),
          height: Math.max(0, Math.min(rect.bottom, innerHeight) - top),
        },
      }
    }

    const swallow = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const onMove = (event: MouseEvent) => show(document.elementFromPoint(event.clientX, event.clientY))
    const onClick = (event: MouseEvent) => {
      swallow(event)
      const target = document.elementFromPoint(event.clientX, event.clientY)
      if (target) finish(target)
    }
    const step = (key: string, element: Element): Element | null => {
      if (key === "ArrowUp") return element.parentElement === document.documentElement ? null : element.parentElement
      if (key === "ArrowDown") return element.firstElementChild
      if (key === "ArrowLeft") return element.previousElementSibling
      if (key === "ArrowRight") return element.nextElementSibling
      return null
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        swallow(event)
        finish(null)
      } else if (event.key === "Enter" && current) {
        swallow(event)
        finish(current)
      } else if (event.key.startsWith("Arrow")) {
        swallow(event)
        const next = current ? step(event.key, current) : document.elementFromPoint(innerWidth / 2, innerHeight / 2)
        if (!next) return
        next.scrollIntoView({ block: "nearest", inline: "nearest" })
        show(next)
      }
    }
    const reposition = () => show(current)
    const blocked = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "auxclick"]

    const finish = (element: Element | null) => {
      removeEventListener("mousemove", onMove, true)
      removeEventListener("click", onClick, true)
      removeEventListener("keydown", onKey, true)
      removeEventListener("scroll", reposition, true)
      removeEventListener("resize", reposition)
      for (const type of blocked) removeEventListener(type, swallow, true)
      delete scope.__hinacodePicker
      const pick = element ? describe(element) : null
      host.remove()
      cursor.remove()
      if (pick === null) return resolve(null)
      // Wait for a frame without the overlay, so the screenshot taken next does not include it.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(pick)))
    }

    addEventListener("mousemove", onMove, true)
    addEventListener("click", onClick, true)
    addEventListener("keydown", onKey, true)
    addEventListener("scroll", reposition, true)
    addEventListener("resize", reposition)
    for (const type of blocked) addEventListener(type, swallow, true)
    scope.__hinacodePicker = { cancel: () => finish(null) }
  })
}

/* oxlint-enable unicorn/consistent-function-scoping */

export const PICK_ELEMENT_SCRIPT = `(${pickElement.toString()})()`
export const CANCEL_PICK_SCRIPT = "window.__hinacodePicker?.cancel()"

/** A short name like the picker's label, `button.btn.primary`, which the composer chip shows. */
export const elementLabel = (element: PickedElement) => {
  const tag = /^<([a-z][\w-]*)/i.exec(element.html)?.[1]?.toLowerCase() ?? "element"
  const classes = /^<[^>]*\sclass="([^"]*)"/i.exec(element.html)?.[1]?.split(/\s+/).filter(Boolean) ?? []
  return [tag, ...classes.slice(0, 2)].join(".")
}
