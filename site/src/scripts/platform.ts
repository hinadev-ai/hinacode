const platform =
  "userAgentData" in navigator &&
  typeof navigator.userAgentData === "object" &&
  navigator.userAgentData !== null &&
  "platform" in navigator.userAgentData &&
  typeof navigator.userAgentData.platform === "string"
    ? navigator.userAgentData.platform
    : navigator.platform

export const isTouch = matchMedia("(pointer: coarse)").matches
export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches

if (/linux/i.test(platform) && !/android/i.test(navigator.userAgent)) {
  for (const label of document.querySelectorAll<HTMLElement>("[data-download-label]")) {
    if (label.dataset.linuxLabel) label.textContent = label.dataset.linuxLabel
  }
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return
  const link = event.target.closest("[data-language-link]")
  if (!(link instanceof HTMLAnchorElement)) return
  const destination = new URL(link.href)
  destination.hash = location.hash
  link.href = destination.href
})

addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
  if (event.target instanceof Element && event.target.closest("input, textarea")) return
  const link = document.querySelector(`.menu-keys a[data-key="${CSS.escape(event.key.toLowerCase())}"]`)
  if (link instanceof HTMLAnchorElement) link.click()
})
